import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { postgresTableSpecs as tableSpecs } from "../src/infrastructure/database/postgres/nativeCatalog.js";
import { MeldiqPostgres } from "../src/infrastructure/database/postgres/client.js";
import { dependencyOrder, digest, TypedPostgresImporter, tableCounts, type MigrationRun } from "../src/infrastructure/database/postgres/migration.js";
import { assertSyntheticStagingDatabase } from "../src/infrastructure/database/postgres/sourceSnapshot.js";

/** Reads a private, frozen normalized NDJSON snapshot. Does not connect to a live legacy writer. */
async function main() {
  const snapshot=process.argv[2];
  if(!snapshot || !process.env.SUPABASE_DATABASE_URL || !process.env.SUPABASE_EXPECTED_PROJECT_REF) throw new Error("Snapshot directory, private SUPABASE_DATABASE_URL and SUPABASE_EXPECTED_PROJECT_REF are required");
  const environment=process.env.SUPABASE_ENVIRONMENT;
  if(environment!=="development"&&environment!=="staging") throw new Error("Only development/staging imports are enabled");
  const url=new URL(process.env.SUPABASE_DATABASE_URL);
  const local=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  const expected=process.env.SUPABASE_EXPECTED_PROJECT_REF;
  if(!local && !(url.hostname===`db.${expected}.supabase.co` || (url.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(url.username).endsWith(`.${expected}`)))) throw new Error("Destination does not match the explicit staging project");
  if(expected==="sgowwdmnavcsofzlgggm") throw new Error("Existing production social-auth project is not a staging destination");
  if(environment==="staging"&&local) throw new Error("Staging must identify the hosted staging project");
  const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,"manifest.json"),"utf8")) as MigrationRun & {frozen:boolean;synthetic:boolean;tables:{name:string;sha256:string;count:number}[];excludedCollections:{name:string;reason:string}[]};
  const real = !manifest.synthetic;
  if(!manifest.frozen || (real && (!process.argv.includes("--real-data-rehearsal") || (manifest as any).realDataSnapshot !== true || (manifest as any).purpose !== "staging-rehearsal" || (manifest as any).sourceWritesFrozen !== false || !local && expected !== "bkvlxbsnzqkhbifawcww"))) throw new Error("Explicit immutable real-data rehearsal or frozen synthetic snapshot required");
  if(digest(JSON.stringify(manifest.tables))!==manifest.sourceSha256) throw new Error("Snapshot manifest fingerprint mismatch");
  const specs=dependencyOrder(tableSpecs());
  if(digest(JSON.stringify(tableSpecs()))!==manifest.catalogSha256) throw new Error("Snapshot and runtime catalogs differ");
  if(manifest.tables.length!==specs.length || new Set(manifest.tables.map(t=>t.name)).size!==specs.length || specs.some(t=>!manifest.tables.some(f=>f.name===t.name))) throw new Error("Incomplete snapshot table inventory");
  // Verify each file before opening a destination connection. Files are bounded streams, not loaded into RAM.
  for(const table of manifest.tables) {
    if(!specs.some(t=>t.name===table.name)) throw new Error("Unknown snapshot collection");
    const hash=createHash("sha256");
    for await(const chunk of fs.createReadStream(path.join(snapshot,`${table.name}.ndjson`))) hash.update(chunk);
    if(hash.digest("hex")!==table.sha256) throw new Error(`Snapshot checksum failed for ${table.name}`);
  }
  const db=new MeldiqPostgres({url:url.href,environment,ca:process.env.SUPABASE_DB_CA_FILE?fs.readFileSync(process.env.SUPABASE_DB_CA_FILE,"utf8"):undefined,maxConnections:2});
  try {
    if(!real&&environment==="staging")await assertSyntheticStagingDatabase(db);
    if(real) {
      const previous = await db.query("SELECT source_sha256,catalog_sha256 FROM meldiq_private.migration_runs WHERE id=$1",[manifest.id]);
      if(!previous.rowCount) {
        const counts = await tableCounts(db,specs);
        if([...counts.values()].some(count=>count!==0)) throw new Error("Real-data rehearsal requires empty application tables; never mix customer and synthetic records");
      }
      if(!local) {
        const receipt=JSON.parse(fs.readFileSync(path.join(snapshot,"local-validation.json"),"utf8"));
        if(receipt.ok!==true||receipt.sourceSha256!==manifest.sourceSha256||receipt.catalogSha256!==manifest.catalogSha256||receipt.allRecordHashesMatch!==true) throw new Error("Exact successful local real-data rehearsal required before hosted import");
      }
    }
    const importer=new TypedPostgresImporter(db);await importer.start({...manifest,environment});
    const sourceCounts=new Map<string,number>();
    for(const spec of specs) {
      const expectedTable=manifest.tables.find(t=>t.name===spec.name)!;
      const input=readline.createInterface({input:fs.createReadStream(path.join(snapshot,`${spec.name}.ndjson`)),crlfDelay:Infinity});
      let batch:Record<string,unknown>[]=[],number=0,count=0;
      for await(const line of input) {if(!line)throw new Error("Empty source record");batch.push(JSON.parse(line));count++;if(batch.length===250){await importer.batch(manifest.id,spec,number++,batch);batch=[];}}
      if(batch.length)await importer.batch(manifest.id,spec,number,batch);
      if(count!==expectedTable.count)throw new Error(`Source count discrepancy for ${spec.name}`);
      sourceCounts.set(spec.name,count);
    }
    const destinationCounts=await tableCounts(db,specs);
    for(const spec of specs){
      const source=sourceCounts.get(spec.name),destination=destinationCounts.get(spec.name);
      if(source!==destination)throw new Error(`Count discrepancy for ${spec.name}`);
      console.log(JSON.stringify({table:spec.name,source,destination,reconciled:true}));
    }
    if(real) for(const [name,value] of Object.entries((manifest as any).counters??{})) {
      const spec=specs.find(table=>table.name===name);
      if(!spec||!(spec.autoincrement||!spec.primaryKey.length)||!Number.isSafeInteger(value)||Number(value)<0) throw new Error("Unmapped source counter");
      await db.query("INSERT INTO meldiq_private.row_counters(table_name,value) VALUES($1,$2) ON CONFLICT(table_name) DO UPDATE SET value=greatest(row_counters.value,excluded.value)",[name,value]);
    }
  } finally {await db.close();}
}
main().catch((error: unknown)=>{
  const code=error && typeof error==='object' && 'code' in error && /^[A-Z0-9_]{5,40}$/.test(String(error.code)) ? String(error.code) : 'migration_stopped';
  const message=error instanceof Error && /^Migration discrepancy table=[a-z_]+ keyDigest=[0-9a-f]+ sourceDigest=[0-9a-f]+ destinationDigest=(?:[0-9a-f]+|missing)$/.test(error.message) ? error.message : 'Import stopped; verify snapshot, environment, constraints and checkpoints';
  const directory=process.argv[2];
  const metadata=Object.fromEntries(['table','constraint'].flatMap(key=>{const value=error&&typeof error==='object'&&key in error?String((error as any)[key]):'';return /^[a-z][a-z0-9_]{0,62}$/.test(value)?[[key,value]]:[];}));
  if(directory && fs.existsSync(directory))fs.appendFileSync(path.join(directory,'errors.ndjson'),JSON.stringify({time:new Date().toISOString(),code,message,...metadata})+'\n',{mode:0o600});
  console.error(JSON.stringify({code,message}));process.exitCode=1;
});
