import type { Collection } from "mongodb";
import type { MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";
import type { DecorationStatus } from "../../../shared/contracts/http/decorations.js";
import type { DecorationPage, DecorationStore, StoredDecoration } from "./store.js";

/** The profile_decorations collection: one document per submission, keyed by its id. */
interface DecorationDoc {
  _id: string;
  creator_id: string;
  name: string;
  status: DecorationStatus;
  format: StoredDecoration["format"];
  animated: boolean;
  size: number;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  reason: string | null;
  wearers: number;
}

const toDoc = (d: StoredDecoration): DecorationDoc => ({
  _id: d.id,
  creator_id: d.creatorId,
  name: d.name,
  status: d.status,
  format: d.format,
  animated: d.animated,
  size: d.size,
  created_at: d.createdAt,
  reviewed_at: d.reviewedAt,
  reviewed_by: d.reviewedBy,
  reason: d.reason,
  wearers: d.wearers,
});

const fromDoc = (d: DecorationDoc): StoredDecoration => ({
  id: d._id,
  creatorId: d.creator_id,
  name: d.name,
  status: d.status,
  format: d.format,
  animated: d.animated,
  size: d.size,
  createdAt: d.created_at,
  reviewedAt: d.reviewed_at,
  reviewedBy: d.reviewed_by,
  reason: d.reason,
  wearers: d.wearers,
});

/**
 * Submitted decorations in MongoDB (API 0.60.0). New data, so it never lived in SQLite and needs no domain migration;
 * every write is one single-document operation. Times are epoch milliseconds like everywhere else (docs/MONGODB.md §3).
 */
export class MongoDecorationStore implements DecorationStore {
  readonly backend = "mongodb" as const;
  private readonly col: Collection<DecorationDoc>;

  constructor(mongo: MeldiqMongo) {
    this.col = mongo.db.collection<DecorationDoc>("profile_decorations");
  }

  /** The indexes the review queue, the catalog and "mine" use (idempotent). */
  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ status: 1, created_at: -1 }, { name: "status_created" });
    await this.col.createIndex({ creator_id: 1, created_at: -1 }, { name: "creator_created" });
  }

  async insert(d: StoredDecoration): Promise<void> {
    await this.col.insertOne(toDoc(d));
  }

  async get(id: string): Promise<StoredDecoration | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? fromDoc(d) : null;
  }

  async approved(): Promise<StoredDecoration[]> {
    return (await this.col.find({ status: "approved" }).sort({ created_at: -1 }).toArray()).map(fromDoc);
  }

  async byCreator(creatorId: string): Promise<StoredDecoration[]> {
    return (await this.col.find({ creator_id: creatorId }).sort({ created_at: -1 }).toArray()).map(fromDoc);
  }

  async countPending(creatorId: string): Promise<number> {
    return this.col.countDocuments({ creator_id: creatorId, status: "pending" });
  }

  async page(status: DecorationStatus, before: number | null, limit: number): Promise<DecorationPage> {
    const docs = await this.col
      .find({ status, ...(before == null ? {} : { created_at: { $lt: before } }) })
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .toArray();
    const items = docs.slice(0, limit).map(fromDoc);
    return { items, next: docs.length > limit ? items[items.length - 1].createdAt : null };
  }

  async review(id: string, from: readonly DecorationStatus[], change: Pick<StoredDecoration, "status" | "reviewedAt" | "reviewedBy" | "reason">): Promise<boolean> {
    const r = await this.col.updateOne(
      { _id: id, status: { $in: [...from] } },
      { $set: { status: change.status, reviewed_at: change.reviewedAt, reviewed_by: change.reviewedBy, reason: change.reason } },
    );
    return r.modifiedCount === 1;
  }

  async remove(id: string): Promise<void> {
    await this.col.deleteOne({ _id: id });
  }

  async addWearers(id: string, by: number): Promise<void> {
    // An update pipeline, so a stale count can't go below zero.
    await this.col.updateOne({ _id: id }, [{ $set: { wearers: { $max: [0, { $add: ["$wearers", by] }] } } }]);
  }

  async setWearers(id: string, count: number): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: { wearers: count } });
  }
}
