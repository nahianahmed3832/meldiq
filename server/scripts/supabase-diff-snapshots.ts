import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import {postgresTableSpecs} from "../src/infrastructure/database/postgres/nativeCatalog.js";
import {digest,rowHash,validateRow} from "../src/infrastructure/database/postgres/migration.js";

/** Read-only planning. Never applies a delta to a live source or destination. Outputs aggregates, never row IDs. */
async function main(){
  process.umask(0o077);
  const [before,after,output]=process.argv.slice(2);
  if(!before||!after||!output)throw new Error("Two private normalized snapshots and a report path required");
  const specs=postgresTableSpecs();
  const manifests=[before,after].map(directory=>{
    const stat=fs.lstatSync(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error("Private snapshot directory required");
    const value=JSON.parse(fs.readFileSync(path.join(directory,"manifest.json"),"utf8"));
    if(!value.frozen||!value.realDataSnapshot||value.synthetic||value.catalogSha256!==digest(JSON.stringify(specs))||value.sourceSha256!==digest(JSON.stringify(value.tables))||value.tables.length!==specs.length||new Set(value.tables.map((table:any)=>table.name)).size!==specs.length)throw new Error("Reviewed immutable matching catalogs required");
    return value;
  });
  const report={observedAt:new Date().toISOString(),ok:false,readOnly:true,productionChanged:false,destinationModified:false,
    beforeSourceSha256:manifests[0].sourceSha256,afterSourceSha256:manifests[1].sourceSha256,beforeSnapshotTime:manifests[0].snapshotTime,afterSnapshotTime:manifests[1].snapshotTime,
    tables:[] as {name:string;before:number;after:number;inserted:number;updated:number;deleted:number;unchanged:number}[]};
  for(const spec of specs){
    const previous=new Map<string,string>();
    const result={name:spec.name,before:0,after:0,inserted:0,updated:0,deleted:0,unchanged:0};
    for(const [pass,directory] of [before,after].entries()){
      const expected=manifests[pass].tables.find((table:any)=>table.name===spec.name);
      if(!expected)throw new Error("Incomplete table inventory");
      const file=path.join(directory,`${spec.name}.ndjson`),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error("Private regular source file required");
      const checksum=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(file))checksum.update(chunk);
      if(checksum.digest("hex")!==expected.sha256)throw new Error("Snapshot changed");
      const seen=new Set<string>();let count=0;
      for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){
        const row=validateRow(spec,JSON.parse(line));
        const pk=spec.primaryKey.length?spec.primaryKey:["rowid"];
        const key=rowHash(Object.fromEntries(pk.map(column=>[column,row[column]])));
        if(seen.has(key))throw new Error("Duplicate source primary key");seen.add(key);count++;
        const hash=rowHash(row);
        if(pass===0)previous.set(key,hash);
        else if(!previous.has(key))result.inserted++;
        else {if(previous.get(key)===hash)result.unchanged++;else result.updated++;previous.delete(key);}
      }
      if(count!==expected.count)throw new Error("Source count changed");
      if(pass===0)result.before=count;else result.after=count;
    }
    result.deleted=previous.size;
    if(result.before+result.inserted-result.deleted!==result.after)throw new Error("Delta reconciliation failed");
    report.tables.push(result);
  }
  report.ok=true;
  fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n",{mode:0o600});
  const totals={before:0,after:0,inserted:0,updated:0,deleted:0,unchanged:0};
  for(const table of report.tables)for(const key of ["before","after","inserted","updated","deleted","unchanged"] as const)totals[key]+=table[key];
  console.log(JSON.stringify({ok:true,readOnly:true,productionChanged:false,destinationModified:false,tables:report.tables.length,...totals,changedTables:report.tables.filter(table=>table.inserted||table.updated||table.deleted).map(table=>table.name)}));
}
main().catch(()=>{console.error("Read-only snapshot comparison stopped; no source or destination was changed");process.exitCode=1;});
