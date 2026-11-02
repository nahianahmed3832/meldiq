import type { PoolClient } from "pg";
import { MemoryRows, type PersistedChanges } from "./memory.js";
import type { TableSpec } from "../mongo/catalog.js";
import type { MeldiqPostgres } from "../postgres/client.js";
import { identifier as q } from "../postgres/client.js";

/** Transitional synchronous repository API, one database writer enforced by a session advisory lock.
 * This preserves existing business rules while individual repositories move to indexed asynchronous SQL.
 * Imports/admin mutations must run with this writer stopped. Use a direct/session connection, never port 6543.
 */
export class PostgresRows extends MemoryRows {
  readonly backend = "postgres" as const;
  private closed = false;
  private constructor(private readonly postgres: MeldiqPostgres, specs: TableSpec[], private readonly lease: PoolClient) { super(specs); }

  static async open(postgres: MeldiqPostgres, specs: TableSpec[]): Promise<PostgresRows> {
    if (new URL(postgres.config.url).port === "6543") throw new Error("PostgresRows needs a direct or session pool connection");
    const lease = await postgres.pool.connect();
    const rows = new PostgresRows(postgres, specs, lease);
    try {
      const result = await lease.query("SELECT pg_try_advisory_lock(hashtextextended('meldiq-rows-writer', 0)) AS locked");
      if (!result.rows[0].locked) throw new Error("Another synchronous repository writer is active");
      // The lease is the write connection too: losing it prevents writes, and therefore stale-cache commits.
      await lease.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      for (const spec of specs) {
        await lease.query(`DECLARE loading NO SCROLL CURSOR FOR SELECT * FROM meldiq.${q(spec.name)}`);
        while (true) {
          const batch = await lease.query("FETCH FORWARD 500 FROM loading");
          if (!batch.rowCount) break;
          for (const row of batch.rows) rows.load(spec.name, row, spec.primaryKey.length ? undefined : row.rowid);
        }
        await lease.query("CLOSE loading");
        const counter = await lease.query("SELECT value FROM meldiq_private.row_counters WHERE table_name = $1", [spec.name]);
        if (counter.rowCount) rows.bumpCounter(spec.name, counter.rows[0].value);
      }
      await lease.query("COMMIT");
      return rows;
    } catch (error) { await lease.query("ROLLBACK").catch(() => undefined); lease.release(true); throw error; }
  }

  protected async persist({ changes, counters }: PersistedChanges): Promise<void> {
    if (this.closed) throw new Error("PostgreSQL rows are closed");
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

  override async close() {
    await this.settled();
    if (this.closed) return;
    this.closed = true;
    // Destroy the session: PostgreSQL releases its advisory lock even on network interruption.
    this.lease.release(true);
  }
}
