#!/usr/bin/env python3
"""Mirror completed ciphertext bundles from the VPS without deleting either copy."""
import hashlib
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

os.umask(0o077)
root = Path.home()/'.local/share/meldiq-migration/offhost-mirror'
root.mkdir(parents=True, exist_ok=True, mode=0o700)
ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'root@72.60.107.88']
listing = subprocess.run(ssh + ["find /var/backups/meldiq -mindepth 2 -maxdepth 2 -name manifest.json -type f"], capture_output=True)
if listing.returncode:
    (root/'mirror-status.json').write_text(json.dumps({'ok': False, 'reason': 'host unavailable'})+'\n')
    sys.exit(1)
verified = []
for line in listing.stdout.decode().splitlines():
    remote = Path(line)
    stamp = remote.parent.name
    if len(stamp) != 16 or not stamp.endswith('Z') or not stamp.replace('T','').replace('Z','').isdigit():
        continue
    destination = root/stamp
    destination.mkdir(mode=0o700, exist_ok=True)
    manifest = subprocess.run(ssh + ['cat '+str(remote)], capture_output=True, check=True)
    data = json.loads(manifest.stdout)
    # Preparation manifests may lack complete=true, but their files are independently hash checked too.
    for file in data['files']:
        name = file['name']
        if Path(name).name != name or not name.endswith('.age'):
            raise RuntimeError('Unsafe manifest file')
        target = destination/name
        if target.exists() and hashlib.file_digest(target.open('rb'),'sha256').hexdigest() != file['sha256']:
            raise RuntimeError('Refusing to replace an existing off-host backup')
        if not target.exists():
            partial = destination/(name+'.partial')
            subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=10',
                            'root@72.60.107.88:'+str(remote.parent/name),str(partial)],check=True)
            if hashlib.file_digest(partial.open('rb'),'sha256').hexdigest() != file['sha256']:
                raise RuntimeError('Encrypted mirror checksum mismatch')
            partial.replace(target)
    (destination/'manifest.json').write_bytes(manifest.stdout)
    verified.append(stamp)
(root/'mirror-status.json').write_text(json.dumps({'ok':True,'checkedAt':datetime.datetime.now(datetime.UTC).isoformat(),'verifiedBackups':verified})+'\n')
print(json.dumps({'ok':True,'verifiedBackups':len(verified)}))
