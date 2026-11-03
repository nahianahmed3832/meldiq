#!/usr/bin/env python3
"""Exercise the real production settings in an isolated, held API. Never switches ingress or activates it."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from urllib.parse import urlsplit, unquote

BASE = Path('/opt/griip-internal-messaging')
ROOT = BASE/'database-migration'
API = 'griip-internal-messaging-api-1'
PROJECT = 'bkvlxbsnzqkhbifawcww'
os.umask(0o077)


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def inspection(name):
    return json.loads(command(['docker','inspect',name]).stdout)[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--revision', required=True)
    parser.add_argument('--canary', type=Path, required=True)
    parser.add_argument('--source-run', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{40}',args.revision) or args.canary.parent != ROOT or args.source_run.parent != ROOT:
        raise RuntimeError('Owned artifacts required')
    canary = json.loads((args.canary/'report.json').read_text())
    if not canary.get('ok') or not canary.get('activationHoldVerified') or not canary.get('customerTableFingerprintsUnchangedAtRollback') or args.revision not in [canary['candidateRevision'],canary['rollbackRevision']]:
        raise RuntimeError('Exact image retained-data canary required')
    original = inspection(API)
    current_env = dict(v.split('=',1) for v in original['Config']['Env'] if '=' in v)
    if current_env.get('DATABASE_MODE') != 'atlas' or not original['State']['Running'] or original['State']['Health']['Status'] != 'healthy':
        raise RuntimeError('Keep healthy Atlas serving during preflight')
    source = next(v for v in original['Mounts'] if v['Destination']=='/data')
    source_data = Path(source['Source'])
    if (source_data/'database-authority.json').exists():
        raise RuntimeError('PostgreSQL authority is already committed')
    image_receipt = json.loads((ROOT/('supabase-compatibility-'+args.revision[:8])/'image.json').read_text())
    image = json.loads(command(['docker','image','inspect',image_receipt['image']]).stdout)[0]
    if image['Id'] != image_receipt['imageId'] or image['Config']['Labels']['org.opencontainers.image.revision'] != args.revision:
        raise RuntimeError('Image provenance changed')
    run = ROOT/('production-preflight-'+args.revision[:8]+'-'+datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ'))
    run.mkdir(mode=0o700)
    data = run/'data';data.mkdir(mode=0o700)
    # Separate writable identity/configuration copy; actual attachments are mounted read-only below.
    for item in source_data.iterdir():
        if item.is_file() and item.name!='database-authority.json' and not re.search(r'\.(?:sqlite|db)(?:-|$)',item.name):
            shutil.copy2(item,data/item.name)
        elif item.is_dir() and item.name=='federation':
            shutil.copytree(item,data/item.name)
    extra_files=[]
    for key,value in current_env.items():
        if not (key.endswith('_FILE') or key=='GOOGLE_APPLICATION_CREDENTIALS') or not value.startswith('/'):
            continue
        location=Path(value)
        if location.is_relative_to('/data'):
            relative=location.relative_to('/data');origin=source_data/relative;target=data/relative
            if origin.is_file() and not target.exists():
                target.parent.mkdir(parents=True,exist_ok=True,mode=0o700);shutil.copy2(origin,target)
        else:
            target=run/('config-'+key.lower())
            result=subprocess.run(['docker','cp',API+':'+value,str(target)],capture_output=True)
            if result.returncode==0:
                target.chmod(0o400);os.chown(target,1000,1000);extra_files.append((target,value))
    for item in [data,*data.rglob('*')]:os.chown(item,1000,1000)
    acceptance = json.loads((args.source_run/'acceptance.json').read_text())
    acceptance.update(runtimeRevision=args.revision,acceptedAt=datetime.datetime.now(datetime.UTC).isoformat(),preflightOnly=True)
    accepted = run/'acceptance.json';accepted.write_text(json.dumps(acceptance)+'\n');accepted.chmod(0o400);os.chown(accepted,1000,1000)
    settings = json.loads((args.source_run/'runtime-settings.json').read_text())
    environment = {**current_env,'DATABASE_MODE':'supabase','MONGODB_URI':'','DATA_DIR':'/data',
                   'SUPABASE_DATABASE_URL':settings['databaseUrl'],'SUPABASE_DATABASE_PROJECT_REF':PROJECT,
                   'SUPABASE_DATABASE_POOL_SIZE':'4','SUPABASE_DB_CA_FILE':'/run/meldiq-db/root.crt',
                   'SUPABASE_PRODUCTION_ACCEPTANCE_FILE':'/run/meldiq-db/acceptance.json'}
    if any('\n' in v or '\r' in v for v in environment.values()):raise RuntimeError('Multiline environment unsupported')
    env = run/'runtime.env';env.write_text(''.join(k+'='+v+'\n' for k,v in environment.items()))
    expected = json.loads((args.source_run/'source-manifest.json').read_text())['tables']
    guarded = [v for v in expected if v['schema'] in ['meldiq','meldiq_private']]
    if len(guarded)!=289 or any(not re.fullmatch('[a-z_][a-z0-9_]*',v['name']) or not re.fullmatch('[a-f0-9]{64}',v['rowChecksum']) for v in guarded):
        raise RuntimeError('Exact protected-table backup inventory required')
    backup = json.loads((ROOT/'backup-tools/postgres-backup.json').read_text());endpoint=urlsplit(backup['databaseUrl'])
    if endpoint.hostname!='aws-1-eu-central-1.pooler.supabase.com' or unquote(endpoint.username or '')!='postgres.'+PROJECT:
        raise RuntimeError('Approved fingerprint source required')
    pg_env = run/'fingerprint.env'
    values={'PGHOST':endpoint.hostname,'PGPORT':'5432','PGUSER':unquote(endpoint.username),'PGPASSWORD':unquote(endpoint.password),
            'PGDATABASE':'postgres','PGSSLMODE':'verify-full','PGSSLROOTCERT':'/run/postgres-root.crt','PGCONNECT_TIMEOUT':'10'}
    pg_env.write_text(''.join(k+'='+v+'\n' for k,v in values.items()))
    pg = ['docker','run','--rm','-i','--read-only','--user','65534:65534','--memory','384m','--cpus','0.5','--cap-drop','ALL',
          '--security-opt','no-new-privileges:true','--env-file',str(pg_env),'--mount','type=bind,src='+str(ROOT/'backup-tools/postgres-root.crt')+',dst=/run/postgres-root.crt,readonly',
          backup['clientImage'],'psql','-XqAt','-v','ON_ERROR_STOP=1']
    script=(ROOT/('supabase-compatibility-'+canary['candidateRevision'][:8])/'source/scripts/supabase-refresh-rehearsal.ts').read_text()
    guard=script.split('const guardSql=`',1)[1].split('`;',1)[0]
    sql="SET timezone='UTC';SET extra_float_digits=3;"+guard+"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout='2min';SELECT pg_temp.verify_rehearsal_backup('"+json.dumps(guarded,separators=(',',':')).replace("'","''")+"'::jsonb);COMMIT;"
    def fingerprints():
        result=subprocess.run(pg,input=sql,text=True,capture_output=True)
        (run/'fingerprint-diagnostics.log').write_text(result.stderr)
        if result.returncode:raise RuntimeError('Protected rows differ from their verified backup')
    name='meldiq-production-preflight-'+args.revision[:8]
    created=False
    report={'ok':False,'observedAt':datetime.datetime.now(datetime.UTC).isoformat(),'runtimeRevision':args.revision,
            'productionChanged':False,'customerIngressChanged':False,'realProductionSettings':True,'copiedWritableDataDirectory':True,
            'actualMediaMountedReadOnly':True,'phase':'fingerprints-before-startup','sourceSha256':acceptance['sourceSha256']}
    try:
        fingerprints();report['protectedRowsMatchBeforeStartup']=True
        args_run=['docker','run','-d','--name',name,'--label','meldiq.migration.owner='+name,'--no-healthcheck',
                  '--memory','768m','--cpus','1','--pids-limit','256','--network','griip-internal-messaging_default',
                  '--env-file',str(env),'--mount','type=bind,src='+str(data)+',dst=/data',
                  '--mount','type=bind,src='+str(accepted)+',dst=/run/meldiq-db/acceptance.json,readonly',
                  '--mount','type=bind,src='+str(ROOT/'backup-tools/postgres-root.crt')+',dst=/run/meldiq-db/root.crt,readonly']
        for item in original['Mounts']:
            if item['Destination']=='/host-metrics':args_run+=['--mount','type=bind,src='+item['Source']+',dst=/host-metrics,readonly']
        for source_file,destination in extra_files:
            args_run+=['--mount','type=bind,src='+str(source_file)+',dst='+destination+',readonly']
        for folder in ['attachments','profile-photos']:
            if (source_data/folder).is_dir():args_run+=['--mount','type=bind,src='+str(source_data/folder)+',dst=/data/'+folder+',readonly']
        command(args_run+[image_receipt['image']]);created=True;report['phase']='held-startup'
        ready=False
        for _ in range(45):
            if not inspection(name)['State']['Running']:break
            probe=subprocess.run(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:8080/healthz').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"],capture_output=True,text=True)
            if probe.returncode==0:
                report['health']=json.loads(probe.stdout);ready=True;break
            time.sleep(2)
        if not ready:raise RuntimeError('Production-config API did not become ready')
        status=command(['docker','exec',name,'node','dist/admin.js','database-cutover-status'],text=True)
        report['cutover']=json.loads(status.stdout)
        if not report['cutover']['held'] or report['cutover']['activationDurable'] or (data/'database-authority.json').exists():
            raise RuntimeError('Preflight must remain held and unactivated')
        stats=subprocess.run(['docker','exec',name,'node','dist/admin.js','stats'],capture_output=True,text=True)
        (run/'operator-stats.log').write_text(stats.stdout+stats.stderr)
        if stats.returncode:raise RuntimeError('Real-config operator statistics failed')
        info=command(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:8080/v1/server-info').then(async r=>console.log(await r.text())).catch(()=>process.exit(1))"],text=True)
        (run/'server-info.json').write_text(info.stdout)
        fingerprints();report['protectedRowsUnchangedAfterStartup']=True
        if inspection(API)['Id']!=original['Id'] or not inspection(API)['State']['Running']:
            raise RuntimeError('Active Atlas API changed during preflight')
        report['phase']='complete';report['ok']=True
    except Exception as error:
        report['errorType']=type(error).__name__
        report['reason']=str(error) if isinstance(error,RuntimeError) else 'preflight step stopped'
    finally:
        if created:
            logs=subprocess.run(['docker','logs',name],capture_output=True)
            (run/'api.log').write_bytes(logs.stdout+logs.stderr)
            if inspection(name)['Config']['Labels'].get('meldiq.migration.owner')==name:
                subprocess.run(['docker','stop','--time','30',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                subprocess.run(['docker','rm',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        pg_env.unlink(missing_ok=True)
        report['completedAt']=datetime.datetime.now(datetime.UTC).isoformat();report['runDirectory']=str(run)
        (run/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
    if not report['ok']:raise SystemExit(1)


if __name__=='__main__':main()
