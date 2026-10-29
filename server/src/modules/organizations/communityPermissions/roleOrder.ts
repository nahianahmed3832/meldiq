import type { AppContext } from "../../../app/context.js";
import { ApiError, badRequest, forbidden } from "../../../shared/errors.js";
import { notifyOrg } from "../orgsRoutes.js";

/**
 * Reordering roles (community parity A1, docs/COMMUNITY_PERMISSIONS.md): highest first, as the member list shows them.
 * The listed roles swap the places they already hold (org_roles.position), so roles left out keep theirs. Owners and
 * admins move any role; others with `roles.manage` only roles below their own highest one, which keeps them there.
 */

interface PositionedRole {
  id: string;
  position: number;
}

/** The places [count] roles get from the places they had: the same ones, or consecutive ones when some were shared. */
export function placesFor(had: readonly number[]): number[] {
  const sorted = [...had].sort((a, b) => a - b);
  const distinct = sorted.every((p, i) => i === 0 || p > sorted[i - 1]!);
  return distinct ? sorted : sorted.map((_, i) => sorted[0]! + i);
}

/** The highest place among [userId]'s roles (a lower number is higher), or null without any. */
function highestPlace(ctx: AppContext, orgId: string, userId: string): number | null {
  const ids = ctx.authz.assignedRoles(orgId, userId).map((r) => r.id);
  const places = ctx.ws.all<PositionedRole>("org_roles", { where: { id: { in: ids } } }).map((r) => r.position);
  return places.length ? Math.min(...places) : null;
}

export async function reorderRoles(ctx: AppContext, orgId: string, actorId: string, roleIds: readonly string[]): Promise<{ order: PositionedRole[] }> {
  const { authz, ws } = ctx;
  authz.requireOrgMember(orgId, actorId);
  const actor = authz.actor(orgId, actorId)!;
  if (!actor.perms.has("roles.manage")) throw forbidden("Your role doesn't include arranging roles");
  if (new Set(roleIds).size !== roleIds.length) throw badRequest("Each role can be listed once");
  const active = new Map(ws.all<PositionedRole>("org_roles", { where: { org_id: orgId, archived_at: null } }).map((r) => [r.id, r]));
  const listed = roleIds.map((id) => active.get(id) ?? badRequestFor(id));
  if (actor.base !== "OWNER" && actor.base !== "ADMIN") {
    const top = highestPlace(ctx, orgId, actorId);
    if (top === null || listed.some((r) => r.position <= top)) {
      throw new ApiError(403, "beyond_your_powers", "You can only move roles that are below your own highest role");
    }
  }
  const places = placesFor(listed.map((r) => r.position));
  await ws.write((w) => roleIds.forEach((id, i) => w.update("org_roles", { id }, { position: places[i]! })));
  ctx.audit({ actorId, orgId, action: "role.reorder", target: orgId, detail: roleIds.join(",") });
  notifyOrg(ctx, orgId);
  const order = ws
    .all<PositionedRole>("org_roles", { where: { org_id: orgId, archived_at: null } })
    .map((r) => ({ id: r.id, position: r.position }))
    .sort((a, b) => a.position - b.position);
  return { order };
}

function badRequestFor(id: string): never {
  throw badRequest("Unknown role, or one that's archived", { roleId: id });
}
