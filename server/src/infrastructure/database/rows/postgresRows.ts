import type { PoolClient, QueryResult } from "pg";
import { MemoryRows, type PersistedChanges } from "./memory.js";
import type { TableSpec } from "../mongo/catalog.js";
import type { MeldiqPostgres } from "../postgres/client.js";
import { identifier as q } from "../postgres/client.js";
import type { Query, Row, Where } from "./types.js";

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
      await lease.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const counters = await lease.query<{table_name: string; value: number}>("SELECT table_name,value FROM meldiq_private.row_counters");
      for (const counter of counters.rows) if (specs.some(spec => spec.name === counter.table_name)) rows.bumpCounter(counter.table_name, counter.value);
      // Amortize hosted round trips while bounding each received group to eight 500-row pages.
      // All cursors and counters use the same repeatable-read snapshot and writer lease.
      for (let start = 0; start < specs.length; start += 8) {
        const group = specs.slice(start, start + 8);
        const initial = await lease.query(group.map((spec, i) =>
          `DECLARE loading_${i} NO SCROLL CURSOR FOR SELECT * FROM meldiq.${q(spec.name)}; FETCH FORWARD 500 FROM loading_${i};`
        ).join("\n")) as unknown as QueryResult<Row>[];
        if (!Array.isArray(initial) || initial.length !== group.length * 2) throw new Error("Unexpected PostgreSQL bootstrap response");
        for (const [i, spec] of group.entries()) {
          let batch = initial[i * 2 + 1];
          while (true) {
            for (const row of batch.rows) rows.load(spec.name, row, spec.primaryKey.length ? undefined : row.rowid as number);
            if (batch.rows.length < 500) break;
            batch = await lease.query<Row>(`FETCH FORWARD 500 FROM loading_${i}`);
          }
        }
        await lease.query(group.map((_, i) => `CLOSE loading_${i};`).join("\n"));
      }
      await lease.query("COMMIT");
      return rows;
    } catch (error) { await lease.query("ROLLBACK").catch(() => undefined); lease.release(true); throw error; }
  }

  protected async persist({ changes, counters }: PersistedChanges): Promise<void> {
    this.assertAvailable();
    await this.lease.query("BEGIN");
    try {
      for (const change of changes) {
        const spec = this.state(change.table).spec;
        const pk = spec.primaryKey.length ? spec.primaryKey : ["rowid"];
        if (change.row) {
          const row = spec.primaryKey.length ? change.row : { ...change.row, rowid: Number(change.key.slice(2)) };
          const cols = [...spec.columns.map(c => c.name), ...(!spec.primaryKey.length ? ["rowid"] : [])];
          const update = cols.filter(c => !pk.includes(c)).map(c => `${q(c)} = EXCLUDED.${q(c)}`).join(", ");
          await this.lease.query(`INSERT INTO meldiq.${q(spec.name)} (${cols.map(q)}) VALUES (${cols.map((_,i) => `$${i+1}`)}) ON CONFLICT (${pk.map(q)}) DO ${update ? `UPDATE SET ${update}` : "NOTHING"}`, cols.map(c => row[c]));
        } else {
          const before = this.state(change.table).rows.get(change.key);
          if (!before) continue;
          const values = pk.map(c => c === "rowid" ? Number(change.key.slice(2)) : before[c]);
          await this.lease.query(`DELETE FROM meldiq.${q(spec.name)} WHERE ${pk.map((c,i) => `${q(c)} = $${i+1}`).join(" AND ")}`, values);
        }
      }
      for (const [table, value] of counters) await this.lease.query("INSERT INTO meldiq_private.row_counters(table_name, value) VALUES($1,$2) ON CONFLICT(table_name) DO UPDATE SET value = greatest(row_counters.value, excluded.value)", [table, value]);
      await this.lease.query("COMMIT");
    } catch (error) { await this.lease.query("ROLLBACK").catch(() => undefined); throw error; }
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
