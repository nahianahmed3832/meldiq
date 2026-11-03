import fs from "node:fs";
import {MeldiqPostgres} from "/app/dist/infrastructure/database/postgres/client.js";
import {openPostgresRuntime} from "/app/dist/app/postgresRuntime.js";

// Run only from the isolated release image, without starting the API, timers or external providers.
const project="bkvlxbsnzqkhbifawcww",revision=process.env.MELDIQ_RUNTIME_REVISION,source=process.env.SUPABASE_EXPECTED_SOURCE_SHA256;
if(!/^[a-f0-9]{40}$/.test(revision??"")||!/^[a-f0-9]{64}$/.test(source??""))throw new Error("Exact release and rehearsal source fingerprints required");
const db=new MeldiqPostgres({url:process.env.SUPABASE_DATABASE_URL,environment:"staging",projectRef:project,maxConnections:6,deliveryMode:"legacy",ca:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE,"utf8")});
let runtime;
const report={ok:false,observedAt:new Date().toISOString(),projectRef:project,runtimeRevision:revision,sourceSha256:source,nodeVersion:process.version,
  phase:"restricted-role-and-source-check",productionContainerChanged:false,applicationDataWrites:0,httpServerStarted:false,externalProvidersStarted:false};
try{
  const run=(await db.query("SELECT id FROM meldiq_private.migration_runs WHERE source_sha256=$1",[source])).rows;
  if(run.length!==1)throw new Error("Expected rehearsal snapshot is absent");
  report.phase="hosted-repository-bootstrap";
  const start=performance.now();runtime=await openPostgresRuntime(db);
  report.bootstrapMilliseconds=Math.round(performance.now()-start);report.residentMemoryBytes=process.memoryUsage().rss;report.heapUsedBytes=process.memoryUsage().heapUsed;
  runtime.rows.assertAvailable();
  const observed={};
  for(const table of ["accounts","users","devices","orgs","conversations","billing_plan_versions","auth_device_sessions"]){
    const count=Number((await db.query(`SELECT count(*)::text AS n FROM meldiq."${table}"`)).rows[0].n);
    if(runtime.rows.count(table)!==count)throw new Error("Cached repository count differs");
    observed[table]=count;
  }
  const ping=performance.now();await db.query("SELECT 1");report.queryRoundTripMilliseconds=Math.round(performance.now()-ping);
  report.counts=observed;report.legacySqlAttempts=runtime.legacySqlAttempts;report.connectionErrors=db.connectionErrors;
  if(runtime.legacySqlAttempts||db.connectionErrors)throw new Error("Database runtime reported a failure");
  report.phase="complete";report.ok=true;
}catch(error){report.errorCode=/^[A-Z0-9_]{5,50}$/.test(error?.code??"")?error.code:"runtime_probe_stopped";process.exitCode=1;}
finally{
  try{await runtime?.close();await db.close();}catch{report.ok=false;report.closeFailed=true;process.exitCode=1;}
  report.completedAt=new Date().toISOString();console.log(JSON.stringify(report));
}
