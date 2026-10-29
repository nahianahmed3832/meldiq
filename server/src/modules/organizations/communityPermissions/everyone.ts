import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { EveryoneDefaults } from "../../../shared/contracts/http/communityPermissions.js";
import { ApiError, forbidden } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { BASE_ROLE_PERMISSIONS, memberDefaultAllowed, type Permission, PERMISSION_KEYS, permissionDef } from "../permissions/catalog.js";
import type { Actor, Refusal } from "../permissions/rules.js";
import { reconcileAccess } from "../communityRoutes.js";

/**
 * A community's "@everyone" defaults (community parity A1, docs/COMMUNITY_PERMISSIONS.md): the everyday permissions
 * every Member holds before custom roles. Owners and admins aren't affected (they hold everything); guests keep their
 * own small set.
 */

const STANDARD = [...BASE_ROLE_PERMISSIONS.MEMBER];
const ALLOWED = PERMISSION_KEYS.filter(memberDefaultAllowed);

export function everyoneView(ctx: AppContext, orgId: string): z.infer<typeof EveryoneDefaults> {
  const row = ctx.communityPermissions.memberDefaultsRow(orgId);
  const held = ctx.communityPermissions.memberDefaults(orgId) ?? BASE_ROLE_PERMISSIONS.MEMBER;
  return {
    permissions: PERMISSION_KEYS.filter((k) => held.has(k)),
    standard: STANDARD,
    allowed: ALLOWED,
    customized: !!row,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * May [actor] change the defaults from [before] to [after]? Needs `roles.manage`; only everyday powers; and every
 * power added or taken away must be one the actor holds, so nobody hands everyone a power they don't have.
 */
export function everyoneRefusal(actor: Actor, before: ReadonlySet<Permission>, after: ReadonlySet<Permission>): Refusal | null {
  if (!actor.perms.has("roles.manage")) return { status: 403, code: "forbidden", message: "Your role doesn't include changing what members may do" };
  const unsafe = [...after].find((p) => !memberDefaultAllowed(p));
  if (unsafe) return { status: 400, code: "not_member_safe", message: `"${permissionDef(unsafe).label}" comes from roles; it can't be given to every member` };
  const changed = [...new Set([...before, ...after])].filter((p) => before.has(p) !== after.has(p));
  const lacking = changed.find((p) => !actor.perms.has(p));
  if (lacking) return { status: 403, code: "beyond_your_powers", message: `You can only change "${permissionDef(lacking).label}" if you hold it yourself` };
  return null;
}

/** PUT /v1/orgs/:orgId/roles/everyone. Saving the standard set removes the community's own. */
export async function setEveryone(ctx: AppContext, orgId: string, actorId: string, wanted: readonly Permission[]): Promise<z.infer<typeof EveryoneDefaults>> {
  const { authz, ws } = ctx;
  authz.requireOrgMember(orgId, actorId);
  const actor = authz.actor(orgId, actorId)!;
  const before = authz.basePermissions(orgId, "MEMBER");
  const after = new Set(wanted);
  const refusal = everyoneRefusal(actor, before, after);
  if (refusal) throw refusal.status === 403 && refusal.code === "forbidden" ? forbidden(refusal.message) : new ApiError(refusal.status, refusal.code, refusal.message);
  const added = [...after].filter((p) => !BASE_ROLE_PERMISSIONS.MEMBER.has(p));
  const removed = STANDARD.filter((p) => !after.has(p));
  await ws.write((w) => {
    if (!added.length && !removed.length) {
      w.delete("community_member_defaults", { org_id: orgId });
      return;
    }
    const row = { org_id: orgId, added: JSON.stringify(added), removed: JSON.stringify(removed), updated_by: actorId, updated_at: now() };
    w.upsert("community_member_defaults", row, { added: row.added, removed: row.removed, updated_by: row.updated_by, updated_at: row.updated_at });
  });
  const plus = [...after].filter((p) => !before.has(p));
  const minus = [...before].filter((p) => !after.has(p));
  ctx.audit({ actorId, orgId, action: "everyone.update", target: orgId, detail: `+${plus.join(",")} -${minus.join(",")}` });
  // Seeing channels may have changed for every member: everyone is checked again (and every app reloads).
  await reconcileAccess(ctx, orgId);
  return everyoneView(ctx, orgId);
}
