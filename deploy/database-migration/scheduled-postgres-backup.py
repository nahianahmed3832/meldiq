#!/usr/bin/env python3
"""Read-only, consistent PostgreSQL snapshot, encrypted before leaving its pipe.

Uses a pinned official PostgreSQL 17 client image. Never restores into the source,
prints credentials/rows, creates a plaintext dump, or deletes older backups.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit, unquote

PROJECT = 'bkvlxbsnzqkhbifawcww'
BASE = Path('/opt/griip-internal-messaging')
TOOLS = BASE / 'database-migration/backup-tools'
RECOVERY = Path('/root/.config/meldiq-recovery')
API = 'griip-internal-messaging-api-1'
SCHEMAS = ['auth', 'meldiq', 'meldiq_private', 'supabase_migrations']
os.umask(0o077)


def private_json(file):
    stat = file.lstat()
    if not file.is_file() or file.is_symlink() or stat.st_mode & 0o077:
        raise RuntimeError('Private configuration file required')
    return json.loads(file.read_text())


def quote(identifier):
    if not re.fullmatch('[a-z_][a-z0-9_]*', identifier):
        raise RuntimeError('Unexpected schema identifier')
    return '"' + identifier + '"'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rehearsal', action='store_true', help='Read the approved Frankfurt destination while Atlas remains authoritative')
    args = parser.parse_args()
    release = open('/run/lock/meldiq-production-release.lock', 'a+')
    try:
        fcntl.flock(release, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({'skipped': True, 'reason': 'production release in progress'}))
        return
    lock = open('/run/lock/meldiq-backup.lock', 'a+')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    config = private_json(TOOLS / 'postgres-backup.json')
    endpoint = urlsplit(config['databaseUrl'])
    if (config.get('projectRef') != PROJECT or endpoint.scheme not in ['postgres', 'postgresql'] or
            endpoint.hostname != 'aws-1-eu-central-1.pooler.supabase.com' or endpoint.port != 5432 or
            endpoint.path != '/postgres' or endpoint.query or endpoint.fragment or
            unquote(endpoint.username or '') != 'postgres.' + PROJECT or not endpoint.password):
        raise RuntimeError('Only the approved Frankfurt backup source is permitted')
    image = config.get('clientImage', '')
    if not re.fullmatch(r'postgres@sha256:[a-f0-9]{64}', image):
        raise RuntimeError('Pinned official PostgreSQL client image required')
    ca = TOOLS / 'postgres-root.crt'
    if not ca.is_file() or ca.is_symlink():
        raise RuntimeError('Verified TLS root certificate required')
    inspection = json.loads(subprocess.check_output(['docker', 'inspect', API]))[0]
    environment = dict(value.split('=', 1) for value in inspection['Config']['Env'] if '=' in value)
    if args.rehearsal:
        if environment.get('DATABASE_MODE') != 'atlas':
            raise RuntimeError('Rehearsal flag is valid only before production database cutover')
    elif environment.get('DATABASE_MODE') != 'supabase' or environment.get('SUPABASE_DATABASE_PROJECT_REF') != PROJECT:
        raise RuntimeError('Production authority does not match the PostgreSQL backup source')
    space = shutil.disk_usage('/var/backups/meldiq')
    if space.free < max(5 * 1024**3, space.total // 10) + 1024**3:
        raise RuntimeError('Disk reserve reached; no backups deleted')
    stamp = datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ')
    destination = Path('/var/backups/meldiq') / stamp
    destination.mkdir(mode=0o700)
    env_file = destination / '.libpq.env'
    values = {'PGHOST': endpoint.hostname, 'PGPORT': '5432', 'PGUSER': unquote(endpoint.username),
              'PGPASSWORD': unquote(endpoint.password), 'PGDATABASE': 'postgres', 'PGSSLMODE': 'verify-full',
              'PGSSLROOTCERT': '/run/postgres-root.crt', 'PGCONNECT_TIMEOUT': '10',
              'PGAPPNAME': 'meldiq-encrypted-backup-readonly',
              'PGOPTIONS': '-c timezone=UTC -c extra_float_digits=3 -c default_transaction_read_only=on -c idle_in_transaction_session_timeout=600000'}
    if any('\n' in value or '\r' in value for value in values.values()):
        raise RuntimeError('Invalid libpq configuration')
    env_file.write_text(''.join(key + '=' + value + '\n' for key, value in values.items()))
    clients = []

    def client(command, configured=True):
        result = ['docker', 'run', '--rm', '--no-healthcheck', '-i', '--read-only', '--user', '65534:65534',
                  '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--memory', '384m', '--cpus', '0.5',
                  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', 'bridge' if configured else 'none']
        if configured:
            result += ['--env-file', str(env_file), '--mount', 'type=bind,src=' + str(ca) + ',dst=/run/postgres-root.crt,readonly']
        return result + [image] + command

    def spawn(command, **kwargs):
        child = subprocess.Popen(command, stderr=subprocess.DEVNULL, **kwargs)
        clients.append(child)
        return child

    def encrypted(command, name):
        incoming = spawn(command, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
        outgoing = spawn(['age', '-R', str(RECOVERY / 'recipient.txt'), '-o', str(destination / name)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
        digest = hashlib.sha256()
        while chunk := incoming.stdout.read(1024 * 1024):
            digest.update(chunk)
            outgoing.stdin.write(chunk)
        incoming.stdout.close()
        outgoing.stdin.close()
        if incoming.wait() or outgoing.wait():
            raise RuntimeError('Incomplete encrypted payload')
        recovered = spawn(['age', '-d', '-i', str(RECOVERY / '20261101T174639Z.agekey'), str(destination / name)], stdout=subprocess.PIPE)
        checksum = hashlib.file_digest(recovered.stdout, 'sha256').digest()
        recovered.stdout.close()
        if recovered.wait() or checksum != digest.digest():
            raise RuntimeError('Encrypted payload did not authenticate and recover exactly')

    try:
        version = subprocess.check_output(client(['pg_dump', '--version'], False), stderr=subprocess.DEVNULL, text=True).strip()
        if not re.match(r'^pg_dump \(PostgreSQL\) 17\.', version):
            raise RuntimeError('PostgreSQL 17 dump tools required')
        snapshot = spawn(client(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

        def sql(query):
            snapshot.stdin.write(query + '\n')
            snapshot.stdin.flush()
            line = snapshot.stdout.readline()
            if not line:
                raise RuntimeError('Read-only snapshot session stopped')
            return json.loads(line)

        state = sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3; SELECT json_build_object('snapshot',pg_export_snapshot(),'version',current_setting('server_version')); ")
        if not re.fullmatch('[A-Fa-f0-9-]+', state['snapshot']) or not state['version'].startswith('17.'):
            raise RuntimeError('Unexpected source snapshot or PostgreSQL version')
        encrypted(client(['pg_dump', '--format=custom', '--no-owner', '--no-acl', '--strict-names', '--lock-wait-timeout=5s',
                          '--snapshot=' + state['snapshot']] + ['--schema=' + schema for schema in SCHEMAS]), 'database.dump.age')
        tables = sql("SELECT coalesce(json_agg(json_build_object('schema',n.nspname,'name',c.relname) ORDER BY n.nspname,c.relname),'[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('auth','meldiq','meldiq_private','supabase_migrations') AND c.relkind IN ('r','p') AND NOT c.relispartition;")
        manifest = []
        for table in tables:
            row = "encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex')"
            sums = ','.join("'s" + str(i) + "',coalesce(sum(('x'||substr(" + row + ',' + str(i * 16 + 1) + ",16))::bit(64)::bigint::numeric),0)::text" for i in range(4))
            value = sql("SELECT json_build_object('count',count(*)::text," + sums + ') FROM ' + quote(table['schema']) + '.' + quote(table['name']) + ' t;')
            manifest.append({**table, 'count': value['count'], 'rowChecksum': hashlib.sha256(json.dumps(value, separators=(',', ':')).encode()).hexdigest()})
        snapshot.stdin.write('COMMIT;\n\\q\n')
        snapshot.stdin.close()
        if snapshot.wait():
            raise RuntimeError('Snapshot session failed')
        # A separate full archive read avoids pg_restore --list's early-exit/EPIPE problem.
        decrypted = spawn(['age', '-d', '-i', str(RECOVERY / '20261101T174639Z.agekey'), str(destination / 'database.dump.age')], stdout=subprocess.PIPE)
        parsed = spawn(client(['pg_restore', '--no-owner', '--no-acl', '--file=/dev/null'], False), stdin=decrypted.stdout, stdout=subprocess.DEVNULL)
        decrypted.stdout.close()
        if parsed.wait() or decrypted.wait():
            raise RuntimeError('Full PostgreSQL dump parsing failed')
        (destination / 'source-manifest.json').write_text(json.dumps({'tables': manifest, 'schemas': SCHEMAS}, indent=2) + '\n')
        encrypted(['cat', str(destination / 'source-manifest.json')], 'source-manifest.json.age')
        for source, name in [(BASE / '.env', 'deployment.env.age'), (BASE / 'compose.yaml', 'compose.yaml.age'),
                             (BASE / 'database-migration/.env.redis', 'redis.env.age'), (TOOLS / 'postgres-backup.json', 'postgres-backup.json.age'),
                             (ca, 'postgres-root.crt.age')]:
            encrypted(['cat', str(source)], name)
        data = environment.get('DATA_DIR', '/data')
        encrypted(['docker', 'exec', API, 'cat', data + '/reports.key'], 'reports.key.age')
        fcm = environment.get('FCM_SERVICE_ACCOUNT_FILE', '').strip()
        if fcm:
            if not Path(fcm).is_absolute() or subprocess.run(['docker', 'exec', API, 'test', '-f', fcm], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
                raise RuntimeError('Configured push service account file is unavailable')
            encrypted(['docker', 'exec', API, 'cat', fcm], 'fcm-service-account.json.age')
        if environment.get('SUPABASE_PRODUCTION_ACCEPTANCE_FILE'):
            encrypted(['docker', 'exec', API, 'cat', environment['SUPABASE_PRODUCTION_ACCEPTANCE_FILE']], 'cutover-acceptance.json.age')
        if subprocess.run(['docker', 'exec', API, 'test', '-f', data + '/database-authority.json'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            encrypted(['docker', 'exec', API, 'cat', data + '/database-authority.json'], 'database-authority.json.age')
        federation = Path(environment.get('FEDERATION_KEY_DIR', data + '/federation'))
        if subprocess.run(['docker', 'exec', API, 'test', '-d', str(federation)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            encrypted(['docker', 'exec', API, 'tar', '-czf', '-', '-C', str(federation.parent), federation.name], 'federation.keys.tar.gz.age')
        # Preserve readable local fallbacks and profile media without copying the obsolete SQLite authority.
        for variable, default, name in [('ATTACHMENT_DIR', data + '/attachments', 'attachments.tar.gz.age'),
                                        ('PROFILE_PHOTO_DIR', data + '/profile-photos', 'profile-photos.tar.gz.age')]:
            folder = Path(environment.get(variable, default))
            if subprocess.run(['docker', 'exec', API, 'test', '-d', str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                encrypted(['docker', 'exec', API, 'tar', '-czf', '-', '-C', str(folder.parent), folder.name], name)
        report = {'capturedAt': stamp, 'complete': True, 'authority': 'Supabase PostgreSQL', 'rehearsal': args.rehearsal,
                  'projectRef': PROJECT, 'encrypted': True, 'allPayloadDecryptionVerified': True,
                  'consistentReadOnlySnapshot': True, 'fullDumpParsingVerified': True, 'independentRestoreVerified': False,
                  'sourceVersion': state['version'], 'dumpVersion': version, 'clientImage': image,
                  'tables': len(manifest), 'rows': sum(int(table['count']) for table in manifest),
                  'apiImage': inspection['Config']['Image'], 'apiImageId': inspection['Image'], 'restoreKeyAccount': '20261101T174639Z',
                  'files': [{'name': file.name, 'bytes': file.stat().st_size, 'sha256': hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()}
                            for file in sorted(destination.glob('*.age'))]}
        temporary = destination / 'manifest.tmp'
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(destination / 'manifest.json')
        print(json.dumps({'complete': True, 'capturedAt': stamp, 'tables': report['tables'], 'rows': report['rows'], 'rehearsal': args.rehearsal}), flush=True)
    finally:
        for child in clients:
            if child.poll() is None:
                child.terminate()
        for child in clients:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
        env_file.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'complete': False, 'errorType': type(error).__name__}), flush=True)
        sys.exit(1)
