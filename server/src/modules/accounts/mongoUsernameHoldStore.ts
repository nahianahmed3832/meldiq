import type { Collection } from "mongodb";
import type { MeldiqMongo } from "../../infrastructure/database/mongo/client.js";
import type { UsernameHold, UsernameHoldStore } from "./usernameHoldStore.js";

/** The username_holds collection: one document per held name, keyed by the name. */
interface HoldDoc {
  _id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

/**
 * Username holds in MongoDB (API 0.65.0). New data, so no domain migration. Expired holds are removed at start-up, not
 * by a TTL index, because times are epoch milliseconds like everywhere else (docs/MONGODB.md §3); an expired one left
 * behind holds nothing (every read checks the time).
 */
export class MongoUsernameHoldStore implements UsernameHoldStore {
  readonly backend = "mongodb" as const;
  private readonly col: Collection<HoldDoc>;

  constructor(mongo: MeldiqMongo) {
    this.col = mongo.db.collection<HoldDoc>("username_holds");
  }

  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ expires_at: 1 }, { name: "expires_at" });
    await this.col.createIndex({ user_id: 1 }, { name: "user_id" });
  }

  async live(at: number): Promise<UsernameHold[]> {
    const docs = await this.col.find({ expires_at: { $gt: at } }).toArray();
    return docs.map((d) => ({ username: d._id, userId: d.user_id, createdAt: d.created_at, expiresAt: d.expires_at }));
  }

  async put(h: UsernameHold): Promise<void> {
    await this.col.replaceOne({ _id: h.username }, { user_id: h.userId, created_at: h.createdAt, expires_at: h.expiresAt }, { upsert: true });
  }

  async remove(username: string): Promise<void> {
    await this.col.deleteOne({ _id: username });
  }

  async removeExpired(at: number): Promise<void> {
    await this.col.deleteMany({ expires_at: { $lte: at } });
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.col.deleteMany({ user_id: userId });
  }
}
