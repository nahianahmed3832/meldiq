import type { AppContext } from "../../app/context.js";
import type { CallParticipantRow } from "../calls/index.js";
import { giftLeaderboard } from "../billing/index.js";
import {
  blockedEitherWay,
  sharesCommunity,
  privacyOf,
  avatarMediaOf,
  styleOf,
  personCards,
  leaderboardIdentity,
} from "../accounts/index.js";
import { leaderboardChannels } from "../organizations/index.js";
import type {
  LeaderboardMetric,
  LeaderboardView,
} from "../../shared/contracts/http/leaderboards.js";
import type { z } from "zod/v4";

type Metric = z.infer<typeof LeaderboardMetric>;
type View = z.infer<typeof LeaderboardView>;
const WEEK = 7 * 86400_000;

/** Private conversations are only ranked for current members, from their latest join onward. */
async function activityScope(ctx: AppContext, viewer: string, voice: boolean): Promise<Map<string, number>> {
  const channels = leaderboardChannels(ctx, viewer).filter((c) => (c.voice === 1) === voice);
  const scope = new Map(channels.map((c) => [c.id, ctx.authz.historySince(c, viewer) ?? 0]));
  const chats = ctx.ws.all<{ conversation_id: string; joined_at: number }>("conversation_members", { where: { user_id: viewer } })
    .flatMap((m) => {
      const c = ctx.authz.conversation(m.conversation_id);
      return c && !c.archived_at && (c.type === "DM" || c.type === "GROUP") ? [{ c, joined: m.joined_at }] : [];
    });
  const requests = new Set((await ctx.relationships.requestsIn(chats.filter(({ c }) => c.type === "DM").map(({ c }) => c.id)))
    .filter((r) => r.state === "pending" || r.state === "declined")
    .map((r) => r.conversation_id));
  for (const { c, joined } of chats) if (!requests.has(c.id)) scope.set(c.id, joined);
  return scope;
}

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
    const scope = await activityScope(ctx, viewer, metric === "voice");
    if (metric === "messages")
      totals = await ctx.messages.rankedSenders(scope, now - WEEK);
    else
      totals = voiceTotals(
        await ctx.calls.leaderboardSpans(scope, now - WEEK),
        now - WEEK,
        now,
      );
  } else if (metric === "gifts") {
    totals = giftLeaderboard(ctx.billing.rows);
  } else totals = await ctx.points.store.leaderboard(metric);
  const cards = personCards(
    ctx,
    totals.map((t) => t.userId),
  );
  const people = totals
    .flatMap((t) => {
      if (
        !Number.isSafeInteger(t.count) ||
        t.count <= (metric === "level" ? 1 : 0)
      )
        return [];
      const card = cards.get(t.userId);
      const user = leaderboardIdentity(ctx, t.userId);
      if (
        !card ||
        !user ||
        user.kind !== "person" ||
        user.synthetic ||
        user.disabled_at ||
        user.home_server_id ||
        blockedEitherWay(ctx, viewer, t.userId)
      )
        return [];
      if (
        t.userId !== viewer &&
        privacyOf(user).findByUsername !== "everyone" &&
        !sharesCommunity(ctx, viewer, t.userId)
      )
        return [];
      return [
        {
          user: {
            ...card,
            avatarMedia:
              privacyOf(user).photo === "everyone" ? avatarMediaOf(user) : null,
            decoration: styleOf(user).decoration,
          },
          value: t.count,
        },
      ];
    })
    .sort((a, b) => b.value - a.value || a.user.id.localeCompare(b.user.id));
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
    scope: "meldiq",
    generatedAt: now,
    total: entries.length,
    entries: entries.slice(0, 100),
    me: entries.find((p) => p.user.id === viewer) ?? null,
  };
}
