"""Replace the single API writer with a qualified patch on the same database and storage."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import runpy
import sys

ops=runpy.run_path(str(Path(__file__).with_name('activate-postgres.py')))
command,atomic,health,wait_for=[ops[x] for x in ('command','atomic','api_health','wait_for')]
def run(o):
    lock=open('/run/lock/meldiq-production-release.lock','a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    current=json.loads(command(['docker','inspect',ops['CONTAINER']]))[0]
    env=dict(x.split('=',1) for x in current['Config']['Env'])
    if current['Image']!=o['baseId'] or env.get('S3_REGION')!='eu-central-1' or env.get('DATABASE_MODE')!='supabase' or env.get('S3_PREVIOUS_UPLOAD_BUCKET') or env.get('ATTACHMENT_RETAIN_COMPLETED')!='true':
        raise ValueError('Live release changed')
    base=json.loads(command(['docker','image','inspect',current['Image']]))[0]
    candidate=json.loads(command(['docker','image','inspect',o['image']]))[0]
    if candidate['Id']!=o['imageId'] or candidate['RootFS']['Layers'][:-1]!=base['RootFS']['Layers'] or candidate['Config']['Labels']['org.opencontainers.image.revision']!=o['revision']:
        raise ValueError('Unqualified patch image')
    health()
    cfg=ops['BASE']/'compose.yaml';cli=['docker','compose','-p',ops['PROJECT'],'-f',str(cfg)]
    previous=cfg.read_bytes();mark=('    image: '+current['Config']['Image']+'\n').encode()
    if previous.count(mark)!=1:raise ValueError('Unexpected compose')
    content=previous.replace(mark,('    image: '+o['image']+'\n').encode(),1)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder=Path('/opt/meldiq-storage-qa')/('patch-'+stamp);folder.mkdir(mode=0o700)
    atomic(folder/'compose.before',previous,0o600)
    original=json.loads(command(cli+['config','--format','json']))
    old=b'proxy_pass http://'+ops['OLD'].encode()
    sites={}
    for path in list(ops['SITES'].iterdir())+list(ops['SNIPPETS'].glob('*.conf')):
        if path.is_file() and old in path.read_bytes():
            if path.name not in {'meldiq-msg.conf','griip-message.conf','meldiq-web.conf','meldiq-apex.conf','meldiq-admin.conf','meldiq-web-media.conf'}:raise ValueError('Unreviewed proxy')
            sites[path.resolve()]=path.read_bytes()
    if not sites:raise ValueError('Missing API routes')
    print('READY '+stamp,flush=True);wait_for('FENCE',240);changed=opened=False
    try:
        for path,data in sites.items():atomic(folder/(path.name+'.before'),data,0o600);atomic(path,data.replace(old,b'proxy_pass http://'+ops['MAINT'].encode()),0o644)
        command(['nginx','-t']);command(['systemctl','reload','nginx']);changed=True
        atomic(cfg,content,0o600);nextcfg=json.loads(command(cli+['config','--format','json']))
        nextcfg['services']['api']['image']=original['services']['api']['image']
        if nextcfg!=original:raise ValueError('Unrelated configuration change')
        command(cli+['up','-d','--no-build','--no-deps','api']);health()
        print('CANDIDATE',flush=True);wait_for('OPEN',120)
        for path,data in sites.items():atomic(path,data,0o644)
        command(['nginx','-t']);command(['systemctl','reload','nginx']);opened=True
        receipt=dict(activatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),revision=o['revision'],image=o['imageId'],baseImage=current['Image'],primaryRegion='eu-central-1',database='supabase')
        atomic(folder/'activated.json',json.dumps(receipt).encode(),0o600);print('OPEN '+str(folder),flush=True)
    finally:
        if not opened:
            if changed:atomic(cfg,previous,0o600);command(cli+['up','-d','--no-deps','--no-build','api']);health()
            for path,data in sites.items():atomic(path,data,0o644)
            command(['nginx','-t']);command(['systemctl','reload','nginx'])
if __name__=='__main__':
    os.umask(0o077)
    try:run(json.loads(sys.stdin.readline()))
    except Exception as exc:print('ABORT '+type(exc).__name__,flush=True);sys.exit(1)
