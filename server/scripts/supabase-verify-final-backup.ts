import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {digest} from "../src/infrastructure/database/postgres/migration.js";
import {MeldiqPostgres,identifier as q} from "../src/infrastructure/database/postgres/client.js";
import {project,privateFile,checksum,manifest,verifyFreeze,guardSql,requireRestoredSourceProof} from "./supabase-refresh-rehearsal.js";

async function main(){
  process.umask(0o077);
  const [directory,backupDirectory]=process.argv.slice(2);
  const after=manifest(directory,true);
  privateFile(path.join(directory,"refresh-results.json"));
  const prepared=JSON.parse(fs.readFileSync(path.join(directory,"refresh-results.json"),"utf8"));
  if(!prepared.atomicDeltaCommitted||prepared.afterSourceSha256!==after.sourceSha256||
    prepared.phase!=="awaiting-independent-final-backup"||prepared.ok||prepared.finalFrozenSourceReconciled)throw new Error("Unactivated prepared final delta required");
  if(path.dirname(path.resolve(backupDirectory))!==path.join(os.homedir(),".local/share/meldiq-supabase")||!/^hosted-backup-[a-f0-9]{16}$/.test(path.basename(backupDirectory)))throw new Error("Owned independent final backup required");
  for(const name of ["receipt.json","source-manifest.json","source-reconciliation.json","database.dump.age"])privateFile(path.join(backupDirectory,name));
  const receipt=JSON.parse(fs.readFileSync(path.join(backupDirectory,"receipt.json"),"utf8"));
  const expected=JSON.parse(fs.readFileSync(path.join(backupDirectory,"source-manifest.json"),"utf8")).tables;
  const sourceProof=JSON.parse(fs.readFileSync(path.join(backupDirectory,"source-reconciliation.json"),"utf8"));
  const captured=Date.parse(receipt.observedAt);
  if(!receipt.ok||receipt.projectRef!==project||!receipt.entireEncryptedArchiveAuthenticated||!receipt.archiveAuthenticatedAndReadable||receipt.reconciledTables!==317||
    receipt.remoteSqlWrites!==0||receipt.syntheticAuthUsersCreated!==0||!Number.isFinite(captured)||Date.now()-captured>3600_000||captured<Date.parse(prepared.completedAt)||
    await checksum(path.join(backupDirectory,"database.dump.age"))!==receipt.ciphertextSha256||digest(JSON.stringify(expected))!==receipt.sourceManifestSha256)throw new Error("Fresh authenticated, fully restored final backup required");
  requireRestoredSourceProof(receipt.sourceReconciliation,after,receipt.sourceManifestSha256,receipt.ciphertextSha256);
  requireRestoredSourceProof(sourceProof,after,receipt.sourceManifestSha256,receipt.ciphertextSha256);
  const endpoint=new URL(process.env.SUPABASE_DATABASE_URL??"");
  if(process.env.SUPABASE_ENVIRONMENT!=="staging"||process.env.SUPABASE_EXPECTED_PROJECT_REF!==project||endpoint.hostname!=="aws-1-eu-central-1.pooler.supabase.com"||endpoint.port!=="5432"||endpoint.pathname!=="/postgres"||endpoint.search||endpoint.hash||decodeURIComponent(endpoint.username)!==`postgres.${project}`)throw new Error("Approved unactivated Frankfurt destination required");
  const guarded=expected.filter((t:any)=>["meldiq","meldiq_private"].includes(t.schema));
  if(guarded.length!==289||guarded.some((t:any)=>!/^[a-z_][a-z0-9_]*$/.test(t.name)||!/^[a-f0-9]{64}$/.test(t.rowChecksum)))throw new Error("All protected-table fingerprints required");
  verifyFreeze(after);
  const db=new MeldiqPostgres({url:endpoint.href,environment:"staging",maxConnections:1,ca:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE!,"utf8")});
  try{
    await db.transaction(async client=>{
      await client.query("SET LOCAL statement_timeout='2min';SET LOCAL lock_timeout='5s'");
      if(!(await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('meldiq-rows-writer',0)) AS locked")).rows[0].locked)throw new Error("Application writer must remain stopped");
      await client.query(`LOCK TABLE ${guarded.map((t:any)=>`${q(t.schema)}.${q(t.name)}`).join(",")} IN ACCESS EXCLUSIVE MODE NOWAIT`);
      const marker=(await client.query("SELECT obj_description('meldiq'::regnamespace,'pg_namespace') AS marker")).rows[0].marker;
      if(marker!==`Meldiq prepared production database: ${after.id}; source frozen; private activation required`)throw new Error("Prepared destination changed");
      await client.query(guardSql);await client.query("SELECT pg_temp.verify_rehearsal_backup($1::jsonb)",[JSON.stringify(guarded)]);
      verifyFreeze(after);
    });
    verifyFreeze(after);
    const report={...prepared,ok:true,phase:"complete",allRecordHashesMatch:true,finalFrozenSourceReconciled:true,
      finalBackupCiphertextSha256:receipt.ciphertextSha256,finalBackupSourceManifestSha256:receipt.sourceManifestSha256,
      sourceComparison:"Every source row, timestamp range, financial total and counter checked against the independent loopback restore; all289 live protected fingerprints match that backup",
      completedAt:new Date().toISOString()};
    fs.writeFileSync(path.join(directory,"refresh-results.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
    fs.appendFileSync(path.join(directory,"refresh-history.ndjson"),JSON.stringify(report)+"\n",{mode:0o600});
    console.log(JSON.stringify(report));
  }finally{await db.close();}
}
main().catch(()=>{console.error("Final recovery/source verification stopped; destination remains unactivated. Inspect private receipts.");process.exitCode=1;});
