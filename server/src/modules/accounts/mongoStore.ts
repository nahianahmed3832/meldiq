import type { ClientSession, Collection, Document } from "mongodb";
import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import type {
  AccountPatch,
  AccountRow,
  AccountStore,
  ActiveSession,
  Admission,
  CodePurpose,
  CodeRow,
  SessionRotation,
  SessionRow,
  TicketRow,
} from "./store.js";
import { isDuplicateKey, type MeldiqMongo } from "../../infrastructure/database/mongo/client.js";

const userDisabledAt = (identity: Rows, id: string): number | null => identity.get<{ disabled_at: number | null }>("users", { id })?.disabled_at ?? null;
const deviceRevokedAt = (identity: Rows, id: string): number | null => identity.get<{ revoked_at: number | null }>("devices", { id })?.revoked_at ?? null;

type WithId<T, Id> = T & { _id: Id };
type AccountDoc = WithId<AccountRow, string>;
type SessionDoc = WithId<SessionRow, string>;
type CodeDoc = WithId<CodeRow, { account_id: string; purpose: CodePurpose }>;
type TicketDoc = WithId<TicketRow, string>;

/** Email lookups use the unique index's case-insensitive collation (the column is COLLATE NOCASE in SQLite). */
const EMAIL_COLLATION = { locale: "en", strength: 2 } as const;
/** Revoked or expired sessions are kept a day so a late refresh still gets "session ended" instead of a generic 401. */
const SESSION_GRACE_MS = 86_400_000;

const PATCHABLE: readonly (keyof AccountPatch)[] = [
  "name",
  "password_hash",
  "password_changed_at",
  "email_verified_at",
  "user_id",
  "legacy_linked_at",
  "selected_workspace_id",
  "admitted_via",
  // Suspension by a platform admin (the Platform Admin Console, 2026-10-23).
  "disabled_at",
];

function strip<T extends { _id: unknown }>(d: T | null): Omit<T, "_id"> | undefined {
  if (!d) return undefined;
  const { _id: _ignored, ...row } = d;
  return row;
}

/**
 * Orbit 2.0 accounts in MongoDB (MONGODB_DOMAINS includes "accounts", docs/MONGODB.md): the same rows as
 * src/accounts/store.ts's SQLite tables, in the collections of the same names. Needs a replica set (transactions).
 *
 * - Every check-and-write is one conditional single-document update (claims, rotations, code use), so concurrent
 *   requests can't both win, with or without a transaction around them.
 * - Steps that also write identity rows run that part as its own rows unit and undo whichever side went first
 *   when the other fails; a crash in between is repaired by the next attempt (identity.ts › enroll).
 * - Foreign keys SQLite enforced are kept by hand: deleting an account deletes its sessions and codes.
 */
export class MongoAccountStore implements AccountStore {
  readonly backend = "mongodb" as const;
  private readonly accounts: Collection<AccountDoc>;
  private readonly sessions: Collection<SessionDoc>;
  private readonly codes: Collection<CodeDoc>;
  private readonly tickets: Collection<TicketDoc>;

  constructor(
    private readonly mongo: MeldiqMongo,
    /** The identity domain's rows (users, devices, registration invites), in SQLite or MongoDB. */
    private readonly identity: Rows,
  ) {
    if (!mongo.supportsTransactions) throw new Error("Accounts in MongoDB need a replica set or Atlas cluster (transactions)");
    this.accounts = mongo.db.collection<AccountDoc>("accounts");
    this.sessions = mongo.db.collection<SessionDoc>("account_sessions");
    this.codes = mongo.db.collection<CodeDoc>("account_codes");
    this.tickets = mongo.db.collection<TicketDoc>("legacy_tickets");
  }

  /** Options carrying the surrounding transaction's session, if any. */
  private get o(): { session?: ClientSession } {
    const session = this.mongo.session();
    return session ? { session } : {};
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.mongo.transaction(fn);
  }

  async accountByEmail(email: string): Promise<AccountRow | undefined> {
    return strip(await this.accounts.findOne({ email }, { ...this.o, collation: EMAIL_COLLATION }));
  }

  async accountById(id: string): Promise<AccountRow | undefined> {
    return strip(await this.accounts.findOne({ _id: id }, this.o));
  }

  async accountByUserId(userId: string): Promise<AccountRow | undefined> {
    return strip(await this.accounts.findOne({ user_id: userId }, this.o));
  }

  async insertAccount(row: AccountRow): Promise<boolean> {
    try {
      await this.accounts.insertOne({ _id: row.id, ...row }, this.o);
      return true;
    } catch (e) {
      if (isDuplicateKey(e)) return false;
      throw e;
    }
  }

  async createAccount(row: AccountRow, admission: Admission | null): Promise<AccountRow | null> {
    const admittedVia = admission ? await this.identity.write(admission.take) : row.admitted_via;
    const r = { ...row, admitted_via: admittedVia };
    try {
      if (await this.insertAccount(r)) return r;
    } catch (e) {
      if (admission) await this.identity.write(admission.undo);
      throw e;
    }
    if (admission) await this.identity.write(admission.undo);
    return null;
  }

  async updateAccount(id: string, patch: AccountPatch, at: number): Promise<void> {
    const set: Document = { updated_at: at };
    for (const k of PATCHABLE) if (k in patch) set[k] = patch[k] ?? null;
    if (Object.keys(set).length === 1) return;
    await this.accounts.updateOne({ _id: id }, { $set: set }, this.o);
  }

  async updateEmail(id: string, email: string, at: number): Promise<void> {
    await this.accounts.updateOne({ _id: id, email_verified_at: null }, { $set: { email, updated_at: at } }, this.o);
  }

  async changeVerifiedEmail(id: string, email: string, at: number): Promise<boolean> {
    try {
      const res = await this.accounts.updateOne({ _id: id }, { $set: { email, email_verified_at: at, updated_at: at } }, this.o);
      return res.matchedCount === 1;
    } catch (e) {
      if (isDuplicateKey(e)) return false;
      throw e;
    }
  }

  async deleteUnverifiedAccount(id: string): Promise<boolean> {
    const res = await this.accounts.deleteOne({ _id: id, email_verified_at: null, user_id: null }, this.o);
    if (res.deletedCount !== 1) return false;
    // ON DELETE CASCADE in SQLite.
    await this.sessions.deleteMany({ account_id: id }, this.o);
    await this.codes.deleteMany({ account_id: id }, this.o);
    return true;
  }

  async deleteAccount(id: string): Promise<boolean> {
    const res = await this.accounts.deleteOne({ _id: id }, this.o);
    // ON DELETE CASCADE in SQLite. Recovery codes and tickets are the recovery store's (RecoveryStore.deleteForAccount).
    await this.sessions.deleteMany({ account_id: id }, this.o);
    await this.codes.deleteMany({ account_id: id }, this.o);
    await this.tickets.deleteMany({ account_id: id }, this.o);
    return res.deletedCount === 1;
  }

  async linkIdentity(accountId: string, userId: string, sessionId: string, at: number, createRows: (w: RowWriter) => string): Promise<string | null> {
    // Claim first: of two requests for one account, only one gets to create rows.
    const claimed = await this.accounts.updateOne({ _id: accountId, user_id: null }, { $set: { user_id: userId, updated_at: at } }, this.o);
    if (claimed.modifiedCount !== 1) return null;
    let deviceId: string;
    try {
      deviceId = await this.identity.write(createRows);
    } catch (e) {
      await this.releaseIdentity(accountId, userId, at);
      throw e;
    }
    // If this fails, the app's retry finds the device by its key and binds it (identity.ts › addDevice).
    await this.bindSessionDevice(sessionId, deviceId);
    return deviceId;
  }

  async releaseIdentity(accountId: string, userId: string, at: number): Promise<boolean> {
    const res = await this.accounts.updateOne({ _id: accountId, user_id: userId }, { $set: { user_id: null, updated_at: at } }, this.o);
    return res.modifiedCount === 1;
  }

  async bindDeviceWith(sessionId: string, deviceRows: (w: RowWriter) => string): Promise<string> {
    const deviceId = await this.identity.write(deviceRows);
    await this.bindSessionDevice(sessionId, deviceId);
    return deviceId;
  }

  async insertSession(row: SessionRow): Promise<void> {
    await this.sessions.insertOne({ _id: row.id, ...row }, this.o);
  }

  /** A session with what decides whether it may be used: its account (MongoDB), user and device (SQLite). */
  private async active(filter: Document): Promise<ActiveSession | undefined> {
    const [d] = await this.sessions
      .aggregate<SessionDoc & { a: AccountDoc[] }>(
        [{ $match: filter }, { $limit: 1 }, { $lookup: { from: "accounts", localField: "account_id", foreignField: "_id", as: "a" } }],
        this.o,
      )
      .toArray();
    const a = d?.a[0];
    if (!d || !a) return undefined;
    const { a: _a, _id: _id, ...s } = d;
    return {
      ...s,
      user_id: a.user_id,
      account_disabled_at: a.disabled_at,
      user_disabled_at: a.user_id ? userDisabledAt(this.identity, a.user_id) : null,
      device_revoked_at: s.device_id ? deviceRevokedAt(this.identity, s.device_id) : null,
    };
  }

  sessionById(id: string): Promise<ActiveSession | undefined> {
    return this.active({ _id: id });
  }

  sessionByAccessHash(hash: string): Promise<ActiveSession | undefined> {
    return this.active({ access_hash: hash });
  }

  async rotateSession(id: string, rotation: SessionRotation, expectedRefreshHash: string): Promise<boolean> {
    const res = await this.sessions.updateOne({ _id: id, refresh_hash: expectedRefreshHash }, { $set: rotation }, this.o);
    return res.modifiedCount === 1;
  }

  async bindSessionDevice(id: string, deviceId: string): Promise<void> {
    await this.sessions.updateOne({ _id: id }, { $set: { device_id: deviceId } }, this.o);
  }

  async touchSession(id: string, at: number): Promise<void> {
    await this.sessions.updateOne({ _id: id, last_used_at: { $lt: at - 60_000 } }, { $set: { last_used_at: at } }, this.o);
  }

  async revokeSession(id: string, reason: string, at: number): Promise<boolean> {
    const res = await this.sessions.updateOne({ _id: id, revoked_at: null }, { $set: { revoked_at: at, revoke_reason: reason } }, this.o);
    return res.modifiedCount === 1;
  }

  async revokeAccountSessions(accountId: string, reason: string, at: number, exceptSessionId?: string): Promise<string[]> {
    const filter: Document = { account_id: accountId, revoked_at: null, ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}) };
    const targets = await this.sessions.find(filter, { ...this.o, projection: { _id: 1, device_id: 1 } }).toArray();
    if (targets.length === 0) return [];
    await this.sessions.updateMany({ _id: { $in: targets.map((t) => t._id) }, revoked_at: null }, { $set: { revoked_at: at, revoke_reason: reason } }, this.o);
    return targets.flatMap((t) => (t.device_id ? [t.device_id] : []));
  }

  async revokeDeviceSessions(deviceId: string, reason: string, at: number): Promise<void> {
    await this.sessions.updateMany({ device_id: deviceId, revoked_at: null }, { $set: { revoked_at: at, revoke_reason: reason } }, this.o);
  }

  async latestSessionOfDevices(deviceIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (deviceIds.length === 0) return out;
    const rows = await this.sessions
      .find({ device_id: { $in: [...deviceIds] } }, { ...this.o, projection: { _id: 1, device_id: 1 } })
      .sort({ last_used_at: -1 })
      .toArray();
    for (const r of rows) if (r.device_id && !out.has(r.device_id)) out.set(r.device_id, r._id);
    return out;
  }

  async activeSessions(accountId: string, at: number): Promise<SessionRow[]> {
    const rows = await this.sessions
      .find({ account_id: accountId, revoked_at: null, expires_at: { $gt: at }, refresh_expires_at: { $gt: at } }, this.o)
      .sort({ last_used_at: -1 })
      .toArray();
    // A removed device's sessions may not be marked yet (auth/routes.ts › revokeDevices): they're over all the same.
    return rows.filter((r) => !r.device_id || deviceRevokedAt(this.identity, r.device_id) === null).map((r) => strip(r)!);
  }

  async recentSessions(accountId: string, since: number, limit: number): Promise<SessionRow[]> {
    const rows = await this.sessions
      .find({ account_id: accountId, expires_at: { $gt: since }, $or: [{ revoked_at: null }, { revoked_at: { $gt: since } }] }, this.o)
      .sort({ last_used_at: -1 })
      .limit(limit)
      .toArray();
    return rows.map((r) => strip(r)!);
  }

  async sessionHolders(at: number): Promise<number> {
    const ids = await this.sessions.distinct("account_id", { revoked_at: null, expires_at: { $gt: at }, refresh_expires_at: { $gt: at } }, this.o);
    return ids.length;
  }

  async putCode(row: CodeRow): Promise<void> {
    const _id = { account_id: row.account_id, purpose: row.purpose };
    await this.codes.replaceOne({ _id }, { ...row, attempts: 0 }, { ...this.o, upsert: true });
  }

  async code(accountId: string, purpose: CodePurpose): Promise<CodeRow | undefined> {
    return strip(await this.codes.findOne({ _id: { account_id: accountId, purpose } }, this.o));
  }

  async countCodeAttempt(accountId: string, purpose: CodePurpose): Promise<void> {
    await this.codes.updateOne({ _id: { account_id: accountId, purpose } }, { $inc: { attempts: 1 } }, this.o);
  }

  async deleteCode(accountId: string, purpose: CodePurpose, codeHash: string): Promise<boolean> {
    const res = await this.codes.deleteOne({ _id: { account_id: accountId, purpose }, code_hash: codeHash }, this.o);
    return res.deletedCount === 1;
  }

  async insertTicket(row: TicketRow): Promise<void> {
    await this.tickets.insertOne({ _id: row.ticket_hash, ...row }, this.o);
  }

  async ticket(hash: string): Promise<TicketRow | undefined> {
    return strip(await this.tickets.findOne({ _id: hash }, this.o));
  }

  async useTicket(hash: string, accountId: string, at: number): Promise<void> {
    await this.tickets.updateOne({ _id: hash }, { $set: { used_at: at, account_id: accountId } }, this.o);
  }

  async purgeExpired(at: number): Promise<number> {
    const grace = at - SESSION_GRACE_MS;
    const sessions = await this.sessions.deleteMany({
      $or: [{ expires_at: { $lte: grace } }, { refresh_expires_at: { $lte: grace } }, { revoked_at: { $ne: null, $lte: grace } }],
    });
    const codes = await this.codes.deleteMany({ expires_at: { $lte: at } });
    const tickets = await this.tickets.deleteMany({ expires_at: { $lte: grace } });
    return sessions.deletedCount + codes.deletedCount + tickets.deletedCount;
  }
}
