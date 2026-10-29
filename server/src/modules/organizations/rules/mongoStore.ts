import type { Collection } from "mongodb";
import type { MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";
import type { RulesStore, StoredAgreement, StoredRule, StoredRules } from "./store.js";

/** One document per community, keyed by its id. */
interface RulesDoc {
  _id: string;
  channel_id: string | null;
  required: boolean;
  rules: StoredRule[];
  updated_at: number;
  updated_by: string;
}

/** One document per member who agreed, keyed "<orgId>|<userId>" so agreeing twice is one document. */
interface AgreementDoc {
  _id: string;
  org_id: string;
  user_id: string;
  agreed_at: number;
}

const rulesFrom = (d: RulesDoc): StoredRules => ({
  orgId: d._id,
  channelId: d.channel_id,
  required: d.required,
  rules: d.rules.map((r) => ({ id: r.id, title: r.title, description: r.description ?? null })),
  updatedAt: d.updated_at,
  updatedBy: d.updated_by,
});

const agreementFrom = (d: AgreementDoc): StoredAgreement => ({ orgId: d.org_id, userId: d.user_id, agreedAt: d.agreed_at });

/** Community rules in MongoDB (API 0.65.0). New data, so no domain migration; each write touches one or a few documents. */
export class MongoRulesStore implements RulesStore {
  readonly backend = "mongodb" as const;
  private readonly rulesCol: Collection<RulesDoc>;
  private readonly agreeCol: Collection<AgreementDoc>;

  constructor(mongo: MeldiqMongo) {
    this.rulesCol = mongo.db.collection<RulesDoc>("community_rules");
    this.agreeCol = mongo.db.collection<AgreementDoc>("community_rule_agreements");
  }

  /** Idempotent. */
  async ensureIndexes(): Promise<void> {
    await this.agreeCol.createIndex({ org_id: 1 }, { name: "org" });
    await this.agreeCol.createIndex({ user_id: 1 }, { name: "user" });
  }

  async all(): Promise<StoredRules[]> {
    return (await this.rulesCol.find({}).toArray()).map(rulesFrom);
  }

  async agreements(): Promise<StoredAgreement[]> {
    return (await this.agreeCol.find({}).toArray()).map(agreementFrom);
  }

  async put(r: StoredRules): Promise<void> {
    const doc: Omit<RulesDoc, "_id"> = { channel_id: r.channelId, required: r.required, rules: r.rules, updated_at: r.updatedAt, updated_by: r.updatedBy };
    await this.rulesCol.replaceOne({ _id: r.orgId }, doc, { upsert: true });
  }

  async removeOrg(orgId: string): Promise<void> {
    await this.rulesCol.deleteOne({ _id: orgId });
    await this.agreeCol.deleteMany({ org_id: orgId });
  }

  async agree(a: StoredAgreement): Promise<boolean> {
    const r = await this.agreeCol.updateOne({ _id: `${a.orgId}|${a.userId}` }, { $setOnInsert: { org_id: a.orgId, user_id: a.userId, agreed_at: a.agreedAt } }, { upsert: true });
    return r.upsertedCount > 0;
  }

  async forget(orgId: string, userId: string): Promise<void> {
    await this.agreeCol.deleteOne({ _id: `${orgId}|${userId}` });
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.agreeCol.deleteMany({ user_id: userId });
  }
}
