import fs from "node:fs";
import crypto from "node:crypto";
import {GriipClient} from "./griipClient.mjs";
if(process.env.MELDIQ_OWNED_CANARY!=="synthetic-loopback")throw new Error("Owned canary only");
const base="http://127.0.0.1:8080",clients=[],report={ok:false,synthetic:true,ownedNetworkOnly:true,productionChanged:false,simulatedDatabaseRoundTripMilliseconds:168,unifiedSupabaseAuthTested:false,managedRealtimeTested:false,phase:"register"};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(predicate,timeout=30_000){const end=performance.now()+timeout;while(performance.now()<end){if(predicate())return;await pause(50);}throw new Error("Owned canary condition timed out");}
const quantile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
try{
  const alice=new GriipClient(base,"canaryalice"),bob=new GriipClient(base,"canarybob");clients.push(alice,bob);
  await alice.register();await bob.register();await alice.connect();await bob.connect();
  const conversation=(await alice.req("POST","/v1/conversations/dm",{userId:bob.userId})).conversation.id;
  const latencies=[],sent=[],total=20,concurrency=4;let next=0;
  report.phase="message-load";
  const started=performance.now();
  await Promise.all(Array.from({length:concurrency},async()=>{
    while(next<total){const index=next++,messageId=crypto.randomBytes(12).toString("base64url"),sentAt=Date.now();
      const start=performance.now();const response=await alice.req("POST","/v2/messages",{conversationId:conversation,messageId,cls:"message",sentAt,payload:{type:"text",text:"owned-load-"+index}});
      if(response.duplicate)throw new Error("Unexpected duplicate message");
      latencies.push(performance.now()-start);sent.push({messageId,index,sentAt,serverTs:response.serverTs});
    }
  }));
  report.messageLoad={requests:total,concurrency,errors:0,elapsedMilliseconds:Math.round(performance.now()-started),p50Milliseconds:Math.round(quantile(latencies,0.5)),p95Milliseconds:Math.round(quantile(latencies,0.95)),maxMilliseconds:Math.round(Math.max(...latencies))};
  await bounded(()=>bob.received.length>=total);
  const seen=new Set(bob.received.map(row=>row.messageId));
  if(sent.some(row=>!seen.has(row.messageId))||seen.size!==total)throw new Error("WebSocket delivery lost or duplicated messages");
  report.websocketMessages=seen.size;
  const initial=await bob.req("GET",`/v2/conversations/${conversation}/messages`);
  if(initial.messages.length!==total||sent.some(row=>!initial.messages.some(message=>message.id===row.messageId&&message.payload.text==="owned-load-"+row.index)))throw new Error("History reconciliation failed");
  const retry=await alice.req("POST","/v2/messages",{conversationId:conversation,messageId:sent[0].messageId,cls:"message",sentAt:sent[0].sentAt,payload:{type:"text",text:"owned-load-"+sent[0].index}});
  if(!retry.duplicate||retry.serverTs!==sent[0].serverTs)throw new Error("Idempotent retry failed");
  await alice.disconnect();await bob.disconnect();
  fs.writeFileSync("/control/ready-for-rollback.json",JSON.stringify({ready:true,committedMessages:total})+"\n");
  report.phase="wait-for-rollback";
  await bounded(()=>fs.existsSync("/control/rollback-ready.json"),120_000);
  await alice.connect();await bob.connect();
  const after=await bob.req("GET",`/v2/conversations/${conversation}/messages`);
  if(after.messages.length!==total||sent.some(row=>!after.messages.some(message=>message.id===row.messageId&&message.payload.text==="owned-load-"+row.index)))throw new Error("Rollback discarded committed messages");
  const finalId=crypto.randomBytes(12).toString("base64url");
  await alice.req("POST","/v2/messages",{conversationId:conversation,messageId:finalId,cls:"message",sentAt:Date.now(),payload:{type:"text",text:"after-compatible-rollback"}});
  await bounded(()=>bob.received.some(row=>row.messageId===finalId));
  const final=await bob.req("GET",`/v2/conversations/${conversation}/messages`);
  if(final.messages.length!==total+1)throw new Error("Post-rollback writes failed");
  report.retainedSessionTokensAfterRollback=true;report.committedMessagesRetainedAfterRollback=total;report.postRollbackMessages=1;report.idempotentRetryPassed=true;report.phase="complete";report.ok=true;
}catch(error){report.errorCode=error?.status?"http_"+error.status:"canary_failed";process.exitCode=1;}
finally{
  await Promise.allSettled(clients.map(client=>client.disconnect()));
  report.completedAt=new Date().toISOString();fs.writeFileSync("/control/client-report.json",JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report));
}
