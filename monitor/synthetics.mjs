import crypto from 'node:crypto';
import WebSocket from 'ws';
import {jsonRequest} from './transport.mjs';
import {Aes256Gcm,CipherSuite,DhkemX25519HkdfSha256,HkdfSha256} from '@hpke/core';
const suite=new CipherSuite({kem:new DhkemX25519HkdfSha256(),kdf:new HkdfSha256(),aead:new Aes256Gcm()});
const info=Buffer.from('griip-envelope-v1/key');
export async function authenticate(identity,base){
 const challenge=await jsonRequest(`${base}/v1/auth/challenge`,{method:'POST',body:{}});
 const message=`griip-auth-v1\nlogin\n${challenge.nonce}\n${identity.signingKey}`;
 const signature=crypto.sign(null,Buffer.from(message),identity.privateKey).toString('base64');
 return jsonRequest(`${base}/v1/auth/login`,{method:'POST',body:{deviceId:identity.deviceId,nonce:challenge.nonce,signature}});
}
export async function gateway(url,session){return new Promise((resolve,reject)=>{
 const ws=new WebSocket(url,{headers:session?{Authorization:`Bearer ${session.sessionToken}`}:{},handshakeTimeout:6000,maxPayload:65536,followRedirects:false});
 const start=performance.now();let hello=false,transport=false;const timer=setTimeout(()=>done(Error('gateway_timeout')),8000);
 function done(error){clearTimeout(timer);ws.removeAllListeners();ws.on('error',()=>{});ws.close();if(ws.readyState!==WebSocket.CLOSED)ws.terminate();if(error)reject(error);else resolve({latencyMs:performance.now()-start,authenticated:hello,transport});}
 ws.on('error',()=>done(Error('gateway_connection_failed')));ws.on('unexpected-response',(_req,res)=>{res.resume();done(Error(`http_${res.statusCode}`));});
 ws.on('open',()=>{ws.ping('status');});
 ws.on('pong',()=>{transport=true;if(!session)done(null);});
 ws.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(m.t==='hello'){hello=true;ws.send(JSON.stringify({t:'ping'}));}if(m.t==='pong'&&hello)done(null);}catch{done(Error('gateway_invalid_frame'));}});
 ws.on('close',()=>done(Error('gateway_closed_early')));
 });}
export async function sealSynthetic(synthetic,session){
 const messageId=`status_${crypto.randomUUID()}`,sentAt=Date.now(),cls=synthetic.receiverUserId?'message':'control';
 const header=`griip-envelope-v1\n${messageId}\n${synthetic.conversationId}\n${session.userId}\n${session.deviceId}\n${sentAt}\n${cls}`;
 const plaintext=JSON.stringify({t:'status-monitor',nonce:crypto.randomUUID()}),contentKey=crypto.randomBytes(32),nonce=crypto.randomBytes(12);
 try{
  const aes=await crypto.subtle.importKey('raw',contentKey,{name:'AES-GCM'},false,['encrypt']);
  const ciphertext=Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:Buffer.from(header)},aes,Buffer.from(plaintext))).toString('base64');
  const recipientPublicKey=await suite.kem.deserializePublicKey(Buffer.from(synthetic.receiver.encryptionKey,'base64'));
  const wrapped=await suite.seal({recipientPublicKey,info},contentKey,Buffer.from(`${messageId}\n${synthetic.receiver.deviceId}`));
  const nonceB64=nonce.toString('base64'),signature=crypto.sign(null,Buffer.from(`${header}\n${nonceB64}\n${ciphertext}`),synthetic.identity.privateKey).toString('base64');
  return {header,plaintext,envelope:{messageId,conversationId:synthetic.conversationId,sentAt,cls,nonce:nonceB64,ciphertext,signature,...(synthetic.receiverUserId?{}:{audience:'self'}),recipients:[{deviceId:synthetic.receiver.deviceId,enc:Buffer.from(wrapped.enc).toString('base64'),wrappedKey:Buffer.from(wrapped.ct).toString('base64')}]}};
 }finally{contentKey.fill(0);}
}
export async function openSynthetic(synthetic,sealed,payload){
 const publicKey=crypto.createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(synthetic.identity.signingKey,'base64').toString('base64url')}});
 if(!crypto.verify(null,Buffer.from(`${sealed.header}\n${payload.nonce}\n${payload.ciphertext}`),publicKey,Buffer.from(payload.signature,'base64')))throw Error('synthetic_signature_failed');
 const privateKey=await crypto.subtle.importKey('pkcs8',Buffer.from(synthetic.receiver.encryptionPrivateKey,'base64'),{name:'X25519'},false,['deriveBits']);
 const pub=await crypto.subtle.importKey('raw',Buffer.from(synthetic.receiver.encryptionKey,'base64'),{name:'X25519'},true,[]);
 const raw=await suite.open({recipientKey:{privateKey,publicKey:pub},enc:Buffer.from(payload.enc,'base64'),info},Buffer.from(payload.wrappedKey,'base64'),Buffer.from(`${sealed.envelope.messageId}\n${synthetic.receiver.deviceId}`));
 const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
 const plaintext=Buffer.from(await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(payload.nonce,'base64'),additionalData:Buffer.from(sealed.header)},key,Buffer.from(payload.ciphertext,'base64'))).toString();
 if(plaintext!==sealed.plaintext)throw Error('synthetic_plaintext_mismatch');
 return true;
}
async function liveReceiver(url,receiver,sealed){
 const ws=new WebSocket(url,{headers:{Authorization:'Bearer '+receiver.sessionToken},handshakeTimeout:6000,maxPayload:1048576,followRedirects:false});
 let ready,receive;
 const hello=new Promise((resolve,reject)=>{ready={resolve,reject}}),arrival=new Promise((resolve,reject)=>{receive={resolve,reject}});
 // A closed socket may reject before the HTTP submission completes.
 arrival.catch(()=>{});
 const fail=()=>{const e=Error('gateway_delivery_unavailable');ready.reject(e);receive.reject(e);};
 const timeout=setTimeout(fail,15000);
 ws.on('error',fail);ws.on('close',fail);ws.on('message',data=>{try{
  const frame=JSON.parse(data);
  if(frame.t==='hello'&&frame.userId===receiver.userId&&frame.deviceId===receiver.deviceId)ready.resolve();
  if(frame.t==='queue'){const row=frame.items.find(i=>i.messageId===sealed.envelope.messageId&&i.conversationId===sealed.envelope.conversationId);if(row)receive.resolve(row);}
 }catch{fail();}});
 const close=()=>{clearTimeout(timeout);ws.terminate();};
 try{await hello;return {arrival,close};}catch(e){close();throw e;}
}
export async function messageRoundtrip(synthetic,session){
 if(!synthetic?.conversationId||!synthetic.identity||!synthetic.receiver||!session)throw Error('monitoring_identity_required');
 if(session.userId!==synthetic.userId)throw Error('synthetic_isolation_unverified');
 const base=synthetic.base??'https://msg.meldiq.app';
 const peer=synthetic.receiverUserId??session.userId;
 const [c,receiver]=await Promise.all([jsonRequest(`${base}/v1/conversations/${synthetic.conversationId}/members`,{token:session.sessionToken}),authenticate(synthetic.receiver,base)]);
 const members=new Set(c.members?.map(m=>m.id)),expected=new Set([session.userId,peer]);
 if(!Array.isArray(c.members)||c.members.length!==expected.size||[...expected].some(id=>!members.has(id))||receiver.userId!==peer||receiver.deviceId!==synthetic.receiver.deviceId)throw Error('synthetic_isolation_unverified');
 const wsUrl=base.replace('https:','wss:')+'/v1/ws';

 const sealed=await sealSynthetic(synthetic,session);
 const payload={type:'status-monitor',sealed:{...sealed.envelope,...sealed.envelope.recipients[0]}};
 const live=synthetic.receiverUserId?await liveReceiver(wsUrl,receiver,sealed):null;
 try{
 const deliveryStart=performance.now();
 let submissionHttpStatus=null;
 const sent=await jsonRequest(`${base}/v2/messages`,{method:'POST',token:session.sessionToken,onStatus:code=>{submissionHttpStatus=code},body:{conversationId:synthetic.conversationId,messageId:sealed.envelope.messageId,cls:sealed.envelope.cls,sentAt:sealed.envelope.sentAt,...(synthetic.receiverUserId?{}:{audience:'self'}),payload}});
 if(sent.messageId!==sealed.envelope.messageId)throw Error('message_acknowledgement_failed');
 let liveMs;
 if(live){
  const event=await live.arrival;
  if(event.senderUserId!==session.userId||event.senderDeviceId!==session.deviceId)throw Error('synthetic_delivery_mismatch');
  await openSynthetic(synthetic,sealed,event.payload?.event?.payload?.sealed??{});
  liveMs=Math.round(performance.now()-deliveryStart);
  live.close();
 }
 let item;
 for(let attempt=0;attempt<3&&!item;attempt++){
  const queue=await jsonRequest(`${base}/v1/queue?limit=200`,{token:receiver.sessionToken});
  item=queue.items.find(i=>i.messageId===sealed.envelope.messageId&&i.conversationId===synthetic.conversationId&&i.senderUserId===session.userId&&i.senderDeviceId===session.deviceId&&i.kind==='message');
  if(!item)await new Promise(r=>setTimeout(r,150));
 }
 if(!item)throw Error('message_delivery_failed');
 if(item.payload?.event?.audience&&item.payload.event.audience!=='self')throw Error('synthetic_isolation_unverified');
 await openSynthetic(synthetic,sealed,item.payload?.event?.payload?.sealed??{});
 const deliveryMs=Math.round(performance.now()-deliveryStart);
 await jsonRequest(`${base}/v1/queue/ack`,{method:'POST',token:receiver.sessionToken,body:{ids:[item.id]}});
 const remaining=await jsonRequest(`${base}/v1/queue?limit=200`,{token:receiver.sessionToken});if(remaining.items.some(i=>i.id===item.id))throw Error('message_acknowledgement_failed');
 if(synthetic.receiverUserId){
  await gateway(wsUrl,receiver);
  const page=await jsonRequest(`${base}/v2/conversations/${synthetic.conversationId}/messages?around=${sealed.envelope.messageId}&limit=3`,{token:receiver.sessionToken});
  const saved=page.messages?.find(m=>m.id===sent.messageId&&m.serverTs===sent.serverTs&&m.senderUserId===session.userId&&m.conversationId===synthetic.conversationId);
  if(!saved)throw Error('message_history_failed');
  await openSynthetic(synthetic,sealed,saved.payload.sealed);
 }
 return {delivered:true,submissionHttpStatus,deliveryMs:liveMs??deliveryMs};
 }finally{live?.close();}
}
