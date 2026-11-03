#!/usr/bin/env python3
"""Host-side synthetic API/load/rollback test in an unpublished, network-isolated PostgreSQL namespace."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

BASE = Path('/opt/griip-internal-messaging/database-migration')
POSTGRES = 'postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'
os.umask(0o077)
parser = argparse.ArgumentParser()
parser.add_argument('--fixtures', type=Path, required=True)
parser.add_argument('--candidate', required=True)
parser.add_argument('--rollback', required=True)
parser.add_argument('--concurrency', type=int, choices=[4, 8], default=4)
args = parser.parse_args()
if not all(re.fullmatch('[a-f0-9]{40}', value) for value in [args.candidate, args.rollback]):
    raise SystemExit('Exact release revisions required')
if args.fixtures.parent != BASE or not args.fixtures.name.startswith('canary-fixtures-'):
    raise SystemExit('Owned fixtures directory required')
stamp = datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ')
run = BASE / ('owned-canary-' + args.candidate[:8] + '-' + stamp)
run.mkdir(mode=0o700)
for directory in ['data', 'control']:
    (run / directory).mkdir(mode=0o700)
    os.chown(run / directory, 1000, 1000)
prefix = 'meldiq-owned-' + args.candidate[:8] + '-' + stamp.lower()
pg, proxy, api, driver = [prefix + '-' + name for name in ['pg', 'lag', 'api', 'client']]
created = []
label = 'meldiq.migration.owner=' + prefix
report = {'ok': False, 'synthetic': True, 'productionChanged': False, 'unpublishedNetworkNamespace': True,
          'candidateRevision': args.candidate, 'rollbackRevision': args.rollback,
          'simulatedDatabaseRoundTripMilliseconds': 168, 'phase': 'setup', 'observedAt': datetime.datetime.now(datetime.UTC).isoformat()}


def command(argv, **kwargs):
    return subprocess.run(argv, check=True, **kwargs)


def image(revision):
    receipt = json.loads((BASE / ('supabase-compatibility-' + revision[:8]) / 'image.json').read_text())
    inspected = json.loads(subprocess.check_output(['docker', 'image', 'inspect', receipt['image']]))[0]
    if receipt['revision'] != revision or receipt['imageId'] != inspected['Id'] or inspected['Config']['Labels']['org.opencontainers.image.revision'] != revision:
        raise RuntimeError('Release image provenance changed')
    return receipt['image']


def start(name, selected, argv, memory, namespace, environment=None, mounts=True):
    invocation = ['docker', 'run', '-d', '--name', name, '--label', label, '--no-healthcheck', '--read-only',
                  '--memory', memory, '--cpus', '1' if name == api else '0.5', '--pids-limit', '128',
                  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', namespace,
                  '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m']
    for key, value in (environment or {}).items():
        invocation += ['-e', key + '=' + value]  # Synthetic loopback settings only; no production credentials.
    if mounts:
        invocation += ['--mount', 'type=bind,src=' + str(args.fixtures) + ',dst=/app/probes,readonly',
                       '--mount', 'type=bind,src=' + str(run / 'control') + ',dst=/control',
                       '--mount', 'type=bind,src=' + str(run / 'data') + ',dst=/data']
    if name == pg:
        invocation += ['--user', '70:70', '--tmpfs', '/var/run/postgresql:rw,nosuid,size=16m,uid=70,gid=70,mode=3775',
                       '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m,uid=70,gid=70,mode=700']
    else:
        invocation += ['--entrypoint', 'node']
    command(invocation + [selected] + argv, stdout=subprocess.DEVNULL, stderr=open(run / (name + '.start.log'), 'wb'))
    created.append(name)


def sql(query):
    return subprocess.check_output(['docker', 'exec', '-i', pg, 'psql', '-U', 'postgres', '-d', 'postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1'], input=query.encode(), stderr=subprocess.DEVNULL).decode().strip()


def wait_file(name, seconds=180):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if (run / 'control' / name).exists():
            return json.loads((run / 'control' / name).read_text())
        if (run / 'control/client-report.json').exists():
            state = json.loads((run / 'control/client-report.json').read_text())
            if not state.get('ok'):
                report['client'] = state
                raise RuntimeError('Synthetic client failed before its checkpoint')
        time.sleep(0.2)
    raise RuntimeError('Owned canary readiness timed out')


def fingerprint():
    tables = ['accounts', 'account_sessions', 'users', 'devices', 'sessions', 'message_events', 'attachments', 'delivery_queue', 'submitted_messages']
    return {table: sql("SELECT count(*)::text||':'||encode(sha256(convert_to(coalesce(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') FROM meldiq.\"" + table + '\" t;') for table in tables}


try:
    candidate, fallback = image(args.candidate), image(args.rollback)
    start(pg, POSTGRES, ['postgres', '-c', 'shared_buffers=64MB', '-c', 'max_connections=30'], '384m', 'none', {'POSTGRES_HOST_AUTH_METHOD': 'trust'}, False)
    end = time.monotonic() + 60
    while time.monotonic() < end:
        if subprocess.run(['docker', 'exec', pg, 'pg_isready', '-U', 'postgres'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('Owned PostgreSQL did not start')
    sql((args.fixtures / 'postgres-bootstrap.sql').read_text())
    for migration in sorted((args.fixtures / 'migrations').glob('*.sql')):
        sql(migration.read_text())
    sql('CREATE ROLE meldiq_canary_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6; GRANT meldiq_api TO meldiq_canary_runtime; ALTER ROLE meldiq_canary_runtime SET search_path=pg_catalog,meldiq;')
    common = {'MELDIQ_OWNED_CANARY': 'synthetic-loopback', 'NODE_ENV': 'development', 'APP_ENV': 'development',
              'DATABASE_MODE': 'supabase', 'SUPABASE_DATABASE_URL': 'postgresql://meldiq_canary_runtime@127.0.0.1:55433/postgres', 'DATA_DIR': '/data'}
    start(proxy, candidate, ['/app/probes/owned-pg-latency.mjs'], '128m', 'container:' + pg, common)
    wait_file('proxy-ready.json')
    report['phase'] = 'candidate-startup-and-hold'
    start(api, candidate, ['/app/probes/owned-api-canary.mjs'], '768m', 'container:' + pg, {**common, 'MELDIQ_CANARY_PHASE': 'candidate'})
    if not wait_file('api-ready.json').get('held'):
        raise RuntimeError('Candidate failed to start held')
    activated = subprocess.check_output(['docker', 'exec', api, 'node', 'dist/admin.js', 'database-cutover-activate', 'a' * 64], stderr=subprocess.DEVNULL)
    if json.loads(activated)['held']:
        raise RuntimeError('Owned candidate did not activate')
    report['activationHoldVerified'] = True
    report['phase'] = 'load-and-post-write-rollback'
    start(driver, candidate, ['/app/probes/owned-client-check.mjs'], '384m', 'container:' + pg, {**common, 'MELDIQ_CANARY_CONCURRENCY': str(args.concurrency)})
    wait_file('ready-for-rollback.json')
    command(['docker', 'stop', '--time', '30', api], stdout=subprocess.DEVNULL)
    before = fingerprint()
    command(['docker', 'rm', api], stdout=subprocess.DEVNULL)
    created.remove(api)
    (run / 'control/api-ready.json').unlink()
    start(api, fallback, ['/app/probes/owned-api-canary.mjs'], '768m', 'container:' + pg, {**common, 'MELDIQ_CANARY_PHASE': 'rollback'})
    wait_file('api-ready.json')
    after = fingerprint()
    if before != after:
        report['changedTablesAtRollback'] = [table for table in before if before[table] != after[table]]
        raise RuntimeError('Compatible rollback changed committed customer records')
    report['customerTableFingerprintsUnchangedAtRollback'] = True
    (run / 'control/rollback-ready.json').write_text('{"ready":true}\n')
    report['client'] = wait_file('client-report.json')
    if not report['client'].get('ok'):
        raise RuntimeError('Post-rollback client checks failed')
    report['pendingNativeFanoutJobs'] = int(sql('SELECT count(*) FROM meldiq_private.outbox;'))
    report['applicationConnections'] = int(sql("SELECT count(*) FROM pg_stat_activity WHERE usename='meldiq_canary_runtime';"))
    if report['pendingNativeFanoutJobs'] or report['applicationConnections'] > 6:
        raise RuntimeError('Compatibility delivery/pool boundary failed')
    report['phase'] = 'complete'
    report['ok'] = True
except Exception as error:
    report['errorType'] = type(error).__name__
finally:
    for name in reversed(created):
        inspection = subprocess.run(['docker', 'inspect', name], capture_output=True)
        if inspection.returncode == 0:
            info = json.loads(inspection.stdout)[0]
            if info['Config']['Labels'].get('meldiq.migration.owner') == prefix:
                subprocess.run(['docker', 'logs', name], stdout=open(run / (name + '.log'), 'wb'), stderr=subprocess.STDOUT)
                subprocess.run(['docker', 'rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    report['ownedContainersRemoved'] = True
    report['completedAt'] = datetime.datetime.now(datetime.UTC).isoformat()
    (run / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
if not report['ok']:
    raise SystemExit(1)
