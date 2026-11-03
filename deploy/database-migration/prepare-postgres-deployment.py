#!/usr/bin/env python3
"""Prepare/review the API-only PostgreSQL configuration while the Atlas source is frozen."""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit, unquote

os.umask(0o077)
BASE = Path('/opt/griip-internal-messaging')
PROJECT = 'bkvlxbsnzqkhbifawcww'


def load(file):
    stat = file.lstat()
    if not file.is_file() or file.is_symlink() or stat.st_mode & 0o077:
        raise RuntimeError('Private regular configuration required')
    return json.loads(file.read_text())


def atomic(file, content, mode=0o600):
    temporary = file.with_name(file.name + '.pg-prepared')
    with temporary.open('x') as handle:
        os.chmod(temporary, mode)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(file)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('run_directory', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    run = args.run_directory
    if run.parent != BASE / 'database-migration' or not re.fullmatch(r'postgres-cutover-\d{8}T\d{6}Z', run.name):
        raise RuntimeError('Owned cutover run required')
    module = importlib.util.spec_from_file_location('cutover_control', BASE / 'database-migration/cutover-control.py')
    control = importlib.util.module_from_spec(module)
    module.loader.exec_module(control)
    source = control.frozen(run)
    acceptance, settings = load(run / 'acceptance.json'), load(run / 'runtime-settings.json')
    final = load(run / 'final-sync.json')
    if (not final.get('ok') or not final.get('finalFrozenSourceReconciled') or not final.get('allRecordHashesMatch') or
            final.get('tables') != 282 or acceptance.get('sourceSha256') != final.get('afterSourceSha256')):
        raise RuntimeError('Exact final frozen-source reconciliation required')
    if (acceptance.get('version') != 1 or acceptance.get('projectRef') != PROJECT or
            acceptance.get('mode') != 'database-compatibility' or acceptance.get('legacyProtocols') is not True or
            any(acceptance.get(key) is not True for key in ['destinationReconciled','encryptedBackupVerified','rollbackPrepared','operatorAccessVerified']) or
            not re.fullmatch('[a-f0-9]{40}', acceptance.get('runtimeRevision','')) or
            not re.fullmatch('[a-f0-9]{64}', acceptance.get('sourceSha256',''))):
        raise RuntimeError('Verified acceptance required')
    endpoint = urlsplit(settings['databaseUrl'])
    if (settings.get('projectRef') != PROJECT or endpoint.hostname != 'aws-1-eu-central-1.pooler.supabase.com' or
            endpoint.port != 5432 or endpoint.path != '/postgres' or endpoint.query or endpoint.fragment or
            not unquote(endpoint.username or '').startswith('meldiq_staging_runtime.') or
            not unquote(endpoint.username).endswith('.' + PROJECT) or not endpoint.password):
        raise RuntimeError('Approved restricted runtime connection required')
    release = load(BASE / ('database-migration/supabase-compatibility-' + acceptance['runtimeRevision'][:8]) / 'image.json')
    image = json.loads(subprocess.check_output(['docker','image','inspect',release['image']]))[0]
    if (image['Id'] != release['imageId'] or release['revision'] != acceptance['runtimeRevision'] or
            image['Config']['Labels']['org.opencontainers.image.revision'] != acceptance['runtimeRevision']):
        raise RuntimeError('Exact tested image provenance required')
    original_compose = (run / 'atlascompose.yaml').read_text()
    original_env = (run / 'atlas.env').read_text()
    if (BASE / 'compose.yaml').read_text() != original_compose or (BASE / '.env').read_text() != original_env:
        raise RuntimeError('Canonical deployment changed since source freeze')
    start = original_compose.index('  api:\n')
    end = original_compose.index('\n  livekit:', start)
    api = original_compose[start:end]
    if api.count('    image: ') != 1 or api.count('    environment:\n') != 1 or api.count('    volumes:\n') != 1:
        raise RuntimeError('Unexpected API configuration shape')
    api = re.sub(r'(?m)^    image: .+$', '    image: ' + release['image'], api)
    if len(re.findall(r'(?m)^      DATABASE_MODE:', api)) != 1:
        raise RuntimeError('Explicit existing database mode required')
    api = re.sub(r'(?m)^      DATABASE_MODE:.*$', '      DATABASE_MODE: supabase', api)
    keys = ['SUPABASE_DATABASE_URL','SUPABASE_DATABASE_PROJECT_REF','SUPABASE_DATABASE_POOL_SIZE','SUPABASE_DB_CA_FILE','SUPABASE_PRODUCTION_ACCEPTANCE_FILE']
    if any(re.search(r'(?m)^      '+key+':', api) for key in keys):
        raise RuntimeError('Unexpected preexisting PostgreSQL configuration')
    api = api.replace('    environment:\n', '    environment:\n' + ''.join('      '+key+': ${'+key+':?}\n' for key in keys) + '      MONGODB_URI: ""\n')
    api = api.replace('    volumes:\n', '    volumes:\n      - ./database-migration/production-db/root.crt:/run/meldiq-db/root.crt:ro\n      - ./database-migration/production-db/acceptance.json:/run/meldiq-db/acceptance.json:ro\n')
    candidate = original_compose[:start] + api + original_compose[end:]
    values = {'DATABASE_MODE':'supabase','MONGODB_URI':'','SUPABASE_DATABASE_URL':settings['databaseUrl'],
              'SUPABASE_DATABASE_PROJECT_REF':PROJECT,'SUPABASE_DATABASE_POOL_SIZE':'4',
              'SUPABASE_DB_CA_FILE':'/run/meldiq-db/root.crt','SUPABASE_PRODUCTION_ACCEPTANCE_FILE':'/run/meldiq-db/acceptance.json'}
    lines = [line for line in original_env.splitlines() if not any(re.match(r'^(?:export\s+)?'+key+r'\s*=',line) for key in values)]
    if any(any(char in value for char in "\n\r'$\\") for value in values.values()):
        raise RuntimeError('Runtime setting needs explicit environment encoding')
    environment = '\n'.join(lines) + '\n' + ''.join(key+"='"+value+"'\n" for key,value in values.items())
    (run / 'compose.candidate.yaml').write_text(candidate)
    (run / 'env.candidate').write_text(environment)
    common = ['docker','compose','-p','griip-internal-messaging','--project-directory',str(BASE)]
    old = json.loads(subprocess.check_output(common+['-f',str(BASE/'compose.yaml'),'config','--format','json'],stderr=subprocess.DEVNULL))
    new = json.loads(subprocess.check_output(common+['--env-file',str(run/'env.candidate'),'-f',str(run/'compose.candidate.yaml'),'config','--format','json'],stderr=subprocess.DEVNULL))
    for name, service in old['services'].items():
        if name != 'api' and new['services'][name] != service:
            raise RuntimeError('An unrelated service would change')
    old_api,new_api = old['services']['api'],new['services']['api']
    for name,value in old_api['environment'].items():
        if name not in values and new_api['environment'].get(name) != value:
            raise RuntimeError('An existing API integration setting would change')
    for key,value in values.items():
        if str(new_api['environment'].get(key)) != value:
            raise RuntimeError('Rendered API environment differs')
    if new_api['volumes'][:len(old_api['volumes'])] == old_api['volumes']:
        pass
    elif not all(volume in new_api['volumes'] for volume in old_api['volumes']):
        raise RuntimeError('An existing API volume would change')
    expected_keys={'image','environment','volumes'}
    if any(old_api.get(key)!=new_api.get(key) for key in old_api.keys()|new_api.keys() if key not in expected_keys):
        raise RuntimeError('Unexpected API service changes')
    if args.apply:
        control.frozen(run)
        target = BASE/'database-migration/production-db'
        target.mkdir(mode=0o700)
        ca = BASE/'database-migration/backup-tools/postgres-root.crt'
        atomic(target/'root.crt',ca.read_text(),0o644)
        atomic(target/'acceptance.json',json.dumps(acceptance)+'\n',0o400)
        os.chown(target/'acceptance.json',1000,1000)
        atomic(BASE/'.env',environment)
        atomic(BASE/'compose.yaml',candidate)
        subprocess.run(common+['-f',str(BASE/'compose.yaml'),'config','-q'],check=True,capture_output=True)
    print(json.dumps({'ok':True,'applied':args.apply,'changedServices':['api'],'otherIntegrationSettingsPreserved':True,
                      'existingVolumesPreserved':True,'image':release['image'],'projectRef':PROJECT,
                      'sourceStillFrozen':True,'applicationStarted':False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok':False,'errorType':type(error).__name__,'reason':str(error) if isinstance(error,RuntimeError) else 'deployment preparation stopped'}))
        raise SystemExit(1)
