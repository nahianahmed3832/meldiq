import type { AppContext } from "../../app/context.js";
import type { CallParticipantRow } from "../calls/store.js";
import type { GiftRow } from "../billing/gifts.js";
import {
  blockedEitherWay,
  sharesCommunity,
} from "../accounts/relationships/rules.js";
import { privacyOf } from "../accounts/profile.js";
import { avatarMediaOf, styleOf } from "../accounts/profileMedia.js";
import { personCards } from "../accounts/peopleCards.js";
import { visibleChannels } from "../organizations/lobby/view.js";
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
    const orgs = ctx.ws.all<{ org_id: string }>("org_members", {
      where: { user_id: viewer },
    });
    const channels = orgs.flatMap((o) =>
      visibleChannels(ctx, o.org_id, viewer),
    );
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
    const counts = new Map<string, number>();
    for (const g of ctx.billing.rows.all<GiftRow>("mojo_gifts", {
      where: { status: { in: ["paid", "redeemed"] } },
    })) {
      if (
        !g.buyer_user_id ||
        (g.refund_status && g.refund_status !== "none") ||
        g.dispute_status
      )
        continue;
      counts.set(g.buyer_user_id, (counts.get(g.buyer_user_id) ?? 0) + 1);
    }
    totals = [...counts].map(([userId, count]) => ({ userId, count }));
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
      const user = ctx.identity.get<{
        kind: string;
        synthetic: number;
        disabled_at: number | null;
        home_server_id: string | null;
        privacy: string | null;
        avatar_media: string | null;
        profile_style: string | null;
      }>("users", { id: t.userId });
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
    scope: weekly ? "visible_communities" : "meldiq",
    generatedAt: now,
    total: entries.length,
    entries: entries.slice(0, 100),
    me: entries.find((p) => p.user.id === viewer) ?? null,
  };
}
