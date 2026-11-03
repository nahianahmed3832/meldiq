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
 const spare=await db.connect();try{await spare.query('SELECT 1');}finally{spare.release();}
 fs.writeFileSync(dir+'/prepared-'+slot,plan.nonce,{mode:0o600,flag:'wx'});
 const deadline=Math.min(plan.expires,Date.now()+20000);
 while(!fs.existsSync(dir+'/start-'+slot)&&Date.now()<deadline)await pause(5);
 if(Date.now()>=deadline||read(dir+'/start-'+slot)!==plan.nonce)throw Error('standby not released for this attempt');
 PreparedPages.prototype.reconcile=function(...args){
   PreparedPages.prototype.reconcile=normalReconcile;
   // open() has acquired the exclusive writer lease. No prepared reader performs writes.
   const count=Math.max(0,Math.min(4,(db.config.maxConnections??5)-2));
   void Promise.allSettled(Array.from({length:count},async()=>{const c=await db.connect();c.release();}));
   return normalReconcile.apply(this,args);
 };
 return normalOpen.call(PostgresRows,db,specs);
};
await import('/app/dist/index.js');
