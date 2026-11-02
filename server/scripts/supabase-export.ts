import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import Database from "better-sqlite3";
import { MongoClient } from "mongodb";
import { toRow } from "../src/infrastructure/database/mongo/catalog.js";
import { postgresTableSpecs as tableSpecs, NATIVE_TABLES, normalizeNativeDocument } from "../src/infrastructure/database/postgres/nativeCatalog.js";
import { digest, validateRow } from "../src/infrastructure/database/postgres/migration.js";

/** Synthetic staging rehearsals only. Production export requires a reviewed frozen-backup runbook. */
async function main() {
  const [kind,source,output]=process.argv.slice(2);
  if(!["sqlite","mongo"].includes(kind)||!source||!output||!process.argv.includes("--synthetic-frozen")) throw new Error("Usage: tsx scripts/supabase-export.ts sqlite|mongo source output --synthetic-frozen");
  if(fs.existsSync(output)) throw new Error("Refusing to overwrite an existing source snapshot");
  const specs=tableSpecs();
  let sqlite:Database.Database|undefined,mongo:MongoClient|undefined;
  if(kind==="sqlite") sqlite=new Database(source,{readonly:true,fileMustExist:true});
  else {
    const uri=process.env.MIGRATION_SOURCE_MONGODB_URI;
    if(!uri||!/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/|\?)/.test(uri)) throw new Error("Synthetic export requires a loopback MongoDB source");
    if(!/^[a-z0-9_-]*rehearsal[a-z0-9_-]*$/i.test(source)) throw new Error("Use an explicitly named rehearsal database");
    mongo=new MongoClient(uri,{maxPoolSize:1,serverSelectionTimeoutMS:5000});await mongo.connect();
    const names=await mongo.db(source).listCollections({}, {nameOnly:true}).toArray();
    if(names.some(c=>!specs.some(t=>t.name===c.name)&&c.name!=="orbit_meta")) throw new Error("Unmapped native/archival collection requires an explicit converter; nothing is silently dropped");
  }
  fs.mkdirSync(output,{recursive:false,mode:0o700});
  const files:{name:string;count:number;sha256:string}[]=[];
  try {
    // A source is immutable during export. SQLite is held in one read transaction.
    sqlite?.exec("BEGIN");
    for(const spec of specs) {
      const stream=fs.createWriteStream(path.join(output,`${spec.name}.ndjson`),{mode:0o600,flags:"wx"});
      const hash=crypto.createHash("sha256");let count=0;
      const native=NATIVE_TABLES.some(t=>t.name===spec.name);
      const rows=sqlite&&native?[]:sqlite?sqlite.prepare(`SELECT ${spec.primaryKey.length?"*":"rowid,*"} FROM "${spec.name}" ORDER BY ${spec.primaryKey.length?spec.primaryKey.map(c=>`"${c}"`).join(","):"rowid"}`).iterate():mongo!.db(source).collection(spec.name).find({}, {batchSize:250}).sort({_id:1});
      for await(const item of rows) {
        const raw=item as Record<string,unknown>;
        if(mongo&&!native&&Object.keys(raw).some(k=>k!=="_id"&&k!=="_retrieval"&&!spec.columns.some(c=>c.name===k))) throw new Error(`Unmapped column in ${spec.name}`);
        const row=validateRow(spec,sqlite?raw:native?normalizeNativeDocument(spec.name,raw):toRow(spec,raw));
        const serial=Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Buffer.isBuffer(v)||v instanceof Uint8Array?{$binary:Buffer.from(v).toString("base64")}:v]));
        const line=JSON.stringify(serial)+"\n";hash.update(line);count++;
        if(!stream.write(line))await once(stream,"drain");
      }
      stream.end();await once(stream,"finish");files.push({name:spec.name,count,sha256:hash.digest("hex")});
    }
    sqlite?.exec("COMMIT");
    const manifest={id:crypto.randomUUID(),frozen:true,synthetic:true,environment:"development",sourceKind:kind,createdAt:new Date().toISOString(),catalogSha256:digest(JSON.stringify(specs)),sourceSha256:digest(JSON.stringify(files)),tables:files,excludedCollections:kind==="mongo"?[{name:"orbit_meta",reason:"legacy bookkeeping only; schema/counters must be separately reconciled before production"}]:[]};
    fs.writeFileSync(path.join(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{mode:0o600,flag:"wx"});
    console.log(JSON.stringify({tables:files.length,records:files.reduce((n,f)=>n+f.count,0),sourceSha256:manifest.sourceSha256,synthetic:true}));
  } finally {sqlite?.close();await mongo?.close();}
}
main().catch(()=>{console.error("Export failed; incomplete snapshot retained privately and must not be imported.");process.exitCode=1;});
