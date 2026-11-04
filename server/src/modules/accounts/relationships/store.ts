import type { DB } from "../../../infrastructure/database/db.js";
import {
  DmPolicy as DmPolicyEnum,
  RequestPolicy as RequestPolicyEnum,
} from "../../../shared/contracts/http/relationships.js";

/** Batch B6 (docs/product/MELDIQ_FRIENDS_AND_DMS_SPEC.md): who is connected, DMs waiting for an answer, messaging settings. */
export type ConnectionState = "pending" | "accepted";
export type DmPolicy = "everyone" | "communities" | "connections";
export type RequestPolicy = "everyone" | "communities" | "nobody";
export const DM_POLICIES: readonly DmPolicy[] = DmPolicyEnum.options;
export const REQUEST_POLICIES: readonly RequestPolicy[] =
  RequestPolicyEnum.options;

export interface ConnectionRow {
  pair: string;
  a: string;
  b: string;
  state: ConnectionState;
  requested_by: string;
  created_at: number;
  accepted_at: number | null;
  request_note?: string | null;
}

export interface DmRequestRow {
  conversation_id: string;
  recipient: string;
  sender: string;
  state: "pending" | "declined";
  sent: number;
  created_at: number;
  answered_at: number | null;
}

export interface MessagingSettings {
  dm_policy: DmPolicy;
  request_policy: RequestPolicy;
}

/** The pair key: both user ids, sorted, joined by "|" (one row per pair whoever asked). */
export function pairOf(
  x: string,
  y: string,
): { pair: string; a: string; b: string } {
  const [a, b] = [x, y].sort();
  return { pair: `${a}|${b}`, a, b };
}

/** Where relationships live: SQLite, or MongoDB when MONGODB_DOMAINS includes "relationships" (src/mongo/relationships.ts). */
export interface RelationshipStore {
  readonly backend: "sqlite" | "mongodb" | "postgres";
  connection(x: string, y: string): Promise<ConnectionRow | null>;
  /** Every connection and pending request [userId] is part of. */
  connectionsOf(userId: string): Promise<ConnectionRow[]>;
  /** Inserts or replaces the pair's row. */
  putConnection(row: ConnectionRow): Promise<void>;
  /** Starts a request or accepts a crossed request atomically, without regressing an accepted pair. */
  requestConnection(
    row: ConnectionRow,
  ): Promise<{ row: ConnectionRow | null; changed: boolean }>;
  /** Accepts only an existing pending request from [from] to [recipient]. No upsert; true only on transition. */
  acceptConnection(
    recipient: string,
    from: string,
    at: number,
  ): Promise<boolean>;
  deleteConnection(x: string, y: string): Promise<boolean>;
  deletePendingConnection(x: string, y: string): Promise<boolean>;
  request(conversationId: string): Promise<DmRequestRow | null>;
  createRequest(row: DmRequestRow): Promise<void>;
  /** [recipient]'s requests in [state], newest first. */
  requestsFor(
    recipient: string,
    state: DmRequestRow["state"],
  ): Promise<DmRequestRow[]>;
  /** The requests for these conversations that [userId] sent or received (for conversation views). */
  requestsIn(conversationIds: string[]): Promise<DmRequestRow[]>;
  /** Counts one more message the sender sent before an answer; returns the new count. */
  countSent(conversationId: string): Promise<number>;
  declineRequest(conversationId: string, at: number): Promise<void>;
  deleteRequest(conversationId: string): Promise<void>;
  /** Connection and message requests [userId] started since [since] (the hourly limit). */
  countStartedSince(userId: string, since: number): Promise<number>;
  /** The person's own choices, or null when they never chose (the server's defaults apply: rules.ts settingsOf). */
  settings(userId: string): Promise<MessagingSettings | null>;
  putSettings(userId: string, s: MessagingSettings, at: number): Promise<void>;
  /** An account was deleted: its connections, requests and settings go. */
  deleteForUser(userId: string): Promise<void>;
}

export class SqliteRelationshipStore implements RelationshipStore {
  readonly backend = "sqlite" as const;
  constructor(private readonly db: DB) {}

  async connection(x: string, y: string): Promise<ConnectionRow | null> {
    return (
      (this.db
        .prepare("SELECT * FROM connections WHERE pair = ?")
        .get(pairOf(x, y).pair) as ConnectionRow | undefined) ?? null
    );
  }

  async connectionsOf(userId: string): Promise<ConnectionRow[]> {
    return this.db
      .prepare(
        "SELECT * FROM connections WHERE a = ? OR b = ? ORDER BY created_at DESC",
      )
      .all(userId, userId) as ConnectionRow[];
  }

  async putConnection(row: ConnectionRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO connections (pair, a, b, state, requested_by, created_at, accepted_at, request_note) VALUES (@pair, @a, @b, @state, @requested_by, @created_at, @accepted_at, @request_note)
         ON CONFLICT (pair) DO UPDATE SET state = excluded.state, requested_by = excluded.requested_by, created_at = excluded.created_at, accepted_at = excluded.accepted_at, request_note=excluded.request_note`,
      )
      .run({
        ...row,
        request_note:
          row.state === "accepted" ? null : (row.request_note ?? null),
      });
  }
  async requestConnection(
    row: ConnectionRow,
  ): Promise<{ row: ConnectionRow | null; changed: boolean }> {
    const changed = this.db
      .prepare(
        `INSERT INTO connections(pair,a,b,state,requested_by,created_at,accepted_at,request_note)
      VALUES(@pair,@a,@b,'pending',@requested_by,@created_at,NULL,@request_note)
      ON CONFLICT(pair) DO UPDATE SET state='accepted',accepted_at=excluded.created_at,request_note=NULL
      WHERE connections.state='pending' AND connections.requested_by<>excluded.requested_by RETURNING *`,
      )
      .get({ ...row, request_note: row.request_note ?? null }) as
      ConnectionRow | undefined;
    return {
      row: changed ?? (await this.connection(row.a, row.b)),
      changed: !!changed,
    };
  }

  async deleteConnection(x: string, y: string): Promise<boolean> {
    return (
      this.db
        .prepare("DELETE FROM connections WHERE pair = ?")
        .run(pairOf(x, y).pair).changes > 0
    );
  }
  async deletePendingConnection(x: string, y: string): Promise<boolean> {
    return (
      this.db
        .prepare("DELETE FROM connections WHERE pair=? AND state='pending'")
        .run(pairOf(x, y).pair).changes > 0
    );
  }

  async acceptConnection(
    recipient: string,
    from: string,
    at: number,
  ): Promise<boolean> {
    return (
      this.db
        .prepare(
          "UPDATE connections SET state = 'accepted', accepted_at = ?, request_note=NULL WHERE pair = ? AND state = 'pending' AND requested_by = ?",
        )
        .run(at, pairOf(recipient, from).pair, from).changes === 1
    );
  }

  async request(conversationId: string): Promise<DmRequestRow | null> {
    return (
      (this.db
        .prepare("SELECT * FROM dm_requests WHERE conversation_id = ?")
        .get(conversationId) as DmRequestRow | undefined) ?? null
    );
  }

  async createRequest(row: DmRequestRow): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO dm_requests (conversation_id, recipient, sender, state, sent, created_at, answered_at)
         VALUES (@conversation_id, @recipient, @sender, @state, @sent, @created_at, @answered_at)`,
      )
      .run(row);
  }

  async requestsFor(
    recipient: string,
    state: DmRequestRow["state"],
  ): Promise<DmRequestRow[]> {
    return this.db
      .prepare(
        "SELECT * FROM dm_requests WHERE recipient = ? AND state = ? ORDER BY created_at DESC",
      )
      .all(recipient, state) as DmRequestRow[];
  }

  async requestsIn(conversationIds: string[]): Promise<DmRequestRow[]> {
    if (conversationIds.length === 0) return [];
    const out: DmRequestRow[] = [];
    // SQLite's default limit on bound variables is generous, but chunk anyway for people in many conversations.
    for (let i = 0; i < conversationIds.length; i += 500) {
      const ids = conversationIds.slice(i, i + 500);
      out.push(
        ...(this.db
          .prepare(
            `SELECT * FROM dm_requests WHERE conversation_id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as DmRequestRow[]),
      );
    }
    return out;
  }

  async countSent(conversationId: string): Promise<number> {
    const r = this.db
      .prepare(
        "UPDATE dm_requests SET sent = sent + 1 WHERE conversation_id = ? RETURNING sent",
      )
      .get(conversationId) as { sent: number } | undefined;
    return r?.sent ?? 0;
  }

  async declineRequest(conversationId: string, at: number): Promise<void> {
    this.db
      .prepare(
        "UPDATE dm_requests SET state = 'declined', answered_at = ? WHERE conversation_id = ?",
      )
      .run(at, conversationId);
  }

  async deleteRequest(conversationId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM dm_requests WHERE conversation_id = ?")
      .run(conversationId);
  }

  async countStartedSince(userId: string, since: number): Promise<number> {
    const c = (
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM connections WHERE requested_by = ? AND created_at >= ?",
        )
        .get(userId, since) as { n: number }
    ).n;
    const r = (
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM dm_requests WHERE sender = ? AND created_at >= ?",
        )
        .get(userId, since) as { n: number }
    ).n;
    return c + r;
  }

  async settings(userId: string): Promise<MessagingSettings | null> {
    return (
      (this.db
        .prepare(
          "SELECT dm_policy, request_policy FROM messaging_settings WHERE user_id = ?",
        )
        .get(userId) as MessagingSettings | undefined) ?? null
    );
  }

  async putSettings(
    userId: string,
    s: MessagingSettings,
    at: number,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messaging_settings (user_id, dm_policy, request_policy, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET dm_policy = excluded.dm_policy, request_policy = excluded.request_policy, updated_at = excluded.updated_at`,
      )
      .run(userId, s.dm_policy, s.request_policy, at);
  }

  async deleteForUser(userId: string): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM connections WHERE a = ? OR b = ?")
        .run(userId, userId);
      this.db
        .prepare("DELETE FROM dm_requests WHERE recipient = ? OR sender = ?")
        .run(userId, userId);
      this.db
        .prepare("DELETE FROM messaging_settings WHERE user_id = ?")
        .run(userId);
    })();
  }
}
