// No credentials, identities or private rows are exported. This runs READ ONLY as the diagnostics role.
const {Pool}=require('pg'),fs=require('fs');
(async()=>{
const writer=new URL(process.env.SUPABASE_DATABASE_URL);
const role=decodeURIComponent(writer.username).split('.')[0];
const pool=new Pool({connectionString:process.env.PERF_PROBE_URL,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE)},max:1,statement_timeout:2200,application_name:'meldiq-release-admission-read'});
const c=await pool.connect();try{
await c.query('BEGIN READ ONLY');
const capacity=await c.query("select rolconnlimit as limit, (select count(*)::int from pg_stat_activity where usename=$1) as connected from pg_roles where rolname=$1",[role]);
if(capacity.rowCount!==1)throw Error('unknown runtime role');
const states=await c.query("select coalesce(state,'not visible') as state,count(*)::int as backends from pg_stat_activity where usename=$1 group by 1 order by 1",[role]);
const server=await c.query("select current_setting('max_connections')::int as max, current_setting('superuser_reserved_connections')::int as superuser_reserved, current_setting('reserved_connections',true)::int as reserved, (select count(*)::int from pg_stat_activity where backend_type='client backend') as observed_client_backends");
const sockets=await c.query("select minute,sockets,connects,disconnects from meldiq.presence_samples where minute>=floor(extract(epoch from now())/60)-12 order by minute desc limit 10");
await c.query('ROLLBACK');console.log(JSON.stringify({at:new Date().toISOString(),providerBackendSessions:capacity.rows[0],backendStates:states.rows,postgresInstance:server.rows[0],incumbentHubSamples:sockets.rows}));
}finally{c.release();await pool.end();}})().catch(()=>{console.error('admission read unavailable');process.exitCode=1;});
