import type { FastifyInstance } from "fastify";
import { type OrgRole, parsePermissionList } from "./authz.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { OrgMemberParams, OrgParams } from "../../shared/contracts/http/orgs.js";
import {
  AuditQuery,
  OwnershipBody,
  PERMISSION_CATEGORIES,
  type PermissionKey,
  ROLE_DESCRIPTION_MAX,
  ROLE_ICON_NAMES,
  ROLE_NAME_MAX,
  RoleCreateBody,
  RoleMemberParams,
  RoleParams,
  RolesQuery,
  RoleUpdateBody,
} from "../../shared/contracts/http/roles.js";
import {
  BASE_ROLE_PERMISSIONS,
  type Permission,
  type PermissionCategory,
  PERMISSIONS,
  ROLE_ICONS,
  ROLE_TEMPLATES,
} from "./permissions/catalog.js";
import { type Actor, canActOn, type RoleGrant, roleAssignmentRefusal, roleDefinitionRefusal, roleRemovalRefusal, type Refusal } from "./permissions/rules.js";
import { ApiError, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { reconcileAccess } from "./communityRoutes.js";
import { notifyOrg } from "./orgsRoutes.js";
import { mapByIds } from "../../infrastructure/database/byIds.js";
import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { compareText, foldAscii } from "../../shared/utilities/sqlText.js";

/**
 * Custom workspace roles (docs/WORKSPACE_ROLES.md): a workspace's own roles on top of the protected base roles, each
 * granting exactly the catalog permissions it lists. Every rule is in src/permissions/rules.ts; this file only loads,
 * checks and stores. Also here: ownership transfer, usage figures and the full audit log, which are gated by the same
 * permissions.
 */

/** At most this many active custom roles per workspace, and roles per person. */
export const MAX_ACTIVE_ROLES = 50;
export const MAX_ROLES_PER_MEMBER = 20;
const BASE_NAMES: Record<OrgRole, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", GUEST: "Guest" };

interface RoleRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  permissions: string;
  denies: string;
  template: string | null;
  position: number;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  /** Batch B12: members listed separately (0/1). */
  hoist?: number;
}

/** The contract's lists (src/shared/contracts/http/roles.ts) are the catalog's: checked when the server compiles. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const contractMatchesCatalog: Same<PermissionKey, Permission> & Same<(typeof ROLE_ICON_NAMES)[number], (typeof ROLE_ICONS)[number]> & Same<(typeof PERMISSION_CATEGORIES)[number], PermissionCategory> = true;
void contractMatchesCatalog;

const grantOf = (r: RoleRow): RoleGrant => ({ permissions: parsePermissionList(r.permissions), denies: parsePermissionList(r.denies) });
const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function throwRefusal(r: Refusal): never {
  throw new ApiError(r.status, r.code, r.message);
}

/** What a workspace uses of each limited capability (round 7 adds members, storage, workflows and more). */
export async function planUsage(ctx: AppContext, orgId: string, customRoles: number) {
  return {
    "roles.custom": customRoles,
    members: ctx.ws.count("org_members", { org_id: orgId }),
    "storage.bytes": (await ctx.files.storedUsage({ conversations: ctx.authz.conversationIdsOf(orgId), liveAt: now() })).bytes,
  };
}

export default async function roleRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const { authz, db, ws } = ctx;

  const roleRow = (id: string, rows: RowReader = ws) => rows.get<RoleRow>("org_roles", { id });
  const memberCount = (roleId: string) => ws.count("org_role_members", { role_id: roleId });
  const holders = (roleId: string) => ws.all<{ user_id: string }>("org_role_members", { where: { role_id: roleId } }).map((r) => r.user_id);

  /**
   * Changing what a role does (its powers, its limits, or whether it counts) changes the access of everyone holding it,
   * so it is allowed only when the caller may act on each of them: nobody restricts another admin, or someone with
   * powers they lack, by editing a role that person holds. Owners aren't affected by roles, so they don't count.
   */
  const requireReachOverHolders = (role: RoleRow, actor: Actor, actorId: string) => {
    for (const { user_id } of ws.all<{ user_id: string }>("org_role_members", { where: { role_id: role.id } })) {
      const t = authz.actor(role.org_id, user_id);
      if (!t || t.base === "OWNER") continue;
      if (!canActOn(actor, { base: t.base, perms: t.perms, self: user_id === actorId })) {
        throw new ApiError(403, "holder_out_of_reach", "Someone holding this role is an admin or has powers you don't, so only an owner can change what it does");
      }
    }
  };

  /** The role and the caller in its workspace; outsiders get 404 so a role id says nothing about the workspace. */
  const loadRole = (roleId: string, userId: string): { role: RoleRow; actor: Actor } => {
    const role = roleRow(roleId);
    const actor = role ? authz.actor(role.org_id, userId) : null;
    if (!role || !actor) throw notFound("Role not found");
    return { role, actor };
  };

  const view = (r: RoleRow, actor: Actor) => {
    const grant = grantOf(r);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      color: r.color,
      icon: r.icon,
      permissions: grant.permissions,
      denies: grant.denies,
      template: r.template,
      position: r.position,
      hoist: r.hoist === 1,
      rev: r.rev,
      memberCount: memberCount(r.id),
      archived: r.archived_at !== null,
      archivedAt: r.archived_at,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // What the caller may do with it (the server checks again on every call).
      canEdit: roleDefinitionRefusal(actor, grant, grant) === null,
      canAssign: actor.perms.has("roles.assign") && !roleAssignmentRefusal(actor, { base: "MEMBER", perms: new Set(), self: false }, grant),
    };
  };

  /** Active roles' names are unique in a workspace (case-insensitive), and never a base role's name. */
  const nameTaken = (rows: RowReader, orgId: string, name: string, exceptId?: string): RoleRow | { id: null } | undefined => {
    if (Object.values(BASE_NAMES).some((b) => b.toLowerCase() === name.trim().toLowerCase())) return { id: null };
    const wanted = foldAscii(name.trim());
    return rows.all<RoleRow>("org_roles", { where: { org_id: orgId, archived_at: null, id: { ne: exceptId ?? "" } } }).find((r) => foldAscii(r.name) === wanted);
  };
  const refuseTaken = (taken: RoleRow | { id: null }, name: string): never => {
    throw new ApiError(409, "role_name_taken", `A role called "${name.trim()}" already exists in this workspace`, taken.id ? { roleId: taken.id } : undefined);
  };
  const activeCount = (orgId: string, rows: RowReader = ws) => rows.count("org_roles", { org_id: orgId, archived_at: null });
  /** How many members hold each base role. */
  const countByRole = (orgId: string): Map<OrgRole, number> => {
    const out = new Map<OrgRole, number>();
    for (const m of ws.all<{ role: OrgRole }>("org_members", { where: { org_id: orgId } })) out.set(m.role, (out.get(m.role) ?? 0) + 1);
    return out;
  };

  // ───────────── The catalog and the workspace's roles ─────────────
  app.get("/v1/orgs/:orgId/roles", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    const { includeArchived } = parse(RolesQuery, req.query);
    authz.requirePermission(orgId, userId, "roles.view", "Your role doesn't include viewing roles");
    const actor = authz.actor(orgId, userId)!;
    const rows = ws
      .all<RoleRow>("org_roles", { where: includeArchived === "true" ? { org_id: orgId } : { org_id: orgId, archived_at: null } })
      .sort((a, b) => Number(a.archived_at !== null) - Number(b.archived_at !== null) || a.position - b.position || compareText(a.name, b.name));
    const baseCounts = countByRole(orgId);
    return {
      catalog: PERMISSIONS,
      templates: ROLE_TEMPLATES,
      icons: ROLE_ICONS,
      baseRoles: (Object.keys(BASE_NAMES) as OrgRole[]).map((key) => ({
        key,
        name: BASE_NAMES[key],
        permissions: [...BASE_ROLE_PERMISSIONS[key]],
        memberCount: baseCounts.get(key) ?? 0,
        protected: true,
      })),
      roles: rows.map((r) => view(r, actor)),
      limits: { activeRoles: MAX_ACTIVE_ROLES, rolesPerMember: MAX_ROLES_PER_MEMBER, nameMax: ROLE_NAME_MAX, descriptionMax: ROLE_DESCRIPTION_MAX },
      me: {
        base: actor.base,
        permissions: [...actor.perms].sort(),
        canManage: actor.perms.has("roles.manage"),
        canAssign: actor.perms.has("roles.assign"),
        canDelegate: actor.perms.has("roles.delegate"),
      },
    };
  });

  app.post("/v1/orgs/:orgId/roles", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(RoleCreateBody, req.body);
    authz.requireOrgMember(orgId, userId);
    const actor = authz.actor(orgId, userId)!;
    let start: { name: string; description: string | null; color: string | null; icon: string | null; grant: RoleGrant; template: string | null } = {
      name: "",
      description: null,
      color: null,
      icon: null,
      grant: { permissions: [], denies: [] },
      template: null,
    };
    if (body.template) {
      const t = ROLE_TEMPLATES.find((x) => x.key === body.template);
      if (!t) throw new ApiError(400, "unknown_template", "Unknown role template");
      start = { name: t.name, description: t.description, color: t.color, icon: t.icon, grant: { permissions: t.permissions, denies: t.denies }, template: t.key };
    } else if (body.cloneOf) {
      const src = roleRow(body.cloneOf);
      if (!src || src.org_id !== orgId) throw notFound("Role not found");
      start = { name: `${src.name} copy`.slice(0, ROLE_NAME_MAX), description: src.description, color: src.color, icon: src.icon, grant: grantOf(src), template: src.template };
    }
    const name = (body.name ?? start.name).trim();
    if (!name) throw new ApiError(400, "bad_request", "Give the role a name");
    const grant: RoleGrant = { permissions: body.permissions ?? start.grant.permissions, denies: body.denies ?? start.grant.denies };
    const refusal = roleDefinitionRefusal(actor, grant);
    if (refusal) throwRefusal(refusal);
    const id = newId("rl");
    const t = now();
    await ws.write((w) => {
      // Checked inside the write unit, so two creates can't both take a name or the last slot.
      const taken = nameTaken(w, orgId, name);
      if (taken) refuseTaken(taken, name);
      if (activeCount(orgId, w) >= MAX_ACTIVE_ROLES) throw conflict(`A workspace can have at most ${MAX_ACTIVE_ROLES} active roles. Archive one first.`);
      ctx.entitlements.check("roles.custom", activeCount(orgId, w), orgId);
      const last = w.get<{ position: number }>("org_roles", { org_id: orgId }, [["position", "desc"]]);
      w.insert("org_roles", {
        id,
        org_id: orgId,
        name,
        description: body.description === undefined ? start.description : body.description,
        color: body.color === undefined ? start.color : body.color,
        icon: body.icon === undefined ? start.icon : body.icon,
        permissions: JSON.stringify(grant.permissions),
        denies: JSON.stringify(grant.denies),
        template: start.template,
        position: (last?.position ?? 0) + 1,
        hoist: body.hoist ? 1 : 0,
        rev: 1,
        created_by: userId,
        created_at: t,
        updated_at: t,
      });
    });
    ctx.audit({ actorId: userId, orgId, action: "role.create", target: id, detail: name });
    notifyOrg(ctx, orgId);
    return { role: view(roleRow(id)!, actor) };
  });

  app.patch("/v1/roles/:roleId", auth, async (req) => {
    const { userId } = me(req);
    const { roleId } = parse(RoleParams, req.params);
    const body = parse(RoleUpdateBody, req.body);
    const { role, actor } = loadRole(roleId, userId);
    const before = grantOf(role);
    const after: RoleGrant = { permissions: body.permissions ?? before.permissions, denies: body.denies ?? before.denies };
    // Editing anything (archiving too) needs the right to define this role, before and after the change.
    const refusal = roleDefinitionRefusal(actor, after, before);
    if (refusal) throwRefusal(refusal);
    const archiveFlip = body.archived !== undefined && body.archived !== (role.archived_at !== null);
    if (archiveFlip || !sameKeys(after.permissions, before.permissions) || !sameKeys(after.denies, before.denies)) requireReachOverHolders(role, actor, userId);
    const t = now();
    const result = await ws.write((w) => {
      const current = roleRow(roleId, w);
      if (!current) throw notFound("Role not found");
      if (current.rev !== body.baseRev) return { stale: current };
      const archiving = body.archived === undefined ? null : body.archived;
      const name = body.name ?? current.name;
      if ((archiving === false && current.archived_at) || (body.name && !current.archived_at)) {
        const taken = nameTaken(w, current.org_id, name, current.id);
        if (taken) refuseTaken(taken, name);
      }
      if (archiving === false && current.archived_at && activeCount(current.org_id, w) >= MAX_ACTIVE_ROLES) {
        throw conflict(`A workspace can have at most ${MAX_ACTIVE_ROLES} active roles. Archive one first.`);
      }
      w.update(
        "org_roles",
        { id: roleId, rev: body.baseRev },
        {
          name,
          description: body.description === undefined ? current.description : body.description,
          color: body.color === undefined ? current.color : body.color,
          icon: body.icon === undefined ? current.icon : body.icon,
          hoist: body.hoist === undefined ? (current.hoist ?? 0) : body.hoist ? 1 : 0,
          permissions: JSON.stringify(after.permissions),
          denies: JSON.stringify(after.denies),
          archived_at: archiving === null ? current.archived_at : archiving ? t : null,
          rev: current.rev + 1,
          updated_at: t,
        },
      );
      return { stale: null, archiveChange: archiving !== null && archiving !== (current.archived_at !== null), archiving };
    });
    if (result.stale) {
      throw new ApiError(409, "stale", "Someone else changed this role. Review the latest version and try again.", { role: view(result.stale, actor) });
    }
    const action = result.archiveChange ? (result.archiving ? "role.archive" : "role.restore") : "role.update";
    ctx.audit({ actorId: userId, orgId: role.org_id, action, target: roleId, detail: body.name ?? role.name });
    // A role's restrictions and archiving change channel access (categories it opens, `channels.view` it restricts).
    await reconcileAccess(ctx, role.org_id, holders(roleId));
    return { role: view(roleRow(roleId)!, actor) };
  });

  /** Deleting is for archived roles only: archive first (assignments stop counting), then delete for good. */
  app.delete("/v1/roles/:roleId", auth, async (req) => {
    const { userId } = me(req);
    const { roleId } = parse(RoleParams, req.params);
    const { role, actor } = loadRole(roleId, userId);
    const refusal = roleDefinitionRefusal(actor, grantOf(role), grantOf(role));
    if (refusal) throwRefusal(refusal);
    if (!role.archived_at) throw new ApiError(409, "not_archived", "Archive the role before deleting it");
    const removed = memberCount(roleId);
    await ws.write((w) => {
      w.delete("channel_overwrites", { org_id: role.org_id, subject: roleId });
      w.delete("org_roles", { id: roleId, archived_at: { ne: null } });
    });
    ctx.audit({ actorId: userId, orgId: role.org_id, action: "role.delete", target: roleId, detail: `${role.name} (${removed} assignment(s))` });
    notifyOrg(ctx, role.org_id);
    return { ok: true };
  });

  // ───────────── Assignments ─────────────
  app.get("/v1/roles/:roleId/members", auth, async (req) => {
    const { userId } = me(req);
    const { roleId } = parse(RoleParams, req.params);
    const { role, actor } = loadRole(roleId, userId);
    if (!actor.perms.has("roles.view") || !actor.perms.has("members.view")) throw forbidden("Your role doesn't include seeing who holds roles");
    const assigned = ws.all<{ org_id: string; user_id: string; assigned_at: number; assigned_by: string }>("org_role_members", { where: { role_id: role.id } });
    const people = mapByIds<{ id: string; username: string; display_name: string }>(db, "users", "id", assigned.map((a) => a.user_id), "id, username, display_name");
    const rows = assigned
      .flatMap((a) => {
        const u = people.get(a.user_id);
        const m = ws.get<{ role: OrgRole }>("org_members", { org_id: a.org_id, user_id: a.user_id });
        return u && m ? [{ id: u.id, username: u.username, display_name: u.display_name, org_role: m.role, assigned_at: a.assigned_at, assigned_by: a.assigned_by }] : [];
      })
      .sort((a, b) => compareText(a.display_name, b.display_name))
      .slice(0, 1000);
    return {
      members: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, orgRole: r.org_role, assignedAt: r.assigned_at, assignedBy: r.assigned_by })),
    };
  });

  const targetIn = (orgId: string, targetId: string, actorId: string) => {
    const t = authz.actor(orgId, targetId);
    if (!t) throw notFound("That person is not a member of this workspace");
    return { base: t.base, perms: t.perms, self: targetId === actorId };
  };

  app.put("/v1/roles/:roleId/members/:userId", auth, async (req) => {
    const actorId = me(req).userId;
    const p = parse(RoleMemberParams, req.params);
    const { role, actor } = loadRole(p.roleId, actorId);
    if (role.archived_at) throw new ApiError(409, "archived", "This role is archived. Restore it before assigning it.");
    const target = targetIn(role.org_id, p.userId, actorId);
    const refusal = roleAssignmentRefusal(actor, target, grantOf(role));
    if (refusal) throwRefusal(refusal);
    const added = await ws.write((w) => {
      if (w.get("org_role_members", { role_id: role.id, user_id: p.userId })) return false;
      const held = w.count("org_role_members", { org_id: role.org_id, user_id: p.userId });
      if (held >= MAX_ROLES_PER_MEMBER) throw conflict(`A person can hold at most ${MAX_ROLES_PER_MEMBER} roles`);
      w.insert("org_role_members", { role_id: role.id, org_id: role.org_id, user_id: p.userId, assigned_by: actorId, assigned_at: now() });
      return true;
    });
    // Assigning twice is harmless (a retry or a double tap): the same answer, no second audit entry.
    if (added) {
      ctx.audit({ actorId, orgId: role.org_id, action: "role.assign", target: `${role.id}:${p.userId}`, detail: role.name });
      await reconcileAccess(ctx, role.org_id, [p.userId]);
    }
    return { ok: true, permissions: [...authz.permissions(role.org_id, p.userId)].sort() };
  });

  app.delete("/v1/roles/:roleId/members/:userId", auth, async (req) => {
    const actorId = me(req).userId;
    const p = parse(RoleMemberParams, req.params);
    const { role, actor } = loadRole(p.roleId, actorId);
    const target = targetIn(role.org_id, p.userId, actorId);
    const refusal = roleRemovalRefusal(actor, target, grantOf(role));
    if (refusal) throwRefusal(refusal);
    const removed = (await ws.write((w) => w.delete("org_role_members", { role_id: role.id, user_id: p.userId }))) > 0;
    if (removed) {
      ctx.audit({ actorId, orgId: role.org_id, action: "role.unassign", target: `${role.id}:${p.userId}`, detail: role.name });
      await reconcileAccess(ctx, role.org_id, [p.userId]);
    }
    return { ok: true, permissions: [...authz.permissions(role.org_id, p.userId)].sort() };
  });

  /** One person's effective permissions and where each comes from (their base role, which custom roles). */
  app.get("/v1/orgs/:orgId/members/:userId/permissions", auth, async (req) => {
    const viewer = me(req).userId;
    const p = parse(OrgMemberParams, req.params);
    authz.requireOrgMember(p.orgId, viewer);
    if (viewer !== p.userId && !(authz.can(p.orgId, viewer, "roles.view") && authz.can(p.orgId, viewer, "members.view"))) {
      throw forbidden("Your role doesn't include seeing other people's permissions");
    }
    const target = authz.actor(p.orgId, p.userId);
    if (!target) throw notFound("Member not found");
    const roles = authz.assignedRoles(p.orgId, p.userId);
    const sources: Record<string, string[]> = {};
    for (const perm of target.perms) {
      const from = BASE_ROLE_PERMISSIONS[target.base].has(perm) ? ["base"] : [];
      for (const r of roles) if (r.permissions.includes(perm)) from.push(r.id);
      sources[perm] = from;
    }
    const restricted = [...new Set(roles.flatMap((r) => r.denies))].filter((d) => !target.perms.has(d));
    return {
      base: target.base,
      roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.color })),
      effective: [...target.perms].sort(),
      sources,
      restricted,
    };
  });

  // ───────────── Ownership transfer ─────────────
  // Owners only, after typing the workspace's exact name. The new owner must already be a member (not a guest); the
  // previous owner becomes an admin, so there is always exactly the owners someone chose.
  app.post("/v1/orgs/:orgId/ownership", auth, async (req) => {
    const actorId = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(OwnershipBody, req.body);
    authz.requirePermission(orgId, actorId, "workspace.transfer", "Only an owner can transfer ownership");
    if (body.userId === actorId) throw new ApiError(400, "bad_request", "Choose someone else to become the owner");
    const org = ws.get<{ name: string }>("orgs", { id: orgId })!;
    if (body.confirmName.trim() !== org.name.trim()) throw new ApiError(400, "confirm_mismatch", "Type the workspace's name exactly as it appears to transfer it");
    const targetRole = authz.orgRole(orgId, body.userId);
    if (!targetRole) throw notFound("That person is not a member of this workspace");
    if (targetRole === "GUEST") throw conflict("Make this guest a member before handing them the workspace");
    if (targetRole === "OWNER") throw conflict("This person is already an owner");
    await ws.write((w) => {
      // Checked again inside the write unit: the actor may have stopped being an owner a moment ago.
      if (authz.orgRole(orgId, actorId) !== "OWNER") throw forbidden("Only an owner can transfer ownership");
      w.update("org_members", { org_id: orgId, user_id: body.userId }, { role: "OWNER" });
      w.update("org_members", { org_id: orgId, user_id: actorId }, { role: "ADMIN" });
      authz.autoJoinScope(w, orgId, body.userId, now());
    });
    ctx.audit({ actorId, orgId, action: "org.ownership.transfer", target: body.userId, detail: `${targetRole}→OWNER; previous owner→ADMIN` });
    notifyOrg(ctx, orgId);
    return { ok: true, newOwner: body.userId, yourRole: "ADMIN" as OrgRole };
  });

  // ───────────── Usage and storage ─────────────
  app.get("/v1/orgs/:orgId/usage", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, userId, "workspace.usage.view", "Your role doesn't include usage figures");
    const byRole = countByRole(orgId);
    const t = now();
    const stored = await ctx.files.storedUsage({ conversations: authz.conversationIdsOf(orgId), liveAt: t });
    const files = { n: stored.count, bytes: stored.bytes };
    return {
      members: {
        total: [...byRole.values()].reduce((a, b) => a + b, 0),
        owners: byRole.get("OWNER") ?? 0,
        admins: byRole.get("ADMIN") ?? 0,
        members: byRole.get("MEMBER") ?? 0,
        guests: byRole.get("GUEST") ?? 0,
      },
      structure: {
        // Zero since branches and teams became roles and categories; kept for apps that read them.
        branches: 0,
        departments: 0,
        teams: 0,
        categories: ws.count("channel_categories", { org_id: orgId }),
        channels: ws.count("conversations", { org_id: orgId, type: "CHANNEL", archived_at: null }),
        archivedChannels: ws.count("conversations", { org_id: orgId, type: "CHANNEL", archived_at: { ne: null } }),
      },
      // Sizes of the encrypted files the server still holds for the workspace's channels (it never sees their content).
      files: { count: files.n, bytes: files.bytes },
      invitations: {
        active: ws.all<{ uses: number; max_uses: number }>("invitations", { where: { org_id: orgId, revoked_at: null, expires_at: { gt: t } } }).filter((i) => i.uses < i.max_uses).length,
      },
      roles: { custom: ws.count("org_roles", { org_id: orgId, archived_at: null }) },
      limits: { fileMaxBytes: ctx.config.fileMaxBytes, orgStoredBytes: ctx.config.abuse.orgStoredBytes || null },
      // Round 7: measured usage over the last 30 days, per day (docs/USAGE_AND_PLANS.md). Counts and sizes only.
      metered: await (async () => {
        await ctx.usage.snapshot();
        return { days: 30, metrics: ctx.usage.series(orgId, 30) };
      })(),
    };
  });

  // ───────────── Plan and limits (docs/PLANS.md) ─────────────
  // Every member may see what their workspace can use. No plans exist yet: the answer says so, with any server-wide limits.
  app.get("/v1/orgs/:orgId/plan", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    authz.requireOrgMember(orgId, userId);
    const customRoles = ws.count("org_roles", { org_id: orgId, archived_at: null });
    return ctx.entitlements.plan(await planUsage(ctx, orgId, customRoles), orgId);
  });

  // ───────────── The full audit log ─────────────
  // For people with `audit.view`: every recorded change, newest first, a page at a time (`before` is the last id seen).
  app.get("/v1/orgs/:orgId/audit", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    const q = parse(AuditQuery, req.query);
    authz.requirePermission(orgId, userId, "audit.view", "Your role doesn't include the audit log");
    // The action filter matches the action itself or any under it ("member" finds "member.remove"), ASCII case ignored
    // as SQLite's LIKE did.
    const family = q.action ? `${foldAscii(q.action)}.` : null;
    const entries = ws.all<any>("audit_log", {
      where: { org_id: orgId, id: { lt: q.before ?? Number.MAX_SAFE_INTEGER }, ...(q.actorId ? { actor_id: q.actorId } : {}) },
      orderBy: [["id", "desc"]],
    });
    const matching = (q.action ? entries.filter((a) => a.action === q.action || foldAscii(a.action).startsWith(family!)) : entries).slice(0, q.limit + 1);
    const actors = mapByIds<{ id: string; display_name: string }>(db, "users", "id", matching.flatMap((a) => (a.actor_id ? [a.actor_id] : [])), "id, display_name");
    const rows = matching.map((a) => ({ ...a, actor_name: a.actor_id ? (actors.get(a.actor_id)?.display_name ?? null) : null }));
    const page = rows.slice(0, q.limit);
    return {
      entries: page.map((r) => ({ id: r.id, at: r.at, action: r.action, actorId: r.actor_id, actorName: r.actor_name ?? null, target: r.target, detail: r.detail })),
      nextBefore: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  });
}
