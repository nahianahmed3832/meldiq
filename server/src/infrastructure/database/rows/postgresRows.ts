import pg, { type PoolClient } from "pg";
import { MemoryRows, type PersistedChanges } from "./memory.js";
import type { TableSpec } from "../mongo/catalog.js";
import type { MeldiqPostgres } from "../postgres/client.js";
import { identifier as q } from "../postgres/client.js";
import type { Query, Row, RowWriter, Where } from "./types.js";

export class ExistingEvent extends Error {}

/** Transitional synchronous repository API, one database writer enforced by a session advisory lock.
 * This preserves existing business rules while individual repositories move to indexed asynchronous SQL.
 * Imports/admin mutations must run with this writer stopped. Use a direct/session connection, never port 6543.
 */
export class PostgresRows extends MemoryRows {
  readonly backend = "postgres" as const;
  private closed = false;
  private failed = false;
  private constructor(private readonly postgres: MeldiqPostgres, specs: TableSpec[], private readonly lease: PoolClient) {
    super(specs);
    lease.on("error", () => { this.failed = true; });
  }
  get available(): boolean { return !this.closed && !this.failed; }
  assertAvailable(): void { if (!this.available) throw new Error("PostgreSQL repository lease is unavailable; restart the runtime to reload authorization"); }
  override get<R = Row>(table: string, where: Where, orderBy?: Query["orderBy"]): R | undefined { this.assertAvailable(); return super.get(table, where, orderBy); }
  override all<R = Row>(table: string, query: Query = {}): R[] { this.assertAvailable(); return super.all(table, query); }
  override count(table: string, where?: Where): number { this.assertAvailable(); return super.count(table, where); }

  static async open(postgres: MeldiqPostgres, specs: TableSpec[]): Promise<PostgresRows> {
    if (new URL(postgres.config.url).port === "6543") throw new Error("PostgresRows needs a direct or session pool connection");
    const lease = await postgres.connect();
    const rows = new PostgresRows(postgres, specs, lease);
    try {
      const result = await lease.query("SELECT pg_try_advisory_lock(hashtextextended('meldiq-rows-writer', 0)) AS locked");
      if (!result.rows[0].locked) throw new Error("Another synchronous repository writer is active");
      // The lease is the write connection too: losing it prevents writes, and therefore stale-cache commits.
      await lease.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='120s'");
      const counters = await lease.query<{table_name: string; value: number}>("SELECT table_name,value FROM meldiq_private.row_counters");
      for (const counter of counters.rows) if (specs.some(spec => spec.name === counter.table_name)) rows.bumpCounter(counter.table_name, counter.value);
      const relations = await lease.query<{oid:string;name:string}>(`SELECT c.oid::text AS oid,c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meldiq' AND c.relname=ANY($1::text[])`,[specs.map(spec=>spec.name)]);
      const byOid=new Map(relations.rows.map(relation=>[Number(relation.oid),specs.find(spec=>spec.name===relation.name)!]));
      if(byOid.size!==specs.length)throw new Error("PostgreSQL bootstrap table inventory is incomplete");
      // pg's row-event API decodes each row directly into the cache without accumulating a second result array.
      // Stream one simple-query message on the already fenced lease. PostgreSQL returns each
      // SELECT's real relation metadata; no second copy of the rows or extra pool slots.
      const query=new pg.Query<Row>({text:specs.map(spec=>`SELECT * FROM meldiq.${q(spec.name)};`).join("\n")});
      let failure:unknown;
      query.on("row",(row,result)=>{
        if(failure)return;
        try{
          const oid=result?.fields[0]?.tableID;
          const spec=oid===undefined?undefined:byOid.get(oid);
          if(!spec)throw new Error("Unexpected PostgreSQL bootstrap relation");
          rows.load(spec.name,row,spec.primaryKey.length?undefined:row.rowid as number);
        }catch(error){failure=error;}
      });
      await new Promise<void>((resolve,reject)=>{
        query.once("error",reject);query.once("end",()=>failure?reject(failure):resolve());lease.query(query);
      });
      await lease.query("COMMIT");
      return rows;
    } catch (error) { await lease.query("ROLLBACK").catch(() => undefined); lease.release(true); throw error; }
  }

  private parameters({ changes, counters }: PersistedChanges): string[] {
    this.assertAvailable();
    const operations:Record<string,unknown>[]=[];
    for(const change of changes){
      const spec=this.state(change.table).spec;
      const encode=(row:Row)=>Object.fromEntries(Object.entries(row).flatMap(([name,value])=>{
        const column=spec.columns.find(column=>column.name===name);
        if(typeof value==="number"&&!Number.isFinite(value))throw new Error("Non-finite PostgreSQL repository number");
        if(column?.type==="BLOB"&&value!==null&&value!==undefined)value="\\x"+Buffer.from(value as Uint8Array).toString("hex");
        if(column?.type==="JSONB"){
          if(value===null||value===undefined)return []; // SQL NULL; a present JSON null is kept distinct.
          if(typeof value==="string")value=JSON.parse(value);
        }
        return [[name,value]];
      }));
      if(change.row){
        const row=spec.primaryKey.length?change.row:{...change.row,rowid:Number(change.key.slice(2))};
        operations.push({table:spec.name,row:encode(row)});
      }else{
        const before=this.state(change.table).rows.get(change.key);if(!before)continue;
        const keys=spec.primaryKey.length?spec.primaryKey:["rowid"];
        operations.push({table:spec.name,key:encode(Object.fromEntries(keys.map(name=>[name,name==="rowid"?Number(change.key.slice(2)):before[name]])))});
      }
    }
    const serialize=(value:unknown)=>JSON.stringify(value,(_key,value)=>typeof value==="bigint"?value.toString():value);
    // The invoker function preserves operation order and rolls the entire unit back on any failure.
    return [serialize(operations), serialize(Object.fromEntries(counters))];
  }

  protected async persist(changes: PersistedChanges): Promise<void> {
    await this.lease.query("SELECT meldiq_private.apply_row_changes($1::jsonb,$2::jsonb)", this.parameters(changes));
  }

  /** The insert-only history and complete fanout commit on the leased connection in one statement.
   * A conflict throws before the queue cache can publish its staged rows or id counter. */
  writeMessage<T>(event: object, stage: (w: RowWriter) => T): Promise<T> {
    return this.writeUnit(stage, async changes => {
      const result = await this.lease.query(
        `WITH saved AS (INSERT INTO meldiq.message_events
             SELECT incoming.* FROM jsonb_populate_record(NULL::meldiq.message_events,$3::jsonb) incoming
             ON CONFLICT (id) DO NOTHING RETURNING id)
         SELECT meldiq_private.apply_row_changes($1::jsonb,$2::jsonb) FROM saved`,
        [...this.parameters(changes), JSON.stringify(event)]);
      if (!result.rowCount) throw new ExistingEvent();
    });
  }

  /** Account/identity operations share this writer and commit together, including nested synchronous business units. */
  transaction<T>(run: () => Promise<T>): Promise<T> {
    return this.writeAsync(() => run());
  }

  override async close() {
    await this.settled();
    if (this.closed) return;
    this.closed = true;
    // Destroy the session: PostgreSQL releases its advisory lock even on network interruption.
    this.lease.release(true);
  }
}
