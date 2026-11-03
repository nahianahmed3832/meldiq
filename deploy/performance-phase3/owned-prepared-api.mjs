import fs from "node:fs";
import {loadConfig} from "/app/dist/app/config.js";
import {buildApp} from "/app/dist/app/server.js";
import {MeldiqPostgres} from "/app/dist/infrastructure/database/postgres/client.js";
const {openOperatorSocket}=await import(fs.existsSync("/app/dist/app/operatorSocket.js")?"/app/dist/app/operatorSocket.js":"/app/dist/modules/administration/operatorSocket.js");

if(process.env.MELDIQ_OWNED_CANARY!=="synthetic-loopback"||process.env.NODE_ENV!=="development")throw new Error("Owned synthetic canary settings required");
const endpoint=new URL(process.env.SUPABASE_DATABASE_URL);
if(endpoint.hostname!=="127.0.0.1"||endpoint.username!=="meldiq_canary_runtime"||endpoint.pathname!=="/postgres"||endpoint.port!=="55433")throw new Error("Canary refuses other databases");
const config=loadConfig({...process.env,DATA_DIR:"/data",LOG_LEVEL:"silent",REGISTRATION_MODE:"open",REGISTRATION_PER_ADDRESS_PER_HOUR:"0",REGISTRATION_PER_ADDRESS_PER_DAY:"0",REGISTRATION_OPEN_PER_DAY:"0",NEW_ACCOUNT_LIMIT_DAYS:"0",AUTH_RATE_LIMIT_PER_MINUTE:"100000",RATE_LIMIT_PER_MINUTE:"100000",TELEMETRY_TICK_MS:"0",REMINDER_TICK_MS:"0",WORKFLOW_TICK_MS:"0",COMMUNITY_BOTS:"off",DEFAULT_GROUP_ADD_POLICY:"everyone",MESSAGES_ACCEPT_ENCRYPTED:"false"});
const database=globalThis.ownedPreparedDatabase??new MeldiqPostgres(config.postgres);
// Apply the independently measured read-only production snapshot floor to this synthetic lab.
if(process.env.PH3_FINAL_READ_FLOOR_MS && globalThis.ownedPreparedDatabase){
  const {PreparedPages}=await import('/app/dist/infrastructure/database/rows/preparedPages.js');
  const {PostgresRows}=await import('/app/dist/infrastructure/database/rows/postgresRows.js');
  const capture=PreparedPages.prototype.reconcile,open=PostgresRows.open;let start=0;
  PreparedPages.prototype.reconcile=function(...args){
    start=performance.now();
    if(process.env.PH3_WARM_POOL==='1'){
      // PostgresRows.open has already acquired the exclusive writer lease. No extra
      // connection is taken from the incumbent. Warm service-reader sessions while the
      // fenced snapshot is being read, before the independent startup views need them.
      const count=Math.max(0,Math.min(4,(database.config.maxConnections??5)-2));
      globalThis.ownedPoolWarm=Promise.allSettled(Array.from({length:count},async()=>{const c=await database.connect();c.release();}));
    }
    return capture.apply(this,args);
  };
  PostgresRows.open=async function(...args){const result=await open.apply(this,args);
    if(!start)throw Error('prepared snapshot required');const measured=performance.now()-start;
    const extra=Math.max(0,Number(process.env.PH3_FINAL_READ_FLOOR_MS)-measured);
    if(extra)await new Promise(ok=>setTimeout(ok,extra));
    fs.writeFileSync('/control/floor-'+process.env.SLOT,JSON.stringify({measured,extra}));
    return result;
  };
}
let cutover;
{
  const {DatabaseCutover}=await import("/app/dist/app/databaseCutover.js");
  cutover=new DatabaseCutover("/data","zzzzzzzzzzzzzzzzzzzz","a".repeat(64));
}
const mailer=process.env.PH3_MANAGED_GATE==='1'?{kind:'memory',available:true,async send(m){
  if(m.to!=='release-gate@example.test')throw Error('unexpected fixture email');
  const code=m.text.match(/\b(\d{6})\b/)?.[1];
  if(code)fs.writeFileSync('/control/managed-mail',code,{mode:0o600});
}}:undefined;
const {app,ctx}=await buildApp(config,{postgres:database,cutover,logger:false,mailer});
const stopOperator=await openOperatorSocket(ctx);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await stopOperator();await app.close();ctx.db.close();await database.close();process.exit(0);}
process.on("SIGTERM",()=>void stop());process.on("SIGINT",()=>void stop());
await app.listen({host:"127.0.0.1",port:8080});
fs.writeFileSync("/control/api-ready.json",JSON.stringify({ready:true,phase:process.env.MELDIQ_CANARY_PHASE,held:ctx.databaseCutover?.held??false,node:process.version})+"\n");
