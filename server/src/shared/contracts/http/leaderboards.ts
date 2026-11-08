import { z } from "zod/v4";
import type { RouteContract } from "./route.js";
export const LeaderboardMetric = z.enum([
  "level",
  "messages",
  "voice",
  "embers",
  "gifts",
  "invites",
]);
export const LeaderboardQuery = z.strictObject({
  metric: LeaderboardMetric.default("level"),
});
const Person = z.strictObject({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarColor: z.number().int(),
  photoRev: z.number().nullable(),
  avatarMedia: z
    .strictObject({ kind: z.enum(["gif", "webp", "video"]), rev: z.number() })
    .nullable(),
  decoration: z.string().nullable(),
});
export const LeaderboardEntry = z.strictObject({
  rank: z.number().int().positive(),
  user: Person,
  value: z.number().int().positive(),
});
export const LeaderboardView = z.strictObject({
  metric: LeaderboardMetric,
  period: z.enum(["week", "all"]),
  scope: z.enum(["visible_communities", "meldiq"]),
  generatedAt: z.number(),
  total: z.number().int().nonnegative(),
  entries: z.array(LeaderboardEntry).max(100),
  me: LeaderboardEntry.nullable(),
});
export const leaderboardContracts: readonly RouteContract[] = [
  {
    method: "GET",
    url: "/v2/leaderboards",
    tag: "Accounts",
    auth: true,
    summary:
      "Ranked account progress and activity in DMs, groups and community channels the viewer may access",
    query: LeaderboardQuery,
    response: LeaderboardView,
  },
];
