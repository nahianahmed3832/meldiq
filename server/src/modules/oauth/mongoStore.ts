import type { Collection } from "mongodb";
import type { MeldiqMongo } from "../../infrastructure/database/mongo/client.js";
import type { OAuthScope } from "../../shared/contracts/http/oauthApps.js";
import type { AuthCode, Grant, OAuthApp, OAuthStore, Rotation, TokenFamily } from "./store.js";

/** oauth_apps: one document per app, keyed by its client_id. */
interface AppDoc {
  _id: string;
  owner_id: string;
  name: string;
  redirect_uris: string[];
  secret_hash: string;
  created_at: number;
  updated_at: number;
  secret_rotated_at: number;
}

/** oauth_codes: authorization codes, keyed by their SHA-256. */
interface CodeDoc {
  _id: string;
  app_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: OAuthScope[];
  challenge: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  family_id: string | null;
}

/** oauth_grants: one document per person and app ("<appId>|<userId>"). */
interface GrantDoc {
  _id: string;
  app_id: string;
  user_id: string;
  scopes: OAuthScope[];
  created_at: number;
  updated_at: number;
}

/** oauth_tokens: one document per token family (one code exchange and its refreshes). */
interface FamilyDoc {
  _id: string;
  app_id: string;
  user_id: string;
  scopes: OAuthScope[];
  confidential: boolean;
  access_hash: string;
  access_expires_at: number;
  refresh_hash: string;
  previous_refresh_hash: string | null;
  refresh_expires_at: number;
  created_at: number;
  rotated_at: number;
}

const fromApp = (d: AppDoc): OAuthApp => ({
  id: d._id,
  ownerId: d.owner_id,
  name: d.name,
  redirectUris: d.redirect_uris,
  secretHash: d.secret_hash,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
  secretRotatedAt: d.secret_rotated_at,
});
const fromCode = (d: CodeDoc): AuthCode => ({
  hash: d._id,
  appId: d.app_id,
  userId: d.user_id,
  redirectUri: d.redirect_uri,
  scopes: d.scopes,
  challenge: d.challenge,
  createdAt: d.created_at,
  expiresAt: d.expires_at,
  usedAt: d.used_at,
  familyId: d.family_id,
});
const fromGrant = (d: GrantDoc): Grant => ({ appId: d.app_id, userId: d.user_id, scopes: d.scopes, createdAt: d.created_at, updatedAt: d.updated_at });
const fromFamily = (d: FamilyDoc): TokenFamily => ({
  id: d._id,
  appId: d.app_id,
  userId: d.user_id,
  scopes: d.scopes,
  confidential: d.confidential,
  accessHash: d.access_hash,
  accessExpiresAt: d.access_expires_at,
  refreshHash: d.refresh_hash,
  previousRefreshHash: d.previous_refresh_hash,
  refreshExpiresAt: d.refresh_expires_at,
  createdAt: d.created_at,
  rotatedAt: d.rotated_at,
});
const APP_FIELDS = { name: "name", redirectUris: "redirect_uris", secretHash: "secret_hash", secretRotatedAt: "secret_rotated_at" } as const;

/**
 * "Log in with Meldiq" in MongoDB (API 0.65.0). New data, so no domain migration and no validators (production's
 * readWrite user never needs collMod). Times are epoch milliseconds (docs/MONGODB.md §3).
 */
export class MongoOAuthStore implements OAuthStore {
  readonly backend = "mongodb" as const;
  private readonly apps: Collection<AppDoc>;
  private readonly codes: Collection<CodeDoc>;
  private readonly grants: Collection<GrantDoc>;
  private readonly families: Collection<FamilyDoc>;

  constructor(mongo: MeldiqMongo) {
    this.apps = mongo.db.collection<AppDoc>("oauth_apps");
    this.codes = mongo.db.collection<CodeDoc>("oauth_codes");
    this.grants = mongo.db.collection<GrantDoc>("oauth_grants");
    this.families = mongo.db.collection<FamilyDoc>("oauth_tokens");
  }

  async ensureIndexes(): Promise<void> {
    await this.apps.createIndex({ owner_id: 1, created_at: 1 }, { name: "owner_created" });
    await this.codes.createIndex({ app_id: 1, user_id: 1 }, { name: "app_user" });
    await this.codes.createIndex({ expires_at: 1 }, { name: "expires_at" });
    await this.grants.createIndex({ user_id: 1, updated_at: -1 }, { name: "user_updated" });
    await this.grants.createIndex({ app_id: 1 }, { name: "app_id" });
    await this.families.createIndex({ access_hash: 1 }, { name: "access_hash", unique: true });
    await this.families.createIndex({ app_id: 1, user_id: 1 }, { name: "app_user" });
    await this.families.createIndex({ user_id: 1 }, { name: "user_id" });
    await this.families.createIndex({ refresh_expires_at: 1 }, { name: "refresh_expires_at" });
  }

  async appsOf(ownerId: string): Promise<OAuthApp[]> {
    return (await this.apps.find({ owner_id: ownerId }).sort({ created_at: 1 }).toArray()).map(fromApp);
  }

  async app(id: string): Promise<OAuthApp | null> {
    const d = await this.apps.findOne({ _id: id });
    return d ? fromApp(d) : null;
  }

  async appsByIds(ids: readonly string[]): Promise<OAuthApp[]> {
    if (!ids.length) return [];
    return (await this.apps.find({ _id: { $in: [...ids] } }).toArray()).map(fromApp);
  }

  async insertApp(a: OAuthApp): Promise<void> {
    await this.apps.insertOne({
      _id: a.id,
      owner_id: a.ownerId,
      name: a.name,
      redirect_uris: a.redirectUris,
      secret_hash: a.secretHash,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      secret_rotated_at: a.secretRotatedAt,
    });
  }

  async updateApp(id: string, ownerId: string, patch: Partial<Pick<OAuthApp, "name" | "redirectUris" | "secretHash" | "secretRotatedAt">>, at: number): Promise<OAuthApp | null> {
    const set: Record<string, unknown> = { updated_at: at };
    for (const [k, field] of Object.entries(APP_FIELDS)) {
      const v = patch[k as keyof typeof APP_FIELDS];
      if (v !== undefined) set[field] = v;
    }
    const d = await this.apps.findOneAndUpdate({ _id: id, owner_id: ownerId }, { $set: set }, { returnDocument: "after" });
    return d ? fromApp(d) : null;
  }

  async deleteApp(id: string): Promise<void> {
    await this.codes.deleteMany({ app_id: id });
    await this.grants.deleteMany({ app_id: id });
    await this.families.deleteMany({ app_id: id });
    await this.apps.deleteOne({ _id: id });
  }

  async insertCode(c: AuthCode): Promise<void> {
    await this.codes.insertOne({
      _id: c.hash,
      app_id: c.appId,
      user_id: c.userId,
      redirect_uri: c.redirectUri,
      scopes: c.scopes,
      challenge: c.challenge,
      created_at: c.createdAt,
      expires_at: c.expiresAt,
      used_at: c.usedAt,
      family_id: c.familyId,
    });
  }

  async takeCode(hash: string, at: number): Promise<AuthCode | null> {
    const taken = await this.codes.findOneAndUpdate({ _id: hash, used_at: null }, { $set: { used_at: at } }, { returnDocument: "before" });
    if (taken) return fromCode(taken);
    const used = await this.codes.findOne({ _id: hash });
    return used ? fromCode(used) : null;
  }

  async setCodeFamily(hash: string, familyId: string): Promise<void> {
    await this.codes.updateOne({ _id: hash }, { $set: { family_id: familyId } });
  }

  async upsertGrant(appId: string, userId: string, scopes: readonly OAuthScope[], at: number): Promise<Grant> {
    const d = await this.grants.findOneAndUpdate(
      { _id: `${appId}|${userId}` },
      { $addToSet: { scopes: { $each: [...scopes] } }, $set: { updated_at: at }, $setOnInsert: { app_id: appId, user_id: userId, created_at: at } },
      { upsert: true, returnDocument: "after" },
    );
    return fromGrant(d!);
  }

  async grant(appId: string, userId: string): Promise<Grant | null> {
    const d = await this.grants.findOne({ _id: `${appId}|${userId}` });
    return d ? fromGrant(d) : null;
  }

  async grantsOf(userId: string): Promise<Grant[]> {
    return (await this.grants.find({ user_id: userId }).sort({ updated_at: -1 }).toArray()).map(fromGrant);
  }

  async revokeGrant(appId: string, userId: string): Promise<boolean> {
    const r = await this.grants.deleteOne({ _id: `${appId}|${userId}` });
    await this.codes.deleteMany({ app_id: appId, user_id: userId });
    await this.families.deleteMany({ app_id: appId, user_id: userId });
    return r.deletedCount > 0;
  }

  async insertFamily(f: TokenFamily): Promise<void> {
    await this.families.insertOne({
      _id: f.id,
      app_id: f.appId,
      user_id: f.userId,
      scopes: f.scopes,
      confidential: f.confidential,
      access_hash: f.accessHash,
      access_expires_at: f.accessExpiresAt,
      refresh_hash: f.refreshHash,
      previous_refresh_hash: f.previousRefreshHash,
      refresh_expires_at: f.refreshExpiresAt,
      created_at: f.createdAt,
      rotated_at: f.rotatedAt,
    });
  }

  async family(id: string): Promise<TokenFamily | null> {
    const d = await this.families.findOne({ _id: id });
    return d ? fromFamily(d) : null;
  }

  async familyByAccess(accessHash: string): Promise<TokenFamily | null> {
    const d = await this.families.findOne({ access_hash: accessHash });
    return d ? fromFamily(d) : null;
  }

  async rotateFamily(id: string, expected: string, n: Rotation): Promise<boolean> {
    const r = await this.families.updateOne(
      { _id: id, refresh_hash: expected },
      {
        $set: {
          access_hash: n.accessHash,
          access_expires_at: n.accessExpiresAt,
          refresh_hash: n.refreshHash,
          previous_refresh_hash: expected,
          refresh_expires_at: n.refreshExpiresAt,
          scopes: n.scopes,
          rotated_at: n.at,
        },
      },
    );
    return r.modifiedCount === 1;
  }

  async deleteFamily(id: string): Promise<void> {
    await this.families.deleteOne({ _id: id });
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const a of await this.appsOf(userId)) await this.deleteApp(a.id);
    await this.codes.deleteMany({ user_id: userId });
    await this.grants.deleteMany({ user_id: userId });
    await this.families.deleteMany({ user_id: userId });
  }

  async purgeExpired(at: number): Promise<number> {
    const codes = await this.codes.deleteMany({ expires_at: { $lte: at } });
    const families = await this.families.deleteMany({ refresh_expires_at: { $lte: at } });
    return codes.deletedCount + families.deletedCount;
  }
}
