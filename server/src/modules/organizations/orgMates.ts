import type { AppContext } from "../../app/context.js";

/**
 * Everyone in a community [userId] belongs to as more than a guest (only in [orgId] when given), [userId] included:
 * whom they can find by part of a name.
 */
export function orgMates(ctx: Pick<AppContext, "ws">, userId: string, orgId?: string): Set<string> {
  const mine = ctx.ws.all<{ org_id: string }>("org_members", { where: { user_id: userId, role: { ne: "GUEST" }, ...(orgId ? { org_id: orgId } : {}) } });
  return new Set(ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: { in: mine.map((m) => m.org_id) } } }).map((m) => m.user_id));
}

/**
 * The non-guest members of every community [userId] belongs to, in any role, [userId] included: the community side
 * of who may see their presence (Authz.canSeePresence). API 0.56.0 tells them live when an activity changes.
 */
export function presenceWatchers(ctx: Pick<AppContext, "ws">, userId: string): Set<string> {
  const orgs = ctx.ws.all<{ org_id: string }>("org_members", { where: { user_id: userId } }).map((m) => m.org_id);
  if (!orgs.length) return new Set();
  return new Set(ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: { in: orgs }, role: { ne: "GUEST" } } }).map((m) => m.user_id));
}

/**
 * API 0.65.0: everyone who shares a community with [userId] (both as more than guests), with how many they share,
 * [userId] left out: the pool of suggested people.
 */
export function sharedCommunityCounts(ctx: Pick<AppContext, "ws">, userId: string): Map<string, number> {
  const mine = ctx.ws.all<{ org_id: string }>("org_members", { where: { user_id: userId, role: { ne: "GUEST" } } }).map((m) => m.org_id);
  const counts = new Map<string, number>();
  if (!mine.length) return counts;
  for (const m of ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: { in: mine }, role: { ne: "GUEST" } } })) {
    if (m.user_id !== userId) counts.set(m.user_id, (counts.get(m.user_id) ?? 0) + 1);
  }
  return counts;
}

/** API 0.65.0: how many communities [userId] is in, in any role. */
export function communityCount(ctx: Pick<AppContext, "ws">, userId: string): number {
  return ctx.ws.count("org_members", { user_id: userId });
}
