import type { z } from "zod/v4";
import type { LockDuration } from "../../../shared/contracts/http/communitySafety.js";
import type { AccountAgeGate, VerificationLevel } from "../../../shared/contracts/http/orgs.js";

/**
 * Community safety's rules (community parity A2, docs/COMMUNITY_SAFETY_API.md). Pure: no database, no clock, so the
 * routes, the tests and the apps' mirrors can be compared line by line.
 */

export type Level = z.infer<typeof VerificationLevel>;
export type AgeGate = z.infer<typeof AccountAgeGate>;
export type LockLength = z.infer<typeof LockDuration>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long each lock lasts. */
export const LOCK_MS: Readonly<Record<LockLength, number>> = { "15m": 15 * MINUTE, "1h": HOUR, "8h": 8 * HOUR, "1d": DAY };

/** The youngest account each gate lets join. */
export const ACCOUNT_AGE_MS: Readonly<Record<AgeGate, number>> = { off: 0, "10m": 10 * MINUTE, "1h": HOUR, "1d": DAY, "7d": 7 * DAY };
/** The longest gate: accounts older than this never need the (slower) platform-staff lookup. */
export const LONGEST_ACCOUNT_GATE_MS = ACCOUNT_AGE_MS["7d"];

/**
 * What each verification level asks of someone before they post or react in the community's channels: a verified email
 * from "low" up, an account at least [accountMs] old and a membership at least [memberMs] old.
 */
export const VERIFICATION: Readonly<Record<Level, { email: boolean; accountMs: number; memberMs: number }>> = {
  none: { email: false, accountMs: 0, memberMs: 0 },
  low: { email: true, accountMs: 0, memberMs: 0 },
  medium: { email: true, accountMs: 5 * MINUTE, memberMs: 5 * MINUTE },
  high: { email: true, accountMs: 5 * MINUTE, memberMs: 10 * MINUTE },
};

/**
 * Raid protection's thresholds. A community gets [joins] new members within [joinWindowMs]: it locks itself for
 * [lockMs]. A channel gets [messages] messages from at least [posters] different people within [messageWindowMs]: it
 * gets a [slowmodeSec] slowmode (only when its own is lower) for a fixed [slowmodeMs], then its own slowmode applies
 * again.
 */
export const RAID_LIMITS = {
  joins: 60,
  joinWindowMs: MINUTE,
  lockMs: 15 * MINUTE,
  messages: 30,
  posters: 6,
  messageWindowMs: 10_000,
  slowmodeSec: 5,
  slowmodeMs: 10 * MINUTE,
} as const;
export type RaidLimits = { -readonly [K in keyof typeof RAID_LIMITS]: number };

/** What a verification level needs to know about the person. */
export interface PosterFacts {
  emailVerified: boolean;
  /** When the account (its messaging identity) was made. */
  accountCreatedAt: number;
  /** When they joined the community. */
  joinedAt: number;
}

/** Why someone can't post yet: no verified email, or not long enough (allowed from [allowedAt]). */
export type VerificationRefusal = { reason: "email"; allowedAt: null } | { reason: "wait"; allowedAt: number };

/** Null when [level] lets this person post at [at]. */
export function verificationRefusal(level: Level, facts: PosterFacts, at: number): VerificationRefusal | null {
  const need = VERIFICATION[level];
  if (need.email && !facts.emailVerified) return { reason: "email", allowedAt: null };
  const allowedAt = Math.max(need.accountMs ? facts.accountCreatedAt + need.accountMs : 0, need.memberMs ? facts.joinedAt + need.memberMs : 0);
  return allowedAt > at ? { reason: "wait", allowedAt } : null;
}

/** When an account made at [createdAt] may join under [gate]; null when it may now. */
export function accountAllowedAt(gate: AgeGate, createdAt: number, at: number): number | null {
  const allowedAt = createdAt + ACCOUNT_AGE_MS[gate];
  return gate !== "off" && allowedAt > at ? allowedAt : null;
}

/**
 * Counts joins per community and messages per channel in sliding windows (in this process's memory: a restart starts
 * them again, which only delays detection). Each window keeps at most as many entries as its threshold, so memory stays
 * bounded by the number of communities and channels with recent activity.
 */
export class RaidDetector {
  private readonly joinTimes = new Map<string, number[]>();
  private readonly posts = new Map<string, { at: number; userId: string }[]>();

  constructor(public limits: RaidLimits = { ...RAID_LIMITS }) {}

  /** Records a join; true when it completes a flood (the window then starts over). */
  join(orgId: string, at: number): boolean {
    const { joins, joinWindowMs } = this.limits;
    const list = (this.joinTimes.get(orgId) ?? []).filter((t) => t > at - joinWindowMs);
    list.push(at);
    const flood = list.length >= joins;
    this.keep(this.joinTimes, orgId, flood ? [] : list.slice(-joins));
    return flood;
  }

  /** Records a message; true when it completes a flood from enough different people (the window then starts over). */
  post(conversationId: string, userId: string, at: number): boolean {
    const { messages, posters, messageWindowMs } = this.limits;
    const list = (this.posts.get(conversationId) ?? []).filter((p) => p.at > at - messageWindowMs);
    list.push({ at, userId });
    const flood = list.length >= messages && new Set(list.map((p) => p.userId)).size >= posters;
    this.keep(this.posts, conversationId, flood ? [] : list.slice(-messages));
    return flood;
  }

  forget(id: string): void {
    this.joinTimes.delete(id);
    this.posts.delete(id);
  }

  private keep<T>(map: Map<string, T[]>, key: string, list: T[]): void {
    if (list.length) map.set(key, list);
    else map.delete(key);
  }
}
