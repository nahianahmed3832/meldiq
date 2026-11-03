// Catalog estimates only; no customer rows, keys or identifiers are exported.
const {Pool}=require('pg'),fs=require('fs');
(async()=>{
const skip=new Set(['files','preferences','history','reports','relationships','calls']);
const {tableSpecs}=await import('/app/dist/infrastructure/database/mongo/catalog.js');
const names=tableSpecs().filter(s=>!skip.has(s.domain)&&!['account_recovery_codes','account_recovery_tickets','account_key_backups','account_key_unlocks'].includes(s.name)).map(s=>s.name).concat('auth_device_sessions');
const p=new Pool({connectionString:process.env.PERF_PROBE_URL,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE)},max:1,statement_timeout:2500,application_name:'meldiq-phase3-footprint'});
const c=await p.connect();try{
await c.query('BEGIN READ ONLY');
const r=await c.query("select count(*)::int as relations, sum(greatest(s.n_live_tup,0))::bigint as estimatedRows,sum(pg_relation_size(s.relid))::bigint as heapBytes, max(pg_relation_size(s.relid))::bigint as largestHeapBytes from pg_stat_user_tables s where s.schemaname='meldiq' and s.relname=any($1::text[])",[names]);
const big=await c.query("select s.relname as relation,s.n_live_tup::int as estimated_rows,pg_relation_size(s.relid)::int as heap_bytes from pg_stat_user_tables s where s.schemaname='meldiq' and s.relname=any($1::text[]) order by pg_relation_size(s.relid) desc limit 12",[names]);
const n=await c.query("select count(*)::int as currentApiDatabaseSessions from pg_stat_activity where application_name='meldiq-production'");
await c.query('ROLLBACK');console.log(JSON.stringify({at:new Date().toISOString(),expectedRelations:names.length,...r.rows[0],...n.rows[0],largest:big.rows}));
}finally{c.release();await p.end();}})().catch(()=>{console.error('catalog probe failed');process.exitCode=1;});
