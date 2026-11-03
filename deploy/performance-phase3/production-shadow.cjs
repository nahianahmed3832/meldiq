// Instrument only read-only snapshots. This program never starts the API, acquires its writer lease, or publishes rows.
const fs=require('fs'),pg=require('pg');
(async()=>{
const {PreparedPages}=await import('/app/dist/infrastructure/database/rows/preparedPages.js');
const {MeldiqPostgres}=await import('/app/dist/infrastructure/database/postgres/client.js');
const {tableSpecs}=await import('/app/dist/infrastructure/database/mongo/catalog.js');
const {safeTypes}=await import('/app/dist/infrastructure/database/postgres/client.js');
const opt={url:process.env.PERF_PROBE_URL,ca:fs.readFileSync('/ca.pem','utf8'),environment:'production',maxConnections:2};
const db=new MeldiqPostgres(opt),specs=tableSpecs(),at=Date.now(),mark=()=>Date.now()-at;
let captured,reader;
try{
 captured=await PreparedPages.capture(db,specs);const preparedMs=mark();
 reader=await db.connect();const from=mark();
 await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const data=await captured.reconcile(reader),verifiedMs=mark()-from;
 const skip=new Set(['files','preferences','history','reports','relationships','calls']);
 const names=specs.filter(s=>!skip.has(s.domain)&&!['resource_samples','delivery_queue','account_recovery_codes','account_recovery_tickets','account_key_backups','account_key_unlocks'].includes(s.name)).map(s=>s.name).concat('auth_device_sessions');
 if(names.some(x=>!/^[a-z][a-z0-9_]*$/.test(x)))throw Error('relation');
 let rest=0;const q=new pg.Query({text:names.map(t=>'SELECT * FROM meldiq."'+t+'"').join(';')});
 await new Promise((ok,no)=>{q.on('row',()=>rest++);q.once('error',no);q.once('end',ok);reader.query(q);});
 const finalReadMs=mark()-from;await reader.query('ROLLBACK');
 console.log(JSON.stringify({at:new Date().toISOString(),preparedMs,verifiedMs,finalReadMs,preparedRows:data.reduce((n,x)=>n+x[1].rows.size,0),otherRows:rest,rssMiB:Math.round(process.memoryUsage.rss()/1048576),writerLease:false,role:'read-only diagnostics; exact production tables; no active API bootstrap'}));
}finally{captured?.discard();reader?.release(true);await db.close();}})().catch(e=>{console.error('shadow failed',String(e.code??e.name).slice(0,24));process.exitCode=1;});
