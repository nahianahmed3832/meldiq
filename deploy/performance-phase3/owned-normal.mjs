// Isolated lab only. Run the published application's normal index, including jobs and shutdown.
import fs from 'node:fs';import http from 'node:http';import {setTimeout as pause} from 'node:timers/promises';
if(process.env.MELDIQ_OWNED_CANARY!=='synthetic-loopback'||process.env.SUPABASE_DATABASE_URL!=='postgresql://meldiq_canary_runtime@127.0.0.1:55433/postgres'){
 if(process.env.SLOT==='bad')throw Error('invalid standby rejected');throw Error('local synthetic database required');
}
Object.assign(process.env,{LOG_LEVEL:'silent',HOST:'127.0.0.1',PORT:'8080',REGISTRATION_MODE:'open',REGISTRATION_PER_ADDRESS_PER_HOUR:'0',REGISTRATION_PER_ADDRESS_PER_DAY:'0',REGISTRATION_OPEN_PER_DAY:'0',NEW_ACCOUNT_LIMIT_DAYS:'0',AUTH_RATE_LIMIT_PER_MINUTE:'100000',RATE_LIMIT_PER_MINUTE:'100000',COMMUNITY_BOTS:'off',TELEMETRY_TICK_MS:'60000',MAIL_TRANSPORT:'file',MAIL_FILE_DIR:'/control/test-mail'});
// Observe the real port binding. /resume still tests live PG + Redis and the operator checks one real lease.
const listen=http.Server.prototype.listen;
http.Server.prototype.listen=function(...args){this.once('listening',()=>{if(this.address()?.port===8080)fs.writeFileSync('/control/api-ready.json',JSON.stringify({ready:true,phase:'normal-index',held:false,node:process.version}));});return listen.apply(this,args);};
const slot=process.env.SLOT;
if(slot==='initial'){await import('/app/dist/index.js');}else{
 const {PreparedPages}=await import('/app/dist/infrastructure/database/rows/preparedPages.js');
 const {PostgresRows}=await import('/app/dist/infrastructure/database/rows/postgresRows.js');
 // Simulate the extra time measured on the real production shadow; this adapter only ADDS delay.
 const base=PreparedPages.prototype.reconcile,open=PostgresRows.open;let began;
 PreparedPages.prototype.reconcile=function(...args){began=performance.now();return base.apply(this,args);};
 PostgresRows.open=async function(...args){const rows=await open.apply(this,args);if(!began)throw Error('missing prepared read');
   const measured=performance.now()-began,extra=Math.max(0,4295-measured);if(extra)await pause(extra);
   fs.writeFileSync('/control/floor-'+slot,JSON.stringify({measured,extra}));return rows;};
 await import('./standby-boot.mjs');
}
