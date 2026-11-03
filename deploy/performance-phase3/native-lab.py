"""Loopback-only macOS/Linux rehearsal outside the production machine. Uses compiled Git snapshots.
Arguments: paths to fixture directory, compiled initial/candidate/fallback server directories, destination receipt.
The Docker image rehearsal remains a separate release gate.
"""
import datetime,json,os,pathlib,shutil,signal,socket,subprocess,sys,tempfile,time
from urllib.request import urlopen
from contextlib import ExitStack
src=pathlib.Path(__file__).resolve().parent
fix,old,new,fallback,output=map(lambda a:pathlib.Path(a).resolve(),sys.argv[1:])
assert all((d/'dist/index.js').is_file() for d in (old,new,fallback))
lab=pathlib.Path(tempfile.mkdtemp(prefix='meldiq-handoff-',dir='/tmp'));control=lab/'control';data=lab/'data'
for d in [control,data]:d.mkdir(mode=0o700)
for port in [55431,55433,18087,8080,56379]:
 with socket.socket() as s:s.bind(('127.0.0.1',port))
def run(cmd,inp=None,timeout=90):return subprocess.check_output([str(x) for x in cmd],input=inp,timeout=timeout,stderr=subprocess.PIPE).decode().strip()
jobs={};logs={};pg=False
base={k:v for k,v in os.environ.items() if k in ['PATH','LANG','TMPDIR']}
def launch(label,cmd,cwd,extra={}):
 logs[label]=(lab/(label+'.log')).open('wb')
 jobs[label]=subprocess.Popen([str(x) for x in cmd],cwd=cwd,env={**base,**extra},stdout=logs[label],stderr=subprocess.STDOUT)
 return jobs[label]
def flag(label,value='1'):
 t=control/(label+'.tmp');t.write_text(value);os.replace(t,control/label)
def wait(label,timeout=100):
 start=time.monotonic()
 while not (control/label).exists():
  for k,p in jobs.items():
   if p.poll() not in [None,0] and k not in ['bad']:raise RuntimeError(k+' exited '+str(p.returncode))
  if time.monotonic()-start>timeout:raise RuntimeError('timeout '+label)
  time.sleep(.012)
 return (control/label).read_text()
def sql(s):return run(['psql','-h','127.0.0.1','-p','55431','-U','postgres','-d','postgres','-qXAt','-v','ON_ERROR_STOP=1'],s.encode())
def api(slot,server):
 d=lab/slot;d.mkdir();(d/'node_modules').symlink_to(server/'node_modules',target_is_directory=True)
 files=['handoff.mjs','park.mjs','owned-prepared-api.mjs','owned-pg-wire.mjs','client.mjs','griipClient.mjs','synthetics.mjs','transport.mjs','managed-client.mjs']
 for file in files:
  f=(src/file) if (src/file).exists() else fix/file
  s=f.read_text().replace('/app/dist/',str(server/'dist')+'/').replace('/app/package.json',str(server/'package.json')).replace('/control',str(control)).replace('"/data"',json.dumps(str(data))).replace("port:5432","port:55431")
  (d/file).write_text(s)
 return d
def ctl(cmd,verb='POST'):
 return json.loads(run(['curl','--fail','-sS','--max-time','9','--unix-socket',str(control/'handoff.sock'),'-X',verb,'http://localhost/'+cmd]))
common=dict(NODE_ENV='development',APP_ENV='development',DATABASE_MODE='supabase',SUPABASE_DATABASE_URL='postgresql://meldiq_canary_runtime@127.0.0.1:55433/postgres',MELDIQ_OWNED_CANARY='synthetic-loopback',MELDIQ_CANARY_DATABASE_RTT_MS='168',DATA_DIR=str(data),MELDIQ_CANARY_PHASE='rollback',PREPARE_PAGES='1',PH3_PREFLIGHT='1',PH3_FINAL_READ_FLOOR_MS='4295',REDIS_URL='redis://127.0.0.1:56379',REDIS_PASSWORD='synthetic-fixture-only',REDIS_PRIVATE_NETWORK='true',PH3_MANAGED_GATE='1')
def startslot(k,d,bad=False):
 launch(k,['node','--max-old-space-size=384','park.mjs'],d,{**common,'SLOT':k,**({'SUPABASE_DATABASE_URL':'postgresql://meldiq_canary_runtime@127.0.0.1:55434/postgres'} if bad else {})});wait('parked-'+k)
def ready(k):
 flag('start-'+k);v=json.loads(wait('api-ready.json'));assert v['ready'] and not v['held']
def leases():return int(sql("select count(*) from pg_locks where locktype='advisory' and granted and classid=(hashtextextended('meldiq-rows-writer',0)>>32 & 4294967295)::oid and objid=(hashtextextended('meldiq-rows-writer',0) & 4294967295)::oid"))
stamp=lambda:round(time.time()*1000)
report={'started':stamp(),'ok':False,'runtime':'native dedicated loopback; published source compiled for local architecture, not production Docker images','rttMs':168,'throughputMiBps':12,'snapshotFloorMs':4295,'armedBeforeDrain':True,'switches':[]}
def change(name,pre,suc,inject):
 flag('phase','prepare-'+name);flag('prepare-'+suc);wait('prepared-'+suc)
 assert leases()==1
 flag('phase',name);at=stamp();ctl('drain');drained=stamp()
 flag('challenge-'+name);wait('arrival-'+name,3)
 jobs[pre].send_signal(signal.SIGTERM);assert jobs[pre].wait(8)==0
 assert leases()==0;(control/'api-ready.json').unlink()
 stopped=stamp()
 if inject:
  flag('start-bad');assert jobs['bad'].wait(5)!=0 and not (control/'api-ready.json').exists()
 ready(suc);activated=stamp();assert leases()==1
 ctl('resume');end=stamp()
 report['switches'].append(dict(label=name,admissionHoldMs=end-at,drainMs=drained-at,stopMs=stopped-drained,bootstrapMs=activated-stopped,readyMs=end-activated,forcedInvalidRejected=inject,read=json.loads((control/('floor-'+suc)).read_text())))
 flag('phase','after-'+name);wait('proven-'+name,13)
try:
 prog=pathlib.Path(run(['pg_config','--bindir']));pgdir=lab/'pg'
 run([prog/'initdb','-D',pgdir,'-A','trust','-U','postgres','--encoding','UTF8','--no-locale'])
 run([prog/'pg_ctl','-D',pgdir,'-l',lab/'postgres.log','-o',f'-p 55431 -h 127.0.0.1 -k {lab} -c max_connections=30','-w','start']);pg=True
 sql((fix/'postgres-bootstrap.sql').read_text())
 for f in sorted((fix/'migrations').glob('*.sql')):sql(f.read_text())
 sql("CREATE ROLE meldiq_canary_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6; GRANT meldiq_api TO meldiq_canary_runtime; ALTER ROLE meldiq_canary_runtime SET search_path=pg_catalog,meldiq;")
 sql("""INSERT INTO meldiq.resource_samples SELECT floor(extract(epoch FROM now())/60)::bigint-n/60,'load-'||(n%60),n*.0625 FROM generate_series(0,582239)n;
 INSERT INTO meldiq.delivery_queue(id,recipient_device_id,kind,conversation_id,message_id,sender_user_id,sender_device_id,payload,created_at,expires_at) SELECT n,'idle-device','receipt','idle',n::text,'idle-user','idle-sender',repeat('X',470),1,4000000000000 FROM generate_series(1,47200)n;
 INSERT INTO meldiq.resource_hourly SELECT n/60,'hour-'||(n%60),1.0,0.0,2.0,60 FROM generate_series(0,15599)n;
 INSERT INTO meldiq.presence_samples SELECT n,0,0,0,0,0,0,0,0,0,0,'{}' FROM generate_series(1,15200)n;
 INSERT INTO meldiq.submitted_messages SELECT 'seed-'||n,'seed-device','seed-user','seed-conv',1,1,4000000000000 FROM generate_series(1,5200)n; ANALYZE;""")
 (data/'database-authority.json').write_text(json.dumps({'version':1,'projectRef':'z'*20,'sourceSha256':'a'*64,'activatedAt':'2026-11-03T00:00:00.000Z'}))
 (data/'database-authority.json').chmod(0o600)
 ds={k:api(k,v) for k,v in [('initial',old),('candidate',new),('fallback',fallback),('bad',new)]}
 launch('redis',['redis-server','--bind','127.0.0.1','--port','56379','--save','','--appendonly','no','--requirepass','synthetic-fixture-only'],lab)
 launch('lag',['node','owned-pg-wire.mjs'],ds['initial'],common);wait('proxy-ready.json')
 startslot('initial',ds['initial']);ready('initial');startslot('candidate',ds['candidate']);startslot('fallback',ds['fallback']);startslot('bad',ds['bad'],True)
 launch('front',['node','handoff.mjs'],ds['initial'],common)
 launch('driver',['node','client.mjs'],ds['initial'],common);wait('managed-ready')
 before=ctl('state','GET')
 try:ctl('drain')
 except subprocess.CalledProcessError as err:
  assert err.returncode==22
 else:raise RuntimeError('managed session would have been detached')
 after=ctl('state','GET')
 assert before['generation']==after['generation']==0 and after['state']=='open' and after['peers']==before['peers'] and after['peers']>=3 and leases()==1
 report['managedVeto']={'samePeers':after['peers'],'writerLease':1,'state':'open','generation':0}
 flag('managed-vetoed');wait('client-ready')
 time.sleep(2);change('rollout','initial','candidate',False);time.sleep(4)
 change('rollback','candidate','fallback',True);time.sleep(4)
 flag('finish');report['client']=json.loads(wait('client-report.json'));report['front']=ctl('state','GET')
 db={k:int(sql(q)) for k,q in dict(events='select count(*) from meldiq.message_events',distinctIds='select count(distinct id) from meldiq.message_events',markers="select count(*) from meldiq.submitted_messages where message_id not like 'seed-%'",pending="select count(*) from meldiq.delivery_queue where kind='message'").items()};db['writerLeases']=leases();report['database']=db
 report['ok']=report['client']['ok'] and report['client']['managedVetoPreserved'] and report['front']['expired']==0 and report['front']['resumed']>=4 and db['writerLeases']==1 and db['events']==db['distinctIds']==db['markers']==report['client']['accepted'] and db['pending']==0
except Exception as e:
 report['error']=str(e)[:150];print('lab artefacts:',lab,flush=True)
finally:
 for k,p in reversed(list(jobs.items())):
  if p.poll() is None:
   p.terminate()
   try:p.wait(4)
   except subprocess.TimeoutExpired:p.kill();p.wait()
 if pg:run([prog/'pg_ctl','-D',pgdir,'-m','fast','-w','stop'])
 for f in logs.values():f.close()
 report['ended']=stamp();output.write_text(json.dumps(report,indent=2))
 if report['ok']:shutil.rmtree(lab)
 else:print('inspect failure:',lab)
print({k:v for k,v in report.items() if k!='client'});sys.exit(0 if report['ok'] else 1)
