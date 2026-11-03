"""Toggle only an authenticated canary's HTTP upstream without reloading Nginx workers.
Installation and final retirement are separate, digest-checked changes outside the sampled window."""
import contextlib,fcntl,hashlib,importlib.util,json,os,pathlib,re,stat,sys,time
def render(old,key,flag,direct=18080,canary=18087):
 if not re.fullmatch('[0-9a-f]{48}',key) or not re.fullmatch(r'/[a-zA-Z0-9_./-]+',str(flag)):raise ValueError('invalid release gate')
 token=f'        proxy_pass http://127.0.0.1:{direct};'.encode()
 if old.count(token)!=1 or b'meldiq_p3_origin' in old:raise ValueError('unknown ingress predecessor')
 switch=f'''map $http_x_meldiq_release_probe $meldiq_p3_gatefile {{
    default /dev/null;
    ~^{key}$ {flag};
}}
'''.encode()
 location=f'''        set $meldiq_p3_origin 127.0.0.1:{direct};
        if (-f $meldiq_p3_gatefile) {{ set $meldiq_p3_origin 127.0.0.1:{canary}; }}
        proxy_set_header X-Meldiq-Release-Probe "";
        proxy_pass http://$meldiq_p3_origin;'''.encode()
 return switch+old.replace(token,location)
def generation():
 master=int(pathlib.Path('/run/nginx.pid').read_text());pids=pathlib.Path(f'/proc/{master}/task/{master}/children').read_text().split()
 live=sorted(p for p in pids if pathlib.Path(f'/proc/{p}/cmdline').exists() and pathlib.Path(f'/proc/{p}/cmdline').read_bytes().strip(b'\0')==b'nginx: worker process')
 if not live:raise RuntimeError('no active nginx workers')
 return hashlib.sha256(','.join(live).encode()).hexdigest()[:16]
def main(mode):
 os.environ['MELDIQ_PHASE3_CHECKPOINT']='verified-v1'
 spec=importlib.util.spec_from_file_location('cohort',pathlib.Path(__file__).with_name('ingress-canary.py'))
 m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 start=m.writer_ok();pins=json.loads((m.root/'pins.json').read_text());old=(m.root/'nginx.before').read_bytes();key=(m.root/'cohort').read_text().strip()
 if start!=pins['writerStart'] or m.sha(old)!=pins['beforeSha256'] or m.sha((m.root/'handoff.mjs').read_bytes())!=pins['sourceSha256']:raise RuntimeError('identity or source drift')
 raw=m.site.read_bytes();gate=pathlib.Path('/run/meldiq-phase3-private-cohort');flag=gate/'enabled';static=render(old,key,flag)
 if mode=='install':
  if raw!=old or m.get('http://127.0.0.1:18080/v1/server-info')['maintenance']['enabled']:raise RuntimeError('not eligible')
  gate.mkdir(mode=0o755,exist_ok=True)
 st=gate.lstat()
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise RuntimeError('unsafe gate')
 if flag.exists() or flag.is_symlink():
  fs=flag.lstat()
  if not stat.S_ISREG(fs.st_mode) or fs.st_uid!=0 or fs.st_mode&0o022 or flag.read_text()!=pins['sourceSha256']:raise RuntimeError('unexpected gate')
 if mode=='install':
  if flag.exists() or m.status()['peers']!=0:raise RuntimeError('gate busy')
  m.nginx(static)
  print(json.dumps(dict(installed=True,dormant=True,sourceSha256=pins['sourceSha256'],writerStart=start,nginxSha256=m.sha(static))));return
 if raw!=static:raise RuntimeError('canary config drift')
 if mode=='check':
  print(json.dumps(dict(present=flag.exists(),predecessor=not flag.exists(),configInstalled=True,writerStart=start,ingress=m.status())));return
 if mode=='retire':
  state=m.status()
  if flag.exists() or any(state[k] for k in ['active','waiting','peers']):raise RuntimeError('busy')
  m.nginx(old);m.main('retire');return
 if mode not in ('activate','rollback') or (mode=='activate')==flag.exists():raise RuntimeError('invalid gate transition')
 before=generation()
 if mode=='activate':
  if m.get('http://127.0.0.1:18080/v1/server-info')['maintenance']['enabled'] or m.status()['state']!='open':raise RuntimeError('not eligible')
  fd=os.open(flag,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o644)
  try:os.write(fd,pins['sourceSha256'].encode())
  finally:os.close(fd)
 else:flag.unlink()
 try:
  route='https://msg.meldiq.app/healthz';n=m.status()['dispatched']
  if not m.get(route,{'X-Meldiq-Release-Probe':key})['ok'] or (m.status()['dispatched']>n)!=(mode=='activate'):raise RuntimeError('cohort routing failed')
  n=m.status()['dispatched']
  if not m.get(route)['ok'] or m.status()['dispatched']!=n:raise RuntimeError('default routing drift')
  if m.writer_ok()!=start or before!=generation():raise RuntimeError('worker generation changed')
 except BaseException:
  if mode=='activate':flag.unlink(missing_ok=True)
  raise
 print(json.dumps(dict(mode=mode,at=time.time(),writerStart=start,canary=flag.exists(),nginxSha256=m.sha(raw),workerGeneration=before,nginxReloaded=False)))
if __name__=='__main__':
 with contextlib.ExitStack() as stack:
  for name in ['meldiq-production-release','meldiq-api-release']:
   lock=stack.enter_context(open('/run/lock/'+name+'.lock','a+'));fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  main(sys.argv[1])
