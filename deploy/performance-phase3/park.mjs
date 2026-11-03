// Prepare only read-only database state before ownership. The public listener and jobs start after the lease.
import fs from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
if(process.env.MELDIQ_OWNED_CANARY!=='synthetic-loopback'||!['initial','candidate','fallback','bad'].includes(process.env.SLOT))throw Error('unpublished rehearsal only');
await Promise.all(['/app/dist/app/server.js','/app/dist/app/config.js','/app/dist/infrastructure/database/postgres/client.js','/app/dist/app/operatorSocket.js'].map(x=>import(x)));
const slot=process.env.SLOT;
fs.writeFileSync('/control/parked-'+slot,'1');
if(process.env.PH3_NORMAL==='1'){
  const pre=['candidate','fallback'].includes(slot);
  const f='/control/'+(pre?'prepare-':'start-')+slot;
  while(!fs.existsSync(f))await pause(10);
  await import('./owned-normal.mjs');
}else{
if(process.env.PREPARE_PAGES==='1'&&['candidate','fallback'].includes(slot)){
  while(!fs.existsSync('/control/prepare-'+slot))await pause(10);
  const {MeldiqPostgres}=await import('/app/dist/infrastructure/database/postgres/client.js');
  const {PostgresRows}=await import('/app/dist/infrastructure/database/rows/postgresRows.js');
  const {tableSpecs}=await import('/app/dist/infrastructure/database/mongo/catalog.js');
  const {loadConfig}=await import('/app/dist/app/config.js');
  const cfg=loadConfig(process.env);
  if(new URL(cfg.postgres.url).hostname!=='127.0.0.1')throw Error('owned DB required');
  globalThis.ownedPreparedDatabase=new MeldiqPostgres(cfg.postgres);
  // The incumbent may retain all six sessions until its normal idle timeout. Preparation
  // waits before closing admissions; it cannot evict an incumbent database connection.
  let prepared=false;
  for(let i=0;i<10&&!prepared;i++){
    try{await PostgresRows.prepare(globalThis.ownedPreparedDatabase,tableSpecs());prepared=true;}
    catch(e){if(!['53300','ECONNRESET'].includes(e.code)&&e.message!=='Connection terminated unexpectedly')throw e;
      if(i===9)throw e;await pause(4500);}
  }
  if(process.env.PH3_PREFLIGHT==='1'){
    // Run the real Fastify constructor, in-memory SQLite bootstrap and PostgreSQL permission
    // preflight while the incumbent still serves. Stop immediately before the writer lock.
    // This adapter only exists on the owned synthetic entry point.
    const open=PostgresRows.open;
    PostgresRows.open=async function(...args){
      fs.writeFileSync('/control/prepared-'+slot,'1');
      while(!fs.existsSync('/control/start-'+slot))await pause(5);
      PostgresRows.open=open;
      return open.apply(this,args);
    };
    await import('./owned-prepared-api.mjs');
    process.exitCode=0;
  }else fs.writeFileSync('/control/prepared-'+slot,'1');
}
while(!fs.existsSync('/control/start-'+slot))await pause(10);
await import(process.env.PREPARE_PAGES==='1'?'./owned-prepared-api.mjs':'./owned-api-canary.mjs');

}
