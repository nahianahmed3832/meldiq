import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Points, quests and account levels (API 0.65.0, docs/SETTINGS_PARITY_API.md). Points are earned for being around
 * (a daily visit, chatting, a 7-day streak, invites that stay) and for quests, and spent on levels. The server decides
 * every amount; points can't be bought, sold or sent. "Points" is the code's name; the apps choose what to call them.
 */

export const PointsKind = z.enum(["visit", "streak", "chat", "invite", "quest", "level"]);
export const QuestKind = z.enum(["daily", "once"]);

export const QuestView = z.strictObject({
  id: z.string(),
  /** "daily": resets at 00:00 UTC; "once": done for good. */
  kind: QuestKind,
  /** What finishing it gives you now (with your plan's multiplier). */
  reward: z.number().int().positive(),
  progress: zCount,
  goal: z.number().int().positive(),
  /** "claimed": done and its reward given (rewards are claimed automatically). */
  state: z.enum(["open", "claimed"]),
});

export const PointsHistoryRow = z.strictObject({
  kind: PointsKind,
  /** Points earned, or spent (negative). */
  amount: z.number().int(),
  /** The quest's id, the community of an invite, or the level reached. */
  detail: z.string().nullable(),
  at: zTime,
});

export const InviteStats = z.strictObject({
  /** People who joined through your invites and haven't been there 7 days yet. */
  pending: zCount,
  credited: zCount,
  creditedThisMonth: zCount,
  monthlyLimit: z.number().int(),
});

export const PointsView = z.strictObject({
  balance: zCount,
  earnedToday: zCount,
  earnedTotal: zCount,
  level: z.number().int().min(1),
  nextLevelCost: z.number().int().positive(),
  /** 1, or 1.5 with Mojo Plus. */
  multiplier: z.number().positive(),
  /** Consecutive days with a visit, up to today or yesterday (0 once a day is missed). */
  streak: zCount,
  chatMinutesToday: zCount,
  chatPointsToday: zCount,
  chatDailyCap: z.number().int(),
  /** false while the account is under a day old: nothing is earned yet. */
  earning: z.boolean(),
  /** Today in UTC (YYYY-MM-DD), and when daily quests reset. */
  day: z.string(),
  resetsAt: zTime,
  quests: z.array(QuestView),
  invites: InviteStats,
  /** The last 50 changes, newest first. */
  history: z.array(PointsHistoryRow),
});
export type PointsView = z.infer<typeof PointsView>;

export const CheckinResult = z.strictObject({
  /** Whether this call counted today's visit (false when it was counted already, or the account can't earn yet). */
  counted: z.boolean(),
  points: PointsView,
});

export const LevelUpResult = z.strictObject({ level: z.number().int().min(2), balance: zCount, nextLevelCost: z.number().int().positive() });

const points = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "points", auth: true, ...c });

export const pointsRoutes = [
  points({ method: "GET", url: "/v2/points", summary: "Your points: balance, today's earnings, level, streak, quests, invites and the last 50 changes.", response: PointsView }),
  points({
    method: "POST",
    url: "/v2/points/checkin",
    summary: "Count today's visit (the apps call it when they open): 5 points once a UTC day, and 30 more every 7 days in a row.",
    response: CheckinResult,
  }),
  points({
    method: "POST",
    url: "/v2/points/level-up",
    summary: "Spend points on the next account level (100 points a level).",
    response: LevelUpResult,
    errors: ["not_enough_points"],
  }),
];
