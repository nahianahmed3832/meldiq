"""Unpublished, synthetic Docker network only. Never mounts a production volume or uses production credentials."""
import datetime, json, os, pathlib, subprocess, sys, time, uuid
from argparse import ArgumentParser
P=ArgumentParser();P.add_argument('--rtt',type=int,choices=[2,168],required=True);P.add_argument('--output',required=True);P.add_argument('--preflight',action='store_true');P.add_argument('--warm-pool',action='store_true');P.add_argument('--normal',action='store_true');P.add_argument('--reserve',action='store_true');P.add_argument('--overlap-stop',action='store_true');P.add_argument('--pinned-session',action='store_true');P.add_argument('--calibrate',action='store_true');P.add_argument('--warm',action='store_true');P.add_argument('--scaled',action='store_true');P.add_argument('--fast',action='store_true');P.add_argument('--failure',action='store_true');A=P.parse_args()
root=pathlib.Path('/opt/griip-internal-messaging/releases/phase3-lab')
fixtures=root/'fixtures'
base='griip-internal-messaging-api:0.76.1-pg-'
old=base+'b9e6f005';new=base+'8ce2c5c0'
pins={old:('b9e6f0054fa1fa5fd647cebb3ea072ea65b20a28','sha256:9bb580a8be7a5f2823cd0b9a1ad95bed65291389321658d29124feebe321ba5c'),new:('8ce2c5c00773551442716fed95d4de587a84103b','sha256:6b03cc04db250e01d9fca3dd625ed3f67c8cf8f181161e3c67f0e6a4a78ad5ab')}
fallback=old
if A.fast:
 new=base+'e3d8f5d8';fallback=base+'a6ecdfeb'
 pins.update({new:('e3d8f5d8e45122cf53460f1c932b78055a6cfb39','sha256:cd3af8cb274d9bc57e4715d852999dedca38bf0a9fe93a14b39f1a66f31766f5'),
              fallback:('a6ecdfebc70db18bc3a9ef7d2330a77e9be2d1dd','sha256:fdf69599c48e200d8e400a648600277de5d94b4fd14e0b275b971d64650a24b8')})
if A.warm:
 fallback=base+'b51f3b13';new=base+'77258f7e';pins.update({fallback:('b51f3b13fb29653688da8334760bd4e85956cd4d', 'sha256:41261d4c1b29e73b960d945f785ea0855a7fa5d5969b4e02aa64cd103639882e'),new:('77258f7e9dafe83256117d33fd0cf0a5153c4632', 'sha256:aaef30f0158286413e4acca7aa119283d547ebb63f733cec5893b33f46c52f25')})
pgimg='sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'
ident='ph3-'+uuid.uuid4().hex[:12]
run=root/ident
run.mkdir(mode=0o700)
for k in ['control','data']:(run/k).mkdir(mode=0o700);os.chown(run/k,1000,1000)
C=run/'control'
created=[]
def out(*cmd,input=None,timeout=70):return subprocess.check_output(cmd,input=input,timeout=timeout,stderr=subprocess.PIPE).decode().strip()
def dr(*args,**kwargs):return out('docker',*args,**kwargs)
def stamp():return round(time.time()*1000)
report={'rttMs':A.rtt,'failureInjection':A.failure,'prepared':A.warm,'productionSized':A.scaled,'preflight':A.preflight,'warmPool':A.warm_pool,'normalEntry':A.normal,'reserveReaderSlots':A.reserve,'overlapStop':A.overlap_stop,'pinnedSession':A.pinned_session,'calibratedFinalReadMs':4295 if A.calibrate else 0,'run':ident,'started':stamp(),'switches':[],'sourceImages':pins}
def start(name,image,argv,env=None,pg=False):
 n=ident+'-'+name
 cmd=['run','-d','--name',n,'--label','meldiq.phase3='+ident,'--network','none' if pg else 'container:'+ident+'-pg','--read-only','--security-opt','no-new-privileges:true','--cap-drop','ALL','--cpus','1.25' if A.scaled else '0.75','--memory','768m' if A.scaled else '480m','--pids-limit','128','--no-healthcheck','--tmpfs','/tmp:rw,nosuid,size=32m']
 if pg:cmd+=['--user','70:70','--tmpfs','/var/run/postgresql:rw,nosuid,size=16m,uid=70,gid=70,mode=3775','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=480m,uid=70,gid=70,mode=700']
 elif name=='redis':cmd+=['--user','999:999','--entrypoint','redis-server']
 else:
  cmd+=['--entrypoint','node','-v',str(fixtures)+':/app/probes:ro','-v',str(C)+':/control']
  if name in ('initial','candidate','fallback','bad'):cmd+=['-v',str(run/'data')+':/data']
 for k,v in (env or {}).items():cmd+=['-e',k+'='+v]
 dr(*cmd,image,*argv);created.append(n);return n
def flag(k,v='1'):tmp=C/(k+'.tmp');tmp.write_text(v);os.replace(tmp,C/k)
def wait(k,t=90):
 end=time.monotonic()+t
 while time.monotonic()<end:
  if (C/k).exists():return (C/k).read_text()
  if k.startswith("prepared-") and int(time.monotonic()*10)%10==0:
   n=ident+"-"+k.removeprefix("prepared-")
   if dr('inspect','-f','{{.State.Running}}',n)!='true':raise RuntimeError('standby exited before preparation: '+n)
  if (C/'client-report.json').exists() and k!='client-report.json':raise RuntimeError('driver stopped: '+str(json.loads((C/'client-report.json').read_text())['errors'][:2]))
  time.sleep(.025)
 raise RuntimeError('timed out: '+k)
def sql(query):return dr('exec','-i',ident+'-pg','psql','-h','127.0.0.1','-U','postgres','-d','postgres','-XqAt','-v','ON_ERROR_STOP=1',input=query.encode())
def control(route,method='POST'):
 return json.loads(out('curl','--fail','-sS','--max-time','9','--unix-socket',str(C/'handoff.sock'),'-X',method,'http://localhost/'+route))
def phase(name):flag('phase',name)
def startslot(s,im,bad=False):
 e={**common,'SLOT':s,'MELDIQ_CANARY_PHASE':'rollback'}
 if A.reserve and s in ('candidate','fallback'):
  # The role budget is six. A prepared standby needs a snapshot and one warm
  # session; cap only the new writer at four. The old image starts unmodified.
  e['SUPABASE_DATABASE_POOL_SIZE']='4'
 if bad:e['SUPABASE_DATABASE_URL']='postgresql://meldiq_canary_runtime@127.0.0.1:55434/postgres'
 start(s,im,['/app/probes/park.mjs'],e);wait('parked-'+s)
def ready(s,signal=True):
 if signal:flag('start-'+s, json.loads((C/('plan-'+s)).read_text())['nonce'] if A.normal and s in ('candidate','fallback') else '1')
 r=json.loads(wait('api-ready.json',70))
 if not r['ready'] or r['held']:raise RuntimeError('writer not active')
def actual_leases():return int(sql("select count(*) from pg_locks where locktype='advisory' and granted and classid=(hashtextextended('meldiq-rows-writer',0)>>32 & 4294967295)::oid and objid=(hashtextextended('meldiq-rows-writer',0) & 4294967295)::oid;"))
def change(name,pre,suc,inject=False):
 if A.warm:
  phase('prepare-'+name)
  if A.normal:flag('plan-'+suc,json.dumps(dict(slot=suc,nonce=os.urandom(24).hex(),expires=stamp()+100000,waitForRelease=A.overlap_stop,pinnedSession=A.pinned_session)))
  flag('prepare-'+suc);wait('prepared-'+suc)
 if A.overlap_stop and inject:
  # Reject a misconfigured target while the incumbent is still serving. Do not
  # pay a failed image's startup cost behind a closed admission gate.
  flag('start-bad');rc=dr('wait',ident+'-bad')
  if rc=='0' or actual_leases()!=1:raise RuntimeError('invalid target passed preflight')
 phase(name);before=stamp();control('drain');drained=stamp()
 flag('challenge-'+name);wait('arrival-'+name,3)
 (C/'api-ready.json').unlink()
 if A.overlap_stop:
  if not (A.normal and A.reserve):raise RuntimeError('ownership overlap requires normal reserved mode')
  # Delivery stopped admitting work; the target may wait for the lease in parallel
  # with graceful shutdown. It cannot start a write or job until it actually owns it.
  with subprocess.Popen(['docker','stop','-t','8',ident+'-'+pre],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE) as stopping:
   flag('start-'+suc,json.loads((C/('plan-'+suc)).read_text())['nonce'])
   if stopping.wait(10)!=0:raise RuntimeError('incumbent stop failed')
  if int(dr('inspect','-f','{{.State.ExitCode}}',ident+'-'+pre))!=0:raise RuntimeError('incumbent required forced stop')
  ready(suc,False)
 else:
  dr('stop','-t','8',ident+'-'+pre);exitcode=int(dr('inspect','-f','{{.State.ExitCode}}',ident+'-'+pre))
  if exitcode!=0:raise RuntimeError('writer required forced stop: '+str(exitcode))
  if actual_leases()!=0:raise RuntimeError('old lease still held')
  if inject:
   flag('start-bad');rc=dr('wait',ident+'-bad')
   if rc=='0' or (C/'api-ready.json').exists():raise RuntimeError('misconfiguration unexpectedly ready')
  ready(suc)
 if actual_leases()!=1:raise RuntimeError('writer lease mismatch')
 control('resume');after=stamp()
 report['switches'].append({'label':name,'start':before,'drained':drained,'resumed':after,'admissionHoldMs':after-before,'afterDrainMs':after-drained,'invalidRejected':inject})
 phase('after-'+name);wait('proven-'+name,12)
try:
 for tag,(rev,digest) in pins.items():
  x=json.loads(dr('image','inspect',tag))[0]
  if x['Id']!=digest or x['Config']['Labels']['org.opencontainers.image.revision']!=rev:raise RuntimeError('image mismatch')
 start('pg',pgimg,['postgres','-c','shared_buffers=48MB','-c','max_connections=30'],{'POSTGRES_HOST_AUTH_METHOD':'trust'},True)
 for tries in range(70):
  try:sql('select 1');break
  except subprocess.SubprocessError:time.sleep(.2)
 sql((fixtures/'postgres-bootstrap.sql').read_text())
 for f in sorted((fixtures/'migrations').glob('*.sql')):sql(f.read_text())
 sql("CREATE ROLE meldiq_canary_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6; GRANT meldiq_api TO meldiq_canary_runtime; ALTER ROLE meldiq_canary_runtime SET search_path=pg_catalog,meldiq;")
 if A.scaled:
  sql("""INSERT INTO meldiq.resource_samples(minute,series,value) SELECT floor(extract(epoch FROM now())/60)::bigint-(n/60), 'load-'||(n%60),n*0.0625 FROM generate_series(0,582239)n;
         INSERT INTO meldiq.delivery_queue(id,recipient_device_id,kind,conversation_id,message_id,sender_user_id,sender_device_id,payload,created_at,expires_at)
         SELECT n,'fixture-idle-device','receipt','fixture-only',n::text,'fixture-idle-user','fixture-sender',repeat('X',470),1,4000000000000 FROM generate_series(1,47200)n;
         ANALYZE meldiq.resource_samples; ANALYZE meldiq.delivery_queue;""")
 if A.calibrate:
  if not (A.warm and A.scaled):raise RuntimeError('calibration needs prepared production-sized mode')
  sql("""INSERT INTO meldiq.resource_hourly SELECT n/60,'hour-'||(n%60),1.0,0.0,2.0,60 FROM generate_series(0,15599)n;
         INSERT INTO meldiq.presence_samples SELECT n,0,0,0,0,0,0,0,0,0,0,'{}' FROM generate_series(1,15200)n;
         INSERT INTO meldiq.submitted_messages SELECT 'seed-'||n,'seed-device','seed-user','seed-conv',1,1,4000000000000 FROM generate_series(1,5200)n;
         ANALYZE meldiq.resource_hourly; ANALYZE meldiq.presence_samples; ANALYZE meldiq.submitted_messages;""")
  start('redis','sha256:21090af93f8324db2f0f0f4f38a7c60369d47d917e000c3423d89d2ae2883537',['--bind','127.0.0.1','--save','','--appendonly','no','--requirepass','synthetic-fixture-only'],{})
 if A.warm:
  authority=run/'data/database-authority.json'
  authority.write_text(json.dumps({'version':1,'projectRef':'z'*20,'sourceSha256':'a'*64,'activatedAt':'2026-11-03T00:00:00.000Z'}));os.chown(authority,1000,1000);authority.chmod(0o600)
 common={'PREPARE_PAGES':'1' if A.warm else '0','MELDIQ_OWNED_CANARY':'synthetic-loopback','MELDIQ_CANARY_DATABASE_RTT_MS':str(A.rtt),'NODE_ENV':'development','APP_ENV':'development','DATABASE_MODE':'supabase','SUPABASE_DATABASE_URL':'postgresql://meldiq_canary_runtime@127.0.0.1:55433/postgres','DATA_DIR':'/data'}
 if A.normal:
  if A.pinned_session and not (A.reserve and A.overlap_stop):raise RuntimeError('pinned session needs reserved role and bounded wait')
  if not (A.preflight and A.warm_pool):raise RuntimeError('calibrated normal entry required')
  common['PH3_NORMAL']='1'
 if A.warm_pool:
  if not A.preflight:raise RuntimeError('prefenced prepare required')
  common['PH3_WARM_POOL']='1'
 if A.preflight:
  if not (A.calibrate and A.warm):raise RuntimeError('preflight certification requires calibrated prepared mode')
  common.update({'PH3_PREFLIGHT':'1','PH3_MANAGED_GATE':'1'})
 if A.calibrate:common.update({'PH3_FINAL_READ_FLOOR_MS':'4295','REDIS_URL':'redis://127.0.0.1:6379','REDIS_PASSWORD':'synthetic-fixture-only','REDIS_PRIVATE_NETWORK':'true'})
 start('lag',old,['/app/probes/owned-pg-wire.mjs' if A.scaled else '/app/probes/owned-pg-latency.mjs'],common);wait('proxy-ready.json')
 startslot('initial',old);ready('initial')
 startslot('candidate',new);startslot('fallback',fallback)
 if A.failure:startslot('bad',new,True)
 start('front',old,['/app/probes/handoff.mjs'],{'MELDIQ_OWNED_CANARY':'synthetic-loopback'})
 start('driver',old,['/app/probes/client.mjs'],{'MELDIQ_OWNED_CANARY':'synthetic-loopback','PH3_MANAGED_GATE':'1' if A.preflight else '0','PH3_NORMAL':'1' if A.normal else '0'})
 if A.preflight:
  wait('managed-ready');before=control('state','GET')
  code=out('curl','-s','-o','/dev/null','-w','%{http_code}','--unix-socket',str(C/'handoff.sock'),'-X','POST','http://localhost/drain')
  after=control('state','GET')
  if code!='409' or after['state']!='open' or after['peers']!=before['peers'] or after['peers']<3 or actual_leases()!=1:raise RuntimeError('managed session drain was not safely vetoed')
  report['managedVeto']={'status':int(code),'peers':after['peers'],'originalOpen':True};flag('managed-vetoed')
 wait('client-ready');time.sleep(2.1);change('rollout','initial','candidate');time.sleep(4.1)
 change('rollback','candidate','fallback',A.failure);time.sleep(4.1);flag('finish')
 report['client']=json.loads(wait('client-report.json',70))
 report['front']=control('state','GET')
 report['database']={k:int(sql(q)) for k,q in {'events':'select count(*) from meldiq.message_events','distinctIds':'select count(distinct id) from meldiq.message_events','markers':"select count(*) from meldiq.submitted_messages where message_id not like 'seed-%'",'pendingMessages':"select count(*) from meldiq.delivery_queue where kind='message'",'writerLeases':"select count(*) from pg_locks where locktype='advisory' and granted"}.items()}
 db=report['database'];n=report['client']['accepted']
 report['ok']=bool(report['client']['ok'] and db['events']==db['distinctIds']==db['markers']==n and db['pendingMessages']==0 and report['front']['expired']==0 and report['front']['resumed']>=4 and len(report['switches'])==2)
except Exception as e:
 report['ok']=False;report['error']=str(e)[:300]
 if (C/'client-ready').exists() and not(C/'client-report.json').exists():
  flag('finish')
  try:wait('client-report.json',15)
  except Exception:pass
 if (C/'client-report.json').exists():report['client']=json.loads((C/'client-report.json').read_text())
 if (C/'handoff.sock').exists():
  try:report['front']=control('state','GET')
  except Exception:pass
finally:
 # Preserve independent durability counts on a failed probe as well. A client timeout
 # after dispatch is ambiguous; never infer a DB commit or a lost event from HTTP alone.
 if 'database' not in report and (C/'client-ready').exists():
  try:
   report['database']={k:int(sql(q)) for k,q in {'events':'select count(*) from meldiq.message_events','distinctIds':'select count(distinct id) from meldiq.message_events','markers':"select count(*) from meldiq.submitted_messages where message_id not like 'seed-%'",'pendingMessages':"select count(*) from meldiq.delivery_queue where kind='message'",'writerLeases':"select count(*) from pg_locks where locktype='advisory' and granted"}.items()}
  except (subprocess.SubprocessError,ValueError):pass
 for n in reversed(created):
  if dr('inspect','-f','{{index .Config.Labels "meldiq.phase3"}}',n)==ident:
   with open(run/(n+'.log'),'wb') as f:subprocess.run(['docker','logs',n],stdout=f,stderr=subprocess.STDOUT)
   dr('rm','-f','-v',n)
 report['ended']=stamp()
 pathlib.Path(A.output).write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({k:v for k,v in report.items() if k not in ('client','sourceImages')}),flush=True)
sys.exit(0 if report['ok'] else 1)
