// Explicit regional monitor pair only. Never acknowledge another probe's events.
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.resolve(process.argv[2]),d=path.resolve(process.argv[3]);
const {authenticate,sealSynthetic,openSynthetic}=await import(pathToFileURL(root+'/monitor/synthetics.mjs'));
const WS=createRequire(root+'/package.json')('ws'),p=JSON.parse(fs.readFileSync(root+'/.local/status-pair-runtime.json')),base=p.base;
if(base!=='https://msg.meldiq.app'||p.userId===p.receiverUserId||!p.conversationId)throw Error('fixture isolation');
const key=fs.readFileSync(d+'/cohort','utf8').trim(),limit=8000,pause=ms=>new Promise(ok=>setTimeout(ok,ms));
const r={segments:[],externalCloses:[],errors:[],messages:0,duplicateFrames:0,verifiedHistory:0,queuesAcked:0,completed:false};
const flag=k=>fs.writeFileSync(d+'/'+k,'1');const has=k=>fs.existsSync(d+'/'+k);
async function request(k,route,token,tag,body=null){
 const st=performance.now(),x=await fetch(base+route,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(limit),headers:{...(token?{authorization:'Bearer '+token}:{}),...(tag?{'X-Meldiq-Release-Probe':key}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const result=await x.json(),ms=Math.round((performance.now()-st)*100)/100;if(x.status!==200){const code=result?.error?.code;throw Error(k+':'+x.status+(typeof code==='string'&&/^[a-z_]{1,40}$/.test(code)?':'+code:''));}return {result,ms,policy:x.headers.get('cache-control')};
}
const bounded=async(what,fn,ms=8000)=>{const until=Date.now()+ms;while(Date.now()<until){const x=fn();if(x)return x;await pause(20);}throw Error(what+' deadline');};
let sender,recv,finished=false;const delivery=new Map(),mine=new Set(),sessions=[];
function socket(s,tag,who){
 const ws=new WS(base.replace('https','wss')+'/v1/ws',{headers:{Authorization:'Bearer '+s.sessionToken,...(tag?{'X-Meldiq-Release-Probe':key}:{})},handshakeTimeout:6000});
 const state={ws,hello:false,pongs:0,who};sessions.push(state);
 ws.on('message',data=>{const f=JSON.parse(data);if(f.t==='hello'&&f.userId===s.userId&&f.deviceId===s.deviceId)state.hello=true;
 if(f.t==='pong')state.pongs++;if(who==='receiver'&&f.t==='queue')for(const item of f.items??[])if(mine.has(item.messageId)){if(delivery.has(item.messageId))r.duplicateFrames++;delivery.set(item.messageId,item);}});
 ws.on('error',()=>{if(!finished)r.errors.push('ws:'+who);});ws.on('close',c=>{if(!finished)r.externalCloses.push({who,c});});return state;
}
try{
 [sender,recv]=await Promise.all([authenticate(p.identity,base),authenticate(p.receiver,base)]);
 if(sender.userId!==p.userId||recv.userId!==p.receiverUserId)throw Error('identity');
 const members=(await request('members','/v1/conversations/'+p.conversationId+'/members',sender.sessionToken,false)).result;
 if(members.members?.length!==2||![p.userId,p.receiverUserId].every(id=>members.members.some(m=>m.id===id)))throw Error('private membership');
 const direct=socket(sender,false,'sender');await bounded('direct hello',()=>direct.hello);flag('direct-ready');
 await bounded('ingress activation',()=>has('activated'),120000);
 const front=socket(recv,true,'receiver');await bounded('canary hello',()=>front.hello);
 let first;
 for(const stage of ['canary-on','ingress-rollback','ingress-restored']){
  if(stage==='ingress-rollback'){flag('request-rollback');await bounded('operator rollback',()=>has('rolled-back'),120000);}
  if(stage==='ingress-restored'){flag('request-restore');await bounded('operator restore',()=>has('restored'),120000);}
  const measures=[];
  for(let i=0;i<4;i++){
   const sealed=await sealSynthetic(p,sender),id=sealed.envelope.messageId;
   const msg={conversationId:p.conversationId,messageId:id,cls:'message',sentAt:sealed.envelope.sentAt,payload:{type:'status-monitor',sealed:{...sealed.envelope,...sealed.envelope.recipients[0]}}};
   const start=performance.now();mine.add(id);
   const sent=(await request('submit','/v2/messages',sender.sessionToken,true,msg)).result;
   if(sent.duplicate||sent.messageId!==id)throw Error('commit');
   const it=await bounded('peer delivery',()=>delivery.get(id));if(it.senderUserId!==p.userId||it.conversationId!==p.conversationId)throw Error('WS isolation');
   await openSynthetic(p,sealed,it.payload.event.payload.sealed);
   const peerMs=Math.round(performance.now()-start);
   const h=(await request('history','/v2/conversations/'+p.conversationId+'/messages?around='+id+'&limit=3',recv.sessionToken,true)).result.messages.filter(m=>m.id===id&&m.serverTs===sent.serverTs);
   if(h.length!==1)throw Error('history');await openSynthetic(p,sealed,h[0].payload.sealed);r.verifiedHistory++;
   await request('ack','/v1/queue/ack',recv.sessionToken,true,{ids:[it.id]});
   if((await request('queue','/v1/queue?limit=200',recv.sessionToken,true)).result.items.some(x=>x.id===it.id))throw Error('ack');r.queuesAcked++;r.messages++;first??={msg,sent};
   for(const peer of sessions){const n=peer.pongs;peer.ws.send('{"t":"ping"}');await bounded('authenticated pong',()=>peer.pongs>n);}
   const summary=(await request('summary','/v2/messages/summary',sender.sessionToken,true));if(!summary.result.conversations?.some(x=>x.conversationId===p.conversationId))throw Error('summary');
   if(stage!=='ingress-rollback'&&summary.policy!=='private, no-store')throw Error('wrong route');
   measures.push({peerMs,summaryMs:summary.ms,summaryPolicy:summary.policy});
  }r.segments.push({stage,measures});
 }
 const retry=(await request('retry','/v2/messages',sender.sessionToken,true,first.msg)).result;
 if(!retry.duplicate||retry.serverTs!==first.sent.serverTs)throw Error('idempotency');
 if(r.externalCloses.length||r.errors.length||r.duplicateFrames)throw Error('continuity');
 r.sameSockets=sessions.every(s=>s.ws.readyState===1);r.idempotent=true;r.completed=r.sameSockets;
}catch(e){r.errors.push(String(e.message).replace(/[^a-z0-9 .:_-]/gi,'').slice(0,95));}
finally{finished=true;for(const s of sessions)s.ws.terminate();r.at=new Date().toISOString();fs.writeFileSync(d+'/live.json',JSON.stringify(r,null,2));process.exitCode=r.completed?0:1;}
