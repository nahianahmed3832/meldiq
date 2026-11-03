"""Run a bounded lab only. Never rotates a service or touches a live data volume."""
import datetime,fcntl,json,os,pathlib,subprocess,sys,urllib.request
from contextlib import ExitStack
lab=pathlib.Path('/opt/griip-internal-messaging/releases/phase3-lab'); lab=lab.resolve(strict=True)
reserve=sys.argv[1:]==['--reserve']
if sys.argv[1:] not in ([],['--reserve']):raise SystemExit('use --reserve or no arguments')
out=lab/('normal-reserved.json' if reserve else 'normal-entry.json')
if out.exists():raise SystemExit('receipt already exists; archive it explicitly before a distinct run')
with open('/run/lock/meldiq-phase3-lab.lock','a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 for n in ('griip-internal-messaging-api-1','griip-internal-messaging-redis-1'):
  s=json.loads(subprocess.check_output(['docker','inspect',n]))[0]
  if not s['State']['Running']:raise SystemExit('service is not running')
  if n.endswith('api-1') and (s['Image']!='sha256:9bb580a8be7a5f2823cd0b9a1ad95bed65291389321658d29124feebe321ba5c' or s['State']['Health']['Status']!='healthy'):raise SystemExit('writer drift')
 if json.load(urllib.request.urlopen('http://127.0.0.1:18080/v1/server-info',timeout=5))['maintenance']['enabled']:raise SystemExit('maintenance active')
 if int(next(l for l in open('/proc/meminfo') if l.startswith('MemAvailable:')).split()[1])<2900000 or subprocess.check_output(['docker','ps','--filter','name=ph3-','-q']).strip():raise SystemExit('insufficient isolated lab capacity')
 p=subprocess.run(['nice','-n','10','python3',lab/'fixtures/rehearse.py','--rtt','168','--warm','--fast','--scaled','--failure','--calibrate','--preflight','--warm-pool','--normal',*(['--reserve'] if reserve else []),'--output',out])
 raise SystemExit(p.returncode)
