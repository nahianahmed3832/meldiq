import type { Collection } from "mongodb";
import type { MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";
import type { GroupAddPolicy } from "../../../shared/contracts/http/relationships.js";
import type { PrivacyChoices, PrivacyStore } from "./privacyStore.js";

/** The privacy_settings collection: one document per person who chose, keyed by their user id. */
interface PrivacyDoc {
  _id: string;
  group_add_policy: GroupAddPolicy;
  suggestable: boolean;
  updated_at: number;
}

const fromDoc = (d: PrivacyDoc): PrivacyChoices => ({ groupAddPolicy: d.group_add_policy, suggestable: d.suggestable });

/** Privacy choices in MongoDB (API 0.65.0). New data, so no domain migration; every write is one single-document upsert. */
export class MongoPrivacyStore implements PrivacyStore {
  readonly backend = "mongodb" as const;
  private readonly col: Collection<PrivacyDoc>;

  constructor(mongo: MeldiqMongo) {
    this.col = mongo.db.collection<PrivacyDoc>("privacy_settings");
  }

  async get(userId: string): Promise<PrivacyChoices | null> {
    const d = await this.col.findOne({ _id: userId });
    return d ? fromDoc(d) : null;
  }

  async many(userIds: readonly string[]): Promise<Map<string, PrivacyChoices>> {
    if (!userIds.length) return new Map();
    const docs = await this.col.find({ _id: { $in: [...userIds] } }).toArray();
    return new Map(docs.map((d) => [d._id, fromDoc(d)]));
  }

  async put(userId: string, c: PrivacyChoices, at: number): Promise<void> {
    await this.col.replaceOne({ _id: userId }, { group_add_policy: c.groupAddPolicy, suggestable: c.suggestable, updated_at: at }, { upsert: true });
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.col.deleteOne({ _id: userId });
  }
}
