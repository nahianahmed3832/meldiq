import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

// Called only after the caller has restored and fingerprinted its own loopback database.
export async function reconcileRestoredSource({snapshot,database,directory,sourceManifestSha256,ciphertextSha256}) {
  const privateRoot=path.join(os.homedir(),".local/share/meldiq-supabase");
  if(!/^meldiq_(?:restore_hosted|vps_restore)_[a-f0-9]{16}$/.test(database)||
    !/^[a-f0-9]{64}$/.test(sourceManifestSha256)||!/^[a-f0-9]{64}$/.test(ciphertextSha256))throw new Error("Owned restored database and exact archive fingerprints required");
  snapshot=path.resolve(snapshot);
  if(path.dirname(path.dirname(snapshot))!==privateRoot||path.basename(snapshot)!=="normalized"||!/^atlas-(?:cutover|rehearsal)-\d{8}T\d{6}Z$/.test(path.basename(path.dirname(snapshot))))throw new Error("Owned normalized customer snapshot required");
  function privateFile(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077)throw new Error("Private regular source required");}
  for(const file of ["manifest.json","local-validation.json"])privateFile(path.join(snapshot,file));
  const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,"manifest.json"),"utf8"));
  const prior=JSON.parse(fs.readFileSync(path.join(snapshot,"local-validation.json"),"utf8"));
  const digest=value=>crypto.createHash("sha256").update(value).digest("hex");
  if(!manifest.realDataSnapshot||manifest.synthetic||!manifest.frozen||!prior.ok||!prior.allRecordHashesMatch||
    prior.sourceSha256!==manifest.sourceSha256||prior.catalogSha256!==manifest.catalogSha256||
    manifest.sourceSha256!==digest(JSON.stringify(manifest.tables))||manifest.tables.length!==282)throw new Error("Exact immutable locally validated source required");
  for(const table of manifest.tables){
    if(!/^[a-z_][a-z0-9_]*$/.test(table.name)||!/^[a-f0-9]{64}$/.test(table.sha256))throw new Error("Invalid source inventory");
    const file=path.join(snapshot,table.name+".ndjson");privateFile(file);
    const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(file))hash.update(chunk);
    if(hash.digest("hex")!==table.sha256)throw new Error("Source content changed");
  }
  const server=process.env.MELDIQ_SERVER_DIR??path.resolve(import.meta.dirname,"../../server");
  const output=path.join(directory,"source-reconciliation.json");
  const env={...process.env,SUPABASE_DATABASE_URL:"postgresql://postgres@127.0.0.1:55432/"+database,SUPABASE_ENVIRONMENT:"development",SUPABASE_EXPECTED_PROJECT_REF:"local-restored-source"};
  delete env.SUPABASE_DB_CA_FILE;
  const result=await promisify(execFile)(process.execPath,["--import","tsx","scripts/supabase-reconcile.ts",snapshot,output,"--real-data-rehearsal"],{cwd:server,env,timeout:300_000,maxBuffer:2_000_000});
  fs.writeFileSync(path.join(directory,"source-reconciliation.log"),result.stdout+result.stderr,{mode:0o600});
  const rows=JSON.parse(fs.readFileSync(output,"utf8"));
  if(!rows.ok||rows.synthetic||rows.tables.length!==282||rows.tables.some(t=>!t.allRecordHashesMatch||t.source!==t.destination))throw new Error("Restored source reconciliation failed");
  const proof={ok:true,sourceSha256:manifest.sourceSha256,catalogSha256:manifest.catalogSha256,snapshotId:manifest.id,
    sourceManifestSha256,ciphertextSha256,tables:282,records:rows.tables.reduce((n,t)=>n+t.source,0),
    allRecordHashesMatch:true,allSourceFileHashesMatch:true,timestampFinancialAndCounterChecksPassed:true,
    comparisonDatabase:"owned loopback restore",completedAt:new Date().toISOString()};
  fs.writeFileSync(output,JSON.stringify({...rows,...proof},null,2)+"\n",{mode:0o600});
  return proof;
}
