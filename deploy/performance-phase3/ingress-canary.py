"""Install/reverse the opt-in production ingress independently of the messaging writer."""
import argparse,datetime,fcntl,hashlib,json,os,pathlib,secrets,shutil,subprocess,time,urllib.request
from contextlib import ExitStack
root=pathlib.Path('/opt/griip-internal-messaging/releases/phase3-ingress')
site=pathlib.Path('/etc/nginx/sites-enabled/meldiq-msg.conf').resolve()
writer='griip-internal-messaging-api-1'
original='sha256:9bb580a8be7a5f2823cd0b9a1ad95bed65291389321658d29124feebe321ba5c'
name='meldiq-phase3-ingress-canary'
port=18087
def run(*c,input=None):return subprocess.check_output(c,input=input,stderr=subprocess.PIPE).decode()
def writer_ok():
 s=json.loads(run('docker','inspect',writer))[0]
 if s['Image']!=original or s['State']['Health']['Status']!='healthy':raise RuntimeError('production writer differs')
 return s['State']['StartedAt']
def sha(b):return hashlib.sha256(b).hexdigest()
def put(path,data):
 tmp=path.with_name(path.name+'.phase3.tmp');tmp.write_bytes(data);shutil.copystat(path,tmp);os.replace(tmp,path)
def get(url,headers={}):
 return json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=4).read())
def status():
 return json.loads(run('curl','--max-time','2','--fail','-s','--unix-socket',str(root/'control/handoff.sock'),'http://localhost/state'))
def nginx(raw):
 before=site.read_bytes();put(site,raw)
 try:run('nginx','-t');run('systemctl','reload','nginx')
 except BaseException:
  put(site,before);run('nginx','-t');run('systemctl','reload','nginx');raise
def render(original,key):
 old=b'        proxy_pass http://127.0.0.1:18080;'
 if original.count(old)!=1 or b'meldiq_p3_origin' in original:raise RuntimeError('nginx config drift')
 mapping=('map $http_x_meldiq_release_probe $meldiq_p3_origin {\n    default 127.0.0.1:18080;\n    ~^'+key+'$ 127.0.0.1:18087;\n}\n').encode()
 return mapping+original.replace(old,b'        proxy_set_header X-Meldiq-Release-Probe "";\n        proxy_pass http://$meldiq_p3_origin;')
def start_sidecar(checkpoint,digest,code,control):
  run('docker','run','-d','--name',name,'--label','meldiq.phase3.ingress='+digest,'--network','host','--restart','unless-stopped','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','96','--memory','192m','--cpus','0.75','--user','1000:1000','--no-healthcheck','-e','WRITER_PORT=18080','-e','FRONT_PORT=18087','-e','INGRESS_CANARY_ONLY=1','--mount','type=bind,src='+str(code)+',dst=/app/handoff.mjs,readonly','--mount','type=bind,src='+str(control)+',dst=/control','--entrypoint','node',original,'/app/handoff.mjs')
  for trial in range(30):
   try:
    if get('http://127.0.0.1:18087/healthz')['ok'] and status()['state']=='open':break
   except Exception:pass
   time.sleep(.25)
  else:raise RuntimeError('Private ingress did not become healthy')
def main(mode):
 os.umask(0o077);start=writer_ok();raw=site.read_bytes()
 checkpoint=root/'nginx.before';keyfile=root/'cohort';code=root/'handoff.mjs'
 if mode=='prepare':
  if checkpoint.exists() or keyfile.exists():raise RuntimeError('canary already prepared')
  if run('ss','-Hlt','sport','=',':18087').strip():raise RuntimeError('port already allocated')
  control=root/'control';control.mkdir(exist_ok=False);os.chown(control,1000,1000);control.chmod(0o700)
  checkpoint.write_bytes(raw);keyfile.write_text(secrets.token_hex(24))
  source=code.read_bytes();receipt={'sourceSha256':sha(source),'beforeSha256':sha(raw),'writerImage':original,'writerStart':start}
  (root/'pins.json').write_text(json.dumps(receipt));digest=receipt['sourceSha256']
  start_sidecar(checkpoint,digest,code,control)
  print(json.dumps({**receipt,'privateHealth':True,'publicChanged':False}));return
 pins=json.loads((root/'pins.json').read_text());old=checkpoint.read_bytes();new=render(old,keyfile.read_text())
 if sha(old)!=pins['beforeSha256'] or sha(code.read_bytes())!=pins['sourceSha256'] or start!=pins['writerStart']:raise RuntimeError('checkpoint drift')
 if mode=='restage':
  if raw!=old:raise RuntimeError('predecessor config required')
  if not get('http://127.0.0.1:18080/healthz')['ok'] or get('http://127.0.0.1:18080/v1/server-info')['maintenance']['enabled']:raise RuntimeError('writer unhealthy or in maintenance')
  if run('ss','-Hlt','sport','=',':18087').strip():raise RuntimeError('canary port is in use')
  start_sidecar(checkpoint,pins['sourceSha256'],code,root/'control')
  print(json.dumps({'restaged':True,'publicChanged':False,'writerStart':start}));return
 if mode=='retire':
  st=status()
  if raw!=old or any(st[k] for k in ['active','waiting','peers']):raise RuntimeError('canary is selected or still in use')
  v=json.loads(run('docker','inspect',name))[0]
  if v['Config']['Labels'].get('meldiq.phase3.ingress')!=pins['sourceSha256']:raise RuntimeError('container drift')
  run('docker','rm','-f',name)
  print(json.dumps({'retired':True,'nginxSha256':sha(raw),'writerStart':start,'ingress':st}));return
 if mode=='check':
  print(json.dumps({'present':raw==new,'predecessor':raw==old,'writerStart':start,'ingress':status()}));return
 if mode=='activate':
  if raw!=old or status()['state']!='open' or get('http://127.0.0.1:18080/v1/server-info')['maintenance']['enabled']:raise RuntimeError('activation drift')
  nginx(new)
  try:
   before=status()['dispatched'];route='https://msg.meldiq.app/healthz'
   for trial in range(12):
    if get(route,{'X-Meldiq-Release-Probe':keyfile.read_text()})['ok'] and status()['dispatched']>before:break
    time.sleep(.25)
   else:raise RuntimeError('opt-in routing failed')
   before=status()['dispatched']
   if not get(route)['ok'] or status()['dispatched']!=before:raise RuntimeError('normal route escaped cohort')
  except BaseException:nginx(old);raise
 elif mode=='rollback':
  if raw!=new:raise RuntimeError('rollback drift')
  nginx(old)
 else:raise RuntimeError('unsupported mode')
 assert writer_ok()==start
 print(json.dumps({'mode':mode,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'writerStart':start,'writerImage':original,'nginxSha256':sha(site.read_bytes()),'canary':mode=='activate'}))
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','activate','rollback','check','restage','retire']);a=parser.parse_args()
 with ExitStack() as stack:
  for filename in ['/run/lock/meldiq-production-release.lock','/run/lock/meldiq-api-release.lock']:
   lock=stack.enter_context(open(filename,'a+'));fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  main(a.mode)
