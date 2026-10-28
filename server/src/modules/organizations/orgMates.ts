import type { AppContext } from "../../app/context.js";

/**
 * Everyone in a community [userId] belongs to as more than a guest (only in [orgId] when given), [userId] included:
 * whom they can find by part of a name.
 */
export function orgMates(ctx: Pick<AppContext, "ws">, userId: string, orgId?: string): Set<string> {
  const mine = ctx.ws.all<{ org_id: string }>("org_members", { where: { user_id: userId, role: { ne: "GUEST" }, ...(orgId ? { org_id: orgId } : {}) } });
  return new Set(ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: { in: mine.map((m) => m.org_id) } } }).map((m) => m.user_id));
}
