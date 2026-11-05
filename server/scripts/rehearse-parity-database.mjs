import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import pg from "pg";

// This rehearsal can only read an owned local stage and create a NEW local restore database.
// It never connects to a hosted database, reuses a target, or removes retained rehearsal evidence.
const [sourceText, targetText, outputText] = process.argv.slice(2);
function endpoint(value, target = false) {
  const url = new URL(value);
  const name = url.pathname.slice(1);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      !url.port || url.search || url.hash || !/^meldiq_parity_stage_[a-z0-9_]+$/.test(name) ||
      (target && !/^meldiq_parity_stage_rollback_[a-z0-9_]+$/.test(name)))
    throw new Error("Only explicit owned loopback stage/NEW rollback databases are allowed");
  return url;
}
if (!sourceText || !targetText || !outputText || !path.isAbsolute(outputText))
  throw new Error("Usage: node scripts/rehearse-parity-database.mjs <owned-local-source-url> <new-local-rollback-url> <new-private-output-directory>");
const source = endpoint(sourceText), target = endpoint(targetText, true);
if (source.href === target.href || source.host !== target.host || source.username !== target.username)
  throw new Error("The source and new target must be distinct on the same owned local cluster");
await fs.mkdir(outputText, { mode: 0o700 }); // Existing directories are refused.
const output = await fs.realpath(outputText);
await fs.chmod(output, 0o700);
const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.href });
const reader = new pg.Client({ connectionString: source.href });
let restored;
const sha = value => createHash("sha256").update(value).digest("hex");
const quote = value => '"' + value.replaceAll('"', '""') + '"';
function pgEnvironment(url) {
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port, PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1), PGSSLMODE: "disable",
    PGAPPNAME: "meldiq-owned-restore-rehearsal", PGOPTIONS: "-c timezone=UTC -c extra_float_digits=3" };
}
function command(program, args, env = process.env) {
  const child = spawn(program, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let diagnostic = "";
  child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${program} failed (${code}): ${diagnostic}`)));
  });
  // Callers still await this promise; suppress an unhandled rejection while a pipe finishes closing.
  completion.catch(() => {});
  return { child, completion };
}
async function collect(program, args, env) {
  const { child, completion } = command(program, args, env);
  child.stdin.end(); const chunks = [];
  for await (const chunk of child.stdout) chunks.push(chunk);
  await completion; return Buffer.concat(chunks);
}
async function manifest(client) {
  const tables = (await client.query(`SELECT n.nspname AS schema,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname`)).rows;
  const rows = [];
  for (const table of tables) {
    const result = await client.query(`SELECT row_to_json(t)::text AS value FROM ${quote(table.schema)}.${quote(table.name)} AS t LIMIT 100001`);
    if (result.rows.length > 100000) throw new Error("Rehearsal fixture table exceeds the local bound");
    const values = result.rows.map(row => row.value).sort();
    if (values.reduce((total,value)=>total+Buffer.byteLength(value),0)>32*1024*1024)
      throw new Error("Rehearsal fixture table exceeds the memory bound");
    const hash = createHash("sha256");
    for (const value of values) hash.update(`${Buffer.byteLength(value)}\0`).update(value);
    rows.push({ ...table, count: values.length, sha256: hash.digest("hex") });
  }
  return rows;
}
async function sequences(client) {
  return (await client.query(`SELECT schemaname,sequencename,data_type::text,start_value,min_value,max_value,
    increment_by,cycle,cache_size,last_value FROM pg_sequences
    WHERE schemaname NOT LIKE 'pg_%' AND schemaname<>'information_schema' ORDER BY schemaname,sequencename`)).rows;
}
function schemaCanonical(buffer) {
  // PG17's per-dump psql restrict token is intentionally fresh, not schema drift.
  return buffer.toString().split("\n").filter(line=>!/^\\(?:un)?restrict\s/.test(line)).join("\n");
}
try {
  await admin.connect(); await reader.connect();
  const database = target.pathname.slice(1);
  if ((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [database])).rowCount)
    throw new Error("Refusing an existing restore target");
  if ((await reader.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND application_name LIKE 'meldiq-%'")).rows[0].count)
    throw new Error("Stop the source application before rehearsing media/credential rollback");
  if ((await reader.query("SELECT count(*)::int AS count FROM meldiq_private.bot_media_evictions")).rows[0].count)
    throw new Error("Drain bot media and verify its durable cleanup ledger is empty first");
  const version = (await collect("pg_dump", ["--version"])).toString().trim();
  if (!/PostgreSQL\) 17\./.test(version)) throw new Error("PostgreSQL 17 tools required");
  const identity = path.join(output, "rehearsal.agekey");
  await collect("age-keygen", ["-o", identity]); await fs.chmod(identity, 0o600);
  const recipient = (await collect("age-keygen", ["-y", identity])).toString().trim();
  await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await reader.query("SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3");
  const snapshot = (await reader.query("SELECT pg_export_snapshot() AS id")).rows[0].id;
  if (!/^[a-fA-F0-9-]+$/.test(snapshot)) throw new Error("Unexpected snapshot identifier");
  const before = await manifest(reader);
  const sequenceBefore = await sequences(reader);
  const archive = path.join(output, "database.dump.age");
  const dump = command("pg_dump", ["--format=custom", "--no-owner", `--snapshot=${snapshot}`], pgEnvironment(source));
  const encrypt = command("age", ["-r", recipient, "-o", archive]);
  dump.child.stdin.end();
  await Promise.all([pipeline(dump.child.stdout, encrypt.child.stdin), dump.completion, encrypt.completion]);
  await fs.chmod(archive, 0o600);
  const sourceSchema = schemaCanonical(await collect("pg_dump", ["--schema-only", "--no-owner", `--snapshot=${snapshot}`], pgEnvironment(source)));
  await reader.query("COMMIT");
  await admin.query(`CREATE DATABASE ${quote(database)}`);
  const decrypt = command("age", ["-d", "-i", identity, archive]); decrypt.child.stdin.end();
  const restore = command("pg_restore", ["--no-owner", "--exit-on-error", "--dbname", database], pgEnvironment(target));
  await Promise.all([pipeline(decrypt.child.stdout, restore.child.stdin), decrypt.completion, restore.completion]);
  restored = new pg.Client({ connectionString: target.href }); await restored.connect();
  await restored.query("SET timezone='UTC'; SET extra_float_digits=3");
  const after = await manifest(restored);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Restored row counts/checksums differ");
  if (JSON.stringify(sequenceBefore) !== JSON.stringify(await sequences(restored))) throw new Error("Restored sequence state differs");
  const restoredSchema = schemaCanonical(await collect("pg_dump", ["--schema-only", "--no-owner"], pgEnvironment(target)));
  if (sha(sourceSchema) !== sha(restoredSchema)) throw new Error("Restored schema, indexes, triggers, policies, grants or sequence definitions differ");
  // These are SELECT-only checks of the exact older authentication semantics: token/code hash lookup.
  // Keep all original grants, tombstones and consent history; never restore a stale customer database.
  const botBefore = (await restored.query("SELECT id,token_hash FROM meldiq.bots")).rows;
  const humanBefore = (await restored.query("SELECT id,row_to_json(u)::text AS value FROM meldiq.users u WHERE kind='person' ORDER BY id")).rows;
  await restored.query("BEGIN");
  try {
    await restored.query("SELECT pg_advisory_xact_lock(hashtextextended('meldiq-rows-writer',0))");
    const at = Date.now();
    // Generate replacement hashes locally; do not add a pgcrypto extension to the restored schema.
    const replaceHashes = async (selection, update) => {
      const selected = (await restored.query(selection)).rows;
      for (const row of selected) await restored.query(update, [at, randomBytes(32).toString("hex"), row.id]);
      return { rowCount: selected.length };
    };
    const bots = await replaceHashes("SELECT id FROM meldiq.bots", "UPDATE meldiq.bots SET token_hash=$2,token_rotated_at=$1 WHERE id=$3");
    const disabled = await restored.query("UPDATE meldiq.users SET disabled_at=$1 WHERE disabled_at IS NULL AND id IN (SELECT id FROM meldiq.bots)", [at]);
    const revisions = await restored.query("UPDATE meldiq.bot_credential_revisions SET active=0 WHERE active<>0");
    const webhooks = await replaceHashes(`SELECT id FROM meldiq.channel_webhooks
      WHERE id IN (SELECT credential_id FROM meldiq.bot_derived_credentials)
         OR created_by IN (SELECT id FROM meldiq.users WHERE kind='agent')`, "UPDATE meldiq.channel_webhooks SET token_hash=$2,token_rotated_at=$1 WHERE id=$3");
    const invites = await replaceHashes(`SELECT id FROM meldiq.invitations
      WHERE id IN (SELECT invite_id FROM meldiq.bot_invite_credentials)
         OR created_by IN (SELECT id FROM meldiq.users WHERE kind='agent')`, "UPDATE meldiq.invitations SET revoked_at=coalesce(revoked_at,$1),code_hash=$2 WHERE id=$3");
    const humansAfter = (await restored.query("SELECT id,row_to_json(u)::text AS value FROM meldiq.users u WHERE kind='person' ORDER BY id")).rows;
    if (JSON.stringify(humanBefore)!==JSON.stringify(humansAfter)) throw new Error("Human identity changed");
    for (const bot of botBefore)
      if ((await restored.query("SELECT 1 FROM meldiq.bots WHERE token_hash=$1",[bot.token_hash])).rowCount)
        throw new Error("Predecessor token lookup can still recover a prior bot credential");
    await restored.query("COMMIT");
    const report = { recordedAt:new Date().toISOString(),scope:"owned loopback fixture database restore and credential quarantine; no production actions",sourceDatabase:source.pathname.slice(1),targetDatabase:database,
      postgresTools:version,consistentReadOnlySnapshot:true,encryptedBackup:true,fullDecryptAndRestore:true,tables:before.length,rows:before.reduce((n,t)=>n+t.count,0),rowChecksumsMatch:true,
      schemaAndAclSha256:sha(sourceSchema),schemaIndexesTriggersPoliciesGrantsMatch:true,sequenceStatesMatch:true,mediaEvictionLedgerEmpty:true,
      quarantine:{bots:bots.rowCount,botIdentitiesDisabled:disabled.rowCount,activeCredentialRevisionsWithdrawn:revisions.rowCount,derivedWebhooksRotated:webhooks.rowCount,derivedInvitationsRevoked:invites.rowCount,priorBotHashLookupsDenied:true,humanIdentitiesUnchanged:true},
      archive:{file:"database.dump.age",sha256:sha(await fs.readFile(archive)),bytes:(await fs.stat(archive)).size},
      notProven:["production backup/provider recovery","application private keys and object-store restoration","old API/runtime and installed native journeys","reverse-proxy bot route hold installation","complete rollback after production writes"],
      requirement:"Before an older API runs, hold bot/developer/interaction/installation routes at the proxy, drain/stop all writers and media, preserve new schema/consent data, quarantine derived credentials, then verify ordinary journeys. Credential quarantine alone does not enforce missing predecessor policy." };
    await fs.writeFile(path.join(output,"source-manifest.json"),JSON.stringify(before,null,2)+"\n",{mode:0o600});
    await fs.writeFile(path.join(output,"receipt.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
    console.log(JSON.stringify(report));
  } catch(error) {await restored.query("ROLLBACK");throw error;}
} finally {
  await reader.query("ROLLBACK").catch(()=>{});
  await restored?.end(); await reader.end(); await admin.end();
}
