import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {pipeline} from "node:stream/promises";

process.umask(0o077);
const root=path.join(os.homedir(),".local/share/meldiq-migration/offhost-mirror");
const directory=path.resolve(process.argv[2]??"");
if(path.dirname(directory)!==root||!/^\d{8}T\d{6}Z$/.test(path.basename(directory)))throw new Error("An owned off-host mirror directory is required");
function privateFile(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error("Private regular file required");}
const key=path.join(os.homedir(),".local/share/meldiq-supabase/recovery-keys/vps-20261101T174639Z.agekey");privateFile(key);
privateFile(path.join(directory,"manifest.json"));
const source=JSON.parse(fs.readFileSync(path.join(directory,"manifest.json"),"utf8"));
if(!source.complete||source.authority!=="Supabase PostgreSQL"||source.projectRef!=="bkvlxbsnzqkhbifawcww"||source.capturedAt!==path.basename(directory)||!source.allPayloadDecryptionVerified||!source.consistentReadOnlySnapshot||!source.fullDumpParsingVerified)throw new Error("Complete verified Frankfurt backup required");
const execute=promisify(execFile), pgBin="/opt/homebrew/opt/postgresql@17/bin";
const env={PATH:process.env.PATH,LANG:"C",PGCONNECT_TIMEOUT:"5",PGAPPNAME:"meldiq-owned-offhost-restore"};
const version=await execute(path.join(pgBin,"pg_restore"),["--version"],{env});
if(!version.stdout.startsWith("pg_restore (PostgreSQL) 17."))throw new Error("PostgreSQL 17 restore tools required");
const server=process.env.MELDIQ_SERVER_DIR??path.resolve(import.meta.dirname,"../../server");
const require=createRequire(path.join(server,"package.json"));
const {Client}=require("pg");
const local={host:"127.0.0.1",port:55432,user:"postgres",database:"postgres",connectionTimeoutMillis:5000};
const administrator=new Client(local), name="meldiq_vps_restore_"+crypto.randomBytes(8).toString("hex");
const report={ok:false,observedAt:new Date().toISOString(),sourceCapturedAt:source.capturedAt,projectRef:source.projectRef,offHostMirror:true,
  sourceDatabaseModified:false,plaintextDumpWritten:false,fullServiceRecoveryVerified:false,phase:"archive-verification"};
let created=false,restored;
function identifier(value){if(!/^[a-z_][a-z0-9_]*$/.test(value))throw new Error("Unexpected database identifier");return '"'+value+'"';}
function child(command,args,extra={}){
  const process=spawn(command,args,{env:{...env,...extra},stdio:["pipe","pipe","pipe"]});process.stderr.resume();
  const done=new Promise((resolve,reject)=>{process.once("error",()=>reject(new Error("Restore tool failed to start")));process.once("close",code=>code===0?resolve():reject(new Error("Restore tool failed")));});done.catch(()=>{});
  return {process,done};
}
async function manifest(client){
  const tables=(await client.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY n.nspname,c.relname`,[source.schemas??["auth","meldiq","meldiq_private","supabase_migrations"]])).rows;
  const result=[];
  for(let offset=0;offset<tables.length;offset+=8){
    const batch=tables.slice(offset,offset+8),row="encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex')";
    const replies=await client.query(batch.map(table=>`SELECT count(*)::text AS count,${[0,1,2,3].map(i=>`coalesce(sum(('x'||substr(${row},${i*16+1},16))::bit(64)::bigint::numeric),0)::text AS s${i}`).join(",")} FROM ${identifier(table.schema)}.${identifier(table.name)} t`).join(";"));
    const list=Array.isArray(replies)?replies:[replies];
    for(const [i,reply] of list.entries())result.push({...batch[i],count:reply.rows[0].count,rowChecksum:crypto.createHash("sha256").update(JSON.stringify(reply.rows[0])).digest("hex")});
  }
  return result;
}
try{
  for(const file of source.files){
    if(!/^[a-z0-9][a-z0-9._-]+\.age$/.test(file.name)||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error("Invalid backup inventory");
    const filename=path.join(directory,file.name);privateFile(filename);
    const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(filename))hash.update(chunk);
    if(hash.digest("hex")!==file.sha256||fs.statSync(filename).size!==file.bytes)throw new Error("Mirrored payload changed");
    const check=child("age",["-d","-i",key,filename]);check.process.stdin.end();check.process.stdout.resume();await check.done;
  }
  report.allMirroredPayloadsAuthenticated=true;report.encryptedFiles=source.files.length;
  const recovered=await execute("age",["-d","-i",key,path.join(directory,"source-manifest.json.age")],{env,maxBuffer:2_000_000});
  const expected=JSON.parse(recovered.stdout).tables;
  if(expected.length!==source.tables||source.tables!==317||expected.reduce((n,t)=>n+Number(t.count),0)!==source.rows)throw new Error("Backup fingerprint inventory mismatch");
  report.sourceManifestSha256=crypto.createHash("sha256").update(JSON.stringify(expected)).digest("hex");
  report.phase="owned-loopback-restore";
  await administrator.connect();await administrator.query(`CREATE DATABASE ${identifier(name)} TEMPLATE template0`);created=true;
  restored=new Client({...local,database:name});await restored.connect();
  await restored.query(`CREATE SCHEMA realtime; CREATE TABLE realtime.messages(id uuid DEFAULT gen_random_uuid(),extension text,payload jsonb,event text,topic text,private boolean);
    CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic',true) $$;
    CREATE FUNCTION realtime.send(jsonb,text,text,boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
    CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;`);
  const start=performance.now(),decrypt=child("age",["-d","-i",key,path.join(directory,"database.dump.age")]);decrypt.process.stdin.end();
  const restore=child(path.join(pgBin,"pg_restore"),["--no-owner","--no-acl","--exit-on-error","--single-transaction","--dbname="+name],{PGHOST:"127.0.0.1",PGPORT:"55432",PGUSER:"postgres",PGSSLMODE:"disable"});restore.process.stdout.resume();
  try{await Promise.all([pipeline(decrypt.process.stdout,restore.process.stdin),decrypt.done,restore.done]);}finally{decrypt.process.kill();restore.process.kill();}
  report.restoreMilliseconds=Math.round(performance.now()-start);
  report.phase="exact-restored-row-reconciliation";
  await restored.query("SET timezone='UTC';SET extra_float_digits=3");
  const actual=await manifest(restored);
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error("Restored rows differ from the exported snapshot");
  report.reconciledTables=actual.length;report.reconciledRows=source.rows;report.exactRowFingerprintsMatch=true;
  report.encryptedBackupVerified=true;report.policyScope="Stored schemas and Auth/application/migration rows; no Auth/Realtime/OAuth/SMTP service or production-role restore claim";
  report.phase="complete";report.ok=true;
}catch(error){report.errorCode=/^[A-Z0-9_]{5,40}$/.test(error?.code??"")?error.code:"verification_stopped";process.exitCode=1;}
finally{
  await restored?.end().catch(()=>{});
  if(created){try{await administrator.query(`DROP DATABASE ${identifier(name)} WITH (FORCE)`);report.ownedScratchDatabaseRemoved=true;}catch{report.ownedScratchDatabaseRemoved=false;report.ok=false;process.exitCode=1;}}
  await administrator.end().catch(()=>{});
  report.completedAt=new Date().toISOString();
  fs.writeFileSync(path.join(directory,"restore-verification.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
  fs.appendFileSync(path.join(directory,"restore-verification-history.ndjson"),JSON.stringify(report)+"\n",{mode:0o600});
  console.log(JSON.stringify(report));
}
