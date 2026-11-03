"""Aggregate origin logs without exporting customer addresses, user agents, private IDs or request contents."""
import json,subprocess,time,collections
bucket=collections.defaultdict(collections.Counter);classes=collections.Counter();route={}
cut=int(time.time())-2400
def tag(p):
 p=p.split('?')[0]
 if p in ['/healthz','/v2/messages','/v2/messages/summary','/v1/queue/ack','/v1/ws','/v1/queue']:return p
 if p.startswith('/v2/ops/') or p.startswith('/v2/admin/'):return 'ops'
 if p.startswith('/v2/'):return 'other-v2'
 if p.startswith('/v1/'):return 'other-v1'
 return 'other'
for l in subprocess.check_output(['docker','logs','--since',str(cut),'griip-internal-messaging-api-1'],stderr=subprocess.STDOUT).splitlines():
 try:x=json.loads(l)
 except Exception:continue
 rid=x.get('reqId')
 if x.get('req'):route[rid]=tag(x['req'].get('url',''))
 code=x.get('res',{}).get('statusCode')
 if code is None: continue
 k=route.pop(rid,'other');minute=int(x.get('time',0))//60000*60
 bucket[minute]['total']+=1
 if int(code)>=500:bucket[minute]['5xx']+=1;classes[(k,int(code))]+=1
print(json.dumps({'observedAt':int(time.time()),'minutes':{k:dict(v)for k,v in sorted(bucket.items())},'errorsByRoute':{k+':'+str(c):n for(k,c),n in classes.items()}}))
