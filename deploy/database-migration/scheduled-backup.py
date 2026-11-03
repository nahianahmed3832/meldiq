#!/usr/bin/env python3
"""Select the encrypted backup implementation from the active database authority."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args, forwarded = parser.parse_known_args()
if any(value != '--under-migration-lock' for value in forwarded):
    raise SystemExit('Unsupported scheduled backup option')
base = Path(__file__).resolve().parent
inspection = json.loads(subprocess.check_output(['docker', 'inspect', 'griip-internal-messaging-api-1']))[0]
environment = dict(value.split('=', 1) for value in inspection['Config']['Env'] if '=' in value)
mode = environment.get('DATABASE_MODE')
if mode == 'atlas':
    script = base / 'scheduled-atlas-backup.py'
elif mode == 'supabase':
    if forwarded:
        raise SystemExit('PostgreSQL snapshots must use their own verified release-lock procedure')
    script = base / 'scheduled-postgres-backup.py'
else:
    raise SystemExit('Unknown database authority; no incomplete fallback backup was created')
if not script.is_file() or script.is_symlink():
    raise SystemExit('Verified backup implementation is missing')
if args.check:
    print(json.dumps({'ok': True, 'databaseMode': mode, 'implementation': script.name, 'backupStarted': False}))
else:
    os.execv(sys.executable, [sys.executable, str(script), *forwarded])
