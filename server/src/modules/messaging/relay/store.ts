import type { DB } from "../../../infrastructure/database/db.js";

/**
 * The relay: end-to-end encrypted envelopes and delivery receipts waiting for each recipient device (delivery_queue),
 * and the idempotency record of every accepted message (submitted_messages). Ciphertext only; at most
 * QUEUE_TTL_SECONDS old; deleted when acknowledged (docs/RETENTION.md, docs/architecture/ARCHITECTURE_1_0_PLAN.md §5.2).
 *
 * SQLite (SqliteRelayStore) or MongoDB (MongoRelayStore, MONGODB_DOMAINS includes "relay"). Every method is async;
 * the `forget*` cascades return nothing: SQLite runs them at once (inside the caller's transaction, as before), MongoDB
 * right after the caller's synchronous step. Undelivered items expire on their own, so a cascade that fails leaves
 * nothing for longer than the queue lifetime.
 */

/** A queue item as stored (the same fields in both stores). */
export interface QueueItemRow {
  /** Increasing: a device receives and acknowledges its items in id order. */
  id: number;
  recipient_device_id: string;
  /** "message": a stored message or change (API 0.56.0); "envelope": an older app's encrypted one. */
  kind: "envelope" | "receipt" | "message";
  conversation_id: string;
  message_id: string;
  sender_user_id: string;
  sender_device_id: string;
  /** JSON text: the envelope or receipt as the recipient gets it. */
  payload: string;
  created_at: number;
  expires_at: number;
}

export type QueueInsert = Omit<QueueItemRow, "id">;

export interface Submission {
  message_id: string;
  sender_device_id: string;
  sender_user_id: string;
  conversation_id: string;
  recipient_count: number;
  server_ts: number;
  expires_at: number;
}

export interface RelayStats {
  envelopes: number;
  receipts: number;
  /** created_at of the oldest item, or null when the queue is empty. */
  oldestCreatedAt: number | null;
}

/** The same messageId was accepted concurrently (the loser of the race answers as a retry would). */
export class DuplicateSubmission extends Error {
  constructor(readonly messageId: string) {
    super(`message ${messageId} was already submitted`);
  }
}

export interface RelayStore {
  readonly backend: "sqlite" | "mongodb";
  /** The accepted message with this id, if any (idempotency and report checks). */
  submission(messageId: string): Promise<Submission | null>;
  /**
   * Records [sub] and queues [items] (one per recipient device) atomically. Throws DuplicateSubmission when the id is
   * already taken. Returns the stored items, ids assigned.
   */
  accept(sub: Submission, items: QueueInsert[]): Promise<QueueItemRow[]>;
  /** Queues items that may already be there (receipts, federated deliveries): an existing one is skipped, not returned. */
  enqueue(items: QueueInsert[]): Promise<QueueItemRow[]>;
  /** A device's items that haven't expired, in id order. */
  backlog(deviceId: string, now: number, limit: number): Promise<QueueItemRow[]>;
  /** Deletes the listed items of this device and returns the ones that existed. */
  take(deviceId: string, ids: readonly number[]): Promise<QueueItemRow[]>;
  /** Whether an envelope for [deviceId] arrived at or after [since] and is still queued (push wake-ups). */
  hasEnvelopeSince(deviceId: string, since: number, now: number): Promise<boolean>;
  /** Deletes expired items and idempotency records. */
  purgeExpired(now: number): Promise<{ queue: number; submitted: number }>;
  stats(): Promise<RelayStats>;
  /** How many items are queued in these conversations (community repair report). */
  countInConversations(conversationIds: readonly string[]): Promise<number>;
  /** A revoked or erased device: its queue. */
  forgetDevice(deviceId: string): void;
  /** A deleted conversation: its queue and idempotency records. */
  forgetConversation(conversationId: string): void;
  /** A declined message request: what was queued in it for these devices. */
  forgetConversationFor(conversationId: string, deviceIds: readonly string[]): void;
  /** A deleted account: what it sent that is still undelivered, and its idempotency records. */
  forgetSender(userId: string): void;
}

export class SqliteRelayStore implements RelayStore {
  readonly backend = "sqlite" as const;

  constructor(private readonly db: DB) {}

  async submission(messageId: string): Promise<Submission | null> {
    return (this.db.prepare("SELECT * FROM submitted_messages WHERE message_id = ?").get(messageId) as Submission | undefined) ?? null;
  }

  async accept(sub: Submission, items: QueueInsert[]): Promise<QueueItemRow[]> {
    const ins = this.insert();
    return this.db.transaction(() => {
      const taken = this.db
        .prepare(
          "INSERT OR IGNORE INTO submitted_messages (message_id, sender_device_id, sender_user_id, conversation_id, recipient_count, server_ts, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(sub.message_id, sub.sender_device_id, sub.sender_user_id, sub.conversation_id, sub.recipient_count, sub.server_ts, sub.expires_at);
      if (taken.changes === 0) throw new DuplicateSubmission(sub.message_id);
      return items.map((i) => ins(i)).filter((r): r is QueueItemRow => r !== undefined);
    })();
  }

  async enqueue(items: QueueInsert[]): Promise<QueueItemRow[]> {
    const ins = this.insert();
    return this.db.transaction(() => items.map((i) => ins(i)).filter((r): r is QueueItemRow => r !== undefined))();
  }

  async backlog(deviceId: string, now: number, limit: number): Promise<QueueItemRow[]> {
    return this.db
      .prepare("SELECT * FROM delivery_queue WHERE recipient_device_id = ? AND expires_at > ? ORDER BY id LIMIT ?")
      .all(deviceId, now, limit) as QueueItemRow[];
  }

  async take(deviceId: string, ids: readonly number[]): Promise<QueueItemRow[]> {
    const del = this.db.prepare("DELETE FROM delivery_queue WHERE id = ? AND recipient_device_id = ? RETURNING *");
    return this.db.transaction(() => ids.map((id) => del.get(id, deviceId) as QueueItemRow | undefined).filter((r): r is QueueItemRow => r !== undefined))();
  }

  async hasEnvelopeSince(deviceId: string, since: number, now: number): Promise<boolean> {
    return !!this.db
      .prepare("SELECT 1 FROM delivery_queue WHERE recipient_device_id = ? AND kind IN ('envelope', 'message') AND created_at >= ? AND expires_at > ? LIMIT 1")
      .get(deviceId, since, now);
  }

  async purgeExpired(now: number): Promise<{ queue: number; submitted: number }> {
    return {
      queue: this.db.prepare("DELETE FROM delivery_queue WHERE expires_at <= ?").run(now).changes,
      submitted: this.db.prepare("DELETE FROM submitted_messages WHERE expires_at <= ?").run(now).changes,
    };
  }

  async stats(): Promise<RelayStats> {
    const r = this.db
      .prepare(
        "SELECT SUM(kind <> 'receipt') AS envelopes, SUM(kind = 'receipt') AS receipts, MIN(created_at) AS oldest FROM delivery_queue",
      )
      .get() as { envelopes: number | null; receipts: number | null; oldest: number | null };
    return { envelopes: r.envelopes ?? 0, receipts: r.receipts ?? 0, oldestCreatedAt: r.oldest };
  }

  async countInConversations(conversationIds: readonly string[]): Promise<number> {
    if (conversationIds.length === 0) return 0;
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM delivery_queue WHERE conversation_id IN (${conversationIds.map(() => "?").join(",")})`)
        .get(...conversationIds) as { n: number }
    ).n;
  }

  forgetDevice(deviceId: string): void {
    this.db.prepare("DELETE FROM delivery_queue WHERE recipient_device_id = ?").run(deviceId);
  }

  forgetConversation(conversationId: string): void {
    this.db.prepare("DELETE FROM delivery_queue WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM submitted_messages WHERE conversation_id = ?").run(conversationId);
  }

  forgetConversationFor(conversationId: string, deviceIds: readonly string[]): void {
    const del = this.db.prepare("DELETE FROM delivery_queue WHERE conversation_id = ? AND recipient_device_id = ?");
    for (const d of deviceIds) del.run(conversationId, d);
  }

  forgetSender(userId: string): void {
    this.db.prepare("DELETE FROM delivery_queue WHERE sender_user_id = ?").run(userId);
    this.db.prepare("DELETE FROM submitted_messages WHERE sender_user_id = ?").run(userId);
  }

  /** INSERT OR IGNORE on (device, kind, message, sender device): the stored row, or undefined when it was there. */
  private insert(): (i: QueueInsert) => QueueItemRow | undefined {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO delivery_queue (recipient_device_id, kind, conversation_id, message_id, sender_user_id, sender_device_id, payload, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    );
    return (i) =>
      stmt.get(i.recipient_device_id, i.kind, i.conversation_id, i.message_id, i.sender_user_id, i.sender_device_id, i.payload, i.created_at, i.expires_at) as
        | QueueItemRow
        | undefined;
  }
}
