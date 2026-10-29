import type { Collection } from "mongodb";
import { isDuplicateKey, type MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";
import type { FavoriteStore } from "./favoritesStore.js";

/** The decoration_favorites collection: one document per person and decoration ("<userId>|<decorationId>"). */
interface FavoriteDoc {
  _id: string;
  user_id: string;
  decoration_id: string;
  created_at: number;
}

const key = (userId: string, decorationId: string) => `${userId}|${decorationId}`;

/** Decoration favourites in MongoDB (API 0.65.0). New data, so no domain migration; each write touches one document. */
export class MongoFavoriteStore implements FavoriteStore {
  readonly backend = "mongodb" as const;
  private readonly col: Collection<FavoriteDoc>;

  constructor(mongo: MeldiqMongo) {
    this.col = mongo.db.collection<FavoriteDoc>("decoration_favorites");
  }

  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ user_id: 1, created_at: -1 }, { name: "user_created" });
  }

  async list(userId: string): Promise<string[]> {
    return (await this.col.find({ user_id: userId }).sort({ created_at: -1 }).toArray()).map((d) => d.decoration_id);
  }

  async count(userId: string): Promise<number> {
    return this.col.countDocuments({ user_id: userId });
  }

  async add(userId: string, decorationId: string, at: number): Promise<boolean> {
    try {
      await this.col.insertOne({ _id: key(userId, decorationId), user_id: userId, decoration_id: decorationId, created_at: at });
      return true;
    } catch (e) {
      if (isDuplicateKey(e)) return false;
      throw e;
    }
  }

  async remove(userId: string, decorationId: string): Promise<void> {
    await this.col.deleteOne({ _id: key(userId, decorationId) });
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.col.deleteMany({ user_id: userId });
  }
}
