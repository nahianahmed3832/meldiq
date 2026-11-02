import type { z } from "zod/v4";
import type { PointsKind as PointsKindEnum } from "../../shared/contracts/http/points.js";
import type { AchievementAward } from "./achievements.js";

export type PointsKind = z.infer<typeof PointsKindEnum>;

/** A person's running totals. Created by their first earning; nobody without one has points (level 1). */
export interface PointsAccount {
  userId: string;
  balance: number;
  earnedTotal: number;
  level: number;
  /** Consecutive check-in days ending on [lastVisitDay]. */
  streak: number;
  lastVisitDay: string | null;
}

/** One change of a balance. [id] makes recording it idempotent (rules.ts entryId). */
export interface PointsEntry {
  id: string;
  userId: string;
  kind: PointsKind;
  /** Earned, or spent (negative). */
  amount: number;
  detail: string | null;
  /** The UTC day it counts for. */
  day: string;
  at: number;
}

/** The sets of a person's day that daily earnings and quests count (each kept only up to what can still earn). */
export type DaySet = "minutes" | "chats" | "reacted" | "replied";

export interface PointsDay {
  earned: number;
  /** Distinct minutes (epoch minute numbers) with a message sent. */
  minutes: number[];
  /** Conversations talked in. */
  chats: string[];
  /** Messages from others reacted to. */
  reacted: string[];
  /** Replies to others' messages. */
  replied: string[];
}

export type InviteState = "pending" | "credited" | "lapsed" | "capped";

/** Someone joined a community through [inviterId]'s invite; settled once they've been there 7 days (or left). */
export interface InviteJoin {
  /** "<orgId>|<joinerId>": one credit per person and community, however often they rejoin. */
  id: string;
  inviterId: string;
  joinerId: string;
  orgId: string;
  joinedAt: number;
  state: InviteState;
  settledAt: number | null;
}

/**
 * Where points live (docs/SETTINGS_PARITY_API.md): MongoDB whenever the server has one (points_accounts, points_ledger,
 * points_days and points_invites: new data goes to MongoDB), otherwise this process's memory (development and tests
 * without MONGODB_URI). Every check-and-change is one single-document operation, so concurrent requests can't earn
 * twice or spend more than the balance.
 */
export interface PointsStore {
  readonly backend: "memory" | "mongodb" | "postgres";
  account(userId: string): Promise<PointsAccount | null>;
  /** Public ranking totals; never balances or private earning history. */
  leaderboard(metric: "level" | "embers" | "invites"): Promise<{ userId: string; count: number }[]>;
  /** Everyone above level 1 (loaded at start: profiles show levels synchronously). */
  levels(): Promise<Map<string, number>>;
  achievementAwards(userId?: string): Promise<AchievementAward[]>;
  /** Records [entry] unless its id was recorded before (then false); a new one adds to the balance, total and day. */
  earn(entry: PointsEntry): Promise<boolean>;
  /** Takes [cost] and raises the level by one if the balance covers it (recording [entry]); the account after, or null. */
  levelUp(
    userId: string,
    cost: number,
    entry: (level: number) => PointsEntry,
  ): Promise<PointsAccount | null>;
  setStreak(userId: string, day: string, streak: number): Promise<void>;
  day(userId: string, day: string): Promise<PointsDay | null>;
  /** Adds [value] to the day's [set] while it holds fewer than [cap]: the set's size after, or null (there already, or full). */
  addToDay(
    userId: string,
    day: string,
    set: DaySet,
    value: string | number,
    cap: number,
  ): Promise<number | null>;
  /** Which of [ids] are recorded. */
  recorded(ids: readonly string[]): Promise<Set<string>>;
  history(userId: string, limit: number): Promise<PointsEntry[]>;
  /** How many [kind] entries [userId] has since [since]. */
  countSince(userId: string, kind: PointsKind, since: number): Promise<number>;
  /** Notes a join through an invite; nothing when one was noted for that person and community before. */
  addInvite(join: InviteJoin): Promise<void>;
  invitesBy(inviterId: string): Promise<InviteJoin[]>;
  /** Settles a pending invite; false when it was settled already. */
  settleInvite(
    id: string,
    state: Exclude<InviteState, "pending">,
    at: number,
  ): Promise<boolean>;
  deleteForUser(userId: string): Promise<void>;
}

const EMPTY_DAY: PointsDay = {
  earned: 0,
  minutes: [],
  chats: [],
  reacted: [],
  replied: [],
};

export class MemoryPointsStore implements PointsStore {
  readonly backend = "memory" as const;
  private readonly accounts = new Map<string, PointsAccount>();
  private readonly ledger = new Map<string, PointsEntry>();
  private readonly days = new Map<string, PointsDay>();
  private readonly invites = new Map<string, InviteJoin>();

  async account(userId: string): Promise<PointsAccount | null> {
    const a = this.accounts.get(userId);
    return a ? { ...a } : null;
  }

  async leaderboard(metric: "level" | "embers" | "invites"): Promise<{ userId: string; count: number }[]> {
    if (metric !== "invites") return [...this.accounts.values()].map(a => ({ userId: a.userId, count: metric === "level" ? a.level : a.earnedTotal }));
    const totals = new Map<string, number>();
    for (const i of this.invites.values()) if (i.state === "credited") totals.set(i.inviterId, (totals.get(i.inviterId) ?? 0) + 1);
    return [...totals].map(([userId, count]) => ({ userId, count }));
  }

  async levels(): Promise<Map<string, number>> {
    return new Map(
      [...this.accounts.values()]
        .filter((a) => a.level > 1)
        .map((a) => [a.userId, a.level]),
    );
  }

  async achievementAwards(userId?: string): Promise<AchievementAward[]> {
    return [...this.ledger.values()]
      .filter(
        (e) =>
          (!userId || e.userId === userId) &&
          e.detail?.startsWith("achievement:") &&
          e.amount === 0,
      )
      .map((e) => ({
        userId: e.userId,
        achievementId: e.detail!.slice("achievement:".length),
        at: e.at,
      }));
  }

  async earn(e: PointsEntry): Promise<boolean> {
    if (this.ledger.has(e.id)) return false;
    this.ledger.set(e.id, { ...e });
    const a = this.accounts.get(e.userId) ?? {
      userId: e.userId,
      balance: 0,
      earnedTotal: 0,
      level: 1,
      streak: 0,
      lastVisitDay: null,
    };
    this.accounts.set(e.userId, {
      ...a,
      balance: a.balance + e.amount,
      earnedTotal: a.earnedTotal + e.amount,
    });
    const key = `${e.userId}|${e.day}`;
    const d = this.days.get(key) ?? EMPTY_DAY;
    this.days.set(key, { ...d, earned: d.earned + e.amount });
    return true;
  }

  async levelUp(
    userId: string,
    cost: number,
    entry: (level: number) => PointsEntry,
  ): Promise<PointsAccount | null> {
    const a = this.accounts.get(userId);
    if (!a || a.balance < cost) return null;
    const next = { ...a, balance: a.balance - cost, level: a.level + 1 };
    this.accounts.set(userId, next);
    const e = entry(next.level);
    this.ledger.set(e.id, { ...e });
    return { ...next };
  }

  async setStreak(userId: string, day: string, streak: number): Promise<void> {
    const a = this.accounts.get(userId);
    if (a) this.accounts.set(userId, { ...a, streak, lastVisitDay: day });
  }

  async day(userId: string, day: string): Promise<PointsDay | null> {
    const d = this.days.get(`${userId}|${day}`);
    return d ? { ...d } : null;
  }

  async addToDay(
    userId: string,
    day: string,
    set: DaySet,
    value: string | number,
    cap: number,
  ): Promise<number | null> {
    const key = `${userId}|${day}`;
    const d = this.days.get(key) ?? EMPTY_DAY;
    const values = d[set] as (string | number)[];
    if (values.includes(value) || values.length >= cap) return null;
    this.days.set(key, { ...d, [set]: [...values, value] });
    return values.length + 1;
  }

  async recorded(ids: readonly string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.ledger.has(id)));
  }

  async history(userId: string, limit: number): Promise<PointsEntry[]> {
    return [...this.ledger.values()]
      .filter((e) => e.userId === userId)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async countSince(
    userId: string,
    kind: PointsKind,
    since: number,
  ): Promise<number> {
    return [...this.ledger.values()].filter(
      (e) =>
        e.userId === userId && e.kind === kind && e.at >= since && e.amount > 0,
    ).length;
  }

  async addInvite(join: InviteJoin): Promise<void> {
    if (!this.invites.has(join.id)) this.invites.set(join.id, { ...join });
  }

  async invitesBy(inviterId: string): Promise<InviteJoin[]> {
    return [...this.invites.values()]
      .filter((i) => i.inviterId === inviterId)
      .map((i) => ({ ...i }));
  }

  async settleInvite(
    id: string,
    state: Exclude<InviteState, "pending">,
    at: number,
  ): Promise<boolean> {
    const i = this.invites.get(id);
    if (!i || i.state !== "pending") return false;
    this.invites.set(id, { ...i, state, settledAt: at });
    return true;
  }

  async deleteForUser(userId: string): Promise<void> {
    this.accounts.delete(userId);
    for (const [id, e] of this.ledger)
      if (e.userId === userId) this.ledger.delete(id);
    for (const key of this.days.keys())
      if (key.startsWith(`${userId}|`)) this.days.delete(key);
    for (const [id, i] of this.invites)
      if (i.inviterId === userId || i.joinerId === userId)
        this.invites.delete(id);
  }
}
