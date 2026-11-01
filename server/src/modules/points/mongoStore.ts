import type { Collection } from "mongodb";
import type { AchievementAward } from "./achievements.js";
import {
  isDuplicateKey,
  type MeldiqMongo,
} from "../../infrastructure/database/mongo/client.js";
import type {
  DaySet,
  InviteJoin,
  InviteState,
  PointsAccount,
  PointsDay,
  PointsEntry,
  PointsKind,
  PointsStore,
} from "./store.js";

/** points_accounts: one document per person who ever earned, keyed by user id. */
interface AccountDoc {
  _id: string;
  balance: number;
  earned_total: number;
  level: number;
  streak: number;
  last_visit_day: string | null;
  updated_at: number;
}

/** points_ledger: one document per change, keyed by its idempotency id (rules.ts entryId). */
interface EntryDoc {
  _id: string;
  user_id: string;
  kind: PointsKind;
  amount: number;
  detail: string | null;
  day: string;
  at: number;
}

/** points_days: one document per person and UTC day ("<userId>|<day>"). The sets are absent until first used. */
interface DayDoc {
  _id: string;
  user_id: string;
  day: string;
  earned?: number;
  minutes?: number[];
  chats?: string[];
  reacted?: string[];
  replied?: string[];
}

/** points_invites: joins through someone's invite, keyed "<orgId>|<joinerId>". */
interface InviteDoc {
  _id: string;
  inviter_id: string;
  joiner_id: string;
  org_id: string;
  joined_at: number;
  state: InviteState;
  settled_at: number | null;
}

const fromAccount = (d: AccountDoc): PointsAccount => ({
  userId: d._id,
  balance: d.balance,
  earnedTotal: d.earned_total,
  level: d.level,
  streak: d.streak,
  lastVisitDay: d.last_visit_day,
});
const fromEntry = (d: EntryDoc): PointsEntry => ({
  id: d._id,
  userId: d.user_id,
  kind: d.kind,
  amount: d.amount,
  detail: d.detail,
  day: d.day,
  at: d.at,
});
const toEntry = (e: PointsEntry): EntryDoc => ({
  _id: e.id,
  user_id: e.userId,
  kind: e.kind,
  amount: e.amount,
  detail: e.detail,
  day: e.day,
  at: e.at,
});
const fromInvite = (d: InviteDoc): InviteJoin => ({
  id: d._id,
  inviterId: d.inviter_id,
  joinerId: d.joiner_id,
  orgId: d.org_id,
  joinedAt: d.joined_at,
  state: d.state,
  settledAt: d.settled_at,
});
const dayKey = (userId: string, day: string) => `${userId}|${day}`;

/**
 * Points in MongoDB (API 0.65.0). New data, so no domain migration. Earning inserts the ledger entry first (its id is
 * the idempotency key, a duplicate means it was earned already) and then adds to the totals; spending is one
 * conditional update, so the balance never goes below zero. Times are epoch milliseconds (docs/MONGODB.md §3).
 */
export class MongoPointsStore implements PointsStore {
  readonly backend = "mongodb" as const;
  private readonly accounts: Collection<AccountDoc>;
  private readonly ledger: Collection<EntryDoc>;
  private readonly days: Collection<DayDoc>;
  private readonly invites: Collection<InviteDoc>;

  constructor(mongo: MeldiqMongo) {
    this.accounts = mongo.db.collection<AccountDoc>("points_accounts");
    this.ledger = mongo.db.collection<EntryDoc>("points_ledger");
    this.days = mongo.db.collection<DayDoc>("points_days");
    this.invites = mongo.db.collection<InviteDoc>("points_invites");
  }

  /** The indexes history, the monthly invite count, levels and invites use (idempotent). */
  async ensureIndexes(): Promise<void> {
    await this.ledger.createIndex({ user_id: 1, at: -1 }, { name: "user_at" });
    await this.ledger.createIndex(
      { user_id: 1, kind: 1, at: -1 },
      { name: "user_kind_at" },
    );
    await this.accounts.createIndex({ level: 1 }, { name: "level" });
    await this.days.createIndex({ user_id: 1 }, { name: "user_id" });
    await this.invites.createIndex(
      { inviter_id: 1, state: 1 },
      { name: "inviter_state" },
    );
    await this.invites.createIndex({ joiner_id: 1 }, { name: "joiner_id" });
  }

  async account(userId: string): Promise<PointsAccount | null> {
    const d = await this.accounts.findOne({ _id: userId });
    return d ? fromAccount(d) : null;
  }

  async levels(): Promise<Map<string, number>> {
    const docs = await this.accounts
      .find({ level: { $gt: 1 } }, { projection: { level: 1 } })
      .toArray();
    return new Map(docs.map((d) => [d._id, d.level]));
  }

  async achievementAwards(userId?: string): Promise<AchievementAward[]> {
    const rows = await this.ledger
      .find({
        ...(userId ? { user_id: userId } : {}),
        kind: "quest",
        amount: 0,
        detail: { $regex: "^achievement:" },
      })
      .toArray();
    return rows.map((d) => ({
      userId: d.user_id,
      achievementId: d.detail!.slice("achievement:".length),
      at: d.at,
    }));
  }

  async earn(e: PointsEntry): Promise<boolean> {
    try {
      await this.ledger.insertOne(toEntry(e));
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
    await this.accounts.updateOne(
      { _id: e.userId },
      {
        $inc: { balance: e.amount, earned_total: e.amount },
        $set: { updated_at: e.at },
        $setOnInsert: { level: 1, streak: 0, last_visit_day: null },
      },
      { upsert: true },
    );
    await this.days.updateOne(
      { _id: dayKey(e.userId, e.day) },
      {
        $inc: { earned: e.amount },
        $setOnInsert: { user_id: e.userId, day: e.day },
      },
      { upsert: true },
    );
    return true;
  }

  async levelUp(
    userId: string,
    cost: number,
    entry: (level: number) => PointsEntry,
  ): Promise<PointsAccount | null> {
    const d = await this.accounts.findOneAndUpdate(
      { _id: userId, balance: { $gte: cost } },
      { $inc: { balance: -cost, level: 1 }, $set: { updated_at: Date.now() } },
      { returnDocument: "after" },
    );
    if (!d) return null;
    await this.ledger.insertOne(toEntry(entry(d.level)));
    return fromAccount(d);
  }

  async setStreak(userId: string, day: string, streak: number): Promise<void> {
    await this.accounts.updateOne(
      { _id: userId },
      { $set: { streak, last_visit_day: day } },
    );
  }

  async day(userId: string, day: string): Promise<PointsDay | null> {
    const d = await this.days.findOne({ _id: dayKey(userId, day) });
    return d
      ? {
          earned: d.earned ?? 0,
          minutes: d.minutes ?? [],
          chats: d.chats ?? [],
          reacted: d.reacted ?? [],
          replied: d.replied ?? [],
        }
      : null;
  }

  async addToDay(
    userId: string,
    day: string,
    set: DaySet,
    value: string | number,
    cap: number,
  ): Promise<number | null> {
    try {
      // Matches only while [value] is missing and the set is below [cap]; otherwise the upsert's insert collides on _id.
      const d = await this.days.findOneAndUpdate(
        {
          _id: dayKey(userId, day),
          [set]: { $ne: value },
          [`${set}.${cap - 1}`]: { $exists: false },
        },
        { $addToSet: { [set]: value }, $setOnInsert: { user_id: userId, day } },
        { upsert: true, returnDocument: "after" },
      );
      return d ? ((d[set] as unknown[] | undefined)?.length ?? null) : null;
    } catch (err) {
      if (isDuplicateKey(err)) return null;
      throw err;
    }
  }

  async recorded(ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const docs = await this.ledger
      .find({ _id: { $in: [...ids] } }, { projection: { _id: 1 } })
      .toArray();
    return new Set(docs.map((d) => d._id));
  }

  async history(userId: string, limit: number): Promise<PointsEntry[]> {
    return (
      await this.ledger
        .find({ user_id: userId })
        .sort({ at: -1 })
        .limit(limit)
        .toArray()
    ).map(fromEntry);
  }

  async countSince(
    userId: string,
    kind: PointsKind,
    since: number,
  ): Promise<number> {
    return this.ledger.countDocuments({
      user_id: userId,
      kind,
      at: { $gte: since },
      amount: { $gt: 0 },
    });
  }

  async addInvite(j: InviteJoin): Promise<void> {
    await this.invites.updateOne(
      { _id: j.id },
      {
        $setOnInsert: {
          inviter_id: j.inviterId,
          joiner_id: j.joinerId,
          org_id: j.orgId,
          joined_at: j.joinedAt,
          state: j.state,
          settled_at: j.settledAt,
        },
      },
      { upsert: true },
    );
  }

  async invitesBy(inviterId: string): Promise<InviteJoin[]> {
    return (await this.invites.find({ inviter_id: inviterId }).toArray()).map(
      fromInvite,
    );
  }

  async settleInvite(
    id: string,
    state: Exclude<InviteState, "pending">,
    at: number,
  ): Promise<boolean> {
    const r = await this.invites.updateOne(
      { _id: id, state: "pending" },
      { $set: { state, settled_at: at } },
    );
    return r.modifiedCount === 1;
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.accounts.deleteOne({ _id: userId });
    await this.ledger.deleteMany({ user_id: userId });
    await this.days.deleteMany({ user_id: userId });
    await this.invites.deleteMany({
      $or: [{ inviter_id: userId }, { joiner_id: userId }],
    });
  }
}
