// Narrow recovery of the failed four-message experiment. Requires the original pair and
// the exact signed messages in both committed history and this receiver's own queue.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]),p=JSON.parse(fs.readFileSync(root+'/.local/status-pair-runtime.json'));
const {authenticate,gateway}=await import(pathToFileURL(root+'/monitor/synthetics.mjs'));
const {jsonRequest}=await import(pathToFileURL(root+'/monitor/transport.mjs'));
const start=Date.parse('2026-11-03T13:29:14Z'),end=Date.parse('2026-11-03T13:29:31Z'),base=p.base;
if(base!=='https://msg.meldiq.app'||p.userId===p.receiverUserId||!p.conversationId)throw Error('fixture');
const [a,b]=await Promise.all([authenticate(p.identity,base),authenticate(p.receiver,base)]);
if(a.userId!==p.userId||a.deviceId!==p.identity.deviceId||b.userId!==p.receiverUserId||b.deviceId!==p.receiver.deviceId)throw Error('identity');
const receive=(route,extra={})=>jsonRequest(base+route,{token:b.sessionToken,...extra});
const members=(await receive('/v1/conversations/'+p.conversationId+'/members')).members;
if(members.length!==2||![a,b].every(x=>members.some(m=>m.id===x.userId)))throw Error('membership');
const pub=crypto.createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(p.identity.signingKey,'base64').toString('base64url')}});
const rows=(await receive('/v2/conversations/'+p.conversationId+'/messages?limit=100')).messages;
function verified(event){
 const e=event.payload?.sealed;
 if(event.payload?.type!=='status-monitor'||!e||!Number.isSafeInteger(e.sentAt)||e.sentAt<start||e.sentAt>=end||e.conversationId!==p.conversationId||e.cls!=='message'||e.messageId!==event.id||!/^status_[a-f0-9-]{36}$/.test(e.messageId)||e.recipients?.length!==1||e.recipients[0].deviceId!==b.deviceId||event.senderUserId!==a.userId||event.senderDeviceId!==a.deviceId||event.conversationId!==p.conversationId)return false;
 const header=['griip-envelope-v1',e.messageId,p.conversationId,a.userId,a.deviceId,e.sentAt,'message',e.nonce,e.ciphertext].join('\n');
 return crypto.verify(null,Buffer.from(header),pub,Buffer.from(e.signature,'base64'));
}
const own=rows.filter(verified);
if(own.length!==4||new Set(own.map(x=>x.id)).size!==4)throw Error('signed four-message history count differs: '+own.length);
const ids=new Map(own.map(x=>[x.id,x.payload.sealed.signature]));
const queued=(await receive('/v1/queue?limit=200')).items;
const pending=queued.filter(it=>ids.has(it.messageId)&&it.kind==='message'&&it.conversationId===p.conversationId&&it.senderDeviceId===a.deviceId&&it.senderUserId===a.userId&&it.payload?.event?.payload?.sealed?.signature===ids.get(it.messageId));
if(pending.length>1)throw Error('pending count differs');
if(pending.length)await receive('/v1/queue/ack',{method:'POST',body:{ids:[pending[0].id]}});
const rest=(await receive('/v1/queue?limit=200')).items.filter(x=>ids.has(x.messageId));
if(rest.length)throw Error('still pending');
const pong=await gateway(base.replace('https:','wss:')+'/v1/ws',b);
if(!pong.authenticated)throw Error('no authenticated pong');
console.log(JSON.stringify({at:new Date().toISOString(),route:'restored production origin',signatureVerifiedHistory:own.length,lateAcks:pending.length,pendingForFour:0,newSends:0,authenticatedPong:true}));
