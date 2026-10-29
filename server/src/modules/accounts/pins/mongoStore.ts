import type { Collection } from "mongodb";
import type { MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";
import type { PinStore, StoredAward, StoredPin } from "./store.js";

interface PinDoc {
  _id: string;
  org_id: string;
  name: string;
  description: string | null;
  format: StoredPin["format"];
  animated: boolean;
  created_by: string;
  created_at: number;
}

/** One document per award, keyed "<pinId>:<userId>" so giving it twice is one document. */
interface AwardDoc {
  _id: string;
  pin_id: string;
  org_id: string;
  user_id: string;
  awarded_by: string;
  awarded_at: number;
}

const pinFrom = (d: PinDoc): StoredPin => ({
  id: d._id,
  orgId: d.org_id,
  name: d.name,
  description: d.description,
  format: d.format,
  animated: d.animated,
  createdBy: d.created_by,
  createdAt: d.created_at,
});

const awardFrom = (d: AwardDoc): StoredAward => ({ pinId: d.pin_id, orgId: d.org_id, userId: d.user_id, awardedBy: d.awarded_by, awardedAt: d.awarded_at });

/**
 * Community pins in MongoDB (API 0.64.0). New data, so it never lived in SQLite and needs no domain migration. Times
 * are epoch milliseconds like everywhere else (docs/MONGODB.md §3).
 */
export class MongoPinStore implements PinStore {
  readonly backend = "mongodb" as const;
  private readonly pinCol: Collection<PinDoc>;
  private readonly awardCol: Collection<AwardDoc>;

  constructor(mongo: MeldiqMongo) {
    this.pinCol = mongo.db.collection<PinDoc>("community_pins");
    this.awardCol = mongo.db.collection<AwardDoc>("community_pin_awards");
  }

  /** Idempotent. */
  async ensureIndexes(): Promise<void> {
    await this.pinCol.createIndex({ org_id: 1, created_at: -1 }, { name: "org_created" });
    await this.awardCol.createIndex({ pin_id: 1 }, { name: "pin" });
    await this.awardCol.createIndex({ user_id: 1 }, { name: "user" });
  }

  async pins(): Promise<StoredPin[]> {
    return (await this.pinCol.find({}).toArray()).map(pinFrom);
  }

  async awards(): Promise<StoredAward[]> {
    return (await this.awardCol.find({}).toArray()).map(awardFrom);
  }

  async insertPin(p: StoredPin): Promise<void> {
    await this.pinCol.insertOne({
      _id: p.id,
      org_id: p.orgId,
      name: p.name,
      description: p.description,
      format: p.format,
      animated: p.animated,
      created_by: p.createdBy,
      created_at: p.createdAt,
    });
  }

  async removePin(id: string): Promise<void> {
    await this.pinCol.deleteOne({ _id: id });
    await this.awardCol.deleteMany({ pin_id: id });
  }

  async award(a: StoredAward): Promise<boolean> {
    const r = await this.awardCol.updateOne(
      { _id: `${a.pinId}:${a.userId}` },
      { $setOnInsert: { pin_id: a.pinId, org_id: a.orgId, user_id: a.userId, awarded_by: a.awardedBy, awarded_at: a.awardedAt } },
      { upsert: true },
    );
    return r.upsertedCount > 0;
  }

  async revoke(pinId: string, userId: string): Promise<boolean> {
    return (await this.awardCol.deleteOne({ _id: `${pinId}:${userId}` })).deletedCount > 0;
  }
}
