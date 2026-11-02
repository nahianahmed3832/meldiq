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
  const report:{observedAt:string;synthetic:boolean;tables:unknown[];ok:boolean}={observedAt:new Date().toISOString(),synthetic:true,tables:[],ok:false};
  try {
    const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,"manifest.json"),"utf8"));
    if(!manifest.synthetic||!manifest.frozen)throw new Error("Frozen synthetic snapshot required");
    const counts=await tableCounts(db,tableSpecs());
    for(const spec of tableSpecs()){
      let count=0;
      const timestamps=spec.columns.filter(c=>c.type==="INTEGER"&&/(?:_at|_ts)$/.test(c.name)).map(c=>c.name);
      const money=spec.columns.filter(c=>c.type==="INTEGER"&&/(?:_minor|_cents)$/.test(c.name)).map(c=>c.name);
      const extrema:Record<string,{min:number;max:number}>={},totals:Record<string,bigint>=Object.fromEntries(money.map(k=>[k,0n]));
      const lines=readline.createInterface({input:fs.createReadStream(path.join(snapshot,`${spec.name}.ndjson`)),crlfDelay:Infinity});
      let batch:Record<string,unknown>[]=[];
      for await(const line of lines){
        const row=validateRow(spec,JSON.parse(line));count++;batch.push(row);
        for(const key of timestamps)if(typeof row[key]==="number"){const value=row[key] as number;const old=extrema[key];extrema[key]={min:Math.min(old?.min??value,value),max:Math.max(old?.max??value,value)};}
        for(const key of money)if(row[key]!==null)totals[key]+=BigInt(row[key] as number);
        if(batch.length===250){await compare.compareRows(spec,batch);batch=[];}
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
    report.ok=true;
  }finally{await db.close();fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n",{mode:0o600});}
}
main().catch(()=>{console.error("Reconciliation failed; report is incomplete. No data was modified.");process.exitCode=1;});
