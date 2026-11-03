// Private ingress. No shared cache, no database credentials and no retry of a dispatched HTTP request.
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import {createRequire} from 'node:module';
const {WebSocket, WebSocketServer}=createRequire('/app/package.json')('ws');
const upstream=Number(process.env.WRITER_PORT??8080), front=Number(process.env.FRONT_PORT??18087);
const limit=7500, maxWaiting=128, peers=new Set(), wait=new Set(), active=new Set();
let state='open', generation=0, expires=0, admissions=0, checking=false;
const stats={peakWaiting:0,expired:0,externalAccepted:0,resumed:0,suppressedRedeliveries:0,dispatched:0};
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
const hops=['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','proxy-connection'];
function headers(h){const copy={...h};for(const k of [...hops,...String(h.connection??'').toLowerCase().split(',').map(x=>x.trim())])delete copy[k];return copy;}
function fail(res,code){if(!res.headersSent)res.writeHead(code,{'cache-control':'no-store','content-type':'application/json'});res.end('{"error":"origin unavailable"}');}
const server=http.createServer((req,res)=>{
  if(!req.url?.startsWith('/')||req.url.startsWith('//'))return fail(res,400);
  function send(){
    if(res.destroyed||req.aborted)return;
    const q=http.request({hostname:'127.0.0.1',port:upstream,path:req.url,method:req.method,headers:headers(req.headers),agent:false},r=>{
      const h=headers(r.headers);
      if(req.url.split('?')[0]==='/v2/messages/summary')h['cache-control']='private, no-store';
      res.writeHead(r.statusCode,h);r.on('error',()=>res.destroy());r.pipe(res);
    });
    active.add(q);stats.dispatched++;
    q.on('error',()=>{if(!res.destroyed){if(res.headersSent)res.destroy();else fail(res,502);}});
    q.on('close',()=>active.delete(q));
    res.on('close',()=>{if(!res.writableFinished)q.destroy();});
    req.on('aborted',()=>q.destroy());req.pipe(q);
  }
  if(state==='open')return send();
  if(Date.now()>expires||wait.size>=maxWaiting)return fail(res,503);
  const cleanup=()=>{clearTimeout(timer);wait.delete(resume);};
  const resume=()=>{cleanup();send();};
  const timer=setTimeout(()=>{cleanup();stats.expired++;fail(res,503);},limit);
  wait.add(resume);stats.peakWaiting=Math.max(stats.peakWaiting,wait.size);
  res.once('close',cleanup);
});
const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/v1/ws'||peers.size>=2048){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});
wss.on('connection',(out,req)=>{
  stats.externalAccepted++;admissions++;
  let token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1],identity,back,verified=false,queue=[],bytes=0,barrier=null,previousPings=0,deadline=null;
  const bound=()=>{if(!deadline)deadline=setTimeout(()=>out.close(1013,'writer unavailable'),limit);};
  // Per-external-socket ledger. An upstream restart replays unacknowledged queue rows.
  // A delivery seen by this same external socket is already in the client transport.
  const delivered=new Map(), needsBacklog=new Set();
  async function eligible(){
    // A managed session can remain valid on the original socket after its bearer rotated.
    // Do not detach it or trust an identity asserted by the proxy. Only an authenticated
    // v1 session may be handed to this release. JWTs, half-open and ambiguous sessions veto.
    if(!verified||!identity||!token||token.includes('.'))return false;
    const options={headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(2000)};
    try{
      const path='http://127.0.0.1:'+upstream;
      const account=await fetch(path+'/v2/account/sessions',options);
      await account.body?.cancel();if(account.status!==401)return false;
      const me=await fetch(path+'/v1/users/me',options);
      if(!me.ok){await me.body?.cancel();return false;}
      return (await me.json()).user?.id===identity[0] && verified;
    }catch{return false;}
  }
  const p={resume:()=>connect(),drain:()=>drain(),eligible};
  peers.add(p);
  const close=(c,r)=>out.close(c,r);
  const offer=(sock,data)=>{if(sock.readyState!==1)return false;if(sock.bufferedAmount+Buffer.byteLength(data)>2*1024*1024){close(1013,'slow connection');return false;}sock.send(data,{binary:false});return true;};
  const append=data=>{if(queue.length>=64||bytes+data.length>65536){close(1013,'frame queue full');return;}queue.push(data);bytes+=data.length;};
  const authTimeout=setTimeout(()=>{if(!token)close(4401,'unauthorized');},5000);
  // An upstream library answers wire pings locally. Independently check the actual external peer.
  let alive=true;
  const heartbeat=setInterval(()=>{if(!alive){out.terminate();return;}alive=false;if(out.readyState===1)out.ping();},30000);
  heartbeat.unref();out.on('pong',()=>{alive=true;});
  out.on('error',()=>{});
  out.on('close',()=>{clearInterval(heartbeat);clearTimeout(authTimeout);clearTimeout(deadline);peers.delete(p);token=null;queue=[];back?.terminate();});
  function forward(raw){
    try{const f=JSON.parse(raw);if(f.t==='ping')previousPings++;
      if(f.t==='ack'&&Array.isArray(f.ids)){
        let restart=false;
        for(const id of f.ids.slice(0,500)){const v=delivered.get(id);if(v)v.acked=true;if(needsBacklog.delete(id))restart=true;}
        if(restart&&!f.backlog)raw=JSON.stringify({...f,backlog:true});
      }
    }catch{}return offer(back,raw);
  }
  function relayQueue(f,raw,u){
    if(!Array.isArray(f.items)||!f.items.length)return offer(out,raw);
    const fresh=[],acked=[];
    for(const item of f.items){
      if(!Number.isSafeInteger(item.id))return close(1011,'invalid queue id');
      const key=JSON.stringify([item.kind,item.messageId,item.conversationId]),prior=delivered.get(item.id);
      if(prior){
        if(prior.key!==key)return close(1011,'queue identity changed');
        stats.suppressedRedeliveries++;if(prior.acked)acked.push(item.id);
        else if(f.backlog&&f.more)needsBacklog.add(item.id);
        continue;
      }
      if(delivered.size>=4096){
        const evict=[...delivered].find(([,v])=>v.acked);
        if(!evict)return close(1013,'pending receipt limit');
        delivered.delete(evict[0]);
      }
      delivered.set(item.id,{key,acked:false});fresh.push(item);
    }
    if(acked.length)offer(u,JSON.stringify({t:'ack',ids:acked,backlog:!!(f.more&&f.backlog&&fresh.length===0&&needsBacklog.size===0)}));
    if(fresh.length)offer(out,fresh.length===f.items.length?raw:JSON.stringify({...f,items:fresh}));
  }
  function connect(){
    if(back||!token||out.readyState!==1||state!=='open')return;
    const h=headers(req.headers);for(const k of Object.keys(h))if(k.startsWith('sec-websocket-'))delete h[k];
    h.authorization='Bearer '+token;
    const u=new WebSocket('ws://127.0.0.1:'+upstream+'/v1/ws',{headers:h,handshakeTimeout:5000,perMessageDeflate:false,maxPayload:8*1024*1024});
    back=u;verified=false;previousPings=0;
    u.on('error',()=>{});
    u.on('message',raw=>{
      let f;try{f=JSON.parse(raw);}catch{return close(1011,'invalid upstream frame');}
      if(f.t==='hello'){
        if(!f.userId||!f.deviceId||identity&&(identity[0]!==f.userId||identity[1]!==f.deviceId))return close(4401,'session changed');
        verified=true;clearTimeout(deadline);deadline=null;
        if(!identity){identity=[f.userId,f.deviceId];offer(out,raw);}else stats.resumed++;
        if(state==='open'){for(const d of queue)forward(d);queue=[];bytes=0;}
      }else if(verified){
        if(f.t==='pong'){if(previousPings>0)previousPings--;else if(barrier){barrier();return;}}
        if(f.t==='queue')relayQueue(f,raw,u);else offer(out,raw);
      }
    });
    u.on('close',(code)=>{
      back=null;verified=false;barrier?.();barrier=null;
      if(out.readyState!==1)return;
      // A policy, quota, normal logout or unexpected failure is never a release handoff.
      if((code>=4000&&code<5000)||code===1008)return close(code,'writer rejected session');
      if(state==='open')return close(code===1000?1000:1011,'writer disconnected');
      bound();
    });
  }
  async function drain(){
    bound();const u=back;
    if(!u)return;
    if(verified&&u.readyState===1){
      // Writer serializes frames by device. A real authenticated pong fences previously sent ACKs.
      await new Promise((ok,no)=>{const t=setTimeout(()=>{barrier=null;no(Error('WS drain timeout'));},2200);
        barrier=()=>{clearTimeout(t);barrier=null;ok();};u.send('{"t":"ping"}');});
    }
    if(u.readyState!==3){const end=new Promise(ok=>u.once('close',ok));u.close(1000,'writer handoff');await end;}
  }
  out.on('message',(raw,binary)=>{
    if(binary)return close(1003,'text required');
    if(!token){
      try{const f=JSON.parse(raw);if(raw.length>1024||f.t!=='auth'||typeof f.token!=='string'||!f.token)throw Error();
        token=f.token;clearTimeout(authTimeout);if(state!=='open')bound();connect();
      }catch{close(4401,'unauthorized');}return;
    }
    if(state==='open'&&verified)forward(raw);else append(raw);
  });
  if(state!=='open')bound();connect();
});
// This interface is a private Unix socket, never an HTTP route at the public listener.
const controls=http.createServer(async(req,res)=>{
  const answer=(code,body)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  if(req.method==='GET'&&req.url==='/state')return answer(200,{state,generation,waiting:wait.size,active:active.size,peers:peers.size,...stats});
  if(process.env.INGRESS_CANARY_ONLY==='1')return answer(403,{error:'canary has no writer control'});
  try{
    if(req.method==='POST'&&req.url==='/drain'&&state==='open'){
      // Check while the incumbent is still serving. On failure no peer or request is held.
      if(checking||peers.size>24)return answer(409,{error:'defer release'});
      checking=true;const version=admissions;
      let ok=false;try{ok=(await Promise.all([...peers].map(p=>p.eligible()))).every(Boolean);}
      finally{checking=false;}
      if(!ok||version!==admissions||state!=='open')return answer(409,{error:'defer release'});
      state='draining';expires=Date.now()+limit;
      await Promise.all([...peers].map(p=>p.drain()));
      const until=Date.now()+2500;while(active.size&&Date.now()<until)await pause(10);
      if(active.size)throw Error('HTTP drain deadline');
      state='held';return answer(200,{held:true});
    }
    if(req.method==='POST'&&req.url==='/resume'&&['held','draining'].includes(state)){
      // Release operator also verifies image, mounts, authority and its private readiness before calling.
      const h=await (await fetch('http://127.0.0.1:'+upstream+'/healthz',{signal:AbortSignal.timeout(2000)})).json();
      if(!h.ok||!h.postgres)throw Error('writer not ready');
      state='open';generation++;for(const p of peers)p.resume();for(const release of [...wait])release();
      return answer(200,{open:true,generation});
    }
    answer(409,{error:'invalid transition'});
  }catch{answer(503,{error:'drain or readiness failed'});}
});
const sock=process.env.CONTROL_SOCKET??'/control/handoff.sock';
if(fs.existsSync(sock)){
  const st=fs.lstatSync(sock);if(!st.isSocket()||st.uid!==process.getuid())throw Error('unsafe control path');
  const active=await new Promise(ok=>{const peer=net.connect(sock);peer.once('connect',()=>{peer.destroy();ok(true);});peer.once('error',e=>ok(e.code!=='ECONNREFUSED'));});
  if(active)throw Error('control already owned');fs.unlinkSync(sock);
}
controls.listen(sock,()=>fs.chmodSync(sock,0o600));
server.listen(front,'127.0.0.1');
