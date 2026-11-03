#!/usr/bin/env python3
"""Source freeze and pre-activation recovery. Never deletes a database or changes RTC."""
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
import urllib.request

BASE = Path('/opt/griip-internal-messaging')
API = 'griip-internal-messaging-api-1'
PROJECT = 'bkvlxbsnzqkhbifawcww'
os.umask(0o077)


def inspect():
    return json.loads(subprocess.check_output(['docker', 'inspect', API]))[0]


def private(file):
    stat = file.lstat()
    if not file.is_file() or file.is_symlink() or stat.st_mode & 0o077:
        raise RuntimeError('Private regular file required')
    return json.loads(file.read_text())


def release(run):
    receipt = private(run / 'release-lock-held.json')
    lock = Path('/run/lock/meldiq-production-release.lock')
    if receipt['runDirectory'] != str(run) or (run / 'release-lock.done').exists():
        raise RuntimeError('Release lock does not identify this run')
    os.kill(receipt['pid'], 0)
    with lock.open('r+') as handle:
        if json.loads(handle.read()) != receipt:
            raise RuntimeError('Release lock owner changed')
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return receipt
        raise RuntimeError('Release lock is no longer held')


def maintenance():
    hosts = ['meldiq-msg.conf', 'griip-message.conf']
    return all('proxy_pass http://127.0.0.1:18082;' in (Path('/etc/nginx/sites-enabled') / name).read_text() for name in hosts)


def frozen(run):
    lock = release(run)
    proof = private(run / 'source-frozen.json')
    current = inspect()
    if (proof['version'] != 1 or proof['runDirectory'] != str(run) or proof['lockPid'] != lock['pid'] or
            current['Id'] != proof['containerId'] or current['Image'] != proof['imageId'] or
            current['State']['Running'] or current['State']['Status'] != 'exited' or not maintenance() or authority(current).exists()):
        raise RuntimeError('Atlas source freeze is not intact')
    return proof


def authority(current):
    mounts = [item for item in current['Mounts'] if item['Destination'] == '/data']
    if len(mounts) != 1:
        raise RuntimeError('Expected retained data volume required')
    return Path(mounts[0]['Source']) / 'database-authority.json'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['preflight', 'freeze', 'status', 'restore-atlas'])
    parser.add_argument('run_directory', type=Path)
    args = parser.parse_args()
    run = args.run_directory
    if run.parent != BASE / 'database-migration' or not re.fullmatch(r'postgres-cutover-\d{8}T\d{6}Z', run.name):
        raise RuntimeError('Owned production cutover directory required')
    current = inspect()
    env = dict(value.split('=', 1) for value in current['Config']['Env'] if '=' in value)
    if args.action == 'preflight':
        with urllib.request.urlopen('http://127.0.0.1:18080/healthz', timeout=5) as response:
            health = json.load(response)
        with urllib.request.urlopen('http://127.0.0.1:18082/v1/server-info', timeout=5) as response:
            responder = json.load(response)
        if (env.get('DATABASE_MODE') != 'atlas' or not current['State']['Running'] or not health.get('ok') or
                not responder.get('maintenance', {}).get('enabled') or authority(current).exists()):
            raise RuntimeError('Healthy Atlas and uncommitted authority required')
        print(json.dumps({'ok': True, 'atlasLive': True, 'maintenanceResponderReady': True,
                          'image': current['Config']['Image'], 'imageId': current['Image'],
                          'runDirectory': str(run), 'productionChanged': False}))
        return
    release(run)
    if args.action == 'status':
        proof = frozen(run)
        print(json.dumps({**proof, 'ok': True, 'verifiedAt': datetime.datetime.now(datetime.UTC).isoformat()}))
        return
    if args.action == 'freeze':
        if (run / 'source-frozen.json').exists() or authority(current).exists() or env.get('DATABASE_MODE') != 'atlas':
            raise RuntimeError('Fresh Atlas cutover run required')
        if not current['State']['Running']:
            raise RuntimeError('Source must be healthy before controlled freeze')
        for name in ['.env', 'compose.yaml']:
            target = run / ('atlas' + name)
            with target.open('xb') as output:
                output.write((BASE / name).read_bytes())
        effective = run / 'atlas-runtime.env'
        if any('\n' in value or '\r' in value for value in current['Config']['Env']):
            raise RuntimeError('Multiline environment requires explicit adapter')
        effective.write_text('\n'.join(current['Config']['Env']) + '\n')
        proof = {'version': 1, 'runDirectory': str(run), 'lockPid': release(run)['pid'],
                 'containerId': current['Id'], 'imageId': current['Image'], 'image': current['Config']['Image'],
                 'sourceDatabaseMode': 'atlas', 'frozenAt': datetime.datetime.now(datetime.UTC).isoformat(),
                 'sourceWritesFrozen': True, 'productionAuthorityChanged': False}
        subprocess.run(['python3', str(BASE / 'database-migration/maintenance-proxy.py'), 'enable', '--run-directory', str(run)], check=True)
        try:
            subprocess.run(['docker', 'stop', '--time', '60', API], check=True, stdout=subprocess.DEVNULL)
            stopped = inspect()
            if stopped['State']['Running'] or stopped['State']['ExitCode'] != 0:
                raise RuntimeError('Source did not stop gracefully')
            (run / 'source-frozen.json').write_text(json.dumps(proof) + '\n')
            frozen(run)
        except BaseException:
            subprocess.run(['docker', 'start', API], check=False, stdout=subprocess.DEVNULL)
            raise
        print(json.dumps({**proof, 'ok': True}))
        return
    if args.action == 'restore-atlas':
        # This file is the authority commit point, including a failed background activation.
        if authority(current).exists():
            raise RuntimeError('PostgreSQL authority committed; retain PostgreSQL and repair/roll back its application')
        private(run / 'source-frozen.json')
        if not maintenance():
            raise RuntimeError('Maintenance must remain enabled during pre-activation recovery')
        subprocess.run(['docker', 'stop', '--time', '60', API], check=False, stdout=subprocess.DEVNULL)
        for name in ['.env', 'compose.yaml']:
            source = run / ('atlas' + name)
            stat = source.lstat()
            if not source.is_file() or source.is_symlink() or stat.st_mode & 0o077:
                raise RuntimeError('Private original configuration required')
            shutil.copyfile(source, BASE / name)
            os.chmod(BASE / name, 0o600)
        subprocess.run(['docker', 'compose', '-p', 'griip-internal-messaging', '-f', str(BASE / 'compose.yaml'), 'config', '-q'], check=True)
        subprocess.run(['docker', 'compose', '-p', 'griip-internal-messaging', '-f', str(BASE / 'compose.yaml'), 'up', '-d', '--no-deps', 'api'], check=True, capture_output=True)
        print(json.dumps({'ok': True, 'atlasRestored': True, 'maintenanceStillEnabled': True,
                          'manualHealthVerificationRequiredBeforeIngress': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'errorType': type(error).__name__, 'reason': str(error) if isinstance(error, RuntimeError) else 'cutover step stopped'}))
        raise SystemExit(1)
