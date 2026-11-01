#!/usr/bin/env python3
"""Host-side encrypted Atlas/configuration backup, installed with a systemd timer.

The private restore key is outside the backup directory. Completed snapshots are
decrypted through a checksum verifier before their manifest is atomically committed.
No automatic deletion or rotation of original databases or backups is performed.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

os.umask(0o077)
release = open('/run/lock/meldiq-production-release.lock', 'a+')
try:
    fcntl.flock(release, fcntl.LOCK_SH | fcntl.LOCK_NB)
except BlockingIOError:
    print(json.dumps({'skipped': True, 'reason': 'production release in progress'}))
    sys.exit(0)
exclusive = open('/run/lock/meldiq-backup.lock', 'a+')
fcntl.flock(exclusive, fcntl.LOCK_EX | fcntl.LOCK_NB)
base = Path('/opt/griip-internal-messaging')
operator = base / 'database-migration/backup-tools'
recovery = Path('/root/.config/meldiq-recovery')
stamp = datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ')
destination = Path('/var/backups/meldiq') / stamp
destination.mkdir(mode=0o700)
api = 'griip-internal-messaging-api-1'
inspection = json.loads(subprocess.run(['docker', 'inspect', api], capture_output=True, check=True).stdout)[0]
environment = dict(value.split('=', 1) for value in inspection['Config']['Env'] if '=' in value)
if environment.get('DATABASE_MODE') != 'atlas' or len(set(environment.get('MONGODB_DOMAINS', '').split(','))) != 16:
    raise SystemExit('Scheduled Atlas backup requires the verified all-domain deployment')
data_dir = Path(environment.get('DATA_DIR', '/data'))
federation_dir = Path(environment.get('FEDERATION_KEY_DIR', str(data_dir/'federation')))
def sidecar(network, configured=False):
    command = ['docker', 'run', '--rm', '--no-healthcheck', '-i', '--read-only',
               '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--memory', '384m', '--cpus', '0.5',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', network]
    if configured:
        command += ['--env-file', str(base/'.env')]
    return command + [inspection['Image'], 'node', '--max-old-space-size=256', '--input-type=module']

def encrypt(command, name, code=None):
    incoming = subprocess.Popen(command, stdin=subprocess.PIPE if code else subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    outgoing = subprocess.Popen(['age', '-R', str(recovery/'recipient.txt'), '-o', str(destination/name)],
                                stdin=incoming.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    incoming.stdout.close()
    if code:
        incoming.stdin.write(code)
        incoming.stdin.close()
    encrypted = outgoing.wait()
    original = incoming.wait()
    if encrypted or original:
        raise RuntimeError('Incomplete encrypted backup: '+name)

try:
    encrypt(sidecar('griip-internal-messaging_default', True), 'atlas.ejson.gz.age',
            (operator/'database-backup.mjs').read_bytes())
    for path, name in [(base/'.env', 'deployment.env.age'), (base/'compose.yaml', 'compose.yaml.age'),
                       (base/'database-migration/.env.redis', 'redis.env.age')]:
        encrypt(['cat', str(path)], name)
    encrypt(['docker', 'exec', api, 'cat', str(data_dir/'reports.key')], 'reports.key.age')
    # Federation is disabled in the verified production baseline; preserve a key if later enabled.
    exists = subprocess.run(['docker', 'exec', api, 'test', '-d', str(federation_dir)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if exists:
        encrypt(['docker', 'exec', api, 'tar', '-czf', '-', '-C', str(federation_dir.parent), federation_dir.name], 'federation.keys.tar.gz.age')
    decrypted = subprocess.Popen(['age', '-d', '-i', str(recovery/'20261101T174639Z.agekey'), str(destination/'atlas.ejson.gz.age')],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    verified = subprocess.run(sidecar('none') + ['-e', (operator/'verify-backup.mjs').read_text()], stdin=decrypted.stdout,
                             capture_output=True, check=False)
    decrypted.stdout.close()
    if decrypted.wait() or verified.returncode:
        raise RuntimeError('Encrypted backup verification failed')
    verification = json.loads(verified.stdout)
    if not verification.get('verified'):
        raise RuntimeError('Backup verification rejected')
    manifest = {'capturedAt': stamp, 'complete': True, 'authority': 'Atlas', 'encrypted': True,
                'verification': verification, 'restoreKeyAccount': '20261101T174639Z',
                'files': [{'name': p.name, 'bytes': p.stat().st_size,
                           'sha256': hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()}
                          for p in sorted(destination.glob('*.age'))]}
    temporary = destination/'manifest.tmp'
    temporary.write_text(json.dumps(manifest, indent=2)+'\n')
    temporary.replace(destination/'manifest.json')
    print(json.dumps({'complete': True, 'capturedAt': stamp, **verification}), flush=True)
except Exception as error:
    print(json.dumps({'complete': False, 'errorType': type(error).__name__, 'capturedAt': stamp}), flush=True)
    sys.exit(1)
