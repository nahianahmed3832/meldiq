// Aggregate only action classes, no actor, request, target or private audit details.
const {Pool}=require('pg'),fs=require('fs');
(async()=>{
const pool=new Pool({connectionString:process.env.PERF_PROBE_URL,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE)},max:1,statement_timeout:2200,application_name:'meldiq-phase3-incident-read'});
const c=await pool.connect();try{
await c.query('BEGIN READ ONLY');
const q=await c.query("SELECT count(*)::int AS all_actions, count(*) FILTER (WHERE action='controls.update' AND target_type='control' AND target_id='maintenance' AND outcome='success')::int AS maintenance_changes FROM meldiq.platform_audit WHERE at BETWEEN $1 AND $2",[Date.parse('2026-11-03T13:28:30Z'),Date.parse('2026-11-03T13:30:15Z')]);
const changes=await c.query("SELECT at, ((detail::jsonb ->> 'after')::jsonb ->> 'enabled')::boolean AS enabled FROM meldiq.platform_audit WHERE action='controls.update' AND target_type='control' AND target_id='maintenance' AND outcome='success' AND at BETWEEN $1 AND $2 ORDER BY at",[Date.parse('2026-11-03T13:28:30Z'),Date.parse('2026-11-03T13:30:15Z')]);
await c.query('ROLLBACK');console.log(JSON.stringify({at:new Date().toISOString(),...q.rows[0],events:changes.rows}));
}finally{c.release();await pool.end();}})().catch(()=>{console.error('audit read unavailable');process.exitCode=1;});
