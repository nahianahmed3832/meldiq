import type { ErrorCode } from "../../../shared/errors.js";
import type { OrgRole } from "../authz.js";
import { BASE_ROLE_PERMISSIONS, BASE_ROLE_RANK, type Permission, permissionDef } from "./catalog.js";

/**
 * Pure permission rules (docs/WORKSPACE_ROLES.md): how a member's effective permissions are worked out, and who may
 * define, assign or remove which roles. No database access, so the routes, the tests and the app's mirror
 * (`RoleRules.kt`) can be compared line by line.
 */

/** What a custom role contributes: the powers it grants and the ones it restricts. */
export interface RoleGrant {
  permissions: readonly Permission[];
  denies: readonly Permission[];
}

/**
 * A member's effective permissions, deterministic whatever order the roles come in:
 * 1. the base role's permissions;
 * 2. plus every assigned role's grants, except owner-only powers (never grantable) and, for guests, anything a guest
 *    may not hold;
 * 3. minus every assigned role's restrictions (deny wins over any grant), limited to restrictable permissions.
 * Owners always hold everything: a role can't restrict an owner, so there is always someone able to fix a mistake.
 * [memberBase]: the community's own "@everyone" defaults (community parity A1), in place of the Member base set.
 */
export function effectivePermissions(base: OrgRole, roles: readonly RoleGrant[], memberBase?: ReadonlySet<Permission> | null): Set<Permission> {
  if (base === "OWNER") return new Set(BASE_ROLE_PERMISSIONS.OWNER);
  const out = new Set(base === "MEMBER" && memberBase ? memberBase : BASE_ROLE_PERMISSIONS[base]);
  for (const r of roles) {
    for (const p of r.permissions) {
      const d = permissionDef(p);
      if (d.ownerOnly) continue;
      if (base === "GUEST" && !d.guestAllowed) continue;
      out.add(p);
    }
  }
  for (const r of roles) {
    for (const p of r.denies) if (permissionDef(p).restrictable) out.delete(p);
  }
  return out;
}

export interface Refusal {
  status: 400 | 403 | 409;
  code: ErrorCode;
  message: string;
}

const refuse = (status: Refusal["status"], code: ErrorCode, message: string): Refusal => ({ status, code, message });

/** The actor: their base role and effective permissions in the workspace. */
export interface Actor {
  base: OrgRole;
  perms: ReadonlySet<Permission>;
}

const missing = (actor: Actor, wanted: Iterable<Permission>): Permission[] => [...wanted].filter((p) => !actor.perms.has(p));

/**
 * May [actor] give a role this definition (create it, or change an existing one from [before] to [after])?
 * - needs `roles.manage`;
 * - owner-only powers never go into a role; restrictions only on restrictable permissions;
 * - you can only grant or restrict powers you hold yourself, so nobody makes a role stronger than they are;
 * - administrative powers need `roles.delegate` as well (owners decide who hands out admin powers);
 * - an existing role that is already stronger than you, or holds admin powers you can't delegate, isn't yours to edit.
 */
export function roleDefinitionRefusal(actor: Actor, after: RoleGrant, before?: RoleGrant): Refusal | null {
  if (!actor.perms.has("roles.manage")) return refuse(403, "forbidden", "You can't create or edit roles in this workspace");
  for (const p of after.permissions) {
    if (permissionDef(p).ownerOnly) return refuse(400, "owner_only", `"${permissionDef(p).label}" stays with owners and can't be put into a role`);
  }
  for (const p of after.denies) {
    if (!permissionDef(p).restrictable) return refuse(400, "not_restrictable", `"${permissionDef(p).label}" can't be restricted by a role`);
  }
  const overlap = after.permissions.filter((p) => after.denies.includes(p));
  if (overlap.length) return refuse(400, "grant_and_deny", `A role can't both grant and restrict "${permissionDef(overlap[0]).label}"`);
  for (const grant of [after, ...(before ? [before] : [])]) {
    const lacking = missing(actor, [...grant.permissions, ...grant.denies]);
    if (lacking.length) {
      return refuse(403, "beyond_your_powers", `You can only give a role powers you hold yourself ("${permissionDef(lacking[0]).label}")`);
    }
    if (grant.permissions.some((p) => permissionDef(p).admin) && !actor.perms.has("roles.delegate")) {
      return refuse(403, "delegation_required", "Only people who can delegate admin powers can give a role administrative powers");
    }
  }
  return null;
}

/** The person a role change is about. */
export interface Target {
  base: OrgRole;
  perms: ReadonlySet<Permission>;
  self: boolean;
}

/**
 * May [actor] act on [target]'s access at all (assign or remove roles, change their base role, remove them)?
 * Owners act on anyone. Nobody else acts on an owner, or on an admin other than themselves (admins don't manage
 * admins). And nobody acts on someone holding an administrative power they lack themselves, so a delegated co-admin
 * can't be undone by someone with fewer powers. (Everyday powers such as posting don't count: a restricted admin still
 * manages members.)
 */
export function canActOn(actor: Actor, target: Target): boolean {
  if (actor.base === "OWNER") return true;
  if (target.self) return true;
  if (BASE_ROLE_RANK[target.base] >= BASE_ROLE_RANK.ADMIN) return false;
  return missing(actor, [...target.perms].filter((p) => permissionDef(p).admin)).length === 0;
}

/**
 * May [actor] give [target] a role carrying [role]? Needs `roles.assign`, a target they may act on, only powers they
 * hold (and `roles.delegate` for admin powers), and for guests only what a guest may hold.
 */
export function roleAssignmentRefusal(actor: Actor, target: Target, role: RoleGrant): Refusal | null {
  if (!actor.perms.has("roles.assign")) return refuse(403, "forbidden", "You can't assign roles in this workspace");
  if (!canActOn(actor, target)) return refuse(403, "forbidden", "You can't change this person's roles");
  const lacking = missing(actor, [...role.permissions, ...role.denies]);
  if (lacking.length) return refuse(403, "beyond_your_powers", `You can only assign roles within your own powers ("${permissionDef(lacking[0]).label}")`);
  if (role.permissions.some((p) => permissionDef(p).admin) && !actor.perms.has("roles.delegate")) {
    return refuse(403, "delegation_required", "Only people who can delegate admin powers can assign a role with administrative powers");
  }
  if (target.base === "GUEST") {
    const notForGuests = role.permissions.find((p) => !permissionDef(p).guestAllowed);
    if (notForGuests) return refuse(409, "not_for_guests", `Guests can't hold "${permissionDef(notForGuests).label}"`);
  }
  return null;
}

/**
 * May [actor] take a role away from [target]? Needs `roles.assign` and a target they may act on. Taking away a role's
 * restrictions gives the powers back, so the actor must hold those powers themselves: a read-only member can't lift
 * their own restriction.
 */
export function roleRemovalRefusal(actor: Actor, target: Target, role: RoleGrant): Refusal | null {
  if (!actor.perms.has("roles.assign")) return refuse(403, "forbidden", "You can't change roles in this workspace");
  if (!canActOn(actor, target)) return refuse(403, "forbidden", "You can't change this person's roles");
  const lacking = missing(actor, role.denies);
  if (lacking.length) return refuse(403, "beyond_your_powers", `Only someone who holds "${permissionDef(lacking[0]).label}" can lift this restriction`);
  if (role.permissions.some((p) => permissionDef(p).admin) && !actor.perms.has("roles.delegate") && !target.self) {
    return refuse(403, "delegation_required", "Only people who can delegate admin powers can take away a role with administrative powers");
  }
  return null;
}
