import type { FastifyBaseLogger } from "fastify";
import type { Collection, Filter } from "mongodb";
import { isDuplicateKey, type MeldiqMongo } from "../../infrastructure/database/mongo/client.js";
import type { BlobKind } from "../../infrastructure/storage/index.js";
import { type Abandoned, type AttachmentRow, type FileStore, KEPT_FOREVER, type PendingBlobDelete, type UploadRow, type Usage, type UsageFilter } from "./store.js";

/** The SQLite rows (same field names, docs/MONGODB.md §3) keyed as the migration keys them. */
type AttachmentDoc = AttachmentRow & { _id: string };
type UploadDoc = UploadRow & { _id: string };
type AbandonedDoc = Abandoned & { _id: string; next_at: number };
type BlobDeleteDoc = PendingBlobDelete & { _id: { kind: BlobKind; blob_id: string }; next_at: number };

/**
 * The files module's records in MongoDB (MONGODB_DOMAINS includes "files"). Completing an upload (session gone,
 * attachment recorded) is one transaction, so exactly one of it and the expiry job wins, as in SQLite. Usage sums are
 * aggregations over the filter the caller gives (uploader and conversation ids come from their own modules).
 */
export class MongoFileStore implements FileStore {
  readonly backend = "mongodb" as const;
  private readonly attachments: Collection<AttachmentDoc>;
  private readonly uploads: Collection<UploadDoc>;
  private readonly abandoned: Collection<AbandonedDoc>;
  private readonly blobDeletes: Collection<BlobDeleteDoc>;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly mongo: MeldiqMongo,
    private readonly log: Pick<FastifyBaseLogger, "error">,
  ) {
    this.attachments = mongo.db.collection<AttachmentDoc>("attachments");
    this.uploads = mongo.db.collection<UploadDoc>("attachment_uploads");
    this.abandoned = mongo.db.collection<AbandonedDoc>("abandoned_uploads");
    this.blobDeletes = mongo.db.collection<BlobDeleteDoc>("pending_blob_deletes");
  }

  async attachment(id: string): Promise<AttachmentRow | null> {
    const d = await this.attachments.findOne({ _id: id }, { session: this.mongo.session() });
    return d ? strip(d) : null;
  }

  async attachmentRows(ids: readonly string[]): Promise<AttachmentRow[]> {
    if (!ids.length) return [];
    return (await this.attachments.find({ _id: { $in: [...ids] } }, { session: this.mongo.session() }).toArray()).map(strip);
  }

  async recordAttachment(r: Omit<AttachmentRow, "kept">): Promise<void> {
    await this.attachments.insertOne({ _id: r.id, ...r, kept: 0 }, { session: this.mongo.session() });
  }

  async keep(id: string, expiresAt: number): Promise<void> {
    await this.attachments.updateOne({ _id: id }, { $set: { kept: 1, expires_at: expiresAt, pending_message_until: null } });
  }

  async publish(id: string, messageId: string, expiresAt?: number): Promise<void> {
    await this.attachments.updateOne({ _id: id }, [{ $set: { message_id: { $ifNull: ["$message_id", messageId] }, pending_message_until: null, ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}) } }]);
  }

  async storedUsage(f: UsageFilter): Promise<Usage> {
    const q = match(f, "uploader_user_id") as Filter<AttachmentDoc>;
    if (f.kept !== undefined) Object.assign(q, { kept: f.kept ? 1 : 0 });
    return sum(this.attachments, q);
  }

  async pendingUsage(f: Omit<UsageFilter, "kept">): Promise<Usage> {
    return sum(this.uploads, match(f, "user_id") as Filter<UploadDoc>);
  }

  async attachmentIdsIn(conversationIds: readonly string[]): Promise<string[]> {
    if (conversationIds.length === 0) return [];
    const docs = await this.attachments.find({ conversation_id: { $in: [...conversationIds] } }, { projection: { _id: 1 } }).toArray();
    return docs.map((d) => d._id);
  }

  async upload(id: string): Promise<UploadRow | null> {
    const d = await this.uploads.findOne({ _id: id });
    return d ? strip(d) : null;
  }

  async startUpload(u: UploadRow): Promise<void> {
    await this.uploads.insertOne({ _id: u.id, ...u });
  }

  async setMultipart(id: string, multipartId: string): Promise<void> {
    await this.uploads.updateOne({ _id: id }, { $set: { multipart_id: multipartId } });
  }

  async abandonUpload(u: Pick<UploadRow, "id" | "multipart_id">): Promise<void> {
    await this.mongo.transaction(async () => {
      const session = this.mongo.session();
      await this.uploads.deleteOne({ _id: u.id }, { session });
      await this.abandon([u], session);
    });
  }

  async dropUpload(id: string): Promise<void> {
    await this.uploads.deleteOne({ _id: id });
  }

  async completeUpload(id: string, a: Omit<AttachmentRow, "kept">): Promise<boolean> {
    return this.mongo.transaction(async () => {
      const session = this.mongo.session();
      const gone = await this.uploads.deleteOne({ _id: id }, { session });
      if (gone.deletedCount === 0) return false;
      await this.attachments.insertOne({ _id: a.id, ...a, kept: 0 }, { session });
      return true;
    });
  }

  async keepAllForever(now: number): Promise<number> {
    return (await this.attachments.updateMany({ expires_at: { $gt: now, $lt: KEPT_FOREVER }, pending_message_until: null }, { $set: { expires_at: KEPT_FOREVER } })).modifiedCount;
  }

  async purgeExpired(now: number): Promise<string[]> {
    const ids = (await this.attachments.find({ expires_at: { $lte: now } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    if (ids.length === 0) return [];
    // Bytes first, then the records: a crash in between leaves records that the next run deletes again.
    await this.queueBlobDeletes(ids.map((id) => ({ kind: "attachments" as const, id })));
    await this.attachments.deleteMany({ _id: { $in: ids }, expires_at: { $lte: now } });
    return ids;
  }

  async expireUploads(now: number): Promise<number> {
    const rows = await this.uploads.find({ expires_at: { $lte: now } }, { projection: { _id: 1, multipart_id: 1 } }).toArray();
    if (rows.length === 0) return 0;
    await this.abandon(rows.map((r) => ({ id: r._id, multipart_id: r.multipart_id })));
    await this.uploads.deleteMany({ _id: { $in: rows.map((r) => r._id) }, expires_at: { $lte: now } });
    return rows.length;
  }

  async dueAbandoned(now: number, limit: number): Promise<Abandoned[]> {
    const docs = await this.abandoned.find({ next_at: { $lte: now } }).limit(limit).toArray();
    return docs.map((d) => ({ id: d._id, multipart_id: d.multipart_id, attempts: d.attempts }));
  }

  async abandonedDone(id: string): Promise<void> {
    await this.abandoned.deleteOne({ _id: id });
  }

  async abandonedRetry(id: string, attempts: number, nextAt: number): Promise<void> {
    await this.abandoned.updateOne({ _id: id }, { $set: { attempts, next_at: nextAt } });
  }

  queueBlobDelete(kind: BlobKind, id: string): void {
    this.later("queue a blob deletion", () => this.queueBlobDeletes([{ kind, id }]));
  }

  async dueBlobDeletes(now: number, limit: number): Promise<PendingBlobDelete[]> {
    const docs = await this.blobDeletes.find({ next_at: { $lte: now } }).limit(limit).toArray();
    return docs.map((d) => ({ kind: d.kind, blob_id: d.blob_id, attempts: d.attempts }));
  }

  async blobDeleteDone(kind: BlobKind, id: string): Promise<void> {
    await this.blobDeletes.deleteOne({ _id: { kind, blob_id: id } });
  }

  async blobDeleteRetry(kind: BlobKind, id: string, attempts: number, nextAt: number): Promise<void> {
    await this.blobDeletes.updateOne({ _id: { kind, blob_id: id } }, { $set: { attempts, next_at: nextAt } });
  }

  async knows(id: string): Promise<boolean> {
    const [a, u] = await Promise.all([this.attachments.findOne({ _id: id }, { projection: { _id: 1 } }), this.uploads.findOne({ _id: id }, { projection: { _id: 1 } })]);
    return a !== null || u !== null;
  }

  forgetConversation(conversationId: string): void {
    this.later("forget a conversation's files", async () => {
      const ids = (await this.attachments.find({ conversation_id: conversationId }, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
      await this.queueBlobDeletes(ids.map((id) => ({ kind: "attachments" as const, id })));
      const open = await this.uploads.find({ conversation_id: conversationId }, { projection: { _id: 1, multipart_id: 1 } }).toArray();
      await this.abandon(open.map((r) => ({ id: r._id, multipart_id: r.multipart_id })));
      await Promise.all([this.uploads.deleteMany({ conversation_id: conversationId }), this.attachments.deleteMany({ conversation_id: conversationId })]);
    });
  }

  forgetUploader(userId: string): void {
    this.later("forget an account's uploads", async () => {
      const open = await this.uploads.find({ user_id: userId }, { projection: { _id: 1, multipart_id: 1 } }).toArray();
      await this.abandon(open.map((r) => ({ id: r._id, multipart_id: r.multipart_id })));
      await this.uploads.deleteMany({ user_id: userId });
    });
  }

  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Cascades run right after the caller's synchronous step (usually a SQLite transaction). Failures are logged. */
  private later(what: string, op: () => Promise<unknown>): void {
    const run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(op)
      .catch((err) => this.log.error({ err }, `files: ${what} failed`))
      .finally(() => this.pending.delete(run));
    this.pending.add(run);
  }

  /** Like INSERT OR IGNORE: an id already scheduled keeps its attempts and time. */
  private async abandon(rows: Pick<UploadRow, "id" | "multipart_id">[], session = this.mongo.session()): Promise<void> {
    if (rows.length === 0) return;
    await this.abandoned.bulkWrite(
      rows.map((r) => ({
        updateOne: {
          filter: { _id: r.id },
          update: { $setOnInsert: { id: r.id, multipart_id: r.multipart_id, attempts: 0, next_at: 0 } },
          upsert: true,
        },
      })),
      { ordered: false, session },
    );
  }

  private async queueBlobDeletes(items: { kind: BlobKind; id: string }[]): Promise<void> {
    if (items.length === 0) return;
    try {
      await this.blobDeletes.bulkWrite(
        items.map((i) => ({
          updateOne: {
            filter: { _id: { kind: i.kind, blob_id: i.id } },
            update: { $setOnInsert: { kind: i.kind, blob_id: i.id, attempts: 0, next_at: 0 } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    } catch (e) {
      // Two runs upserting the same new id at once: one wins, which is all that's needed.
      if (!isDuplicateKey(e)) throw e;
    }
  }
}

/** The filter of a usage query; [userField] is the uploader's field in the collection. */
function match(f: Omit<UsageFilter, "kept">, userField: string): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (f.uploaders) q[userField] = { $in: [...f.uploaders] };
  if (f.conversations) q.conversation_id = { $in: [...f.conversations] };
  if (f.createdAfter !== undefined) q.created_at = { $gt: f.createdAfter };
  if (f.liveAt !== undefined) q.expires_at = { $gt: f.liveAt };
  return q;
}

async function sum<T extends { size: number }>(c: Collection<T>, q: Filter<T>): Promise<Usage> {
  const [r] = await c.aggregate<Usage>([{ $match: q }, { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: "$size" } } }]).toArray();
  return { count: r?.count ?? 0, bytes: r?.bytes ?? 0 };
}

function strip<T extends { _id: unknown }>(d: T): Omit<T, "_id"> {
  const { _id: _drop, ...row } = d;
  return row;
}
