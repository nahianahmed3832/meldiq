import fs from "node:fs";
import {loadConfig} from "/app/dist/app/config.js";
import {buildApp} from "/app/dist/app/server.js";
import {MeldiqPostgres} from "/app/dist/infrastructure/database/postgres/client.js";
import {openOperatorSocket} from "/app/dist/modules/administration/operatorSocket.js";

if(process.env.MELDIQ_OWNED_CANARY!=="synthetic-loopback"||process.env.NODE_ENV!=="development")throw new Error("Owned synthetic canary settings required");
const endpoint=new URL(process.env.SUPABASE_DATABASE_URL);
if(endpoint.hostname!=="127.0.0.1"||endpoint.username!=="meldiq_canary_runtime"||endpoint.pathname!=="/postgres"||endpoint.port!=="55433")throw new Error("Canary refuses other databases");
const config=loadConfig({...process.env,DATA_DIR:"/data",LOG_LEVEL:"silent",REGISTRATION_MODE:"open",REGISTRATION_PER_ADDRESS_PER_HOUR:"0",REGISTRATION_PER_ADDRESS_PER_DAY:"0",REGISTRATION_OPEN_PER_DAY:"0",NEW_ACCOUNT_LIMIT_DAYS:"0",AUTH_RATE_LIMIT_PER_MINUTE:"100000",RATE_LIMIT_PER_MINUTE:"100000",TELEMETRY_TICK_MS:"0",REMINDER_TICK_MS:"0",WORKFLOW_TICK_MS:"0",COMMUNITY_BOTS:"off",DEFAULT_GROUP_ADD_POLICY:"everyone",MESSAGES_ACCEPT_ENCRYPTED:"false"});
const database=new MeldiqPostgres(config.postgres);
let cutover;
if(process.env.MELDIQ_CANARY_PHASE==="candidate"){
  const {DatabaseCutover}=await import("/app/dist/app/databaseCutover.js");
  cutover=new DatabaseCutover("/data","zzzzzzzzzzzzzzzzzzzz","a".repeat(64));
}
const {app,ctx}=await buildApp(config,{postgres:database,cutover,logger:false});
const stopOperator=await openOperatorSocket(ctx);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await stopOperator();await app.close();ctx.db.close();await database.close();process.exit(0);}
process.on("SIGTERM",()=>void stop());process.on("SIGINT",()=>void stop());
await app.listen({host:"127.0.0.1",port:8080});
fs.writeFileSync("/control/api-ready.json",JSON.stringify({ready:true,phase:process.env.MELDIQ_CANARY_PHASE,held:ctx.databaseCutover?.held??false,node:process.version})+"\n");
