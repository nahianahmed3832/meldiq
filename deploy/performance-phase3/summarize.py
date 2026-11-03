"""Expose stage counts/tail latency without hiding failed requests or treating them as successful samples."""
import argparse,gzip,json,math,pathlib,collections
p=argparse.ArgumentParser();p.add_argument('input',type=pathlib.Path);a=p.parse_args()
with (gzip.open(a.input,'rt') if a.input.suffix=='.gz' else a.input.open()) as stream:r=json.load(stream)
stats=collections.defaultdict(list)
for o in r.get('client',{}).get('observations',[]):stats[(o['p'],o['k'])].append(o)
def pct(values,p):return values[math.ceil(len(values)*p)-1] if values else None
table={}
for (phase,k),items in sorted(stats.items()):
 t=sorted(x['ms'] for x in items if x['ok']);table.setdefault(phase,{})[k]=dict(attempts=len(items),failed=len(items)-len(t),p50=pct(t,.50),p95=pct(t,.95),p99=pct(t,.99),max=max(t,default=None))
print(json.dumps(dict(source=a.input.name,note='Synthetic, milliseconds. No warm-up discard in these continuous release probes. Percentiles describe successful operations; failures counted separately. Includes multiple sequential operations in inHoldMessage.',success=r['ok'],timings=table),indent=2))
