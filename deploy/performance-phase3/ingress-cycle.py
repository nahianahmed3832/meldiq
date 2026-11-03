"""One private cohort, on the unchanged writer. Always restore original routing."""
import argparse,json,subprocess,time,pathlib,os,tempfile
p=argparse.ArgumentParser();p.add_argument('status_root',type=pathlib.Path);p.add_argument('output',type=pathlib.Path);a=p.parse_args();root=a.status_root.resolve();a.output=a.output.resolve()
src=pathlib.Path(__file__).resolve().parent
events=[]
def host(command,input=None):return subprocess.check_output(['ssh','-o','BatchMode=yes','root@72.60.107.88',command],input=input,timeout=20)
def mode(k):return json.loads(host('cd /opt/griip-internal-messaging/releases/phase3-ingress && python3 ingress-canary.py '+k))
def wait(d,k,proc):
 end=time.monotonic()+120
 while time.monotonic()<end:
  if (d/k).exists():return
  if (d/'live.json').exists() or proc.poll() is not None:raise RuntimeError('client stopped before '+k)
  time.sleep(.12)
 raise RuntimeError('deadline '+k)
with tempfile.TemporaryDirectory(prefix='meldiq-cohort-') as tmp:
 d=pathlib.Path(tmp);os.umask(0o077)
 state=mode('check');assert state['predecessor'] and state['ingress']['peers']==0 and state['ingress']['active']==0
 (d/'cohort').write_bytes(host('cat /opt/griip-internal-messaging/releases/phase3-ingress/cohort'))
 proc=subprocess.Popen(['node',src/'live-canary.mjs',root,d],stdout=subprocess.DEVNULL)
 try:
  wait(d,'direct-ready',proc)
  for m,target,nextflag in [('activate','activated','request-rollback'),('rollback','rolled-back','request-restore'),('activate','restored','live.json')]:
   events.append(mode(m));(d/target).touch();wait(d,nextflag,proc)
  assert proc.wait(5)==0
 finally:
  if proc.poll() is None:proc.terminate();proc.wait(5)
  state=mode('check')
  if state['present']:events.append(mode('rollback'))
  assert mode('check')['predecessor']
  for i in range(30):
   if mode('check')['ingress']['peers']==0:break
   time.sleep(.2)
  events.append(mode('retire'))
  client=json.loads((d/'live.json').read_text()) if (d/'live.json').exists() else {'completed':False}
  a.output.write_text(json.dumps({'events':events,'client':client},indent=2)+'\n')
  print('cohort:',client.get('completed',False),'messages:',client.get('messages',0),'route restored and ingress retired')
