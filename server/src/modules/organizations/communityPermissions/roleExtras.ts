import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { RoleExtrasBody } from "../../../shared/contracts/http/communityPermissions.js";
import { ApiError, notFound } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import type { RowReader, RowWriter } from "../../../infrastructure/database/rows/index.js";
import { parsePermissionList } from "../authz.js";
import { roleDefinitionRefusal } from "../permissions/rules.js";
import { reconcileAccess } from "../communityRoutes.js";
import { notifyOrg } from "../orgsRoutes.js";

/**
 * A role's extras (community parity A1, docs/COMMUNITY_PERMISSIONS.md): a second colour, whether anyone may mention it,
 * and who gets it automatically. Roles given automatically are for show: they never carry permissions or restrictions,
 * so handing one out can't change what anyone may do.
 */

/** At most this many roles per person (rolesRoutes MAX_ROLES_PER_MEMBER); automatic roles never go beyond it. */
const ROLES_PER_MEMBER = 20;
/** Who gave a role automatically (org_role_members.assigned_by). */
export const AUTO_ASSIGNER = "auto";

export type AutoMode = "none" | "everyone" | "joined_before";

export interface RoleExtrasWire {
  color2: string | null;
  mentionable: boolean;
  autoAssign: { mode: AutoMode; before: number | null };
}

interface ExtrasRow {
  role_id: string;
  org_id: string;
  color2: string | null;
  mentionable: number;
  auto_assign: AutoMode;
  auto_before: number | null;
}

interface RoleRow {
  id: string;
  org_id: string;
  name: string;
  permissions: string;
  denies: string;
  archived_at: number | null;
}

const NONE: RoleExtrasWire = { color2: null, mentionable: false, autoAssign: { mode: "none", before: null } };

const wireOf = (r: ExtrasRow | undefined): RoleExtrasWire =>
  r ? { color2: r.color2, mentionable: r.mentionable === 1, autoAssign: { mode: r.auto_assign, before: r.auto_before } } : NONE;

export function extrasOf(rows: RowReader, roleId: string): RoleExtrasWire {
  return wireOf(rows.get<ExtrasRow>("org_role_extras", { role_id: roleId }));
}

/** Whether someone who joined at [joinedAt] gets a role handed out this way. */
export function autoMatches(a: RoleExtrasWire["autoAssign"], joinedAt: number): boolean {
  return a.mode === "everyone" || (a.mode === "joined_before" && a.before !== null && joinedAt < a.before);
}

const hasPowers = (r: RoleRow) => parsePermissionList(r.permissions).length > 0 || parsePermissionList(r.denies).length > 0;

/** Gives [userId] the role unless they hold it or already hold as many roles as a person may. */
function give(w: RowWriter, role: RoleRow, userId: string, t: number): boolean {
  if (w.get("org_role_members", { role_id: role.id, user_id: userId })) return false;
  if (w.count("org_role_members", { org_id: role.org_id, user_id: userId }) >= ROLES_PER_MEMBER) return false;
  w.insert("org_role_members", { role_id: role.id, org_id: role.org_id, user_id: userId, assigned_by: AUTO_ASSIGNER, assigned_at: t }, { orIgnore: true });
  return true;
}

/** The automatic roles of [orgId] a newcomer gets (called inside the join's write unit). */
export function assignAutoRoles(w: RowWriter, orgId: string, userId: string, joinedAt: number): void {
  for (const x of w.all<ExtrasRow>("org_role_extras", { where: { org_id: orgId, auto_assign: { ne: "none" } } })) {
    const role = w.get<RoleRow>("org_roles", { id: x.role_id, archived_at: null });
    if (role && !hasPowers(role) && autoMatches(wireOf(x).autoAssign, joinedAt)) give(w, role, userId, joinedAt);
  }
}

/**
 * Brings a role's automatic holders in line with its setting: members who match get it, and people it was given to
 * automatically who no longer match lose it (people given it by hand keep it). Returns everyone whose roles changed.
 */
function syncAutoRole(w: RowWriter, role: RoleRow, a: RoleExtrasWire["autoAssign"], t: number): string[] {
  const changed: string[] = [];
  const members = w.all<{ user_id: string; joined_at: number }>("org_members", { where: { org_id: role.org_id } });
  const matching = new Set(members.filter((m) => autoMatches(a, m.joined_at)).map((m) => m.user_id));
  for (const m of w.all<{ user_id: string }>("org_role_members", { where: { role_id: role.id, assigned_by: AUTO_ASSIGNER } })) {
    if (matching.has(m.user_id)) continue;
    w.delete("org_role_members", { role_id: role.id, user_id: m.user_id });
    changed.push(m.user_id);
  }
  for (const u of matching) if (give(w, role, u, t)) changed.push(u);
  return changed;
}

/** PUT /v1/roles/:roleId/extras: anyone who may edit the role sets them (the same rule as editing its powers). */
export async function setRoleExtras(ctx: AppContext, roleId: string, actorId: string, body: z.infer<typeof RoleExtrasBody>) {
  const { authz, ws } = ctx;
  const role = ws.get<RoleRow>("org_roles", { id: roleId });
  const actor = role ? authz.actor(role.org_id, actorId) : null;
  if (!role || !actor) throw notFound("Role not found");
  const grant = { permissions: parsePermissionList(role.permissions), denies: parsePermissionList(role.denies) };
  const refusal = roleDefinitionRefusal(actor, grant, grant);
  if (refusal) throw new ApiError(refusal.status, refusal.code, refusal.message);
  if (role.archived_at) throw new ApiError(409, "archived", "This role is archived. Restore it before changing it.");
  const before = extrasOf(ws, roleId);
  const next: RoleExtrasWire = {
    color2: body.color2 === undefined ? before.color2 : body.color2,
    mentionable: body.mentionable ?? before.mentionable,
    autoAssign: body.autoAssign ? { mode: body.autoAssign.mode, before: body.autoAssign.before ?? null } : before.autoAssign,
  };
  if (next.autoAssign.mode !== "none" && hasPowers(role)) {
    throw new ApiError(400, "auto_role_has_powers", "Roles given automatically are for show: take this role's permissions and restrictions away first");
  }
  const autoChanged = JSON.stringify(next.autoAssign) !== JSON.stringify(before.autoAssign);
  const t = now();
  const changed = await ws.write((w) => {
    const row = {
      role_id: roleId,
      org_id: role.org_id,
      color2: next.color2,
      mentionable: next.mentionable ? 1 : 0,
      auto_assign: next.autoAssign.mode,
      auto_before: next.autoAssign.before,
      updated_by: actorId,
      updated_at: t,
    };
    const { role_id: _id, ...set } = row;
    w.upsert("org_role_extras", row, set);
    return autoChanged ? syncAutoRole(w, role, next.autoAssign, t) : [];
  });
  const auto = next.autoAssign.mode === "joined_before" ? `joined_before ${new Date(next.autoAssign.before!).toISOString()}` : next.autoAssign.mode;
  ctx.audit({ actorId, orgId: role.org_id, action: "role.extras", target: roleId, detail: `${role.name}: ${next.color2 ?? "one colour"}, ${next.mentionable ? "mentionable" : "not mentionable"}, auto ${auto}` });
  // A role can still open channels through their permissions, so whoever it reached is checked again.
  if (changed.length) await reconcileAccess(ctx, role.org_id, changed);
  else notifyOrg(ctx, role.org_id);
  return { roleId, extras: next, memberCount: ws.count("org_role_members", { role_id: roleId }) };
}

/** Whether a role carries automatic assignment (a role given automatically can't be given powers). */
export function isAutoRole(rows: RowReader, roleId: string): boolean {
  return extrasOf(rows, roleId).autoAssign.mode !== "none";
}
