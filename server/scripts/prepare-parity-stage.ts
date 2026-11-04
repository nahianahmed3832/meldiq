import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

// Disposable local staging only. Never accepts a hosted/customer database or reuses existing data.
const [connection, webRoot] = process.argv.slice(2);
if (!connection || !webRoot) throw new Error("Usage: tsx scripts/prepare-parity-stage.ts <local-postgres-url> <web-source-root>");
const endpoint = new URL(connection);
const database = endpoint.pathname.slice(1);
if (!['postgres:', 'postgresql:'].includes(endpoint.protocol) || endpoint.hostname !== '127.0.0.1' || endpoint.search || endpoint.hash || !/^meldiq_parity_stage_[a-z0-9_]+$/.test(database)) {
  throw new Error("Only a fresh meldiq_parity_stage_* database on 127.0.0.1 is permitted");
}
const administrator = new URL(endpoint);
administrator.pathname = "/postgres";
const admin = new pg.Client({ connectionString: administrator.href });
let client: pg.Client | undefined;
try {
  await admin.connect();
  if ((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [database])).rowCount) throw new Error("Refusing to reuse an existing staging database");
  await admin.query(`CREATE DATABASE "${database}"`);
  client = new pg.Client({ connectionString: endpoint.href });
  await client.connect();
  await client.query(fs.readFileSync(path.join(webRoot, "scripts/supabase/postgres-bootstrap.sql"), "utf8"));
  const migrations = [];
  for (const name of fs.readdirSync(path.join(webRoot, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(webRoot, "supabase/migrations", name), "utf8");
    await client.query("BEGIN");
    try { await client.query(sql); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    migrations.push({ name, sha256: crypto.createHash("sha256").update(sql).digest("hex") });
  }
  console.log(JSON.stringify({ scope: "disposable loopback PostgreSQL; Auth/Realtime contracts are test stubs", database, migrations }, null, 2));
} finally {
  await client?.end();
  await admin.end();
}
