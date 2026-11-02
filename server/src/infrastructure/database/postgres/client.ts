import { AsyncLocalStorage } from "node:async_hooks";
import pg, { type PoolClient, type QueryResultRow } from "pg";

export interface PostgresConfig {
  url: string;
  environment: "development" | "staging" | "production";
  /** Required by the staged application bootstrap for remote project identity checks. */
  projectRef?: string;
  maxConnections?: number;
  ca?: string;
}

/** Explicit per-pool decoding: never silently round money, counters or epoch milliseconds. */
export const safeTypes = {
  getTypeParser(oid: number, format?: string) {
    if (oid === 1016 && format !== "binary") return (value: string) => (pg.types.getTypeParser(1016 as Parameters<typeof pg.types.getTypeParser>[0])(value) as string[]).map(item => {
      const number = Number(item); if (!Number.isSafeInteger(number)) throw new Error("PostgreSQL integer array exceeds safe range"); return number;
    });
    if (oid === 20 && format !== "binary") return (value: string) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error("PostgreSQL integer exceeds the API's safe range");
      return number;
    };
    return pg.types.getTypeParser(oid, format as "text");
  },
};

export class MeldiqPostgres {
  readonly pool: pg.Pool;
  private readonly context = new AsyncLocalStorage<PoolClient>();
  private runtimeGuard?: () => void;

  constructor(readonly config: PostgresConfig) {
    const url = new URL(config.url);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("PostgreSQL URL required");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (config.environment === "production" && local) throw new Error("Production cannot use a development database");
    if ([...url.searchParams.keys()].some(k => /^ssl/i.test(k))) throw new Error("Configure TLS through the trusted CA setting, not URL overrides");
    const max = config.maxConnections ?? 5;
    if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error("Connection pool must be between 1 and 20");
    this.pool = new pg.Pool({ connectionString: url.href, max, min: 0, idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000, statement_timeout: 15_000, idle_in_transaction_session_timeout: 30_000,
      application_name: `meldiq-${config.environment}`, options: "-c timezone=UTC",
      ssl: local ? false : { rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) }, types: safeTypes });
    // No raw driver errors: connection errors can contain infrastructure details.
    this.pool.on("error", () => { this.connectionErrors++; });
  }
  connectionErrors = 0;

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    this.runtimeGuard?.();
    return (this.context.getStore() ?? this.pool).query<R>(sql, values);
  }

  /** No automatic callback retries: callers may have performed non-transactional external work. */
  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    this.runtimeGuard?.();
    const current = this.context.getStore();
    if (current) throw new Error("Nested PostgreSQL transactions require an explicit service boundary");
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      const result = await this.context.run(client, () => run(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }

  async asUser<T>(subject: string, sessionId: string, run: () => Promise<T>): Promise<T> {
    return this.transaction(async client => {
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: subject, session_id: sessionId, role: "authenticated" })]);
      return run();
    });
  }

  metrics() { return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount, errors: this.connectionErrors }; }
  installRuntimeGuard(guard: () => void): () => void {
    if (this.runtimeGuard) throw new Error("A PostgreSQL application runtime is already attached");
    this.runtimeGuard = guard;
    return () => { if (this.runtimeGuard === guard) this.runtimeGuard = undefined; };
  }
  async close() { await this.pool.end(); }
}

export function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Invalid schema identifier");
  return `"${value}"`;
}
