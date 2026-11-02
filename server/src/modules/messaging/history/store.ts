import type { DB } from "../../../infrastructure/database/db.js";

/** An account's history totals: the next sync cursor, live items and their bytes. */
export interface HistoryAccount {
  next_seq: number;
  items: number;
  bytes: number;
}

/** One item to write: opaque tag and conversation tag, the client's time, and the ciphertext (null: a deletion marker). */
export interface HistoryWrite {
  tag: string;
  conv: string;
  ts: number;
  body: Buffer | null;
}

export interface HistoryItem {
  tag: string;
  conv_tag: string;
  seq: number;
  ts: number;
  body: Buffer | null;
}

/** The limits a write is checked against; [maxTotalBytes] 0: no server-wide cap. */
export interface HistoryLimits {
  maxItems: number;
  maxBytes: number;
  maxTotalBytes: number;
}

/** A write's outcome: the new totals, or which limit refused it whole. */
export type HistoryPut = { seq: number; items: number; bytes: number } | "account" | "server";

/**
 * Where encrypted message history lives (docs/MESSAGE_HISTORY.md): SQLite (migration 009) or MongoDB
 * (src/mongo/history.ts), chosen by MONGODB_DOMAINS ("history"). The server never sees content: only opaque tags, sizes,
 * times and the per-account write order.
 */
export interface HistoryStore {
  readonly backend: "sqlite" | "mongodb" | "postgres";
  account(userId: string): Promise<HistoryAccount | null>;
  /**
   * Adds or replaces [items] (already de-duplicated by tag, last copy wins), all or nothing: refused whole when the
   * account would pass its limits, or when the server-wide cap is reached and the write would grow the account.
   * Concurrent writes for one account never interleave.
   */
  put(userId: string, items: HistoryWrite[], limits: HistoryLimits, at: number): Promise<HistoryPut>;
  /** Items written after cursor [after], oldest write first, at most [limit]. */
  items(userId: string, after: number, limit: number): Promise<HistoryItem[]>;
  /** The account's whole history; returns how many items there were. */
  deleteForUser(userId: string): Promise<number>;
  /** Deletion markers last updated at or before [before]. */
  purgeTombstones(before: number): Promise<number>;
  /** Accounts holding history whose user is gone (deleted, or never existed): a deletion that couldn't finish. */
  orphanUserIds(exists: (userIds: string[]) => Set<string>): Promise<string[]>;
}

export class SqliteHistoryStore implements HistoryStore {
  readonly backend = "sqlite" as const;
  constructor(private readonly db: DB) {}

  async account(userId: string): Promise<HistoryAccount | null> {
    return (this.db.prepare("SELECT next_seq, items, bytes FROM history_accounts WHERE user_id = ?").get(userId) as HistoryAccount | undefined) ?? null;
  }

  async put(userId: string, plan: HistoryWrite[], limits: HistoryLimits, at: number): Promise<HistoryPut> {
    const db = this.db;
    // One immediate transaction: the quota check and the writes can't interleave with another request.
    return db
      .transaction((): HistoryPut => {
        const a = (db.prepare("SELECT next_seq, items, bytes FROM history_accounts WHERE user_id = ?").get(userId) as HistoryAccount | undefined) ?? {
          next_seq: 1,
          items: 0,
          bytes: 0,
        };
        let items = a.items;
        let bytes = a.bytes;
        let seq = a.next_seq;
        const get = db.prepare("SELECT size, body IS NULL AS gone FROM history_items WHERE user_id = ? AND tag = ?");
        for (const i of plan) {
          const old = get.get(userId, i.tag) as { size: number; gone: number } | undefined;
          if (old && !old.gone) {
            items--;
            bytes -= old.size;
          }
          if (i.body) {
            items++;
            bytes += i.body.length;
          }
        }
        if (items > limits.maxItems || bytes > limits.maxBytes) return "account";
        // Every account's history shares the server's disk: growth stops at the server-wide cap (changes that free
        // space always go through).
        if (limits.maxTotalBytes > 0 && bytes > a.bytes) {
          const total = (db.prepare("SELECT SUM(bytes) n FROM history_accounts").get() as { n: number | null }).n ?? 0;
          if (total - a.bytes + bytes > limits.maxTotalBytes) return "server";
        }
        const upsert = db.prepare(
          `INSERT INTO history_items (user_id, tag, conv_tag, seq, ts, body, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, tag) DO UPDATE SET conv_tag = excluded.conv_tag, seq = excluded.seq, ts = excluded.ts,
             body = excluded.body, size = excluded.size, updated_at = excluded.updated_at`,
        );
        for (const p of plan) upsert.run(userId, p.tag, p.conv, seq++, p.ts, p.body, p.body?.length ?? 0, at);
        db.prepare(
          `INSERT INTO history_accounts (user_id, next_seq, items, bytes) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET next_seq = excluded.next_seq, items = excluded.items, bytes = excluded.bytes`,
        ).run(userId, seq, items, bytes);
        return { seq: seq - 1, items, bytes };
      })
      .immediate();
  }

  async items(userId: string, after: number, limit: number): Promise<HistoryItem[]> {
    return this.db
      .prepare("SELECT tag, conv_tag, seq, ts, body FROM history_items WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(userId, after, limit) as HistoryItem[];
  }

  async deleteForUser(userId: string): Promise<number> {
    return this.db
      .transaction(() => {
        const n = this.db.prepare("DELETE FROM history_items WHERE user_id = ?").run(userId).changes;
        this.db.prepare("DELETE FROM history_accounts WHERE user_id = ?").run(userId);
        return n;
      })
      .immediate();
  }

  async purgeTombstones(before: number): Promise<number> {
    return this.db.prepare("DELETE FROM history_items WHERE body IS NULL AND updated_at <= ?").run(before).changes;
  }

  /** SQLite's foreign keys delete history with its user, so there are no orphans here. */
  async orphanUserIds(): Promise<string[]> {
    return [];
  }
}
