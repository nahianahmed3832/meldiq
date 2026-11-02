import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import type { HistoryAccount, HistoryItem, HistoryLimits, HistoryPut, HistoryStore, HistoryWrite } from "./store.js";

/** Encrypted history remains opaque bytea. A per-account lock protects cursors and totals; the shared/exclusive
 * global lock also protects an enabled server quota across accounts. Locks end with the database transaction.
 */
export class PostgresHistoryStore implements HistoryStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async account(userId: string): Promise<HistoryAccount | null> {
    return (await this.db.query<HistoryAccount>("SELECT next_seq,items,bytes FROM meldiq.history_accounts WHERE user_id=$1", [userId])).rows[0] ?? null;
  }
  async put(userId: string, plan: HistoryWrite[], limits: HistoryLimits, at: number): Promise<HistoryPut> {
    if (new Set(plan.map(item => item.tag)).size !== plan.length) throw new Error("History plan must be deduplicated");
    return this.db.transaction(async () => {
      await this.lock(userId, limits.maxTotalBytes > 0);
      const account = await this.account(userId) ?? {next_seq: 1, items: 0, bytes: 0};
      const previous = await this.db.query<{tag: string; size: number; gone: boolean}>(
        "SELECT tag,size,body IS NULL AS gone FROM meldiq.history_items WHERE user_id=$1 AND tag=ANY($2::text[])", [userId, plan.map(item => item.tag)]);
      const old = new Map(previous.rows.map(item => [item.tag, item]));
      let items = account.items, bytes = account.bytes;
      for (const item of plan) {
        const before = old.get(item.tag);
        if (before && !before.gone) { items--; bytes -= before.size; }
        if (item.body) { items++; bytes += item.body.length; }
      }
      if (items > limits.maxItems || bytes > limits.maxBytes) return "account";
      if (limits.maxTotalBytes > 0 && bytes > account.bytes) {
        const total = (await this.db.query<{bytes: number}>("SELECT coalesce(sum(bytes),0)::bigint AS bytes FROM meldiq.history_accounts")).rows[0].bytes;
        if (total - account.bytes + bytes > limits.maxTotalBytes) return "server";
      }
      const next = account.next_seq + plan.length;
      if (!Number.isSafeInteger(next) || !Number.isSafeInteger(bytes) || items < 0 || bytes < 0) throw new Error("History totals are outside the supported range");
      // Bounded SQL batches preserve input order and avoid one pooler round trip per ciphertext.
      for (let offset = 0; offset < plan.length; offset += 100) {
        const batch = plan.slice(offset, offset + 100), params: unknown[] = [];
        const values = batch.map((item, index) => {
          const first = params.length;
          params.push(userId, item.tag, item.conv, account.next_seq + offset + index, item.ts, item.body, item.body?.length ?? 0, at);
          return `(${Array.from({length: 8}, (_, n) => `$${first + n + 1}`).join(",")})`;
        });
        await this.db.query(`INSERT INTO meldiq.history_items(user_id,tag,conv_tag,seq,ts,body,size,updated_at) VALUES ${values.join(",")}
          ON CONFLICT(user_id,tag) DO UPDATE SET conv_tag=excluded.conv_tag,seq=excluded.seq,ts=excluded.ts,
          body=excluded.body,size=excluded.size,updated_at=excluded.updated_at`, params);
      }
      await this.db.query(`INSERT INTO meldiq.history_accounts(user_id,next_seq,items,bytes) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id) DO UPDATE SET next_seq=excluded.next_seq,items=excluded.items,bytes=excluded.bytes`, [userId, next, items, bytes]);
      return {seq: next - 1, items, bytes};
    });
  }
  async items(userId: string, after: number, limit: number): Promise<HistoryItem[]> {
    return (await this.db.query<HistoryItem>("SELECT tag,conv_tag,seq,ts,body FROM meldiq.history_items WHERE user_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [userId, after, limit])).rows;
  }
  async deleteForUser(userId: string): Promise<number> {
    return this.db.transaction(async () => {
      await this.lock(userId, false);
      const removed = await this.db.query("DELETE FROM meldiq.history_items WHERE user_id=$1", [userId]);
      await this.db.query("DELETE FROM meldiq.history_accounts WHERE user_id=$1", [userId]);
      return removed.rowCount ?? 0;
    });
  }
  async purgeTombstones(before: number): Promise<number> {
    return (await this.db.query("DELETE FROM meldiq.history_items WHERE body IS NULL AND updated_at<=$1", [before])).rowCount ?? 0;
  }
  async orphanUserIds(): Promise<string[]> {
    // FK constraints cascade history when an internal identity is removed.
    return [];
  }
  private async lock(userId: string, exclusiveGlobal: boolean): Promise<void> {
    await this.db.query(`SELECT ${exclusiveGlobal ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended('meldiq-history-quota',0))`);
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended('meldiq-history-account:' || $1,0))", [userId]);
  }
}
