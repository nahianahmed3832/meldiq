import crypto from "node:crypto";
import type { TableSpec } from "../mongo/catalog.js";
import type { Row } from "../rows/types.js";
import { identifier as q, type MeldiqPostgres } from "./client.js";

export const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $binary: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export const rowHash = (row: Row) => digest(JSON.stringify(canonical(row)));

/** One database round trip for a whole catalog, including empty relations. */
export async function tableCounts(db:MeldiqPostgres,specs:readonly TableSpec[]):Promise<Map<string,number>> {
  const sql=specs.map((spec,i)=>`SELECT $${i+1}::text AS name,count(*) AS count FROM meldiq.${q(spec.name)}`).join(" UNION ALL ");
  const result=await db.query<{name:string;count:number}>(sql,specs.map(t=>t.name));
  return new Map(result.rows.map(row=>[row.name,row.count]));
}

export function validateRow(spec: TableSpec, input: Row): Row {
  const allowed = [...spec.columns, ...(!spec.primaryKey.length ? [{name:"rowid",type:"INTEGER",notNull:true}] : [])];
  if (Object.keys(input).some(k=>!allowed.some(c=>c.name===k))) throw new Error("Unmapped source column");
  const row: Row = {};
  for (const column of allowed) {
    const value = input[column.name];
    if (value === undefined) throw new Error("Missing source column");
    if (value === null) {
      if (column.notNull || spec.primaryKey.includes(column.name)) throw new Error("Required source value is null");
      row[column.name] = null; continue;
    }
    if (column.type === "TEXT" && typeof value !== "string") throw new Error("Source text type mismatch");
    if (column.type === "INTEGER" && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new Error("Unsafe source integer");
    if (column.type === "REAL" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("Invalid source real");
    if (column.type === "BOOLEAN" && typeof value !== "boolean") throw new Error("Invalid source boolean");
    if (column.type === "TEXT[]" && (!Array.isArray(value) || value.some(v=>typeof v!=="string"))) throw new Error("Invalid source text array");
    if (column.type === "BIGINT[]" && (!Array.isArray(value) || value.some(v=>typeof v!=="number" || !Number.isSafeInteger(v)))) throw new Error("Invalid source integer array");
    if (column.type === "JSONB" && (typeof value!=="object" || value===null)) throw new Error("Invalid source JSON document");
    if (column.type === "BLOB") {
      if (value && typeof value === "object" && "$binary" in value && typeof value.$binary === "string") row[column.name] = Buffer.from(value.$binary,"base64");
      else if (Buffer.isBuffer(value) || value instanceof Uint8Array) row[column.name] = Buffer.from(value);
      else throw new Error("Invalid source binary");
    } else row[column.name] = value;
  }
  return row;
}

export function dependencyOrder(specs: readonly TableSpec[]): TableSpec[] {
  const remaining = new Map(specs.map(t=>[t.name,t]));
  const done = new Set<string>(); const ordered: TableSpec[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(t=>t.foreignKeys.every(f=>done.has(f.table)));
    if (!ready.length) throw new Error("Missing or cyclic migration dependency requires an explicit plan");
    for (const table of ready.sort((a,b)=>a.name.localeCompare(b.name))) {ordered.push(table);done.add(table.name);remaining.delete(table.name);}
  }
  return ordered;
}

export interface MigrationRun { id: string; sourceSha256: string; catalogSha256: string; environment: "development" | "staging"; }
/** Strict immutable snapshot import. Conflicting existing rows are never overwritten.
 * A batch checkpoint and its rows commit together; a changed batch cannot reuse a checkpoint.
 */
export class TypedPostgresImporter {
  constructor(private readonly db: MeldiqPostgres) {}
  async start(run: MigrationRun) {
    if (this.db.config.environment === "production") throw new Error("Production imports require a separately approved cutover release");
    await this.db.query(`INSERT INTO meldiq_private.migration_runs(id,source_sha256,catalog_sha256,environment) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,[run.id,run.sourceSha256,run.catalogSha256,run.environment]);
    const previous = (await this.db.query("SELECT * FROM meldiq_private.migration_runs WHERE id=$1",[run.id])).rows[0];
    if (previous.source_sha256!==run.sourceSha256 || previous.catalog_sha256!==run.catalogSha256 || previous.environment!==run.environment) throw new Error("Migration run source changed");
  }
  async batch(runId: string, spec: TableSpec, number: number, input: Row[]): Promise<{inserted:number;resumed:boolean;sha256:string}> {
    if (this.db.config.environment === "production") throw new Error("Production import disabled");
    if (!Number.isSafeInteger(number) || number<0 || input.length>500) throw new Error("Invalid migration batch");
    const rows=input.map(r=>validateRow(spec,r));
    const sha256=digest(rows.map(rowHash).join("\n"));
    return this.db.transaction(async()=>{
      // Prevent an operator import racing the synchronous runtime's cached writer.
      const lock=(await this.db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('meldiq-rows-writer',0)) AS ok")).rows[0].ok;
      if(!lock) throw new Error("Stop the repository writer before importing");
      const previous=(await this.db.query("SELECT * FROM meldiq_private.migration_batches WHERE run_id=$1 AND table_name=$2 AND batch_number=$3",[runId,spec.name,number])).rows[0];
      if (previous) {
        if(previous.sha256!==sha256 || previous.record_count!==rows.length) throw new Error("Completed batch source changed");
        await this.compareRows(spec,rows);
        return {inserted:0,resumed:true,sha256};
      }
      const columns=[...spec.columns.map(c=>c.name),...(!spec.primaryKey.length?["rowid"]:[])];
      let inserted=0;
      if(rows.length) {
        if(rows.length*columns.length>60000)throw new Error("Migration batch exceeds parameter budget");
        const values=rows.flatMap(row=>columns.map(c=>row[c]));
        const groups=rows.map((_,n)=>`(${columns.map((_,i)=>`$${n*columns.length+i+1}`).join(",")})`).join(",");
        const result=await this.db.query(`INSERT INTO meldiq.${q(spec.name)} (${columns.map(q)}) VALUES ${groups} ON CONFLICT DO NOTHING`,values);
        inserted=result.rowCount??0;
      }
      await this.compareRows(spec,rows);
      const counter=spec.autoincrement?spec.primaryKey[0]:!spec.primaryKey.length?"rowid":null;
      if(counter && rows.length) await this.db.query("INSERT INTO meldiq_private.row_counters(table_name,value) VALUES($1,$2) ON CONFLICT(table_name) DO UPDATE SET value=greatest(row_counters.value,excluded.value)",[spec.name,Math.max(...rows.map(r=>Number(r[counter])))]);
      await this.db.query("INSERT INTO meldiq_private.migration_batches(run_id,table_name,batch_number,record_count,sha256) VALUES($1,$2,$3,$4,$5)",[runId,spec.name,number,rows.length,sha256]);
      return {inserted,resumed:false,sha256};
    });
  }
  async compareRows(spec: TableSpec, rows: Row[]): Promise<void> {
    const pk=spec.primaryKey.length?spec.primaryKey:["rowid"];
    if(!rows.length)return;
    const keyOf=(row:Row)=>JSON.stringify(pk.map(c=>row[c]));
    const values=rows.flatMap(row=>pk.map(c=>row[c]));
    const groups=rows.map((_,n)=>`(${pk.map((_,i)=>`$${n*pk.length+i+1}`).join(",")})`).join(",");
    const result=await this.db.query(`SELECT * FROM meldiq.${q(spec.name)} WHERE (${pk.map(q)}) IN (${groups})`,values);
    const foundByKey=new Map(result.rows.map(row=>[keyOf(row),row]));
    for(const row of rows) {
      const found=foundByKey.get(keyOf(row));
      if(!found || rowHash(found)!==rowHash(row)) {
        throw new Error(`Migration discrepancy table=${spec.name} keyDigest=${digest(keyOf(row))} sourceDigest=${rowHash(row)} destinationDigest=${found?rowHash(found):"missing"}`);
      }
    }
  }
}
