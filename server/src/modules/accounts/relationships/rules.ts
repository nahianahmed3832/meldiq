import type { AppContext } from "../../../app/context.js";
import { ApiError } from "../../../shared/errors.js";
import type { MessagingSettings } from "./store.js";

/**
 * Batch B6: who may message whom (docs/product/MELDIQ_FRIENDS_AND_DMS_SPEC.md §3). Unknown, disabled and blocked people
 * all get the same answer, so a block is never revealed.
 */
export function notAvailable(): ApiError {
  return new ApiError(404, "not_available", "You can't message this person");
}

/** Whether either of the two blocked the other. */
export function blockedEitherWay(ctx: AppContext, x: string, y: string): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM user_blocks WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)").get(x, y, y, x);
}

/** Whether the two are both members (not guests) of at least one community. */
export function sharesCommunity(ctx: AppContext, x: string, y: string): boolean {
  return !!ctx.db
    .prepare("SELECT 1 FROM org_members a JOIN org_members b ON a.org_id = b.org_id WHERE a.user_id = ? AND b.user_id = ? AND a.role != 'GUEST' AND b.role != 'GUEST' LIMIT 1")
    .get(x, y);
}

/** A local, enabled account (people on other servers keep their own settings there). */
export function availableUser(ctx: AppContext, id: string): { id: string; home_server_id: string | null } | null {
  // AI agents' bot identities (kind 'agent') are no one's to message: their direct conversations start from AI agents.
  return (ctx.db.prepare("SELECT id, home_server_id FROM users WHERE id = ? AND disabled_at IS NULL AND kind = 'person'").get(id) as { id: string; home_server_id: string | null } | undefined) ?? null;
}

export type DmDecision = "direct" | "request" | "refused";

/** [userId]'s messaging settings, with the server's defaults where they never chose. */
export async function settingsOf(ctx: AppContext, userId: string): Promise<MessagingSettings> {
  return (await ctx.relationships.settings(userId)) ?? { dm_policy: ctx.config.defaultDmPolicy, request_policy: "everyone" };
}

/** How a new DM from [from] to [to] starts: directly, as a message request, or not at all. */
export async function dmDecision(ctx: AppContext, from: string, to: string): Promise<DmDecision> {
  const s = await settingsOf(ctx, to);
  if ((await ctx.relationships.connection(from, to))?.state === "accepted") return "direct";
  const shared = sharesCommunity(ctx, from, to);
  if (s.dm_policy === "everyone" || (s.dm_policy === "communities" && shared)) return "direct";
  if (requestAllowed(s, shared)) return "request";
  return "refused";
}

/** Whether [s] lets someone send a connection or message request ([shared]: they share a community). */
export function requestAllowed(s: MessagingSettings, shared: boolean): boolean {
  return s.request_policy === "everyone" || (s.request_policy === "communities" && shared);
}

/** The most connection and message requests one person may start in an hour. */
export const REQUESTS_PER_HOUR = 20;
/** Messages a sender may send before the recipient answers their message request. */
export const REQUEST_MESSAGE_LIMIT = 3;

export async function requireRequestBudget(ctx: AppContext, userId: string, at: number): Promise<void> {
  if ((await ctx.relationships.countStartedSince(userId, at - 3_600_000)) >= REQUESTS_PER_HOUR) {
    throw new ApiError(429, "request_rate_limited", "You've sent a lot of requests. Try again in an hour.", { retryAfter: 3600 });
  }
}
