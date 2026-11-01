#!/usr/bin/env python3
"""Switch only the two API virtual hosts between live and preverified maintenance responders.

No Nginx restart; validate configuration before graceful reload. Never modifies
the RTC hosts, unrelated sites, certificates or active backend data.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['enable', 'disable', 'status'])
parser.add_argument('--run-directory', type=Path, required=True)
args = parser.parse_args()
hosts = [Path('/etc/nginx/sites-enabled/meldiq-msg.conf').resolve(),
         Path('/etc/nginx/sites-enabled/griip-message.conf').resolve()]
live = 'proxy_pass http://127.0.0.1:18080;'
maintenance = 'proxy_pass http://127.0.0.1:18082;'
originals = {p:p.read_text() for p in hosts}
if args.action == 'status':
    print(json.dumps({'maintenance': all(maintenance in s for s in originals.values())}))
    raise SystemExit(0)
lock = json.loads((args.run_directory/'release-lock-held.json').read_text())
os.kill(lock['pid'], 0)
if (args.run_directory/'release-lock.done').exists():
    raise SystemExit('Production release lock is not held')
port = 18082 if args.action == 'enable' else 18080
with urllib.request.urlopen(f'http://127.0.0.1:{port}/v1/server-info',timeout=5) as response:
    info = json.load(response)
if args.action == 'enable' and not info.get('maintenance',{}).get('enabled'):
    raise SystemExit('Maintenance responder has not passed verification')
if args.action == 'disable' and info.get('maintenance',{}).get('enabled'):
    raise SystemExit('Application still reports maintenance')
subprocess.run(['nginx','-t'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
source, destination = (live,maintenance) if args.action == 'enable' else (maintenance,live)
for path, content in originals.items():
    if content.count(live)+content.count(maintenance) != 1:
        raise SystemExit('Unexpected API proxy configuration')
    backup = args.run_directory/(path.name+'.before-maintenance')
    if not backup.exists():
        backup.write_text(content); os.chmod(backup,0o600)

def write(path, content):
    temporary = path.with_name(path.name+'.meldiq-migration-tmp')
    temporary.write_text(content); os.chmod(temporary,0o644);temporary.replace(path)

try:
    for path, content in originals.items():write(path,content.replace(source,destination))
    subprocess.run(['nginx','-t'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
    subprocess.run(['systemctl','reload','nginx'],capture_output=True,check=True)
except BaseException:
    for path, content in originals.items():write(path,content)
    subprocess.run(['nginx','-t'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
    subprocess.run(['systemctl','reload','nginx'],capture_output=True,check=True)
    raise
print(json.dumps({'maintenance':args.action=='enable','apiHostsUpdated':len(hosts),'rtcHostsChanged':False,'nginxRestarted':False}))
