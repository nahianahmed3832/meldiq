"""Matched A/B read stress. No warm-ups in percentiles; preserve every observed failure."""
import json,math,gzip,sys
with gzip.open(sys.argv[1],'rt') as f:r=json.load(f)
assert len(r.get('blocks',[]))==4 and [b['pool'] for b in r['blocks']]==[6,4,4,6]
def stats(obs):
 values=sorted(x['ms'] for x in obs if x['ok']);q=lambda p:values[math.ceil(len(values)*p)-1] if values else None
 return dict(measured=len(obs),errors=len(obs)-len(values),p50=q(.50),p95=q(.95),p99=q(.99))
def grouped(obs):return {k:stats([o for o in obs if o['k']==k]) for k in ['summary','history','health']}
agg={str(cap):grouped([o for b in r['blocks'] if b['pool']==cap for o in b['obs']]) for cap in [6,4]}
ok=bool(r['ok']);dif={}
for k,metrics in agg['6'].items():
 four,six=agg['4'][k],metrics
 assert four['measured']==six['measured']==(40 if k=='health' else 500)
 dif[k]=round((four['p95']/six['p95']-1)*100,2) if four['p95'] is not None and six['p95'] else None
 ok=ok and dif[k] is not None and dif[k]<=5
print(json.dumps(dict(run=r['run'],source='pool-load.json.gz',unit='ms',warmups='discarded 32 mixed reads plus their health probes per block; all warm-up errors counted',screen='no errors, p95 may not worsen by more than 5% for any measured route; not equivalent to live regional p95',passed=bool(ok),p95ChangePercent=dif,warmErrors=sum(not o['ok'] for b in r['blocks'] for o in b['warm']),byPool=agg,blocks=[dict(pool=b['pool'],block=b['block'],elapsedMs=b['ended']-b['at'],connectedBackends=b['restrictedBackendsAtEnd'],timings=grouped(b['obs'])) for b in r['blocks']]),indent=2))
