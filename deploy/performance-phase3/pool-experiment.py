"""Controlled read-capacity experiment; run only from the unpublished rehearsal harness."""
import json,time
def measure(h):
 C,dr,start,wait,flag,ready,common,new,ident,created,sql=[h[x] for x in ('C','dr','start','wait','flag','ready','common','new','ident','created','sql')]
 results=[]
 for idx,cap in enumerate([6,4,4,6]):
  (C/'api-ready.json').unlink(missing_ok=True)
  app=start('initial',new,['/app/probes/owned-normal.mjs'],{**common,'SLOT':'initial','SUPABASE_DATABASE_POOL_SIZE':str(cap)})
  ready('initial',False)
  if idx==0:
   start('load-client',new,['/app/probes/pool-client.mjs'],{'MELDIQ_OWNED_CANARY':'synthetic-loopback'})
   wait('capacity-seeded',25)
  flag('block-'+str(idx))
  end=time.monotonic()+200
  while not (C/('capacity-'+str(idx))).exists():
   if (C/'capacity-error').exists():raise RuntimeError('capacity client: '+(C/'capacity-error').read_text())
   if time.monotonic()>end:raise RuntimeError('capacity block timed out')
   time.sleep(.2)
  result=json.loads((C/('capacity-'+str(idx))).read_text());result.update(pool=cap,block=idx)
  result['restrictedBackendsAtEnd']=int(sql("select count(*) from pg_stat_activity where usename='meldiq_canary_runtime'"))
  results.append(result)
  dr('stop','-t','8',app)
  if dr('inspect','-f','{{.State.ExitCode}}',app)!='0':raise RuntimeError('unclean stop')
  if dr('inspect','-f','{{index .Config.Labels "meldiq.phase3"}}',app)!=ident:raise RuntimeError('label drift')
  dr('rm','-v',app);created.remove(app)
 return results
