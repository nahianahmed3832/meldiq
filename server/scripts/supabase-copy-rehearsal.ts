import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import {once} from "node:events";
import {spawn} from "node:child_process";
import {postgresTableSpecs} from "../src/infrastructure/database/postgres/nativeCatalog.js";
import {dependencyOrder,digest,validateRow,tableCounts} from "../src/infrastructure/database/postgres/migration.js";
import {MeldiqPostgres,identifier as q} from "../src/infrastructure/database/postgres/client.js";

/** A bounded CSV stream, in ONE atomic transaction. No direct connection to the source writer. */
async function main() {
  process.umask(0o077);
  const [snapshot, backupDirectory] = process.argv.slice(2);
  if (!snapshot || !process.env.SUPABASE_DATABASE_URL) throw new Error("Private snapshot and destination required");
  const snapshotStat=fs.lstatSync(snapshot);
  if(!path.isAbsolute(snapshot)||!snapshotStat.isDirectory()||snapshotStat.isSymbolicLink()||snapshotStat.mode&0o077)throw new Error("Private snapshot directory required");
  const url=new URL(process.env.SUPABASE_DATABASE_URL), local=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  const expected="bkvlxbsnzqkhbifawcww";
  if (url.search || (local ? !/^\/meldiq_copy_rehearsal_[a-f0-9]{16}$/.test(url.pathname) || process.env.SUPABASE_ENVIRONMENT!=="development" :
    process.env.SUPABASE_ENVIRONMENT!=="staging" || process.env.SUPABASE_EXPECTED_PROJECT_REF!==expected || url.hostname!=="aws-1-eu-central-1.pooler.supabase.com" || url.port!=="5432" || decodeURIComponent(url.username)!==`postgres.${expected}` || url.pathname!=="/postgres")) throw new Error("Only an owned loopback rehearsal or selected Frankfurt staging destination is allowed");
  const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,"manifest.json"),"utf8"));
  const validated=JSON.parse(fs.readFileSync(path.join(snapshot,"local-validation.json"),"utf8"));
  const specs=dependencyOrder(postgresTableSpecs());
  if(!manifest.realDataSnapshot||manifest.synthetic||!manifest.frozen||manifest.purpose!=="staging-rehearsal"||manifest.sourceWritesFrozen!==false||!validated.ok||!validated.allRecordHashesMatch||validated.sourceSha256!==manifest.sourceSha256||validated.catalogSha256!==manifest.catalogSha256||manifest.catalogSha256!==digest(JSON.stringify(postgresTableSpecs()))||manifest.sourceSha256!==digest(JSON.stringify(manifest.tables))||!/^[a-f0-9-]{36}$/.test(manifest.id))throw new Error("Exact locally validated real-data manifest required");
  if(manifest.tables.length!==specs.length||new Set(manifest.tables.map((table:any)=>table.name)).size!==specs.length)throw new Error("Invalid table inventory");
  for(const spec of specs){
    const file=manifest.tables.find((table:any)=>table.name===spec.name);
    if(!file||!Number.isSafeInteger(file.count)||file.count<0)throw new Error("Missing table inventory");
    const fileStat=fs.lstatSync(path.join(snapshot,`${spec.name}.ndjson`));
    if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.mode&0o077)throw new Error("Private immutable snapshot file required");
    const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(path.join(snapshot,`${spec.name}.ndjson`)))hash.update(chunk);
    if(hash.digest("hex")!==file.sha256)throw new Error("Snapshot file changed");
  }
  const db=new MeldiqPostgres({url:url.href,environment:local?"development":"staging",maxConnections:1,ca:local?undefined:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE!,"utf8")});
  let child: ReturnType<typeof spawn>|undefined;
  try {
    const prior=(await db.query("SELECT source_sha256,catalog_sha256 FROM meldiq_private.migration_runs WHERE id=$1",[manifest.id])).rows[0];
    if(prior){
      if(prior.source_sha256!==manifest.sourceSha256||prior.catalog_sha256!==manifest.catalogSha256)throw new Error("Run fingerprint changed");
      const counts=await tableCounts(db,specs);
      for(const spec of specs)if(counts.get(spec.name)!==manifest.tables.find((table:any)=>table.name===spec.name).count)throw new Error("Existing run is incomplete; do not claim an atomic resume");
      console.log(JSON.stringify({copyCommitted:true,resumed:true,runId:manifest.id}));return;
    }
    const before=await tableCounts(db,specs);
    if((await db.query("SELECT coalesce(obj_description('meldiq'::regnamespace,'pg_namespace'),'') AS purpose")).rows[0].purpose.startsWith("Meldiq customer-data rehearsal:"))throw new Error("Do not replace an existing customer-data rehearsal with another snapshot");
    const replace=[...before.values()].some(count=>count>0);
    if(local&&replace)throw new Error("Owned COPY test requires empty tables");
    let backup:any;
    if(!local){
      if(!backupDirectory)throw new Error("Verified fresh encrypted staging backup required");
      const receipt=JSON.parse(fs.readFileSync(path.join(backupDirectory,"receipt.json"),"utf8"));
      if(!receipt.ok||receipt.projectRef!==expected||!receipt.archiveAuthenticatedAndReadable||receipt.reconciledTables!==317||Date.now()-Date.parse(receipt.completedAt)>3600000)throw new Error("Verified fresh complete backup required");
      const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(path.join(backupDirectory,"database.dump.age")))hash.update(chunk);
      if(hash.digest("hex")!==receipt.ciphertextSha256)throw new Error("Backup archive changed");
      backup=JSON.parse(fs.readFileSync(path.join(backupDirectory,"source-manifest.json"),"utf8"));
    }
    const pgEnv={PATH:process.env.PATH!,LANG:"C",PGHOST:url.hostname.replace(/^\[|\]$/g,""),PGPORT:url.port,PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:url.pathname.slice(1),PGSSLMODE:local?"disable":"verify-full",...(local?{}:{PGSSLROOTCERT:process.env.SUPABASE_DB_CA_FILE!}),PGCONNECT_TIMEOUT:"10",PGOPTIONS:"-c timezone=UTC -c statement_timeout=300000 -c idle_in_transaction_session_timeout=120000 -c extra_float_digits=3"};
    child=spawn("/opt/homebrew/opt/postgresql@17/bin/psql",["-X","-q","-v","ON_ERROR_STOP=1"],{env:pgEnv,stdio:["pipe","ignore","pipe"]});
    const diagnostics=fs.createWriteStream(path.join(snapshot,local?"local-copy-diagnostics.log":"hosted-copy-diagnostics.log"),{flags:"a",mode:0o600});child.stderr!.pipe(diagnostics);
    const closed=once(child,"close");closed.catch(()=>undefined);
    child.stdin!.on("error",()=>undefined);
    const write=async(text:string)=>{if(child!.exitCode!==null)throw new Error("COPY process stopped");if(!child!.stdin!.write(text))await once(child!.stdin!,"drain");};
    await write("BEGIN;\nDO $$ BEGIN IF NOT pg_try_advisory_xact_lock(hashtextextended('meldiq-rows-writer',0)) THEN RAISE EXCEPTION 'Repository writer must stop before import'; END IF; END $$;\n");
    await write(`LOCK TABLE ${specs.map(spec=>`meldiq.${q(spec.name)}`).join(",")} IN ACCESS EXCLUSIVE MODE NOWAIT;\n`);
    if(!local){
      // Guard the exact application/operational rows covered by the verified backup, INSIDE the reset transaction.
      const guarded=backup.tables.filter((table:any)=>["meldiq","meldiq_private"].includes(table.schema));
      if(guarded.length!==289)throw new Error("Incomplete fixture backup inventory");
      for(const table of guarded){
        const row="encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex')";
        const totals=`SELECT count(*)::text AS count,${[0,1,2,3].map(part=>`coalesce(sum(('x'||substr(${row},${part*16+1},16))::bit(64)::bigint::numeric),0)::text AS s${part}`).join(",")} FROM ${q(table.schema)}.${q(table.name)} t`;
        if(!/^[a-f0-9]{64}$/.test(table.rowChecksum))throw new Error("Invalid backup checksum");
        const canonical=`'{"count":"'||count||'","s0":"'||s0||'","s1":"'||s1||'","s2":"'||s2||'","s3":"'||s3||'"}'`;
        await write(`DO $$ BEGIN IF (SELECT encode(sha256(convert_to(${canonical},'UTF8')),'hex') FROM (${totals}) checks) <> '${table.rowChecksum}' THEN RAISE EXCEPTION 'Staging fixtures changed since backup'; END IF; END $$;\n`);
      }
      await write("DO $$ BEGIN IF EXISTS(SELECT 1 FROM meldiq.accounts WHERE email !~* '^[^[:space:]@]+@example[.](test|invalid)$') OR EXISTS(SELECT 1 FROM auth.users WHERE email IS NULL OR email !~* '^[^[:space:]@]+@example[.](test|invalid)$') THEN RAISE EXCEPTION 'Only synthetic fixtures may be replaced'; END IF; END $$;\n");
      // Three explicitly named fixture-only delete triggers are restored in the same transaction. FK/check/RLS
      // enforcement stays on. No cleanup job is allowed to inherit synthetic attachment deletion work.
      await write("ALTER TABLE meldiq.platform_audit DISABLE TRIGGER platform_audit_no_delete; ALTER TABLE meldiq.attachments DISABLE TRIGGER attachment_removed_cleanup; ALTER TABLE meldiq.attachment_uploads DISABLE TRIGGER upload_removed_cleanup;\n");
      for(const name of ["auth_links","revoked_auth_sessions","row_counters","migration_batches","migration_runs","outbox","realtime_grants"])await write(`DELETE FROM meldiq_private.${q(name)};\n`);
      for(const spec of [...specs].reverse())await write(`DELETE FROM meldiq.${q(spec.name)};\n`);
      await write("ALTER TABLE meldiq.platform_audit ENABLE TRIGGER platform_audit_no_delete; ALTER TABLE meldiq.attachments ENABLE TRIGGER attachment_removed_cleanup; ALTER TABLE meldiq.attachment_uploads ENABLE TRIGGER upload_removed_cleanup;\n");
    }
    await write(`INSERT INTO meldiq_private.migration_runs(id,source_sha256,catalog_sha256,environment) VALUES('${manifest.id}','${manifest.sourceSha256}','${manifest.catalogSha256}','${local?"development":"staging"}');\n`);
    let total=0;
    for(const spec of specs){
      const columns=[...spec.columns,...(!spec.primaryKey.length?[{name:"rowid",type:"INTEGER"}]:[])];
      const file=manifest.tables.find((table:any)=>table.name===spec.name);
      await write(`COPY meldiq.${q(spec.name)}(${columns.map(column=>q(column.name)).join(",")}) FROM STDIN WITH(FORMAT csv,NULL '\\N');\n`);
      const input=readline.createInterface({input:fs.createReadStream(path.join(snapshot,`${spec.name}.ndjson`)),crlfDelay:Infinity});let count=0;
      for await(const line of input){
        const row=validateRow(spec,JSON.parse(line));
        const values=columns.map(column=>{
          let value=row[column.name];if(value===null)return "\\N";
          if(column.type==="BLOB")value="\\x"+Buffer.from(value as Uint8Array).toString("hex");
          else if(column.type==="JSONB")value=JSON.stringify(value);
          else if(column.type==="TEXT[]")value="{"+(value as string[]).map(item=>'"'+item.replaceAll("\\","\\\\").replaceAll('"','\\"')+'"').join(",")+"}";
          else if(column.type==="BIGINT[]")value="{"+(value as number[]).join(",")+"}";
          return '"'+String(value).replaceAll('"','""')+'"';
        });
        await write(values.join(",")+"\n");count++;total++;
      }
      await write("\\.\n");
      if(count!==file.count)throw new Error("Source row count changed");
      await write(`INSERT INTO meldiq_private.migration_batches(run_id,table_name,batch_number,record_count,sha256) VALUES('${manifest.id}','${spec.name}',0,${count},'${file.sha256}');\n`);
      if(spec.autoincrement||!spec.primaryKey.length){const column=spec.autoincrement?spec.primaryKey[0]:"rowid";const floor=manifest.counters[spec.name]??0;if(!Number.isSafeInteger(floor)||floor<0)throw new Error("Invalid counter floor");await write(`INSERT INTO meldiq_private.row_counters(table_name,value) SELECT '${spec.name}',greatest(coalesce(max(${q(column)}),0),${floor}) FROM meldiq.${q(spec.name)};\n`);}
    }
    await write(`COMMENT ON SCHEMA meldiq IS 'Meldiq customer-data rehearsal: ${manifest.id}; Atlas remains live';\nCOMMIT;\n`);child.stdin!.end();
    if((await closed)[0]!==0)throw new Error("Atomic COPY failed; inspect private diagnostics");
    const after=await tableCounts(db,specs);
    for(const spec of specs)if(after.get(spec.name)!==manifest.tables.find((table:any)=>table.name===spec.name).count)throw new Error("Committed table count mismatch");
    console.log(JSON.stringify({copyCommitted:true,resumed:false,runId:manifest.id,tables:specs.length,records:total,fixtureReplacement:!local,productionChanged:false,fullReconciliationRequired:true}));
  }finally{if(child&&child.exitCode===null)child.kill();await db.close();}
}
main().catch(()=>{console.error("Atomic real-data COPY stopped. Keep Atlas live; inspect private diagnostics and verify commit state before retrying.");process.exitCode=1;});
