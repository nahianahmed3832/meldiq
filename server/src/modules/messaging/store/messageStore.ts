import type { DB } from "../../../infrastructure/database/db.js";

/**
 * Messages stored and served by the server (docs/SERVER_MESSAGES.md, migration 066): every message and every change to
 * one, as the app sent it, readable by the server. A conversation's history is its messages, newest first, with the
 * changes that point at them; apps apply the changes as they do live ones.
 *
 * SQLite (SqliteMessageStore) or MongoDB (MongoMessageStore, MONGODB_DOMAINS includes "history"). Queries go to the
 * database each time: the table grows without bound, so it is never held in memory.
 */
export interface MessageEvent {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  sender_device_id: string | null;
  cls: "message" | "control";
  type: string;
  target: string | null;
  audience: "all" | "self";
  /** JSON text. */
  payload: string;
  sent_at: number;
  server_ts: number;
  mention_all: 0 | 1;
  /** Who uploaded it from their device's own history (null: sent live through the server). */
  imported_by: string | null;
}

export interface HistoryPage {
  /** Messages before the cursor, newest first. */
  messages: MessageEvent[];
  /**
   * Every change that points at one of [messages] (another member's edits, reactions, deletions...), and each other
   * member's newest read receipt (a read names no message: `{ type: "read", upTo }`), oldest first.
   */
  changes: MessageEvent[];
  /** Whether older messages remain. */
  more: boolean;
}

/** Where a person stands in one conversation (the apps' list: preview, unread and mentions after a reload). */
export interface ConversationSummary {
  conversation_id: string;
  /** The newest message, or null when there's none. */
  last: MessageEvent | null;
  /** The newest time this person said they had read up to (their read markers), 0 when never. */
  read_up_to: number;
  /** Others' messages after that, counted up to [cap]. */
  unread: number;
  /** Of those, the ones that mention this person or everyone. */
  mentions: number;
}

export interface MessageStore {
  readonly backend: "sqlite" | "mongodb" | "postgres";
  get(id: string): Promise<MessageEvent | null>;
  /** Adds [e]; false when an event with its id already exists (nothing changes then). */
  add(e: MessageEvent): Promise<boolean>;
  /** Adds what isn't there yet (imported history: the first device to upload a message wins). Returns how many were new. */
  addMany(events: MessageEvent[]): Promise<number>;
  /**
   * A page of [conversationId]'s history: messages before the ordered (server_ts, id) cursor (or the newest), at most [limit],
   * and the changes to them, with the other members' newest read receipts (so an app rebuilding the conversation from
   * history shows what they have read). Self-only events (a person's read markers on their own devices) are only
   * [viewer]'s.
   */
  page(conversationId: string, viewer: string, before: number | null, limit: number, beforeId?: string): Promise<HistoryPage>;
  /** Messages around one (a link or a search hit): [limit] before it, it, and [limit] after, with their changes. */
  around(conversationId: string, viewer: string, messageId: string, limit: number): Promise<HistoryPage | null>;
  /** Text messages in [conversationIds] whose text contains [query] (case-insensitive), newest first. */
  search(conversationIds: readonly string[], query: string, limit: number): Promise<MessageEvent[]>;
  /** For each conversation: its newest message, this person's read position, and unread messages and mentions since. */
  summaries(conversationIds: readonly string[], userId: string, cap: number): Promise<ConversationSummary[]>;
  /**
   * Community parity A1: the changes of one [type] that point at [targetId] (everyone's, oldest first): which emoji a
   * message's reactions hold.
   */
  changesTo(conversationId: string, targetId: string, type: string): Promise<MessageEvent[]>;
  /** Other members’ public read markers, reused by every history/collection page. */
  readReceipts(conversationId: string, viewer: string): Promise<MessageEvent[]>;
  /** Community parity A1: whether a message after [since] replies in the thread of [rootId] (the thread exists). */
  threadHasReplies(conversationId: string, rootId: string, since: number): Promise<boolean>;
  /** Every event of a deleted conversation. */
  deleteConversation(conversationId: string): Promise<number>;
  /** Counts for the operator (no content). */
  stats(): Promise<{ messages: number; changes: number }>;
  /**
   * Community parity B (the lobby): messages sent live in [conversationIds] since [since] (uploaded history doesn't
   * count), per conversation and for the [top] busiest senders. No content is read.
   */
  activitySince(conversationIds: readonly string[], since: number, top: number): Promise<MessageActivity>;
  /** The newest message's time in each of [conversationIds] that has one ("Active 5m ago"). */
  lastMessageAt(conversationIds: readonly string[]): Promise<Record<string, number>>;
}

/** How busy some conversations were (MessageStore.activitySince). */
export interface MessageActivity {
  perConversation: Record<string, number>;
  /** Busiest first. */
  topSenders: { userId: string; count: number }[];
}

/** The thread a stored message replies in, or null. */
export function threadRootOf(e: { payload: string }): string | null {
  const root = (JSON.parse(e.payload) as { threadRoot?: unknown }).threadRoot;
  return typeof root === "string" ? root : null;
}

/** Whether a stored message mentions [userId] or everyone. */
export function mentionsOf(e: { payload: string; mention_all: number }, userId: string): boolean {
  if (e.mention_all === 1) return true;
  const p = JSON.parse(e.payload) as { mentions?: unknown };
  return Array.isArray(p.mentions) && p.mentions.includes(userId);
}

/**
 * At most this many other members' read receipts go with a page, the most recent readers first. Receipts are sent only
 * in DMs and groups of up to 20 (the apps' sendsReadReceipts); the bound only matters for imported history.
 */
export const PAGE_READERS = 50;

/**
 * A page's changes: [targeted] (pointing at its messages) and [reads] (the other members' newest receipts), once each,
 * oldest first as apps apply them.
 */
export function pageChanges(targeted: readonly MessageEvent[], reads: readonly MessageEvent[]): MessageEvent[] {
  const seen = new Set(targeted.map((e) => e.id));
  return [...targeted, ...reads.filter((e) => !seen.has(e.id))].sort((a, b) => a.server_ts - b.server_ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const COLUMNS = "id, conversation_id, sender_user_id, sender_device_id, cls, type, target, audience, payload, sent_at, server_ts, mention_all, imported_by";

/** Escapes LIKE's wildcards so a search for "100%" finds "100%" and not everything after "100". */
const likeEscaped = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export class SqliteMessageStore implements MessageStore {
  readonly backend = "sqlite" as const;
  constructor(private readonly db: DB) {}

  async get(id: string): Promise<MessageEvent | null> {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM message_events WHERE id = ?`).get(id) as MessageEvent | undefined) ?? null;
  }

  async add(e: MessageEvent): Promise<boolean> {
    return this.insert(e);
  }

  private insert(e: MessageEvent): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO message_events (${COLUMNS}) VALUES (@id, @conversation_id, @sender_user_id, @sender_device_id, @cls, @type, @target, @audience, @payload, @sent_at, @server_ts, @mention_all, @imported_by)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(e);
    return r.changes > 0;
  }

  async addMany(events: MessageEvent[]): Promise<number> {
    return this.db.transaction(() => events.reduce((n, e) => n + (this.insert(e) ? 1 : 0), 0))();
  }

  async page(conversationId: string, viewer: string, before: number | null, limit: number, beforeId?: string): Promise<HistoryPage> {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'message' AND (server_ts < ? OR (server_ts = ? AND id < ?)) ORDER BY server_ts DESC, id DESC LIMIT ?`,
      )
      .all(conversationId, before ?? Number.MAX_SAFE_INTEGER, before ?? Number.MAX_SAFE_INTEGER, beforeId ?? '', limit + 1) as MessageEvent[];
    const messages = rows.slice(0, limit);
    return { messages, changes: await this.changesFor(conversationId, viewer, messages), more: rows.length > limit };
  }

  async around(conversationId: string, viewer: string, messageId: string, limit: number): Promise<HistoryPage | null> {
    const at = await this.get(messageId);
    if (!at || at.conversation_id !== conversationId || at.cls !== "message") return null;
    const older = this.db
      .prepare(`SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'message' AND (server_ts < ? OR (server_ts = ? AND id < ?)) ORDER BY server_ts DESC, id DESC LIMIT ?`)
      .all(conversationId, at.server_ts, at.server_ts, at.id, limit + 1) as MessageEvent[];
    const newer = this.db
      .prepare(`SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'message' AND (server_ts > ? OR (server_ts = ? AND id > ?)) ORDER BY server_ts, id LIMIT ?`)
      .all(conversationId, at.server_ts, at.server_ts, at.id, limit) as MessageEvent[];
    const messages = [...newer.reverse(), at, ...older.slice(0, limit)];
    return { messages, changes: await this.changesFor(conversationId, viewer, messages), more: older.length > limit };
  }

  private async changesFor(conversationId: string, viewer: string, messages: MessageEvent[]): Promise<MessageEvent[]> {
    if (!messages.length) return [];
    const ids = messages.map((m) => m.id);
    const targeted = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'control' AND target IN (${ids.map(() => "?").join(",")})
           AND (audience = 'all' OR sender_user_id = ?) ORDER BY server_ts, id`,
      )
      .all(conversationId, ...ids, viewer) as MessageEvent[];
    return pageChanges(targeted, await this.readReceipts(conversationId, viewer));
  }

  /** Each other member's newest read receipt in [conversationId] (receipts are sent with rising upTo). */
  async readReceipts(conversationId: string, viewer: string): Promise<MessageEvent[]> {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM (
           SELECT ${COLUMNS}, ROW_NUMBER() OVER (PARTITION BY sender_user_id ORDER BY server_ts DESC, id DESC) n FROM message_events
           WHERE conversation_id = ? AND cls = 'control' AND type = 'read' AND audience = 'all' AND sender_user_id <> ?
         ) WHERE n = 1 ORDER BY server_ts DESC, id DESC LIMIT ?`,
      )
      .all(conversationId, viewer, PAGE_READERS) as MessageEvent[];
  }

  async search(conversationIds: readonly string[], query: string, limit: number): Promise<MessageEvent[]> {
    if (!conversationIds.length || !query.trim()) return [];
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM message_events WHERE cls = 'message' AND type = 'text' AND conversation_id IN (${conversationIds.map(() => "?").join(",")})
           AND json_extract(payload, '$.text') LIKE ? ESCAPE '\\' ORDER BY server_ts DESC LIMIT ?`,
      )
      .all(...conversationIds, `%${likeEscaped(query.trim())}%`, limit) as MessageEvent[];
  }

  async summaries(conversationIds: readonly string[], userId: string, cap: number): Promise<ConversationSummary[]> {
    const last = this.db.prepare(`SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'message' ORDER BY server_ts DESC, id DESC LIMIT 1`);
    const read = this.db.prepare(
      "SELECT MAX(CAST(json_extract(payload, '$.upTo') AS INTEGER)) up FROM message_events WHERE conversation_id = ? AND cls = 'control' AND type = 'read' AND sender_user_id = ?",
    );
    const newer = this.db.prepare(
      // Uploaded history (imported_by) was seen on the device that kept it: never unread.
      `SELECT payload, mention_all FROM message_events WHERE conversation_id = ? AND cls = 'message' AND sender_user_id <> ? AND server_ts > ? AND imported_by IS NULL
         ORDER BY server_ts DESC LIMIT ?`,
    );
    return conversationIds.map((id) => {
      const up = (read.get(id, userId) as { up: number | null }).up ?? 0;
      const rows = newer.all(id, userId, up, cap) as { payload: string; mention_all: number }[];
      return { conversation_id: id, last: (last.get(id) as MessageEvent | undefined) ?? null, read_up_to: up, unread: rows.length, mentions: rows.filter((r) => mentionsOf(r, userId)).length };
    });
  }

  async changesTo(conversationId: string, targetId: string, type: string): Promise<MessageEvent[]> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'control' AND target = ? AND type = ? AND audience = 'all' ORDER BY server_ts, id`)
      .all(conversationId, targetId, type) as MessageEvent[];
  }

  async threadHasReplies(conversationId: string, rootId: string, since: number): Promise<boolean> {
    return !!this.db
      .prepare("SELECT 1 FROM message_events WHERE conversation_id = ? AND cls = 'message' AND server_ts >= ? AND json_extract(payload, '$.threadRoot') = ? LIMIT 1")
      .get(conversationId, since, rootId);
  }

  async deleteConversation(conversationId: string): Promise<number> {
    return this.db.prepare("DELETE FROM message_events WHERE conversation_id = ?").run(conversationId).changes;
  }

  async stats(): Promise<{ messages: number; changes: number }> {
    const r = this.db.prepare("SELECT SUM(cls = 'message') m, SUM(cls = 'control') c FROM message_events").get() as { m: number | null; c: number | null };
    return { messages: r.m ?? 0, changes: r.c ?? 0 };
  }

  async activitySince(conversationIds: readonly string[], since: number, top: number): Promise<MessageActivity> {
    if (conversationIds.length === 0) return { perConversation: {}, topSenders: [] };
    const where = `conversation_id IN (${conversationIds.map(() => "?").join(",")}) AND cls = 'message' AND server_ts >= ? AND imported_by IS NULL`;
    const per = this.db.prepare(`SELECT conversation_id id, COUNT(*) n FROM message_events WHERE ${where} GROUP BY conversation_id`).all(...conversationIds, since) as { id: string; n: number }[];
    const senders = this.db
      .prepare(`SELECT sender_user_id id, COUNT(*) n FROM message_events WHERE ${where} GROUP BY sender_user_id ORDER BY n DESC, id ASC LIMIT ?`)
      .all(...conversationIds, since, top) as { id: string; n: number }[];
    return { perConversation: Object.fromEntries(per.map((r) => [r.id, r.n])), topSenders: senders.map((r) => ({ userId: r.id, count: r.n })) };
  }

  async lastMessageAt(conversationIds: readonly string[]): Promise<Record<string, number>> {
    const q = this.db.prepare("SELECT MAX(server_ts) t FROM message_events WHERE conversation_id = ? AND cls = 'message'");
    const out: Record<string, number> = {};
    for (const id of conversationIds) {
      const t = (q.get(id) as { t: number | null }).t;
      if (t !== null) out[id] = t;
    }
    return out;
  }
}
