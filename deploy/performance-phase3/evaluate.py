"""Evaluate evidence only, never trigger a deploy. A passing sample is not a release authorization."""
import argparse,json,gzip,pathlib,datetime
p=argparse.ArgumentParser();p.add_argument('receipts',type=pathlib.Path);a=p.parse_args();d=a.receipts
def load(f):
 path=d/f
 with (gzip.open(path,'rt') if f.endswith('.gz') else path.open())as s:return json.load(s)
host=load('production-final.json');gate=load('live-admission.json');cohort=load('production-ingress-retest.json')
checks=[]
def test(label,passed,detail):checks.append(dict(check=label,passed=bool(passed),detail=detail))
test('writer unchanged and healthy',host['release'].endswith('b9e6f005') and host['restarts']==0 and all(host[k] for k in ['healthySupabaseRedis','authorityMatches','mountsMatch','environmentMatches','rollbackImageRetained']),host['startedAt'])
c=cohort['client'];test('public cohort and restore',c['completed'] and c['sameSockets'] and not c['errors'] and not c['duplicateFrames'] and c['verifiedHistory']==c['queuesAcked']==12 and cohort['events'][-1]['retired'],f"{c['verifiedHistory']} encrypted messages")
for file,label in [('scaled-proof.json.gz','scaled container'),('native-managed.json.gz','calibrated native with managed veto')]:
 r=load(file);test(label,r['ok'] and r['client']['allDelivered'] and not r['client']['socketCloses'] and not r['client']['duplicates'],[x['admissionHoldMs'] for x in r['switches']])
file=next(f for f in ['normal-reserved.json.gz','normal-entry.json.gz','calibrated-pool.json.gz','calibrated-preflight.json'] if (d/f).exists())
r=load(file)
test('production-sized calibrated container both transitions',r['ok'] and len(r['switches'])==2 and r.get('client',{}).get('allDelivered') and not r.get('client',{}).get('socketCloses') and not r.get('client',{}).get('duplicates') and not r.get('front',{}).get('expired') and r.get('managedVeto',{}).get('status')==409,[x['admissionHoldMs'] for x in r['switches']])
cap=gate['providerBackendSessions'];test('two standby slots with one spare for incumbent',int(cap['limit'])-int(cap['connected'])>=3,cap)
latest=gate['incumbentHubSamples'][:3]
test('incumbent direct clients drained',len(latest)==3 and all(int(x['sockets'])==0 for x in latest),[int(x['sockets']) for x in latest])
normal_name=next((f for f in ['normal-reserved.json.gz','normal-entry.json.gz'] if (d/f).exists()),None)
normal=load(normal_name) if normal_name else {}
test('published index plus private standby and rollback',normal.get('normalEntry') and normal.get('ok') and len(normal.get('switches',[]))==2 and normal['switches'][-1]['invalidRejected'] and normal.get('managedVeto',{}).get('status')==409,
     [x['admissionHoldMs'] for x in normal.get('switches',[])] if normal else 'no full normal-entry receipt')
test('recent production observation',all(0<=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(x.replace('Z','+00:00'))).total_seconds()<180 for x in [gate['at'],host['at']]),'must repeat immediately before any real switch')
print(json.dumps(dict(evaluatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),decision='eligible-for-live-preflight' if all(x['passed'] for x in checks) else 'hold b9e6f005',checks=checks),indent=2))
