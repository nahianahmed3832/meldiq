// Run inside the active API container. Return aggregate counts only.
const fs = require('node:fs');
const { Client } = require('pg');

async function main() {
  const c = new Client({connectionString:process.env.SUPABASE_DATABASE_URL,
    ssl:{rejectUnauthorized:true,ca:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE)},
    application_name:'meldiq_storage_reference_audit'});
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout = '15s'");
    const tables = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='meldiq' AND table_type='BASE TABLE' ORDER BY table_name");
    const bucket = 'griipbuddy-orbit-media-sg';
    const report = {tables:0,rows:0,rowsWithSourceUrls:0};
    const oldOrigin = 'https?://(' + bucket + '[.]s3[^/" ]*[.]amazonaws[.]com|s3[^/" ]*[.]amazonaws[.]com/' + bucket + ')([/:?]|$)';
    for (const {table_name:name} of tables.rows) {
      if (!/attachment|file|media|message|envelope|relay|history|photo|profile|sticker|emoji|preview|upload|conversation|channel|community|asset/i.test(name)) continue;
      if (!/^[a-z0-9_]+$/.test(name)) throw Error('Unexpected table identifier');
      const {rows:[r]} = await c.query('SELECT count(*)::integer AS rows, count(*) FILTER (WHERE to_jsonb(t)::text ~* $1)::integer AS refs FROM meldiq."'+name+'" t',[oldOrigin]);
      report.tables++; report.rows+=r.rows; report.rowsWithSourceUrls+=r.refs;
    }
    await c.query('COMMIT'); console.log(JSON.stringify(report));
    if (!report.tables || report.rowsWithSourceUrls) process.exitCode=1;
  } finally {await c.end();}
}
main().catch(()=>{console.error('PostgreSQL reference audit failed');process.exitCode=1;});
