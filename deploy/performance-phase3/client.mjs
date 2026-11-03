// No live endpoints or credentials. Observations retain only timing/status and stage names.
import fs from 'node:fs';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import {GriipClient} from './griipClient.mjs';
import {sealSynthetic,openSynthetic} from './synthetics.mjs';
const base='http://127.0.0.1:18087', pause=ms=>new Promise(ok=>setTimeout(ok,ms));
if(process.env.MELDIQ_OWNED_CANARY!=='synthetic-loopback')throw Error('owned staging required');
const stats={started:Date.now(),observations:[],errors:[],accepted:0,socketCloses:[],duplicates:0,history:0,pongs:0,typing:0,acks:0};
const phase=()=>{try{return fs.readFileSync('/control/phase','utf8').trim()}catch{return 'warm'}};
function fault(w,e){stats.errors.push({phase:phase(),w,why:String(e?.message||e).slice(0,100)});}
async function measure(k,fn){const at=Date.now(),p=phase();try{const x=await fn();stats.observations.push({k,p,at,ms:Date.now()-at,ok:true});return x;}catch(e){stats.observations.push({k,p,at,ms:Date.now()-at,ok:false});throw e;}}
async function call(k,path,token,body,expected=200){
  return measure(k,async()=>{const r=await fetch(base+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(8000),headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    if(r.status!==expected)throw Error('http_'+r.status+'_'+k);return r.json();});
}
const bounded=async(fn,timeout=8000)=>{const end=Date.now()+timeout;while(Date.now()<end){const v=fn();if(v)return v;await pause(12);}throw Error('deadline');};
const alice=new GriipClient(base,'phase3alice'),bob=new GriipClient(base,'phase3bob');
let a,b,done=false,serial=0,first;const seen=new Map(),sent=[],pongs=new Map();
async function socket(client,who,browser){
 const ws=new WebSocket(base.replace('http','ws')+'/v1/ws',browser?{}:{headers:{authorization:'Bearer '+client.token}});
 const hello=new Promise((ok,no)=>{
 ws.on('open',()=>{if(browser)ws.send(JSON.stringify({t:'auth',token:client.token}));});
 ws.on('error',no);ws.on('close',c=>{if(!done&&!(who==='managed'&&stats.managedVetoPreserved&&[4001,4401].includes(c)))stats.socketCloses.push({who,c,phase:phase()});no(Error('closed '+c));});
 ws.on('message',raw=>{const f=JSON.parse(raw);
   if(f.t==='hello'){if(f.userId!==client.userId||f.deviceId!==client.deviceId)no(Error('identity'));else ok();}
   if(f.t==='pong'){pongs.set(who,(pongs.get(who)||0)+1);stats.pongs++;}
   if(f.t==='typing'&&who==='bob')stats.typing++;
   if(f.t==='queue'){for(const it of f.items){if(it.kind!=='message'||who!=='bob')continue;if(seen.has(it.messageId))stats.duplicates++;seen.set(it.messageId,it);}
    if(!f.items.length&&f.backlog)ws.send(JSON.stringify({t:'ack',ids:[],backlog:true}));}
 });});
 await hello;return ws;
}
try{
 await alice.register();await bob.register();const conversation=(await alice.req('POST','/v1/conversations/dm',{userId:bob.userId})).conversation.id;
 const members=await alice.req('GET','/v1/conversations/'+conversation+'/members');
 if(members.members.length!==2||![alice,bob].every(x=>members.members.some(m=>m.id===x.userId)))throw Error('isolation');
 const pair={conversationId:conversation,receiverUserId:bob.userId,identity:{privateKey:alice.device.key,signingKey:alice.signingKeyB64},receiver:{deviceId:bob.deviceId,encryptionKey:bob.encKeyB64,encryptionPrivateKey:crypto.createPrivateKey({format:'jwk',key:{kty:'OKP',crv:'X25519',x:bob.enc.pub.toString('base64url'),d:bob.enc.priv.toString('base64url')}}).export({format:'der',type:'pkcs8'}).toString('base64')}};
 [a,b]=await Promise.all([socket(alice,'alice',false),socket(bob,'bob',true)]);
 async function message(){
   const sealed=await sealSynthetic(pair,alice),id=sealed.envelope.messageId,body={conversationId:conversation,messageId:id,cls:'message',sentAt:sealed.envelope.sentAt,payload:{type:'status-monitor',sealed:{...sealed.envelope,...sealed.envelope.recipients[0]}}};
   const result=await call('submit','/v2/messages',alice.token,body);if(result.messageId!==id||result.duplicate)throw Error('unexpected submission');
   sent.push(id);stats.accepted++;first??={body,result};const item=await bounded(()=>seen.get(id));
   if(item.senderUserId!==alice.userId||item.conversationId!==conversation)throw Error('delivery isolation');await openSynthetic(pair,sealed,item.payload.event.payload.sealed);
   const page=await call('history','/v2/conversations/'+conversation+'/messages?around='+id+'&limit=3',bob.token);
   const match=page.messages.filter(m=>m.id===id&&m.serverTs===result.serverTs);if(match.length!==1)throw Error('history mismatch');
   await openSynthetic(pair,sealed,match[0].payload.sealed);stats.history++;
   b.send(JSON.stringify({t:'ack',ids:[item.id]}));
   await boundedResult(async()=>!(await call('queue','/v1/queue?limit=200',bob.token)).items.some(x=>x.id===item.id));stats.acks++;
 }
 async function boundedResult(fn){const end=Date.now()+8000;while(Date.now()<end){if(await fn())return;await pause(35);}throw Error('ack timeout');}
 if(process.env.PH3_MANAGED_GATE==='1'){
   const {AccountClient}=await import('./managed-client.mjs');
   const m=new AccountClient(base,'release-gate@example.test');
   await m.signUp({verifyCode:()=>{
     if(process.env.PH3_NORMAL!=='1')return fs.readFileSync('/control/managed-mail','utf8');
     for(const f of fs.readdirSync('/control/test-mail').filter(f=>f.endsWith('.eml')).sort().reverse()){
       const mail=fs.readFileSync('/control/test-mail/'+f,'utf8');if(mail.includes('To: release-gate@example.test\n'))return mail.match(/\b(\d{6})\b/)?.[1];
     }throw Error('missing synthetic verification');
   }});
   await m.signIn();await m.setUpIdentity();
   let ms=await socket(m,'managed',true);await m.refresh();
   const oldPong=pongs.get('managed')||0;
   ms.send('{"t":"ping"}');await bounded(()=>(pongs.get('managed')||0)>oldPong);
   fs.writeFileSync('/control/managed-ready','1');
   await bounded(()=>fs.existsSync('/control/managed-vetoed'),8000);
   const old=pongs.get('managed');ms.send('{"t":"ping"}');
   await bounded(()=>(pongs.get('managed')||0)>old);
   stats.managedVetoPreserved=ms.readyState===1;
   // Explicit logout by this owned account ends its socket; the operator never closes it.
   const normalClose=new Promise(ok=>ms.once('close',code=>ok([4001,4401].includes(code))));
   await m.req('POST','/v2/auth/logout',{});if(ms.readyState===1)ms.send('{"t":"ping"}');
   if(!await Promise.race([normalClose,pause(3000).then(()=>false)]))throw Error('managed logout failed');
 }
 await message();
 fs.writeFileSync('/control/client-ready','ready');
 const end=Date.now()+300000;
 const stop=()=>fs.existsSync('/control/finish')||Date.now()>end;
 const loop=async(k,fn,ms)=>{while(!stop()){try{await fn();}catch(e){fault(k,e);}await pause(ms);}};
 await Promise.all([
 loop('overlap',async()=>{
   for(const k of ['rollout','rollback'])if(fs.existsSync('/control/challenge-'+k)&&!fs.existsSync('/control/arrival-'+k)){
     fs.writeFileSync('/control/arrival-'+k,'1');
     await measure('inHoldMessage',message);
     fs.writeFileSync('/control/proven-'+k,'1');
   }
 },35),
 loop('health',async()=>{const h=await call('health','/healthz');if(!h.ok||!h.postgres)throw Error('dependencies');},170),
 loop('summary',async()=>{const h=await call('summary','/v2/messages/summary',bob.token);if(!h.conversations?.some(x=>x.conversationId===conversation))throw Error('not visible');},180),
 loop('deny',()=>call('deny','/v2/messages/summary',null,null,401),300),
 loop('send',message,140),
 loop('heartbeat',async()=>{const n=pongs.get('bob')||0;
 await measure('applicationPong',async()=>{b.send('{"t":"ping"}');await bounded(()=>(pongs.get('bob')||0)>n);});
 a.send(JSON.stringify({t:'typing',c:conversation,on:false}));},180)
 ]);
 const retry=await call('retry','/v2/messages',alice.token,first.body);stats.idempotent=!!retry.duplicate&&retry.serverTs===first.result.serverTs;
 stats.sameSockets=a.readyState===1&&b.readyState===1;
 stats.allDelivered=sent.length===seen.size&&sent.every(x=>seen.has(x))&&stats.acks===sent.length;
 if(!fs.existsSync('/control/finish'))throw Error('controller timeout');
 // Invalid credentials never receive a hello. The still-connected browser must be denied after logout.
 const invalid=new WebSocket(base.replace('http','ws')+'/v1/ws',{headers:{authorization:'Bearer invalid'}});
 stats.invalidRejected=await new Promise((ok,no)=>{invalid.on('message',()=>no(Error('invalid authorized')));invalid.on('close',c=>ok(c===4401));invalid.on('error',no);});
 done=true;
 const reject=new Promise(ok=>b.once('close',c=>ok([4401,4001].includes(c))));
 await call('logout','/v1/auth/logout',bob.token,{});if(b.readyState===1)b.send('{"t":"ping"}');
 stats.revokedRejected=await Promise.race([reject,pause(3000).then(()=>false)]);
 stats.ok=!stats.errors.length&&!stats.socketCloses.length&&!stats.duplicates&&stats.allDelivered&&stats.sameSockets&&stats.idempotent&&stats.invalidRejected&&stats.revokedRejected&&stats.typing>0;
}catch(e){fault('driver',e);stats.ok=false;}
finally{done=true;a?.terminate();b?.terminate();stats.ended=Date.now();fs.writeFileSync('/control/client-report.json',JSON.stringify(stats));}
