import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import {execFileSync} from "node:child_process";
import {postgresTableSpecs} from "../src/infrastructure/database/postgres/nativeCatalog.js";
import {dependencyOrder,digest,rowHash,validateRow,tableCounts,TypedPostgresImporter} from "../src/infrastructure/database/postgres/migration.js";
import {MeldiqPostgres,identifier as q} from "../src/infrastructure/database/postgres/client.js";

const project="bkvlxbsnzqkhbifawcww";
function privateFile(file:string){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077)throw new Error("Private regular source file required");}
async function checksum(file:string){const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest("hex");}
function manifest(directory:string,final=false){
  const stat=fs.lstatSync(directory);if(!path.isAbsolute(directory)||!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error("Private source directory required");
  privateFile(path.join(directory,"manifest.json"));privateFile(path.join(directory,"local-validation.json"));
  const source=JSON.parse(fs.readFileSync(path.join(directory,"manifest.json"),"utf8")),proof=JSON.parse(fs.readFileSync(path.join(directory,"local-validation.json"),"utf8"));
  if(!source.realDataSnapshot||source.synthetic||!source.frozen||source.purpose!==(final?"production-cutover":"staging-rehearsal")||source.sourceWritesFrozen!==final||!/^[a-f0-9-]{36}$/.test(source.id)||source.catalogSha256!==digest(JSON.stringify(postgresTableSpecs()))||source.sourceSha256!==digest(JSON.stringify(source.tables))||!proof.ok||!proof.allRecordHashesMatch||proof.sourceSha256!==source.sourceSha256||proof.catalogSha256!==source.catalogSha256)throw new Error("Exact locally verified immutable customer snapshot required");
  if(source.tables.length!==postgresTableSpecs().length||new Set(source.tables.map((t:any)=>t.name)).size!==source.tables.length)throw new Error("Incomplete snapshot inventory");
  for(const [name,value] of Object.entries(source.counters)){const spec=postgresTableSpecs().find(table=>table.name===name);if(!spec||!(spec.autoincrement||!spec.primaryKey.length)||!Number.isSafeInteger(value)||Number(value)<0)throw new Error("Invalid source counter");}
  return source;
}
function verifyFreeze(source:any){
  const run=source.freezeProof?.runDirectory;
  if(!/^\/opt\/griip-internal-messaging\/database-migration\/postgres-cutover-\d{8}T\d{6}Z$/.test(run??"")||!source.freezeProof.ok||!source.freezeProof.sourceWritesFrozen||!/^sha256:[a-f0-9]{64}$/.test(source.freezeProof.imageId)||!/^[a-f0-9]{64}$/.test(source.sourceCiphertextSha256??""))throw new Error("Frozen cutover source evidence required");
  const live=JSON.parse(execFileSync("ssh",["-o","BatchMode=yes","-o","ConnectTimeout=10","root@72.60.107.88","python3 /opt/griip-internal-messaging/database-migration/cutover-control.py status "+run],{encoding:"utf8",timeout:20_000}));
  if(!live.ok||["containerId","imageId","frozenAt","lockPid","runDirectory"].some(key=>live[key]!==source.freezeProof[key]))throw new Error("Atlas source freeze changed");
}
async function* rows(directory:string,spec:ReturnType<typeof postgresTableSpecs>[number],source:any){
  const file=path.join(directory,spec.name+".ndjson"),expected=source.tables.find((t:any)=>t.name===spec.name);privateFile(file);
  if(!expected||await checksum(file)!==expected.sha256)throw new Error("Source file checksum changed");
  let count=0;for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){count++;yield validateRow(spec,JSON.parse(line));}
  if(count!==expected.count)throw new Error("Source row count changed");
}
async function reconcile(db:MeldiqPostgres,directory:string,source:any){
  const counts=await tableCounts(db,postgresTableSpecs()),compare=new TypedPostgresImporter(db);
  for(const spec of postgresTableSpecs()){
    if(counts.get(spec.name)!==source.tables.find((t:any)=>t.name===spec.name).count)throw new Error("Destination count differs from its declared source");
    let batch:Record<string,unknown>[]=[],bytes=0;
    for await(const row of rows(directory,spec,source)){
      batch.push(row);bytes+=Buffer.byteLength(JSON.stringify(row));
      if(batch.length>=5000||bytes>=2_000_000){await compare.compareRows(spec,batch);batch=[];bytes=0;}
    }
    if(batch.length)await compare.compareRows(spec,batch);
  }
}
function sqlRow(spec:ReturnType<typeof postgresTableSpecs>[number],row:Record<string,unknown>){
  return Object.fromEntries(Object.entries(row).flatMap(([name,value])=>{
    const column=spec.columns.find(column=>column.name===name);
    if(column?.type==="BLOB"&&value!==null)value="\\x"+Buffer.from(value as Uint8Array).toString("hex");
    if(column?.type==="JSONB"&&value===null)return []; // Snapshot JSONB values are semantic JSON, not encoded input strings.
    return [[name,value]];
  }));
}
const guardSql=`CREATE FUNCTION pg_temp.verify_rehearsal_backup(expected jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE item jsonb; totals jsonb; canonical text; actual text;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(expected) LOOP
  EXECUTE format('WITH hashes AS MATERIALIZED (SELECT encode(sha256(convert_to(row_to_json(t)::text,''UTF8'')),''hex'') AS h FROM %I.%I t)
    SELECT jsonb_build_object(''count'',count(*)::text,''s0'',coalesce(sum((''x''||substr(h,1,16))::bit(64)::bigint::numeric),0)::text,
    ''s1'',coalesce(sum((''x''||substr(h,17,16))::bit(64)::bigint::numeric),0)::text,
    ''s2'',coalesce(sum((''x''||substr(h,33,16))::bit(64)::bigint::numeric),0)::text,
    ''s3'',coalesce(sum((''x''||substr(h,49,16))::bit(64)::bigint::numeric),0)::text) FROM hashes',item->>'schema',item->>'name') INTO totals;
  canonical := '{"count":"'||(totals->>'count')||'","s0":"'||(totals->>'s0')||'","s1":"'||(totals->>'s1')||'","s2":"'||(totals->>'s2')||'","s3":"'||(totals->>'s3')||'"}';
  actual := encode(sha256(convert_to(canonical,'UTF8')),'hex');
  IF actual<>item->>'rowChecksum' THEN RAISE EXCEPTION 'Destination changed since verified backup'; END IF;
 END LOOP;
END $$;`;

async function main(){
  process.umask(0o077);
  const [beforeDirectory,afterDirectory,backupDirectory,mode]=process.argv.slice(2);
  const final=mode==="--apply-final-sync";
  if(!beforeDirectory||!afterDirectory||!process.env.SUPABASE_DATABASE_URL||!final&&mode!=="--apply-rehearsal-refresh")throw new Error("Explicit refresh/final sync, two verified snapshots and a backup directory required");
  const before=manifest(beforeDirectory),after=manifest(afterDirectory,final),endpoint=new URL(process.env.SUPABASE_DATABASE_URL);
  const local=["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname);
  if(endpoint.search||endpoint.hash||(local?!/^\/meldiq_customer_rehearsal_[a-f0-9]{32}$/.test(endpoint.pathname)||process.env.SUPABASE_ENVIRONMENT!=="development":
    process.env.SUPABASE_ENVIRONMENT!=="staging"||process.env.SUPABASE_EXPECTED_PROJECT_REF!==project||endpoint.hostname!=="aws-1-eu-central-1.pooler.supabase.com"||endpoint.port!=="5432"||endpoint.pathname!=="/postgres"||decodeURIComponent(endpoint.username)!==`postgres.${project}`))throw new Error("Only the owned clone or approved Frankfurt rehearsal is permitted");
  if(final){if(local)throw new Error("Final sync requires the approved Frankfurt project");verifyFreeze(after);}
  const report:any={ok:false,observedAt:new Date().toISOString(),productionCutoverCompleted:false,sourceModified:false,scope:local?"owned loopback refresh":"backed customer-data rehearsal refresh",beforeSourceSha256:before.sourceSha256,afterSourceSha256:after.sourceSha256,phase:"backup-validation"};
  let guarded:any[]|undefined;
  if(!local){
    const mirrorRoot=path.join(os.homedir(),".local/share/meldiq-migration/offhost-mirror");
    if(!backupDirectory||path.dirname(path.resolve(backupDirectory))!==mirrorRoot)throw new Error("Owned complete off-host backup required");
    for(const file of ["manifest.json","restore-verification.json"])privateFile(path.join(backupDirectory,file));
    const backup=JSON.parse(fs.readFileSync(path.join(backupDirectory,"manifest.json"),"utf8")),proof=JSON.parse(fs.readFileSync(path.join(backupDirectory,"restore-verification.json"),"utf8"));
    const captured=backup.capturedAt.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,"$1-$2-$3T$4:$5:$6Z");
    if(!backup.complete||backup.projectRef!==project||!backup.rehearsal||!proof.ok||!proof.encryptedBackupVerified||!proof.allMirroredPayloadsAuthenticated||!proof.exactRowFingerprintsMatch||proof.reconciledTables!==317||proof.sourceCapturedAt!==backup.capturedAt||!Number.isFinite(Date.parse(captured))||Date.parse(captured)>Date.now()+60_000||Date.now()-Date.parse(captured)>3600_000)throw new Error("Fresh independently restored Frankfurt rehearsal backup required");
    for(const name of ["database.dump.age","source-manifest.json.age"]){const file=backup.files.find((f:any)=>f.name===name);privateFile(path.join(backupDirectory,name));if(!file||await checksum(path.join(backupDirectory,name))!==file.sha256)throw new Error("Verified backup archive changed");}
    const identity=path.join(os.homedir(),".local/share/meldiq-supabase/recovery-keys/vps-20261101T174639Z.agekey");privateFile(identity);
    const metadata=JSON.parse(execFileSync("age",["-d","-i",identity,path.join(backupDirectory,"source-manifest.json.age")],{encoding:"utf8",maxBuffer:2_000_000}));
    if(digest(JSON.stringify(metadata.tables))!==proof.sourceManifestSha256)throw new Error("Backup fingerprint evidence changed");
    guarded=metadata.tables.filter((table:any)=>["meldiq","meldiq_private"].includes(table.schema));
    if(guarded?.length!==289||guarded.some(table=>!/^[a-z_][a-z0-9_]*$/.test(table.name)||!/^[a-f0-9]{64}$/.test(table.rowChecksum)))throw new Error("Incomplete protected-table backup");
  }
  const db=new MeldiqPostgres({url:endpoint.href,environment:local?"development":"staging",maxConnections:1,ca:local?undefined:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE!,"utf8")});
  try{
    const marker=(await db.query("SELECT coalesce(obj_description('meldiq'::regnamespace,'pg_namespace'),'') AS marker")).rows[0].marker;
    if(!local&&!marker.startsWith("Meldiq customer-data rehearsal:"))throw new Error("A serving or prepared production database cannot be refreshed");
    const native=(await db.query("SELECT (SELECT count(*) FROM meldiq_private.auth_links)+(SELECT count(*) FROM meldiq.auth_device_sessions)+(SELECT count(*) FROM meldiq_private.outbox)+(SELECT count(*) FROM meldiq_private.realtime_grants) AS n")).rows[0].n;
    if(native!==0)throw new Error("Native identity/delivery work must not be overwritten");
    report.phase="exact-before-reconciliation";await reconcile(db,beforeDirectory,before);
    report.phase="prepare-delta";
    const order=dependencyOrder(postgresTableSpecs()),upserts:Record<string,unknown>[]=[],deletes=new Map<string,Record<string,unknown>[]>();
    let updated=0,inserted=0,deleted=0;
    for(const spec of order){
      const keys=spec.primaryKey.length?spec.primaryKey:["rowid"],old=new Map<string,{hash:string;key:Record<string,unknown>}>();
      for await(const row of rows(beforeDirectory,spec,before)){const key=Object.fromEntries(keys.map(name=>[name,row[name]])),id=rowHash(key);if(old.has(id))throw new Error("Duplicate source key");old.set(id,{key,hash:rowHash(row)});}
      for await(const row of rows(afterDirectory,spec,after)){
        const id=rowHash(Object.fromEntries(keys.map(name=>[name,row[name]]))),previous=old.get(id);
        if(!previous||previous.hash!==rowHash(row)){upserts.push({table:spec.name,row:sqlRow(spec,row)});if(previous)updated++;else inserted++;}
        old.delete(id);
      }
      const removals=[...old.values()].map(previous=>({table:spec.name,key:sqlRow(spec,previous.key)}));deleted+=removals.length;deletes.set(spec.name,removals);
    }
    const removals=[...order].reverse().flatMap(spec=>deletes.get(spec.name)??[]);
    report.delta={inserted,updated,deleted};report.phase="atomic-refresh";
    if(final)verifyFreeze(after);
    await db.transaction(async client=>{
      await client.query("SET LOCAL statement_timeout='5min'; SET LOCAL lock_timeout='5s'");
      const locked=(await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('meldiq-rows-writer',0)) AS locked")).rows[0].locked;
      if(!locked)throw new Error("The application repository writer must be stopped");
      const protectedTables=guarded??[...postgresTableSpecs().map(table=>({schema:"meldiq",name:table.name})),...["auth_links","revoked_auth_sessions","row_counters","migration_batches","migration_runs","outbox","realtime_grants"].map(name=>({schema:"meldiq_private",name}))];
      await client.query(`LOCK TABLE ${protectedTables.map(table=>`${q(table.schema)}.${q(table.name)}`).join(",")} IN ACCESS EXCLUSIVE MODE NOWAIT`);
      if(guarded){await client.query(guardSql);await client.query("SELECT pg_temp.verify_rehearsal_backup($1::jsonb)",[JSON.stringify(guarded)]);}
      // The source already owns cleanup queues. Replaying a snapshot must not synthesize new S3 deletions.
      await client.query("ALTER TABLE meldiq.attachments DISABLE TRIGGER attachment_removed_cleanup; ALTER TABLE meldiq.attachment_uploads DISABLE TRIGGER upload_removed_cleanup");
      // Upsert parents and changed foreign keys first; remove deleted children before parents. Any conflict aborts the whole refresh.
      if(upserts.length)await client.query("SELECT meldiq_private.apply_row_changes($1::jsonb,'{}'::jsonb)",[JSON.stringify(upserts)]);
      if(removals.length)await client.query("SELECT meldiq_private.apply_row_changes($1::jsonb,'{}'::jsonb)",[JSON.stringify(removals)]);
      // INSERT/UPDATE can queue deferred FK events on these relations, even with cleanup disabled.
      // Validate the complete delta and drain that queue before ALTER TABLE restores the cleanup triggers.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("ALTER TABLE meldiq.attachments ENABLE TRIGGER attachment_removed_cleanup; ALTER TABLE meldiq.attachment_uploads ENABLE TRIGGER upload_removed_cleanup");
      await client.query("SELECT meldiq_private.apply_row_changes('[]'::jsonb,$1::jsonb)",[JSON.stringify(after.counters)]);
      const prior=(await client.query("SELECT source_sha256,catalog_sha256 FROM meldiq_private.migration_runs WHERE id=$1",[after.id])).rows[0];
      if(prior&&(prior.source_sha256!==after.sourceSha256||prior.catalog_sha256!==after.catalogSha256))throw new Error("Import ledger source changed");
      if(!prior){
        await client.query("INSERT INTO meldiq_private.migration_runs(id,source_sha256,catalog_sha256,environment) VALUES($1,$2,$3,$4)",[after.id,after.sourceSha256,after.catalogSha256,local?"development":"staging"]);
        await client.query("INSERT INTO meldiq_private.migration_batches(run_id,table_name,batch_number,record_count,sha256) SELECT $1::uuid,name,0,count,sha256 FROM jsonb_to_recordset($2::jsonb) AS t(name text,count bigint,sha256 text)",[after.id,JSON.stringify(after.tables)]);
      }
      if(final)verifyFreeze(after);
      await client.query(`COMMENT ON SCHEMA meldiq IS '${final?"Meldiq prepared production database":"Meldiq customer-data rehearsal"}: ${after.id}; ${final?"source frozen; private activation required":"Atlas remains live"}'`);
    });
    report.atomicDeltaCommitted=true;report.phase="exact-after-reconciliation";await reconcile(db,afterDirectory,after);
    if(final){verifyFreeze(after);report.finalFrozenSourceReconciled=true;report.preparedForProduction=true;}
    report.allRecordHashesMatch=true;report.tables=postgresTableSpecs().length;report.records=after.tables.reduce((sum:number,table:any)=>sum+table.count,0);report.phase="complete";report.ok=true;
  }catch(error){report.errorCode=/^[A-Z0-9_]{5,40}$/.test((error as any)?.code??"")?(error as any).code:"refresh_stopped";fs.writeFileSync(path.join(afterDirectory,"refresh-diagnostics.json"),JSON.stringify({code:report.errorCode,message:error instanceof Error?error.message:"refresh stopped",table:(error as any)?.table,constraint:(error as any)?.constraint},null,2)+"\n",{mode:0o600});process.exitCode=1;}
  finally{await db.close();report.completedAt=new Date().toISOString();fs.writeFileSync(path.join(afterDirectory,"refresh-results.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});fs.appendFileSync(path.join(afterDirectory,"refresh-history.ndjson"),JSON.stringify(report)+"\n",{mode:0o600});console.log(JSON.stringify(report));}
}
main().catch(()=>{console.error("Rehearsal refresh stopped; keep Atlas live and inspect private evidence. No production cutover was performed.");process.exitCode=1;});
