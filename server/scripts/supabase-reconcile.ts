import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { postgresTableSpecs as tableSpecs } from "../src/infrastructure/database/postgres/nativeCatalog.js";
import { MeldiqPostgres, identifier as q } from "../src/infrastructure/database/postgres/client.js";
import { TypedPostgresImporter, validateRow, tableCounts } from "../src/infrastructure/database/postgres/migration.js";

async function main() {
  const [snapshot,output]=process.argv.slice(2);
  if(!snapshot||!output||!process.env.SUPABASE_DATABASE_URL)throw new Error("Snapshot, report path and private database URL required");
  const environment=process.env.SUPABASE_ENVIRONMENT;
  if(environment!=="development"&&environment!=="staging")throw new Error("Only staging/development reconciliation is enabled in this release");
  const db=new MeldiqPostgres({url:process.env.SUPABASE_DATABASE_URL,environment,ca:process.env.SUPABASE_DB_CA_FILE?fs.readFileSync(process.env.SUPABASE_DB_CA_FILE,"utf8"):undefined,maxConnections:1});
  const compare=new TypedPostgresImporter(db);
  const report:{observedAt:string;synthetic:boolean;tables:unknown[];ok:boolean;errorCode?:string;failedTable?:string}={observedAt:new Date().toISOString(),synthetic:true,tables:[],ok:false};
  let currentTable="";
  try {
    const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,"manifest.json"),"utf8"));
    const endpoint=new URL(process.env.SUPABASE_DATABASE_URL);
    const local=["localhost","127.0.0.1","[::1]"].includes(endpoint.hostname);
    if(!manifest.frozen||(!manifest.synthetic&&(!process.argv.includes("--real-data-rehearsal")||manifest.realDataSnapshot!==true||manifest.purpose!=="staging-rehearsal"||!local&&process.env.SUPABASE_EXPECTED_PROJECT_REF!=="bkvlxbsnzqkhbifawcww")))throw new Error("Explicit immutable real-data rehearsal or frozen synthetic snapshot required");
    report.synthetic=manifest.synthetic;
    const counts=await tableCounts(db,tableSpecs());
    for(const spec of tableSpecs()){
      currentTable=spec.name;
      let count=0;
      const timestamps=spec.columns.filter(c=>c.type==="INTEGER"&&/(?:_at|_ts)$/.test(c.name)).map(c=>c.name);
      const money=spec.columns.filter(c=>c.type==="INTEGER"&&/(?:_minor|_cents)$/.test(c.name)).map(c=>c.name);
      const extrema:Record<string,{min:number;max:number}>={},totals:Record<string,bigint>=Object.fromEntries(money.map(k=>[k,0n]));
      const lines=readline.createInterface({input:fs.createReadStream(path.join(snapshot,`${spec.name}.ndjson`)),crlfDelay:Infinity});
      let batch:Record<string,unknown>[]=[],batchBytes=0;
      const maxRows=manifest.synthetic?250:Math.min(5000,Math.floor(60000/Math.max(1,spec.primaryKey.length)));
      for await(const line of lines){
        const row=validateRow(spec,JSON.parse(line));count++;batch.push(row);batchBytes+=Buffer.byteLength(line);
        for(const key of timestamps)if(typeof row[key]==="number"){const value=row[key] as number;const old=extrema[key];extrema[key]={min:Math.min(old?.min??value,value),max:Math.max(old?.max??value,value)};}
        for(const key of money)if(row[key]!==null)totals[key]+=BigInt(row[key] as number);
        if(batch.length>=maxRows||batchBytes>=2_000_000){await compare.compareRows(spec,batch);batch=[];batchBytes=0;}
      }
      if(batch.length)await compare.compareRows(spec,batch);
      const destination=counts.get(spec.name);
      if(count!==destination||count!==manifest.tables.find((t:{name:string})=>t.name===spec.name)?.count)throw new Error(`Count mismatch ${spec.name}`);
      for(const [key,value] of Object.entries(extrema)){
        const actual=(await db.query(`SELECT min(${q(key)}) AS min,max(${q(key)}) AS max FROM meldiq.${q(spec.name)}`)).rows[0];
        if(actual.min!==value.min||actual.max!==value.max)throw new Error(`Timestamp mismatch ${spec.name}`);
      }
      for(const [key,value] of Object.entries(totals)){
        const actual=(await db.query(`SELECT coalesce(sum(${q(key)}),0)::text AS total FROM meldiq.${q(spec.name)}`)).rows[0].total;
        if(actual!==value.toString())throw new Error(`Financial mismatch ${spec.name}`);
      }
      report.tables.push({name:spec.name,source:count,destination,allRecordHashesMatch:true,timestampRanges:extrema,financialTotalsMinor:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,v.toString()]))});
    }
    for(const [name,value] of Object.entries(manifest.counters??{})){
      const actual=(await db.query("SELECT value FROM meldiq_private.row_counters WHERE table_name=$1",[name])).rows[0]?.value;
      if(!Number.isSafeInteger(value)||actual===undefined||actual<Number(value))throw new Error("Counter floor mismatch");
    }
    report.ok=true;
  }catch(error){
    report.errorCode=error&&typeof error==='object'&&'code'in error&&/^[A-Z0-9_]{5,40}$/.test(String(error.code))?String(error.code):'reconciliation_stopped';
    report.failedTable=currentTable;
    throw error;
  }finally{await db.close();fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n",{mode:0o600});}
}
main().catch(()=>{console.error("Reconciliation failed; report is incomplete. No data was modified.");process.exitCode=1;});
