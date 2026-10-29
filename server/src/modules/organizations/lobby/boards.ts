import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { LOBBY_LIMITS } from "../../../shared/contracts/http/communityLobby.js";
import type { LobbyLeaderboard } from "../../../shared/contracts/http/communityLobbyView.js";
import { sha256Hex } from "../../../shared/utilities/util.js";
import { personCards } from "../../accounts/index.js";
import type { Board } from "./defaults.js";

type Leaderboard = z.infer<typeof LobbyLeaderboard>;

/** "Messages this week" and "busiest channels" look back this far. */
export const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** How long one count of a week's messages is reused (the same community and the same visible channels). */
export const ACTIVITY_CACHE_MS = 5 * 60 * 1000;
/** Counts kept at most; the oldest go first. */
const ACTIVITY_CACHE_ENTRIES = 1000;

/** A week of messages in some channels: per channel, and the busiest senders. */
export interface WeekActivity {
  perConversation: Record<string, number>;
  topSenders: { userId: string; count: number }[];
}

/**
 * Counts of the last week's messages, cached for a few minutes per community and set of channels: everyone who sees
 * the same channels shares one count, and nobody's board counts a channel they can't see.
 */
export class ActivityCache {
  private readonly entries = new Map<string, { at: number; activity: WeekActivity }>();

  constructor(
    private readonly ctx: Pick<AppContext, "messages">,
    private readonly clock: () => number,
  ) {}

  async week(orgId: string, channelIds: readonly string[]): Promise<WeekActivity> {
    const t = this.clock();
    const key = `${orgId}|${sha256Hex([...channelIds].sort().join(","))}`;
    const hit = this.entries.get(key);
    if (hit && t - hit.at < ACTIVITY_CACHE_MS) return hit.activity;
    // Twice the board's size, so people who left since still leave ten to show.
    const activity = await this.ctx.messages.activitySince(channelIds, t - ACTIVITY_WINDOW_MS, LOBBY_LIMITS.leaderboard * 2);
    this.entries.delete(key);
    this.entries.set(key, { at: t, activity });
    while (this.entries.size > ACTIVITY_CACHE_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return activity;
  }

  /** A community changed in a way that moves the counts (tests, or a channel's visibility): start again. */
  clear(): void {
    this.entries.clear();
  }
}

/** Ranked entries for current members of [orgId] among [counts] (busiest first), at most a board's size. */
function ranked(ctx: AppContext, orgId: string, counts: readonly { userId: string; count: number }[]): Leaderboard["entries"] {
  const members = counts.filter((c) => c.count > 0 && ctx.authz.orgRole(orgId, c.userId) !== null).slice(0, LOBBY_LIMITS.leaderboard);
  const cards = personCards(ctx, members.map((m) => m.userId));
  return members.flatMap((m) => {
    const user = cards.get(m.userId);
    return user ? [{ user, count: m.count }] : [];
  }).map((e, i) => ({ rank: i + 1, ...e }));
}

/**
 * People by how many joined through their invites: the invitations' use counts per member who made them (Meldiq
 * doesn't record which invitation each member joined with, so people who joined and left since still count).
 */
function invitesBoard(ctx: AppContext, orgId: string): Leaderboard["entries"] {
  const byInviter = new Map<string, number>();
  for (const inv of ctx.ws.all<{ created_by: string; uses: number }>("invitations", { where: { org_id: orgId, uses: { gt: 0 } } })) {
    byInviter.set(inv.created_by, (byInviter.get(inv.created_by) ?? 0) + inv.uses);
  }
  const counts = [...byInviter].map(([userId, count]) => ({ userId, count })).sort((a, b) => b.count - a.count || (a.userId < b.userId ? -1 : 1));
  return ranked(ctx, orgId, counts);
}

/** The Levels bot's board (community parity D): the most XP first, while the bot is on; empty otherwise. */
function levelsBoard(ctx: AppContext, orgId: string): Leaderboard["entries"] {
  // Twice the board's size, so people who left since still leave ten to show.
  return ranked(ctx, orgId, ctx.officialBots.levelsTop(orgId, LOBBY_LIMITS.leaderboard * 2));
}

/** The boards [boards] asks for, in that order. */
export function leaderboards(ctx: AppContext, orgId: string, boards: readonly Board[], week: WeekActivity): Leaderboard[] {
  return boards.map((board) => {
    if (board === "messages_week") return { board, entries: ranked(ctx, orgId, week.topSenders) };
    if (board === "invites") return { board, entries: invitesBoard(ctx, orgId) };
    return { board, entries: levelsBoard(ctx, orgId) };
  });
}
