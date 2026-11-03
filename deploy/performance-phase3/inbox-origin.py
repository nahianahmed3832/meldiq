"""Aggregate only signed-in inbox successes, with error counts. Never export URLs with query strings or request IDs."""
import subprocess,collections,datetime,json,math,time
cut=int(time.time())-3600;route=set();ms=[];fails=collections.Counter()
for line in subprocess.check_output(['docker','logs','--since',str(cut),'griip-internal-messaging-api-1'],stderr=subprocess.STDOUT).splitlines():
 try:r=json.loads(line)
 except Exception:continue
 id=r.get('reqId')
 if (r.get('req',{}).get('url') or '').split('?')[0]=='/v2/messages/summary':route.add(id)
 if id not in route or 'res' not in r:continue
 route.discard(id);code=r['res'].get('statusCode')
 if code==200 and isinstance(r.get('responseTime'),(float,int)):ms.append(r['responseTime'])
 else:fails[str(code)]+=1
ms.sort()
def q(p):return round(ms[math.ceil(p*len(ms))-1],2) if ms else None
print(json.dumps(dict(writer='b9e6f005',metric='Fastify origin processing; real and synthetic requests share this interval; no network latency or alternate production writer',fromUTC=datetime.datetime.fromtimestamp(cut,datetime.timezone.utc).isoformat(),untilUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),successes=len(ms),non200=dict(fails),p50Ms=q(.5),p95Ms=q(.95),p99Ms=q(.99))))
