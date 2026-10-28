import type { FastifyBaseLogger } from "fastify";
import { type AnyBulkWriteOperation, type Collection, MongoBulkWriteError } from "mongodb";
import type { DB } from "../../../infrastructure/database/db.js";
import { isDuplicateKey, META_COLLECTION, type MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";
import { DuplicateSubmission, type QueueInsert, type QueueItemRow, type RelayStats, type RelayStore, type Submission } from "./store.js";

/** delivery_queue: the SQLite row (same field names, docs/MONGODB.md §3) keyed by its id. */
type QueueDoc = QueueItemRow & { _id: number };
/** submitted_messages: keyed by message id. */
type SubmissionDoc = Submission & { _id: string };
interface CounterDoc {
  _id: string;
  seq: number;
}

/** The counter that numbers queue items, in orbit_meta. */
const COUNTER_ID = "seq:delivery_queue";

/**
 * The relay in MongoDB (MONGODB_DOMAINS includes "relay"). Queue item ids stay numbers that only increase, as apps
 * acknowledge by id: a counter document hands out a block of ids per write, starting above every id SQLite or a
 * migration ever used. Accepting a message is one transaction (its record and its items); duplicates are refused by
 * the same unique indexes as in SQLite.
 */
export class MongoRelayStore implements RelayStore {
  readonly backend = "mongodb" as const;
  private readonly queue: Collection<QueueDoc>;
  private readonly submitted: Collection<SubmissionDoc>;
  private readonly meta: Collection<CounterDoc>;
  private counterReady: Promise<void> | null = null;

  constructor(
    private readonly mongo: MeldiqMongo,
    /** To start the counter above SQLite's ids (a queue moved from SQLite; afterwards the counter holds the floor). */
    private readonly db: DB,
    private readonly log: Pick<FastifyBaseLogger, "error">,
  ) {
    this.queue = mongo.db.collection<QueueDoc>("delivery_queue");
    this.submitted = mongo.db.collection<SubmissionDoc>("submitted_messages");
    this.meta = mongo.db.collection<CounterDoc>(META_COLLECTION);
  }

  async submission(messageId: string): Promise<Submission | null> {
    const d = await this.submitted.findOne({ _id: messageId }, { session: this.mongo.session() });
    return d ? strip(d) : null;
  }

  async accept(sub: Submission, items: QueueInsert[]): Promise<QueueItemRow[]> {
    return this.mongo.transaction(async () => {
      const session = this.mongo.session();
      try {
        await this.submitted.insertOne({ _id: sub.message_id, ...sub }, { session });
      } catch (e) {
        if (isDuplicateKey(e)) throw new DuplicateSubmission(sub.message_id);
        throw e;
      }
      return this.insert(items);
    });
  }

  async enqueue(items: QueueInsert[]): Promise<QueueItemRow[]> {
    return this.insert(items);
  }

  async backlog(deviceId: string, now: number, limit: number): Promise<QueueItemRow[]> {
    const docs = await this.queue
      .find({ recipient_device_id: deviceId, expires_at: { $gt: now } }, { session: this.mongo.session() })
      .sort({ id: 1 })
      .limit(limit)
      .toArray();
    return docs.map(strip);
  }

  async take(deviceId: string, ids: readonly number[]): Promise<QueueItemRow[]> {
    if (ids.length === 0) return [];
    const filter = { _id: { $in: [...ids] }, recipient_device_id: deviceId };
    const docs = await this.queue.find(filter).toArray();
    if (docs.length) await this.queue.deleteMany({ _id: { $in: docs.map((d) => d._id) }, recipient_device_id: deviceId });
    return docs.map(strip).sort((a, b) => a.id - b.id);
  }

  async hasEnvelopeSince(deviceId: string, since: number, now: number): Promise<boolean> {
    return (await this.queue.findOne({ recipient_device_id: deviceId, kind: { $in: ["envelope", "message"] }, created_at: { $gte: since }, expires_at: { $gt: now } }, { projection: { _id: 1 } })) !== null;
  }

  async purgeExpired(now: number): Promise<{ queue: number; submitted: number }> {
    const [q, s] = await Promise.all([this.queue.deleteMany({ expires_at: { $lte: now } }), this.submitted.deleteMany({ expires_at: { $lte: now } })]);
    return { queue: q.deletedCount, submitted: s.deletedCount };
  }

  async stats(): Promise<RelayStats> {
    const [r] = await this.queue
      .aggregate<{ envelopes: number; receipts: number; oldest: number | null }>([
        {
          $group: {
            _id: null,
            envelopes: { $sum: { $cond: [{ $ne: ["$kind", "receipt"] }, 1, 0] } },
            receipts: { $sum: { $cond: [{ $eq: ["$kind", "receipt"] }, 1, 0] } },
            oldest: { $min: "$created_at" },
          },
        },
      ])
      .toArray();
    return { envelopes: r?.envelopes ?? 0, receipts: r?.receipts ?? 0, oldestCreatedAt: r?.oldest ?? null };
  }

  async countInConversations(conversationIds: readonly string[]): Promise<number> {
    if (conversationIds.length === 0) return 0;
    return this.queue.countDocuments({ conversation_id: { $in: [...conversationIds] } });
  }

  forgetDevice(deviceId: string): void {
    this.later("forget device", () => this.queue.deleteMany({ recipient_device_id: deviceId }));
  }

  forgetConversation(conversationId: string): void {
    this.later("forget conversation", () =>
      Promise.all([this.queue.deleteMany({ conversation_id: conversationId }), this.submitted.deleteMany({ conversation_id: conversationId })]),
    );
  }

  forgetConversationFor(conversationId: string, deviceIds: readonly string[]): void {
    if (deviceIds.length === 0) return;
    this.later("forget conversation for devices", () => this.queue.deleteMany({ conversation_id: conversationId, recipient_device_id: { $in: [...deviceIds] } }));
  }

  forgetSender(userId: string): void {
    this.later("forget sender", () =>
      Promise.all([this.queue.deleteMany({ sender_user_id: userId }), this.submitted.deleteMany({ sender_user_id: userId })]),
    );
  }

  /** Cascades run right after the caller's synchronous step (usually a SQLite transaction). Failures are logged. */
  private later(what: string, op: () => Promise<unknown>): void {
    setImmediate(() => void op().catch((err) => this.log.error({ err }, `relay: ${what} failed (items expire on their own)`)));
  }

  /**
   * Inserts [items] with fresh ids, skipping any that are already queued (the unique index on device, kind, message
   * and sender device). Returns the inserted rows.
   */
  private async insert(items: QueueInsert[]): Promise<QueueItemRow[]> {
    if (items.length === 0) return [];
    const first = await this.allocate(items.length);
    const docs: QueueDoc[] = items.map((i, n) => ({ ...i, _id: first + n, id: first + n }));
    const ops: AnyBulkWriteOperation<QueueDoc>[] = docs.map((d) => ({ insertOne: { document: d } }));
    let failed = new Set<number>();
    try {
      await this.queue.bulkWrite(ops, { ordered: false, session: this.mongo.session() });
    } catch (e) {
      if (!(e instanceof MongoBulkWriteError)) throw e;
      const errors = [e.writeErrors].flat();
      if (errors.some((w) => w.code !== 11000)) throw e;
      failed = new Set(errors.map((w) => w.index));
    }
    return docs.filter((_, n) => !failed.has(n)).map(strip);
  }

  /** [count] consecutive ids; the first is returned. */
  private async allocate(count: number): Promise<number> {
    await this.startCounter();
    // Outside any transaction: ids only need to grow, and a hot counter inside every transaction would make them conflict.
    const c = await this.meta.findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { seq: count } }, { returnDocument: "after" });
    if (!c) throw new Error("relay id counter missing");
    return c.seq - count + 1;
  }

  /**
   * Starts the counter above every id already used: the largest in MongoDB (a migrated queue) and SQLite's
   * AUTOINCREMENT high-water mark (ids of acknowledged items are never handed out again). $max makes this safe to run
   * from several processes and again after a restart.
   */
  private startCounter(): Promise<void> {
    this.counterReady ??= (async () => {
      const top = await this.queue.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).toArray();
      const sqlite = this.db.prepare("SELECT MAX(seq) AS seq FROM sqlite_sequence WHERE name = 'delivery_queue'").get() as { seq: number | null } | undefined;
      const floor = Math.max(top[0]?._id ?? 0, sqlite?.seq ?? 0);
      await this.meta.updateOne({ _id: COUNTER_ID }, { $max: { seq: floor } }, { upsert: true });
    })().catch((e) => {
      this.counterReady = null;
      throw e;
    });
    return this.counterReady;
  }
}

function strip<T extends { _id: unknown }>(d: T): Omit<T, "_id"> {
  const { _id: _drop, ...row } = d;
  return row;
}
