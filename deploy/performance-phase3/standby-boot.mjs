// Optional entry point for a private staged candidate. The normal server owns ALL setup,
// listening, jobs, auth and shutdown. Only postpone entry to its PostgresRows writer lock.
import fs from 'node:fs';import {setTimeout as pause} from 'node:timers/promises';
import {PostgresRows} from '/app/dist/infrastructure/database/rows/postgresRows.js';
import {PreparedPages} from '/app/dist/infrastructure/database/rows/preparedPages.js';
import {DatabaseCutover} from '/app/dist/app/databaseCutover.js';
const dir='/control',slot=process.env.SLOT;
if(!['candidate','fallback'].includes(slot))throw Error('explicit standby required');
const privateDir=fs.lstatSync(dir);
if(!privateDir.isDirectory()||privateDir.isSymbolicLink()||privateDir.uid!==process.getuid()||(privateDir.mode&0o077))throw Error('private release mount required');
function read(file){
 const s=fs.lstatSync(file);
 if(!s.isFile()||s.isSymbolicLink()||![0,process.getuid()].includes(s.uid)||(s.mode&0o022)||s.size>4096)throw Error('unsafe release control');
 return fs.readFileSync(file,'utf8');
}
const plan=JSON.parse(read(dir+'/plan-'+slot));
if(!/^[a-f0-9]{48}$/.test(plan.nonce)||plan.slot!==slot||!Number.isSafeInteger(plan.expires)||plan.expires<Date.now()||plan.expires>Date.now()+120000)throw Error('invalid release attempt');
const normalOpen=PostgresRows.open,normalReconcile=PreparedPages.prototype.reconcile;
PostgresRows.open=async function(db,specs){
 PostgresRows.open=normalOpen;
 const owned=process.env.MELDIQ_OWNED_CANARY==='synthetic-loopback'&&db.config.environment==='development'&&db.config.url==='postgresql://meldiq_canary_runtime@127.0.0.1:55433/postgres';
 if(!owned){
   const a=db.config.productionAcceptance;
   if(db.config.environment!=='production'||!a||!db.config.projectRef||new DatabaseCutover('/data',db.config.projectRef,a.sourceSha256).held)
     throw Error('accepted production authority required');
 }
 // postgresRuntime has already checked role/schema using this pool. Capture and the
 // spare idle session are read-only; failure leaves the incumbent's lease untouched.
 let prepared=false;
 for(let n=0;n<8&&!prepared;n++){
   try{await PostgresRows.prepare(db,specs);prepared=true;}
   catch(e){if(!['53300','ECONNRESET'].includes(e.code)||Date.now()+5000>=plan.expires)throw e;await pause(4000);}
 }
 if(!prepared)throw Error('could not reserve read-only preparation');
 const pinned=plan.pinnedSession===true;
 if(pinned&&!plan.waitForRelease)throw Error('pinned lease requires a fenced handoff');
 let reserved=await db.connect();
 try{
   if(pinned)await reserved.query("SET lock_timeout='3750ms'");
   else await reserved.query('SELECT 1');
 }catch(e){reserved.release(true);throw e;}
 if(!pinned){reserved.release();reserved=null;}
 try{
 fs.writeFileSync(dir+'/prepared-'+slot,plan.nonce,{mode:0o600,flag:'wx'});
 const deadline=Math.min(plan.expires,Date.now()+20000);
 while(!fs.existsSync(dir+'/start-'+slot)&&Date.now()<deadline)await pause(5);
 if(Date.now()>=deadline||read(dir+'/start-'+slot)!==plan.nonce)throw Error('standby not released for this attempt');
 PreparedPages.prototype.reconcile=async function(...args){
   PreparedPages.prototype.reconcile=normalReconcile;
   // open() has acquired the exclusive writer lease. No prepared reader performs writes.
   const count=Math.max(0,Math.min(4,(db.config.maxConnections??5)-(pinned?1:2)));
   void Promise.allSettled(Array.from({length:count},async()=>{const c=await db.connect();c.release();}));
   const states=await normalReconcile.apply(this,args);
   // Exact tuple verification has completed in the writer's own repeatable snapshot.
   // No later read depends on the old snapshot. Free its slot while the writer is
   // still streaming the other tables, so the final service connection can warm now.
   if(pinned)this.discard();
   return states;
 };
 if(plan.waitForRelease===true){
   // The incumbent may still be closing its jobs when the private operator opens
   // the gate. Wait on the *same physical session* that normal open() will use;
   // its own advisory-lock check is then reentrant. Both holds end on close/destroy.
   const connect=db.connect;
   db.connect=async function(){
     db.connect=connect;
     const lease=reserved??await connect.call(db);
     reserved=null;
     if(pinned){
       const query=lease.query;
       lease.query=function(sql,...args){
         lease.query=query;
         if(args.length||sql!=="SELECT pg_try_advisory_lock(hashtextextended('meldiq-rows-writer', 0)) AS locked")
           throw Error('unexpected pinned writer protocol');
         // The pinned image must perform its usual try-lock. Wait and re-check on the
         // same backend in one round trip. A failure destroys this session in normalOpen.
         return query.call(lease,"WITH acquired AS MATERIALIZED (SELECT pg_advisory_lock(hashtextextended('meldiq-rows-writer',0))) SELECT pg_try_advisory_lock(hashtextextended('meldiq-rows-writer',0)) AS locked, set_config('lock_timeout','0',false) AS reset FROM acquired");
       };
       return lease;
     }
     try{
       await lease.query("SET lock_timeout='3750ms'; SELECT pg_advisory_lock(hashtextextended('meldiq-rows-writer',0)); RESET lock_timeout");
       return lease;
     }catch(e){lease.release(true);throw e;}
   };
 }
 return await normalOpen.call(PostgresRows,db,specs);
 }finally{reserved?.release(true);}
};
await import('/app/dist/index.js');
