import type { Collection } from "mongodb";
import type { MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";
import type { ActivityWire } from "../../../shared/contracts/realtime.js";
import type { ActivityStore, StoredActivity } from "./store.js";

/** The user_activities collection: one document per person, keyed by their user id. */
interface ActivityDoc {
  _id: string;
  activity: ActivityWire;
  updated_at: number;
  expires_at: number;
}

/**
 * Activities in MongoDB (API 0.56.0). New data, so it never lived in SQLite and needs no domain migration: every write
 * is one single-document upsert or delete. Lapsed documents are removed by ActivityService's sweep, not a TTL index,
 * because times are epoch milliseconds like everywhere else (docs/MONGODB.md §3).
 */
export class MongoActivityStore implements ActivityStore {
  readonly backend = "mongodb" as const;
  private readonly col: Collection<ActivityDoc>;

  constructor(mongo: MeldiqMongo) {
    this.col = mongo.db.collection<ActivityDoc>("user_activities");
  }

  /** Creates the index the sweep and the start-up load use (idempotent). */
  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ expires_at: 1 }, { name: "expires_at" });
  }

  async live(at: number): Promise<StoredActivity[]> {
    const docs = await this.col.find({ expires_at: { $gt: at } }).toArray();
    return docs.map((d) => ({ userId: d._id, activity: d.activity, updatedAt: d.updated_at, expiresAt: d.expires_at }));
  }

  async put(e: StoredActivity): Promise<void> {
    await this.col.replaceOne({ _id: e.userId }, { activity: e.activity, updated_at: e.updatedAt, expires_at: e.expiresAt }, { upsert: true });
  }

  async remove(userId: string): Promise<void> {
    await this.col.deleteOne({ _id: userId });
  }

  async removeLapsed(at: number): Promise<void> {
    await this.col.deleteMany({ expires_at: { $lte: at } });
  }
}
