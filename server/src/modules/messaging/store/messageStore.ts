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
  /** Every change that points at one of [messages], oldest first (another member's edits, reactions, deletions...). */
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
  readonly backend: "sqlite" | "mongodb";
  get(id: string): Promise<MessageEvent | null>;
  /** Adds [e]; false when an event with its id already exists (nothing changes then). */
  add(e: MessageEvent): Promise<boolean>;
  /** Adds what isn't there yet (imported history: the first device to upload a message wins). Returns how many were new. */
  addMany(events: MessageEvent[]): Promise<number>;
  /**
   * A page of [conversationId]'s history: messages with server_ts before [before] (or the newest), at most [limit],
   * and the changes to them. Self-only events (a person's read markers on their own devices) are only [viewer]'s.
   */
  page(conversationId: string, viewer: string, before: number | null, limit: number): Promise<HistoryPage>;
  /** Messages around one (a link or a search hit): [limit] before it, it, and [limit] after, with their changes. */
  around(conversationId: string, viewer: string, messageId: string, limit: number): Promise<HistoryPage | null>;
  /** Text messages in [conversationIds] whose text contains [query] (case-insensitive), newest first. */
  search(conversationIds: readonly string[], query: string, limit: number): Promise<MessageEvent[]>;
  /** For each conversation: its newest message, this person's read position, and unread messages and mentions since. */
  summaries(conversationIds: readonly string[], userId: string, cap: number): Promise<ConversationSummary[]>;
  /** Every event of a deleted conversation. */
  deleteConversation(conversationId: string): Promise<number>;
  /** Counts for the operator (no content). */
  stats(): Promise<{ messages: number; changes: number }>;
}

/** Whether a stored message mentions [userId] or everyone. */
export function mentionsOf(e: { payload: string; mention_all: number }, userId: string): boolean {
  if (e.mention_all === 1) return true;
  const p = JSON.parse(e.payload) as { mentions?: unknown };
  return Array.isArray(p.mentions) && p.mentions.includes(userId);
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

  async page(conversationId: string, viewer: string, before: number | null, limit: number): Promise<HistoryPage> {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'message' AND server_ts < ? ORDER BY server_ts DESC, id DESC LIMIT ?`,
      )
      .all(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as MessageEvent[];
    const messages = rows.slice(0, limit);
    return { messages, changes: this.changesFor(conversationId, viewer, messages), more: rows.length > limit };
  }

  async around(conversationId: string, viewer: string, messageId: string, limit: number): Promise<HistoryPage | null> {
    const at = await this.get(messageId);
    if (!at || at.conversation_id !== conversationId || at.cls !== "message") return null;
    const older = this.db
      .prepare(`SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'message' AND server_ts < ? ORDER BY server_ts DESC, id DESC LIMIT ?`)
      .all(conversationId, at.server_ts, limit + 1) as MessageEvent[];
    const newer = this.db
      .prepare(`SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'message' AND server_ts >= ? AND id <> ? ORDER BY server_ts, id LIMIT ?`)
      .all(conversationId, at.server_ts, at.id, limit) as MessageEvent[];
    const messages = [...newer.reverse(), at, ...older.slice(0, limit)];
    return { messages, changes: this.changesFor(conversationId, viewer, messages), more: older.length > limit };
  }

  private changesFor(conversationId: string, viewer: string, messages: MessageEvent[]): MessageEvent[] {
    if (!messages.length) return [];
    const ids = messages.map((m) => m.id);
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM message_events WHERE conversation_id = ? AND cls = 'control' AND target IN (${ids.map(() => "?").join(",")})
           AND (audience = 'all' OR sender_user_id = ?) ORDER BY server_ts, id`,
      )
      .all(conversationId, ...ids, viewer) as MessageEvent[];
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

  async deleteConversation(conversationId: string): Promise<number> {
    return this.db.prepare("DELETE FROM message_events WHERE conversation_id = ?").run(conversationId).changes;
  }

  async stats(): Promise<{ messages: number; changes: number }> {
    const r = this.db.prepare("SELECT SUM(cls = 'message') m, SUM(cls = 'control') c FROM message_events").get() as { m: number | null; c: number | null };
    return { messages: r.m ?? 0, changes: r.c ?? 0 };
  }
}
