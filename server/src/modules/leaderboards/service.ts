import type { AppContext } from "../../app/context.js";
import type { CallParticipantRow } from "../calls/index.js";
import { giftLeaderboard } from "../billing/index.js";
import { leaderboardPeople } from "../accounts/index.js";
import { visibleChannels, memberOrgIds } from "../organizations/index.js";
import type {
  LeaderboardMetric,
  LeaderboardView,
} from "../../shared/contracts/http/leaderboards.js";
import type { z } from "zod/v4";

type Metric = z.infer<typeof LeaderboardMetric>;
type View = z.infer<typeof LeaderboardView>;
const WEEK = 7 * 86400_000;

/** Union overlapping device/call spans per person before counting complete minutes. */
export function voiceTotals(
  spans: readonly CallParticipantRow[],
  since: number,
  now: number,
) {
  const users = new Map<string, [number, number][]>();
  for (const p of spans) {
    const start = Math.max(since, p.joined_at),
      end = Math.min(now, p.left_at ?? now);
    if (end <= start) continue;
    const rows = users.get(p.user_id) ?? [];
    rows.push([start, end]);
    users.set(p.user_id, rows);
  }
  return [...users].map(([userId, spans]) => {
    spans.sort((a, b) => a[0] - b[0]);
    let total = 0,
      start = spans[0]![0],
      end = spans[0]![1];
    for (const [a, b] of spans.slice(1)) {
      if (a <= end) end = Math.max(end, b);
      else {
        total += end - start;
        start = a;
        end = b;
      }
    }
    return { userId, count: Math.floor((total + end - start) / 60_000) };
  });
}

export async function leaderboard(
  ctx: AppContext,
  viewer: string,
  metric: Metric,
  now = Date.now(),
): Promise<View> {
  let totals: { userId: string; count: number }[];
  const weekly = metric === "messages" || metric === "voice";
  if (weekly) {
    const orgs = memberOrgIds(ctx.ws, viewer);
    const channels = orgs.flatMap((o) => visibleChannels(ctx, o, viewer));
    if (metric === "messages")
      totals = (
        await ctx.messages.activitySince(
          channels.filter((c) => c.voice !== 1).map((c) => c.id),
          now - WEEK,
          2147483647,
        )
      ).topSenders;
    else
      totals = voiceTotals(
        await ctx.calls.leaderboardSpans(
          channels.filter((c) => c.voice === 1).map((c) => c.id),
          now - WEEK,
        ),
        now - WEEK,
        now,
      );
  } else if (metric === "gifts") {
    totals = giftLeaderboard(ctx.billing.rows);
  } else totals = await ctx.points.store.leaderboard(metric);
  const people = leaderboardPeople(
    ctx,
    viewer,
    totals,
    metric === "level" ? 1 : 0,
  );
  let rank = 0,
    previous = -1;
  const entries = people.map((p, index) => {
    if (p.value !== previous) rank = index + 1;
    previous = p.value;
    return { ...p, rank };
  });
  return {
    metric,
    period: weekly ? "week" : "all",
    scope: weekly ? "visible_communities" : "meldiq",
    generatedAt: now,
    total: entries.length,
    entries: entries.slice(0, 100),
    me: entries.find((p) => p.user.id === viewer) ?? null,
  };
}
