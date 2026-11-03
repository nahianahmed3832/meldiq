// Seed only this unpublished PG fixture. The same private accounts, DM and encrypted
// event survive all four process restarts. This client never writes tokens to disk.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {GriipClient} from './griipClient.mjs';
import {sealSynthetic,openSynthetic} from './synthetics.mjs';
if(process.env.MELDIQ_OWNED_CANARY!=='synthetic-loopback')throw Error('unpublished fixture required');
const base='http://127.0.0.1:8080',a=new GriipClient(base,'poolalpha'),b=new GriipClient(base,'poolbeta');
const write=(f,v)=>{const p='/control/'+f;fs.writeFileSync(p+'.tmp',JSON.stringify(v));fs.renameSync(p+'.tmp',p);};
async function check(k,fn,obs){const at=performance.now();let ok=true;
 try{await fn();}catch{ok=false;}obs.push({k,ms:Math.round(performance.now()-at),ok});}
try{
 await a.register();await b.register();
 const conv=(await a.req('POST','/v1/conversations/dm',{userId:b.userId})).conversation.id;
 const pair={conversationId:conv,receiverUserId:b.userId,identity:{privateKey:a.device.key,signingKey:a.signingKeyB64},receiver:{deviceId:b.deviceId,encryptionKey:b.encKeyB64,encryptionPrivateKey:crypto.createPrivateKey({format:'jwk',key:{kty:'OKP',crv:'X25519',x:b.enc.pub.toString('base64url'),d:b.enc.priv.toString('base64url')}}).export({format:'der',type:'pkcs8'}).toString('base64')}};
 const sealed=await sealSynthetic(pair,a),id=sealed.envelope.messageId;
 const sent=await a.req('POST','/v2/messages',{conversationId:conv,messageId:id,cls:'message',sentAt:sealed.envelope.sentAt,payload:{type:'status-monitor',sealed:{...sealed.envelope,...sealed.envelope.recipients[0]}}});
 const get=async(path)=>{const r=await fetch(base+path,{headers:{authorization:'Bearer '+b.token},signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('status');return r.json();};
 const history=async()=>{const h=(await get('/v2/conversations/'+conv+'/messages?around='+id+'&limit=3')).messages;if(h.length!==1||h[0].id!==id||h[0].serverTs!==sent.serverTs)throw Error('wrong history');return h[0];};
 const summary=async()=>{const s=await get('/v2/messages/summary');if(!s.conversations?.some(c=>c.conversationId===conv))throw Error('wrong summary');};
 await openSynthetic(pair,sealed,(await history()).payload.sealed);
 write('capacity-seeded',true);
 for(let block=0;block<4;block++){
  const end=Date.now()+240000;while(!fs.existsSync('/control/block-'+block)&&Date.now()<end)await pause(25);
  if(Date.now()>=end)throw Error('block did not start');
  const warm=[],obs=[];
  async function wave(total,points){
   let next=0;await Promise.all(Array.from({length:8},async()=>{
    while(next<total){const n=next++,k=n%2?'history':'summary';await check(k,k==='history'?history:summary,points);
     if(n%25===0)await check('health',async()=>{const h=await get('/healthz');if(!h.ok||!h.postgres||!h.redis)throw Error('dependencies');},points);}
   }));
  }
  await wave(32,warm);const at=Date.now();await wave(500,obs);
  write('capacity-'+block,{at,ended:Date.now(),warm,obs});
 }
}catch(e){write('capacity-error',String(e.message).slice(0,100));process.exitCode=1;}
