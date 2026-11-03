import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
export const sha=(s)=>crypto.createHash('sha256').update(s).digest('hex');
export function privateAddress(ip){
 if(net.isIP(ip)===4){const a=ip.split('.').map(Number);return a[0]===0||a[0]===10||a[0]===127||a[0]>=224||(a[0]===169&&a[1]===254)||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168)||(a[0]===100&&a[1]>=64&&a[1]<=127)||(a[0]===198&&[18,19].includes(a[1]));}
 if(net.isIP(ip)===6){const s=ip.toLowerCase();return s==='::'||s==='::1'||s.startsWith('fc')||s.startsWith('fd')||s.startsWith('fe8')||s.startsWith('fe9')||s.startsWith('fea')||s.startsWith('feb')||s.startsWith('ff')||s.startsWith('::ffff:');}return true;
}
export async function publicTarget(value){const u=new URL(value);if(!['https:','wss:'].includes(u.protocol)||u.username||u.password||u.port||u.hash||net.isIP(u.hostname)||!u.hostname.includes('.')||u.hostname.endsWith('.local'))throw new Error('unsafe_target');const ips=await dns.lookup(u.hostname,{all:true});if(!ips.length||ips.some(x=>privateAddress(x.address)))throw new Error('unsafe_target');return u;}
// Only configuration reads and idempotent sample uploads can be retried. A retry signs the
// identical bytes with a fresh nonce. It never repeats a probe, advances its slot, or claims mail twice.
export function signer(origin,keyId,key,fetchFn=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))){return async function request(path,{method='GET',data}={}){
 const body=data===undefined?'':JSON.stringify(data);
 const retryable=(method==='GET'&&path==='/api/internal/configuration')||(method==='POST'&&path==='/api/internal/samples');
 for(let attempt=0;;attempt++){
  const timestamp=String(Date.now()),nonce=crypto.randomUUID(),canonical=[method,path,timestamp,nonce,sha(body)].join('\n');
  try{
   const r=await fetchFn(new URL(path,origin),{method,headers:{'Content-Type':'application/json','x-monitor-key':keyId,'x-monitor-timestamp':timestamp,'x-monitor-nonce':nonce,'x-monitor-signature':crypto.createHmac('sha256',key).update(canonical).digest('hex')},...(body?{body}:{}),signal:AbortSignal.timeout(15000),redirect:'error'});
   if(!r.ok){await r.body?.cancel().catch(()=>{});throw Object.assign(new Error(`status_ingestion_http_${r.status}`),{status:r.status});}
   return await r.json();
  }catch(e){
   if(!retryable||attempt>=2||!([500,502,503,504].includes(e?.status)||['TypeError','TimeoutError'].includes(e?.name)))throw e;
   await pause([300,900][attempt]+Math.floor(Math.random()*150));
  }
 }
};}
export async function boundedText(response,max=262144){if(!response.body)return '';const reader=response.body.getReader(),chunks=[];let size=0;while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Error('response_too_large');}chunks.push(Buffer.from(value));}return Buffer.concat(chunks).toString('utf8');}
export async function jsonRequest(url,{method='GET',body,token,onStatus}={}){
 const r=await fetch(url,{method,headers:{'Content-Type':'application/json','Cache-Control':'no-cache',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000),redirect:'error'});
 onStatus?.(r.status);const text=await boundedText(r);if(!r.ok){const error=Error(`http_${r.status}`);try{error.code=JSON.parse(text)?.error?.code;}catch{}throw error;}return JSON.parse(text);
}
// Separate active TCP handshake, after DNS. This is neither HTTP duration nor an inferred residual.
export async function tcpHandshakeMs(host){
 try{
  const addresses=await dns.lookup(host,{all:true});const address=addresses.find(a=>a.family===4)??addresses[0];
  if(!address||addresses.some(a=>privateAddress(a.address)))return null;
  return await new Promise(resolve=>{
   const start=performance.now(),socket=net.connect({host:address.address,port:443,family:address.family});
   function done(value){socket.destroy();resolve(value);}
   socket.setTimeout(3000,()=>done(null));socket.once('error',()=>done(null));socket.once('connect',()=>done(+(performance.now()-start).toFixed(3)));
  });
 }catch{return null;}
}
export function cycleHttp(location,resolveTarget=publicTarget,request=fetch){
 const cycle=new Map();
 return (url,attempt)=>{
  const key=url+'#'+attempt;
  if(!cycle.has(key))cycle.set(key,(async()=>{
   const start=performance.now(),u=await resolveTarget(url);
   const requestId=location+'-'+crypto.randomUUID();u.searchParams.set('status_probe',requestId);
   const r=await request(u,{headers:{'Cache-Control':'no-cache','User-Agent':'MeldiqStatus/1.0'},signal:AbortSignal.timeout(8000),redirect:'error'});
   const text=await boundedText(r);
   return {requestId,text,status:r.status,ok:r.ok,latencyMs:Math.round(performance.now()-start),observedAt:Date.now()};
  })());
  return cycle.get(key);
 };
}
