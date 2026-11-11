/** Disposable migration/RLS check. Refuses hosted URLs and creates/drops only its own random database. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Pool } = require('pg');
const endpoint = new URL(process.env.MELDIQ_TEST_PG_URL ?? 'postgres://meldiq_admin_qa@127.0.0.1:55431/postgres');
if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Only a disposable loopback PostgreSQL cluster is permitted.');
const fixture = process.env.MELDIQ_SUPABASE_WEB_ROOT;
if (!fixture) throw new Error('Set MELDIQ_SUPABASE_WEB_ROOT to the exact release schema plus candidate migration fixture.');
const name = `meldiq_admin_rls_${crypto.randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: endpoint.href, max: 1 });
let db;
const tables = ['billing_admin_refunds', 'platform_incident_requests', 'platform_feedback_reviews', 'platform_recovery_runs', 'platform_export_jobs'];
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  endpoint.pathname = `/${name}`;
  db = new Pool({ connectionString: endpoint.href, max: 1 });
  await db.query(fs.readFileSync(path.join(fixture, 'scripts/supabase/postgres-bootstrap.sql'), 'utf8'));
  const files = fs.readdirSync(path.join(fixture, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    await db.query('BEGIN');
    try { await db.query(fs.readFileSync(path.join(fixture, 'supabase/migrations', file), 'utf8')); await db.query('COMMIT'); }
    catch (error) { await db.query('ROLLBACK'); throw error; }
  }
  for (const table of tables) {
    const { rows: [r] } = await db.query(`SELECT c.relrowsecurity, c.relforcerowsecurity,
      has_table_privilege('anon', c.oid, 'SELECT') AS anon_read,
      has_table_privilege('authenticated', c.oid, 'SELECT') AS user_read,
      has_table_privilege('meldiq_api', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS api_access
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meldiq' AND c.relname=$1`, [table]);
    if (!r?.relrowsecurity || !r.relforcerowsecurity || r.anon_read || r.user_read || !r.api_access) throw new Error(`Unexpected table security: ${table}`);
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try { await db.query(`SELECT * FROM meldiq.${table} LIMIT 1`); throw new Error(`Private table was readable by ${role}`); }
      catch (error) { if (error.code !== '42501') throw error; }
      finally { await db.query('RESET ROLE'); }
    }
  }
  await db.query('SET ROLE meldiq_api');
  await db.query(`INSERT INTO meldiq.platform_export_jobs (id,actor_account_id,request_key,kind,query_json,state,created_at,expires_at)
    VALUES ('safe-fixture','safe-admin','safe-request','users','{}','queued',0,1)`);
  const { rows: [r] } = await db.query("SELECT count(*)::int AS count FROM meldiq.platform_export_jobs WHERE id='safe-fixture'");
  if (r.count !== 1) throw new Error('Trusted API policy did not retain its fixture.');
  await db.query('RESET ROLE');
  process.stdout.write(JSON.stringify({ result: 'pass', migrationFiles: files.length, privateTables: tables.length, deniedRoleReads: tables.length * 2, apiInsertRead: true }) + '\n');
} finally {
  await db?.end();
  try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
  finally { await admin.end(); }
}
