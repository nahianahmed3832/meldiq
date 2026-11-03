"""Single-host transaction for a verified PostgreSQL API deployment. Controller uses SSH stdin.
Protocol: send private JSON settings, wait for READY, send FENCE. On FROZEN verify
the S3 manifests and send ACTIVATE. Test the loopback candidate on CANDIDATE,
then send OPEN. EOF or timeout before OPEN restores the previous deployment.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time
import urllib.request

BASE=Path('/opt/griip-internal-messaging')
CONTAINER='griip-internal-messaging-api-1'
PROJECT='griip-internal-messaging'
SITES=Path('/etc/nginx/sites-enabled')
SNIPPETS=Path('/etc/nginx/snippets')
OLD='127.0.0.1:18080'
MAINT='127.0.0.1:18082'


def command(args,**kwargs):
    return subprocess.check_output(args,stderr=subprocess.PIPE,timeout=120,**kwargs)


def atomic(path,data,mode):
    tmp=path.with_name(path.name+'.storage-next')
    with tmp.open('wb') as f:
        os.fchmod(f.fileno(),mode)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


def wait_for(word,seconds):
    if not select.select([sys.stdin],[],[],seconds)[0] or sys.stdin.readline().strip()!=word:
        raise RuntimeError('Operator/controller fence did not confirm '+word)


def api_health():
    for _ in range(50):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18080/healthz',timeout=3) as r:
                d=json.load(r)
                if d.get('ok') and d.get('postgres') and d.get('mongodb') is None and d.get('databaseMode')=='supabase' and d.get('redis'):return
        except (OSError,ValueError):pass
        time.sleep(1)
    raise RuntimeError('API readiness failed')


def activate(opts):
    if not all(re.fullmatch('[a-f0-9]{64}',opts[name]) for name in ['MEDIA_EDGE_SECRET','MEDIA_GRANT_KEY']):raise ValueError('Invalid secret shape')
    if opts['MEDIA_PUBLIC_BASE_URL']!='https://media.meldiq.app':raise ValueError('Wrong media route')
    compose=BASE/'compose.yaml';envfile=BASE/'.env'
    cli=['docker','compose','-p',PROJECT,'-f',str(compose)]
    lock=open('/run/lock/meldiq-production-release.lock','a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    current=json.loads(command(['docker','inspect',CONTAINER]))[0]
    live=dict(s.split('=',1) for s in current['Config']['Env'])
    if (current['Image']!=opts['baseId'] or not current['State']['Running'] or live.get('DATABASE_MODE')!='supabase'
        or live.get('S3_REGION')!='ap-southeast-1' or live.get('S3_BUCKET')!=opts['source'] or live.get('S3_PREFIX')!='orbit/'):
        raise ValueError('Active image, DB or storage no longer matches the qualified base')
    image=json.loads(command(['docker','image','inspect',opts['image']]))[0]
    if image['Id']!=opts['imageId'] or image['Config']['Labels'].get('org.opencontainers.image.revision')!=opts['revision']:
        raise ValueError('Candidate image provenance mismatch')
    if image['RootFS']['Layers'][:-1]!=json.loads(command(['docker','image','inspect',current['Image']]))[0]['RootFS']['Layers']:
        raise ValueError('Candidate does not extend the exact active base')
    api_health()
    public=json.loads(command(['curl','-fsS','--max-time','10','https://msg.meldiq.app/healthz']))
    if not public.get('ok') or not public.get('postgres') or public.get('databaseMode')!='supabase' or public.get('mongodb') is not None or not public.get('redis'):raise ValueError('Public PostgreSQL API is not ready')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    run=Path('/opt/meldiq-storage-qa')/('cutover-'+stamp)
    run.mkdir(mode=0o700)
    originals={compose:compose.read_bytes()}
    for p,b in originals.items():atomic(run/(p.name+'.before'),b,0o600)
    line='    image: '+current['Config']['Image']
    c=originals[compose].decode()
    if c.count(line)!=1 or '    - .env\n' not in c:raise ValueError('Unexpected Compose structure')
    candidate=c.replace(line,'    image: '+opts['image'],1)
    # Only API upstreams are put in maintenance. Static websites keep serving.
    allowed={'meldiq-msg.conf','griip-message.conf','meldiq-web.conf','meldiq-apex.conf','meldiq-admin.conf','meldiq-web-media.conf'}
    sites={}
    for p in list(SITES.iterdir())+list(SNIPPETS.glob('*.conf')):
        if not p.is_file():continue
        b=p.read_bytes()
        if b'proxy_pass http://'+OLD.encode() not in b:continue
        if p.name not in allowed:raise ValueError('Unreviewed API upstream')
        sites[p.resolve()]=b
    if not sites:raise ValueError('No live API upstream')
    for p,b in sites.items():atomic(run/(p.name+'.before'),b,0o600)
    prior=json.loads(command(cli+['config','--format','json']))
    ca=next(m for m in current['Mounts'] if m['Destination']==live['SUPABASE_DB_CA_FILE'])
    if ca['RW']:raise ValueError('CA mount must be read-only')
    def pending_sessions():
        node="""const fs=require('fs'),{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.SUPABASE_DATABASE_URL,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE)}});await c.connect();try{await c.query('BEGIN READ ONLY');const r=await c.query('SELECT id FROM meldiq.attachment_uploads WHERE expires_at > $1 ORDER BY id',[Date.now()]);await c.query('COMMIT');console.log(JSON.stringify(r.rows.map(x=>x.id)))}finally{await c.end()}})().catch(()=>process.exitCode=1)"""
        keys=['SUPABASE_DATABASE_URL','SUPABASE_DB_CA_FILE']
        conn=dict(os.environ,**{k:live[k] for k in keys})
        return json.loads(command(['docker','run','--rm','--read-only','--memory=220m','--cpus=.4','--mount',
            'type=bind,source='+ca['Source']+',target='+ca['Destination']+',readonly','-e',keys[0],'-e',keys[1],
            '--entrypoint','node',current['Image'],'-e',node],env=conn))
    pending_sessions()
    if command(['curl','-sS','-o','/dev/null','-w','%{http_code}','--max-time','4','http://'+MAINT+'/healthz'])!=b'503':
        raise ValueError('Maintenance service unavailable')
    print('READY '+stamp,flush=True)
    wait_for('FENCE',420)
    stopped=changed=opened=False
    try:
        for p,b in sites.items():atomic(p,b.replace(b'proxy_pass http://'+OLD.encode(),b'proxy_pass http://'+MAINT.encode()),0o644)
        command(['nginx','-t']);command(['systemctl','reload','nginx'])
        stopped=True
        command(['docker','stop','-t','20',CONTAINER])
        # No second API writer: read the authoritative session list after shutdown.
        ids=pending_sessions()
        if any(not isinstance(i,str) or not re.fullmatch('[A-Za-z0-9_-]{1,64}',i) for i in ids):raise ValueError('Unknown pending session structure')
        atomic(run/'previous-source-session-ids.json',json.dumps(ids).encode(),0o600)
        print('FROZEN '+str(len(ids)),flush=True)
        wait_for('ACTIVATE',240)
        updates={k:opts[k] for k in ['MEDIA_PUBLIC_BASE_URL','MEDIA_EDGE_SECRET','MEDIA_GRANT_KEY']}
        updates.update(S3_REGION='eu-central-1',S3_BUCKET=opts['target'],S3_PREVIOUS_UPLOAD_BUCKET=opts['source'],
                       S3_PREVIOUS_UPLOAD_REGION='ap-southeast-1',S3_PREVIOUS_UPLOAD_IDS=','.join(ids),S3_PREVIOUS_DESKTOP_UPLOADS='true')
        media_env=run/'media.env'
        atomic(media_env,('\n'.join(k+'='+v for k,v in updates.items())+'\n').encode(),0o600)
        marker='    - ./database-migration/.env.redis\n'
        if candidate.count(marker)!=1:raise ValueError('Unknown PostgreSQL compose structure')
        candidate=candidate.replace(marker,marker+'    - '+str(media_env)+'\n',1)
        changed=True
        atomic(compose,candidate.encode(),0o600)
        after=json.loads(command(cli+['config','--format','json']))
        normalized=json.loads(json.dumps(after));oldsvc=prior['services']['api'];newsvc=normalized['services']['api']
        if newsvc['image']!=opts['image'] or any(newsvc['environment'].get(k)!=v for k,v in updates.items()):
            raise ValueError('Candidate effective environment mismatch')
        newsvc['image']=oldsvc['image']
        for k in updates:
            if k in oldsvc['environment']:newsvc['environment'][k]=oldsvc['environment'][k]
            else:newsvc['environment'].pop(k,None)
        if normalized!=prior:raise ValueError('Unrelated effective Compose change')
        command(cli+['up','-d','--no-deps','--no-build','api']);api_health()
        print('CANDIDATE',flush=True)
        wait_for('OPEN',120)
        for p,b in sites.items():atomic(p,b,0o644)
        command(['nginx','-t']);command(['systemctl','reload','nginx']);opened=True
        receipt={'activatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baseImage':current['Image'],'image':image['Id'],'revision':opts['revision'],'pendingSourceSessions':len(ids),'database':'supabase','primaryRegion':'eu-central-1'}
        atomic(run/'activated.json',json.dumps(receipt).encode(),0o600);print('OPEN '+str(run),flush=True)
    finally:
        if not opened:
            if changed:
                for p,b in originals.items():atomic(p,b,0o600)
            if stopped:command(cli+['up','-d','--no-deps','--no-build','api']);api_health()
            for p,b in sites.items():atomic(p,b,0o644)
            command(['nginx','-t']);command(['systemctl','reload','nginx'])


if __name__=='__main__':
    os.umask(0o077)
    def interrupted(signum,frame):raise RuntimeError('Activation interrupted')
    for sig in [signal.SIGHUP,signal.SIGTERM]:signal.signal(sig,interrupted)
    try:activate(json.loads(sys.stdin.readline()))
    except Exception as exc:print('ABORT '+type(exc).__name__+' '+(str(exc)[:180] if isinstance(exc,(ValueError,RuntimeError,BlockingIOError)) else ''),flush=True);sys.exit(1)
