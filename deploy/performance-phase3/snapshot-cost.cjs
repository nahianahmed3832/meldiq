// Lower bound for a fresh fenced writer: stream the real cache's SELECTs through one read-only diagnostics session.
// No writer lock, persisted rows, row values in logs, application mutation or production role grants.
const pg=require('pg'),fs=require('fs');
(async()=>{
const {tableSpecs}=await import('/app/dist/infrastructure/database/mongo/catalog.js');
const skip=new Set(['files','preferences','history','reports','relationships','calls']);
const names=tableSpecs().filter(s=>!skip.has(s.domain)&&!['account_recovery_codes','account_recovery_tickets','account_key_backups','account_key_unlocks'].includes(s.name)).map(s=>s.name).concat('auth_device_sessions');
if(names.some(s=>!/^\w+$/.test(s)))throw Error();
const p=new pg.Pool({connectionString:process.env.PERF_PROBE_URL,ssl:{rejectUnauthorized:true,ca:fs.readFileSync('/ca.pem')},max:1,statement_timeout:20000,application_name:'meldiq-phase3-cost'});
const c=await p.connect();let count=0;
try{
await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout='500ms'");
const at=performance.now();
const q=new pg.Query({text:names.map(s=>'SELECT * FROM meldiq."'+s+'"').join(';')});
await new Promise((ok,no)=>{q.on('row',()=>count++);q.once('error',no);q.once('end',ok);c.query(q);});
console.log(JSON.stringify({at:new Date().toISOString(),queries:names.length,rows:count,wireAndDecodeMs:Math.round(performance.now()-at),session:'read-only; no cache constructed'}));
await c.query('ROLLBACK');
}finally{c.release(true);await p.end();}})().catch(()=>{console.error('snapshot probe failed');process.exitCode=1;});
