import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { openDatabase } from "../src/infrastructure/database/db.js";
import { MeldiqPostgres } from "../src/infrastructure/database/postgres/client.js";
import { PostgresMessageStore } from "../src/modules/messaging/store/postgresStore.js";
import { PostgresOutbox } from "../src/infrastructure/database/postgres/outbox.js";

const execute=promisify(execFile);
const connection=process.env.MELDIQ_PG_TEST_URL;
if(!connection)throw new Error("Loopback MELDIQ_PG_TEST_URL required");
const base=new URL(connection);
if(!["localhost","127.0.0.1","[::1]"].includes(base.hostname))throw new Error("Rehearsal refuses remote databases");
const web=process.env.MELDIQ_SUPABASE_WEB_ROOT??path.resolve(process.cwd(),"../../meldiq_web");
const bin=process.env.POSTGRES_BIN??"/opt/homebrew/opt/postgresql@17/bin";
const stamp=Date.now(),destination=`meldiq_supabase_rehearsal_${stamp}`,restored=`meldiq_supabase_restore_${stamp}`;
const directory=path.join(os.homedir(),".local/share/meldiq-supabase",`rehearsal-${stamp}`);
process.umask(0o077);fs.mkdirSync(directory,{recursive:true,mode:0o700});
const admin=new pg.Pool({connectionString:connection,max:1});
const source=path.join(directory,"synthetic.sqlite");
const snapshot=path.join(directory,"snapshot");
const url=new URL(base);url.pathname=`/${destination}`;
const restoreUrl=new URL(base);restoreUrl.pathname=`/${restored}`;
const report:Record<string,unknown>={observedAt:new Date().toISOString(),synthetic:true,productionChanged:false,privateDirectory:directory};
let db:MeldiqPostgres|undefined;
async function script(name:string,args:string[],environment:NodeJS.ProcessEnv){
  const result=await execute(process.execPath,["--import","tsx",`scripts/${name}`, ...args],{env:{...process.env,...environment},maxBuffer:2_000_000});
  fs.writeFileSync(path.join(directory,`${name.replace(/\.ts$/,"")}-${Date.now()}.log`),result.stdout+result.stderr,{mode:0o600});
}
try{
  const sqlite=openDatabase(source);
  for(let n=1;n<=2;n++){
    sqlite.prepare("INSERT INTO users(id,username,display_name,identity_key,avatar_color,created_at,updated_at) VALUES(?,?,?,?,1,1000,1000)").run(`fixture${n}`,`fixture${n}`,`Fixture ${n}`,`fixture-key-${n}`);
    sqlite.prepare("INSERT INTO accounts(id,email,name,password_hash,password_changed_at,user_id,created_at,updated_at) VALUES(?,?,?,'!synthetic-only',1000,?,1000,1000)").run(`account${n}`,`fixture${n}@example.invalid`,`Fixture ${n}`,`fixture${n}`);
  }
  sqlite.prepare("INSERT INTO conversations(id,type,created_by,created_at,updated_at) VALUES('fixtureconversation','DM','fixture1',1000,1000)").run();
  sqlite.prepare("INSERT INTO conversation_members(conversation_id,user_id,role,joined_at) VALUES('fixtureconversation','fixture1','MEMBER',1000),('fixtureconversation','fixture2','MEMBER',1000)").run();
  const insert=sqlite.prepare("INSERT INTO message_events(id,conversation_id,sender_user_id,sender_device_id,cls,type,target,audience,payload,sent_at,server_ts,mention_all,imported_by) VALUES(?,'fixtureconversation','fixture1',NULL,'message','text',NULL,'all',?,1000,?,0,'fixture1')");
  sqlite.transaction(()=>{for(let n=0;n<1000;n++)insert.run(`fixturemessage${String(n).padStart(5,"0")}`,JSON.stringify({type:"text",text:`Synthetic message ${n}`}),1000+Math.floor(n/3));})();
  sqlite.prepare("INSERT INTO attachments(id,conversation_id,uploader_user_id,size,created_at,expires_at) VALUES('fixtureattachment','fixtureconversation','fixture1',1024000000,1000,9999999999999)").run();
  sqlite.prepare("INSERT INTO spark_purchases(id,buyer_account_id,buyer_user_id,quantity,currency,amount_minor,status,provider,created_at,expires_at,updated_at) VALUES('syntheticpurchase','account1','fixture1',1,'USD',1250,'pending','synthetic',1000,9999999999999,1000)").run();
  sqlite.pragma("wal_checkpoint(TRUNCATE)");sqlite.close();
  await script("supabase-export.ts",["sqlite",source,snapshot,"--synthetic-frozen"],{});
  await admin.query(`CREATE DATABASE ${destination}`);
  db=new MeldiqPostgres({url:url.href,environment:"development",maxConnections:6});
  await db.query(fs.readFileSync(path.join(web,"scripts/supabase/postgres-bootstrap.sql"),"utf8"));
  for(const file of fs.readdirSync(path.join(web,"supabase/migrations")).filter(f=>f.endsWith(".sql")).sort())await db.transaction(async()=>{await db!.query(fs.readFileSync(path.join(web,"supabase/migrations",file),"utf8"));});
  const environment={SUPABASE_DATABASE_URL:url.href,SUPABASE_ENVIRONMENT:"development",SUPABASE_EXPECTED_PROJECT_REF:"local-rehearsal"};
  let start=performance.now();await script("supabase-import.ts",[snapshot],environment);report.importMilliseconds=performance.now()-start;
  start=performance.now();await script("supabase-import.ts",[snapshot],environment);report.resumeMilliseconds=performance.now()-start;
  const reconciliation=path.join(directory,"reconciliation.json");await script("supabase-reconcile.ts",[snapshot,reconciliation],environment);
  const reconciled=JSON.parse(fs.readFileSync(reconciliation,"utf8"));report.tablesReconciled=reconciled.tables.length;report.recordsReconciled=reconciled.tables.reduce((n:number,t:{source:number})=>n+t.source,0);report.reconciliationPassed=reconciled.ok;
  const minor=reconciled.tables.find((t:{name:string})=>t.name==="spark_purchases");report.syntheticFinancialTotal=minor.financialTotalsMinor;
  // Real PostgreSQL custom archive and independent restore, not a mocked copy.
  const archive=path.join(directory,"postgres.dump");
  const env={...process.env,PGHOST:base.hostname,PGPORT:base.port,PGUSER:decodeURIComponent(base.username),PGPASSWORD:decodeURIComponent(base.password)};
  start=performance.now();await execute(path.join(bin,"pg_dump"),["-Fc","-d",destination,"-f",archive],{env});report.dumpMilliseconds=performance.now()-start;
  await admin.query(`CREATE DATABASE ${restored}`);
  start=performance.now();await execute(path.join(bin,"pg_restore"),["--exit-on-error","-d",restored,archive],{env,maxBuffer:2_000_000});report.restoreMilliseconds=performance.now()-start;
  const restoredReport=path.join(directory,"restore-reconciliation.json");await script("supabase-reconcile.ts",[snapshot,restoredReport],{...environment,SUPABASE_DATABASE_URL:restoreUrl.href});
  report.restoreReconciliationPassed=JSON.parse(fs.readFileSync(restoredReport,"utf8")).ok;
  const messages=new PostgresMessageStore(db),samples:number[]=[];
  let errors=0,index=0;const count=200;
  start=performance.now();
  await Promise.all(Array.from({length:10},async()=>{while(index<count){const n=index++,t=performance.now();try{await messages.add({id:`loadmessage${String(n).padStart(5,"0")}`,conversation_id:"fixtureconversation",sender_user_id:"fixture1",sender_device_id:null,cls:"message",type:"text",target:null,audience:"all",payload:'{"type":"text","text":"Synthetic concurrent load"}',sent_at:2000,server_ts:2000+n,mention_all:0,imported_by:null});samples.push(performance.now()-t);}catch{errors++;}}}));
  const elapsed=performance.now()-start;samples.sort((a,b)=>a-b);
  report.localRepositoryLoad={requests:count,concurrency:10,errors,errorRate:errors/count,elapsedMilliseconds:elapsed,p50Milliseconds:samples[Math.floor(samples.length*.5)],p95Milliseconds:samples[Math.floor(samples.length*.95)],connectionPool:db.metrics(),processRssBytes:process.memoryUsage().rss,scope:"local PostgreSQL repository only, not HTTP or hosted Realtime"};
  const outbox=new PostgresOutbox(db);let delivered=0;start=performance.now();while(delivered<count){const result=await outbox.runRealtimeOnce();if(!result.claimed)break;delivered+=result.delivered;}
  report.testRealtimeEnqueue={delivered,elapsedMilliseconds:performance.now()-start,scope:"plain-Postgres realtime.send contract stub; not a hosted socket delivery test"};
  report.ok=errors===0&&delivered===count&&report.reconciliationPassed&&report.restoreReconciliationPassed;
}catch(error){report.ok=false;report.error=error instanceof Error?error.message.slice(0,300):"rehearsal_failed";process.exitCode=1;}
finally{
  await db?.close();await admin.end();
  fs.writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
  fs.writeFileSync(path.join(web,"docs/testing/supabase-rehearsal-results.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({ok:report.ok,report:path.join(directory,"report.json")}));
}
