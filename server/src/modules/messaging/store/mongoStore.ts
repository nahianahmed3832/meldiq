import type { Collection } from "mongodb";
import type { MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";
import { type ConversationSummary, type HistoryPage, type MessageEvent, type MessageStore, mentionsOf } from "./messageStore.js";

/** message_events: the SQLite row itself (same field names, docs/MONGODB.md §3), keyed by its id. */
type EventDoc = MessageEvent & { _id: string };

const toEvent = ({ _id, ...rest }: EventDoc): MessageEvent => rest;
const toDoc = (e: MessageEvent): EventDoc => ({ _id: e.id, ...e });
/** Regex metacharacters escaped, so a search is for the text itself. */
const literal = (q: string) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Stored messages in MongoDB (MONGODB_DOMAINS includes "history"). Each query goes to the database; the indexes come
 * from migration 066 through the checked-in schema (conversation + class + time, conversation + target, sender).
 */
export class MongoMessageStore implements MessageStore {
  readonly backend = "mongodb" as const;
  private readonly col: Collection<EventDoc>;

  constructor(private readonly mongo: MeldiqMongo) {
    this.col = mongo.db.collection<EventDoc>("message_events");
  }

  async get(id: string): Promise<MessageEvent | null> {
    const d = await this.col.findOne({ _id: id }, { session: this.mongo.session() });
    return d ? toEvent(d) : null;
  }

  async add(e: MessageEvent): Promise<boolean> {
    const r = await this.col.updateOne({ _id: e.id }, { $setOnInsert: toDoc(e) }, { upsert: true, session: this.mongo.session() });
    return r.upsertedCount > 0;
  }

  async addMany(events: MessageEvent[]): Promise<number> {
    if (!events.length) return 0;
    const r = await this.col.bulkWrite(
      events.map((e) => ({ updateOne: { filter: { _id: e.id }, update: { $setOnInsert: toDoc(e) }, upsert: true } })),
      { ordered: false, session: this.mongo.session() },
    );
    return r.upsertedCount;
  }

  async page(conversationId: string, viewer: string, before: number | null, limit: number): Promise<HistoryPage> {
    const docs = await this.col
      .find({ conversation_id: conversationId, cls: "message", server_ts: { $lt: before ?? Number.MAX_SAFE_INTEGER } }, { session: this.mongo.session() })
      .sort({ server_ts: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const messages = docs.slice(0, limit).map(toEvent);
    return { messages, changes: await this.changesFor(conversationId, viewer, messages), more: docs.length > limit };
  }

  async around(conversationId: string, viewer: string, messageId: string, limit: number): Promise<HistoryPage | null> {
    const at = await this.get(messageId);
    if (!at || at.conversation_id !== conversationId || at.cls !== "message") return null;
    const session = this.mongo.session();
    const older = (
      await this.col
        .find({ conversation_id: conversationId, cls: "message", server_ts: { $lt: at.server_ts } }, { session })
        .sort({ server_ts: -1, _id: -1 })
        .limit(limit + 1)
        .toArray()
    ).map(toEvent);
    const newer = (
      await this.col
        .find({ conversation_id: conversationId, cls: "message", server_ts: { $gte: at.server_ts }, _id: { $ne: at.id } }, { session })
        .sort({ server_ts: 1, _id: 1 })
        .limit(limit)
        .toArray()
    ).map(toEvent);
    const messages = [...newer.reverse(), at, ...older.slice(0, limit)];
    return { messages, changes: await this.changesFor(conversationId, viewer, messages), more: older.length > limit };
  }

  private async changesFor(conversationId: string, viewer: string, messages: MessageEvent[]): Promise<MessageEvent[]> {
    if (!messages.length) return [];
    const docs = await this.col
      .find(
        { conversation_id: conversationId, cls: "control", target: { $in: messages.map((m) => m.id) }, $or: [{ audience: "all" }, { sender_user_id: viewer }] },
        { session: this.mongo.session() },
      )
      .sort({ server_ts: 1, _id: 1 })
      .toArray();
    return docs.map(toEvent);
  }

  async search(conversationIds: readonly string[], query: string, limit: number): Promise<MessageEvent[]> {
    const q = query.trim();
    if (!conversationIds.length || !q) return [];
    const docs = await this.col
      .find(
        { cls: "message", type: "text", conversation_id: { $in: [...conversationIds] }, payload: { $regex: literal(JSON.stringify(q).slice(1, -1)), $options: "i" } },
        { session: this.mongo.session() },
      )
      .sort({ server_ts: -1 })
      .limit(limit * 3)
      .toArray();
    // The regex runs over the JSON text: keep only hits in the message's own text.
    const needle = q.toLowerCase();
    return docs
      .map(toEvent)
      .filter((e) => String((JSON.parse(e.payload) as { text?: unknown }).text ?? "").toLowerCase().includes(needle))
      .slice(0, limit);
  }

  async summaries(conversationIds: readonly string[], userId: string, cap: number): Promise<ConversationSummary[]> {
    const session = this.mongo.session();
    return Promise.all(
      conversationIds.map(async (id): Promise<ConversationSummary> => {
        const [lastDoc] = await this.col.find({ conversation_id: id, cls: "message" }, { session }).sort({ server_ts: -1, _id: -1 }).limit(1).toArray();
        const reads = await this.col.find({ conversation_id: id, cls: "control", type: "read", sender_user_id: userId }, { session, projection: { payload: 1 } }).toArray();
        const up = reads.reduce((max, r) => Math.max(max, Number((JSON.parse(r.payload) as { upTo?: unknown }).upTo) || 0), 0);
        const newer = await this.col
          .find({ conversation_id: id, cls: "message", sender_user_id: { $ne: userId }, server_ts: { $gt: up } }, { session, projection: { payload: 1, mention_all: 1 } })
          .sort({ server_ts: -1 })
          .limit(cap)
          .toArray();
        return {
          conversation_id: id,
          last: lastDoc ? toEvent(lastDoc) : null,
          read_up_to: up,
          unread: newer.length,
          mentions: newer.filter((d) => mentionsOf(d, userId)).length,
        };
      }),
    );
  }

  async deleteConversation(conversationId: string): Promise<number> {
    return (await this.col.deleteMany({ conversation_id: conversationId }, { session: this.mongo.session() })).deletedCount;
  }

  async stats(): Promise<{ messages: number; changes: number }> {
    const [messages, changes] = await Promise.all([this.col.countDocuments({ cls: "message" }), this.col.countDocuments({ cls: "control" })]);
    return { messages, changes };
  }
}
