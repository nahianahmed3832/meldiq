/**
 * What earns points and what they cost (API 0.65.0, docs/SETTINGS_PARITY_API.md). Amounts are before the plan's
 * multiplier (Mojo Plus earns 1.5 times, rounded); spending is never multiplied.
 */
export const POINTS = {
  /** The first check-in of a UTC day. */
  visit: 5,
  /** Every [chatBlockMinutes] distinct minutes with a message sent, up to [chatDailyMinutes] minutes a day (25 points). */
  chatBlock: 5,
  chatBlockMinutes: 5,
  chatDailyMinutes: 25,
  /** Each 7th consecutive day with a check-in. */
  streakBonus: 30,
  streakDays: 7,
  /** Someone joined a community through your invite and was still in it 7 days later; at most 10 a month (UTC). */
  invite: 100,
  inviteStayMs: 7 * 86_400_000,
  invitesPerMonth: 10,
  /** Accounts younger than this earn nothing. */
  newAccountMs: 86_400_000,
  levelCost: 100,
  plusMultiplier: 1.5,
  historyRows: 50,
} as const;

export type QuestId =
  | "daily-chats"
  | "daily-reactions"
  | "daily-reply"
  | "profile"
  | "friend"
  | "communities"
  | "decoration"
  | "two-step"
  | "daily-active"
  | "daily-appreciation"
  | "daily-thoughtful"
  | "daily-conversations"
  | "avatar"
  | "bio"
  | "banner"
  | "pronouns"
  | "first-community"
  | "community-explorer"
  | "close-circle";

export interface QuestSpec {
  id: QuestId;
  kind: "daily" | "once";
  reward: number;
  goal: number;
}

/**
 * Daily quests reset at 00:00 UTC: talk in 3 different chats, react to 3 messages from others, reply to someone else's
 * message. One-time quests: avatar and About me, a friend, 3 communities, a decoration worn, two-step sign-in on.
 */
export const QUESTS: readonly QuestSpec[] = [
  { id: "daily-chats", kind: "daily", reward: 10, goal: 3 },
  { id: "daily-reactions", kind: "daily", reward: 5, goal: 3 },
  { id: "daily-reply", kind: "daily", reward: 5, goal: 1 },
  { id: "profile", kind: "once", reward: 25, goal: 2 },
  { id: "friend", kind: "once", reward: 25, goal: 1 },
  { id: "communities", kind: "once", reward: 25, goal: 3 },
  { id: "decoration", kind: "once", reward: 15, goal: 1 },
  { id: "two-step", kind: "once", reward: 50, goal: 1 },
  { id: "daily-active", kind: "daily", reward: 10, goal: 10 },
  { id: "daily-appreciation", kind: "daily", reward: 10, goal: 5 },
  { id: "daily-thoughtful", kind: "daily", reward: 10, goal: 3 },
  { id: "daily-conversations", kind: "daily", reward: 15, goal: 5 },
  { id: "avatar", kind: "once", reward: 10, goal: 1 },
  { id: "bio", kind: "once", reward: 10, goal: 1 },
  { id: "banner", kind: "once", reward: 15, goal: 1 },
  { id: "pronouns", kind: "once", reward: 10, goal: 1 },
  { id: "first-community", kind: "once", reward: 15, goal: 1 },
  { id: "community-explorer", kind: "once", reward: 40, goal: 5 },
  { id: "close-circle", kind: "once", reward: 35, goal: 3 },
];

export const questSpec = (id: QuestId): QuestSpec =>
  QUESTS.find((q) => q.id === id)!;

const DAY_MS = 86_400_000;
/** The UTC day of [ms], "YYYY-MM-DD". */
export const utcDay = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);
export const previousDay = (day: string): string =>
  utcDay(Date.parse(`${day}T00:00:00Z`) - DAY_MS);
/** The next 00:00 UTC after [ms]. */
export const nextDayStart = (ms: number): number =>
  Date.parse(`${utcDay(ms)}T00:00:00Z`) + DAY_MS;
/** The first moment of [ms]'s UTC month. */
export function monthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** [base] with the plan's multiplier, rounded to whole points. */
export const scaled = (base: number, multiplier: number): number =>
  Math.round(base * multiplier);

/**
 * Ledger ids: each earning has one, so recording it twice (a retry, two devices, two requests at once) counts once.
 * They name the person, what was earned and the day or thing it was for.
 */
export const entryId = {
  visit: (userId: string, day: string) => `visit:${userId}:${day}`,
  streak: (userId: string, day: string) => `streak:${userId}:${day}`,
  chat: (userId: string, day: string, block: number) =>
    `chat:${userId}:${day}:${block}`,
  quest: (userId: string, q: QuestSpec, day: string) =>
    q.kind === "daily"
      ? `quest:${q.id}:${userId}:${day}`
      : `quest:${q.id}:${userId}`,
  invite: (inviteId: string) => `invite:${inviteId}`,
  level: (userId: string, level: number) => `level:${userId}:${level}`,
};
