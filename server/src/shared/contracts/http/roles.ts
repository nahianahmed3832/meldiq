import { z } from "zod/v4";
import { OrgMemberParams, OrgParams, OrgRole, RoleBadge } from "./orgs.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Custom community roles (docs/WORKSPACE_ROLES.md), plus ownership transfer, usage figures, the plan and the full audit
 * log, which the same permissions gate.
 */

/**
 * The permission catalog's keys (modules/organizations/permissions/catalog.ts, checked to be the same list when the
 * server compiles). GET /v1/orgs/:orgId/roles returns the catalog with labels.
 */
export const PERMISSION_KEYS = [
  "workspace.edit",
  "workspace.usage.view",
  "workspace.delete",
  "workspace.transfer",
  "members.view",
  "members.invite",
  "members.invites.manage",
  "members.roles",
  "members.titles",
  "members.remove",
  "members.ban",
  "members.timeout",
  "members.approve",
  "roles.view",
  "roles.manage",
  "roles.assign",
  "roles.delegate",
  "channels.view",
  "channels.create",
  "channels.manage",
  "channels.visibility",
  "messages.post",
  "messages.attach",
  "messages.announce",
  "messages.bypass_slowmode",
  "expressions.manage",
  "voice.connect",
  "voice.speak",
  "audit.view",
  "reports.view",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export const PERMISSION_CATEGORIES = ["workspace", "members", "roles", "channels", "messaging", "voice", "security"] as const;
/** Icons a custom role may show (names the app maps to its own icon set). */
export const ROLE_ICON_NAMES = ["shield", "star", "people", "briefcase", "support", "code", "finance", "eye", "megaphone", "badge"] as const;

export const ROLE_NAME_MAX = 40;
export const ROLE_DESCRIPTION_MAX = 200;
export const AUDIT_PAGE_MAX = 100;

export const Permission = z.enum(PERMISSION_KEYS);
const known = new Set<string>(PERMISSION_KEYS);
/** Input: an unknown key is refused with "Unknown permission". */
const zPermissionInput = z.string().refine((k) => known.has(k), { message: "Unknown permission" }) as unknown as z.ZodType<PermissionKey>;
/** Repeats are dropped. */
const zPermissionList = z
  .array(zPermissionInput)
  .max(64)
  .transform((l) => [...new Set(l)]);
const zRoleName = z.string().trim().min(1).max(ROLE_NAME_MAX);
const zColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a colour like #E39B7B").nullable();
const zIcon = z.enum(ROLE_ICON_NAMES).nullable();
const zId = z.string().max(64);

export const RoleParams = z.object({ roleId: zId });
export const RoleMemberParams = z.object({ roleId: zId, userId: zId });
export const RolesQuery = z.object({ includeArchived: z.enum(["true", "false"]).optional() });

export const RoleCreateBody = z.object({
  name: zRoleName.optional(),
  description: z.string().trim().max(ROLE_DESCRIPTION_MAX).nullable().optional(),
  color: zColor.optional(),
  icon: zIcon.optional(),
  hoist: z.boolean().optional(),
  permissions: zPermissionList.optional(),
  denies: zPermissionList.optional(),
  /** Start from a starter template or by cloning an existing role; explicit fields override what's copied. */
  template: z.string().max(40).optional(),
  cloneOf: zId.optional(),
});

export const RoleUpdateBody = z.object({
  /** The revision the edit is based on (409 stale otherwise). */
  baseRev: z.number().int().min(1),
  name: zRoleName.optional(),
  description: z.string().trim().max(ROLE_DESCRIPTION_MAX).nullable().optional(),
  color: zColor.optional(),
  icon: zIcon.optional(),
  hoist: z.boolean().optional(),
  permissions: zPermissionList.optional(),
  denies: zPermissionList.optional(),
  archived: z.boolean().optional(),
});

export const OwnershipBody = z.object({ userId: zId, confirmName: z.string().max(200) });

export const AuditQuery = z.object({
  /** The last id seen (the next page starts below it). */
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(50),
  /** An action, or an action prefix ("role" matches role.create, role.update …). */
  action: z
    .string()
    .regex(/^[a-z_.]{1,40}$/)
    .optional(),
  /** Only changes made by this person. */
  actorId: z.string().min(1).max(64).optional(),
});

// ───────────── Views ─────────────

/** A custom role, with what the caller may do with it (the server checks again on every call). */
export const RoleView = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  permissions: z.array(Permission),
  denies: z.array(Permission),
  template: z.string().nullable(),
  position: z.number().int(),
  /** Its holders are listed separately in the member list. */
  hoist: z.boolean(),
  /** Send as baseRev to change it. */
  rev: z.number().int().positive(),
  memberCount: zCount,
  archived: z.boolean(),
  archivedAt: zTime.nullable(),
  createdBy: z.string(),
  createdAt: zTime,
  updatedAt: zTime,
  canEdit: z.boolean(),
  canAssign: z.boolean(),
});
export const RoleOnly = z.strictObject({ role: RoleView });

const PermissionDef = z.strictObject({
  key: Permission,
  category: z.enum(PERMISSION_CATEGORIES),
  label: z.string(),
  description: z.string(),
  /** Only someone with roles.delegate may put it into a role or hand out a role carrying it. */
  admin: z.boolean(),
  ownerOnly: z.boolean(),
  guestAllowed: z.boolean(),
  restrictable: z.boolean(),
});

const RoleTemplate = z.strictObject({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  color: z.string(),
  icon: z.enum(ROLE_ICON_NAMES),
  permissions: z.array(Permission),
  denies: z.array(Permission),
});

export const RolesOverview = z.strictObject({
  catalog: z.array(PermissionDef),
  templates: z.array(RoleTemplate),
  icons: z.array(z.enum(ROLE_ICON_NAMES)),
  baseRoles: z.array(z.strictObject({ key: OrgRole, name: z.string(), permissions: z.array(Permission), memberCount: zCount, protected: z.literal(true) })),
  roles: z.array(RoleView),
  limits: z.strictObject({ activeRoles: zCount, rolesPerMember: zCount, nameMax: zCount, descriptionMax: zCount }),
  me: z.strictObject({ base: OrgRole, permissions: z.array(Permission), canManage: z.boolean(), canAssign: z.boolean(), canDelegate: z.boolean() }),
});

/** After assigning or removing a role: the person's effective permissions. */
const AssignmentResult = z.strictObject({ ok: z.literal(true), permissions: z.array(Permission) });

const MetricSeries = z.strictObject({
  metric: z.string(),
  label: z.string(),
  kind: z.enum(["counter", "gauge"]),
  /** Counters: the sum over the period. Gauges: the latest value. */
  total: zCount,
  daily: z.array(z.strictObject({ day: z.string(), value: zCount })),
});

export const Usage = z.strictObject({
  members: z.strictObject({ total: zCount, owners: zCount, admins: zCount, members: zCount, guests: zCount }),
  structure: z.strictObject({
    branches: z.literal(0),
    departments: z.literal(0),
    teams: z.literal(0),
    categories: zCount,
    channels: zCount,
    archivedChannels: zCount,
  }),
  /** The encrypted files the server still holds for the community's channels. */
  files: z.strictObject({ count: zCount, bytes: zCount }),
  invitations: z.strictObject({ active: zCount }),
  roles: z.strictObject({ custom: zCount }),
  limits: z.strictObject({ fileMaxBytes: zCount, orgStoredBytes: zCount.nullable() }),
  /** Measured usage over the last 30 days, per day (counts and sizes only). */
  metered: z.strictObject({ days: z.literal(30), metrics: z.array(MetricSeries) }),
});

/** No plans exist yet (docs/PLANS.md): plan and upgrade are null, with any limits that apply. */
export const Plan = z.strictObject({
  plan: z.null(),
  source: z.enum(["workspace", "server", "none"]),
  capabilities: z.array(
    z.strictObject({
      key: z.string(),
      label: z.string(),
      /** null: no limit. */
      limit: zCount.nullable(),
      used: zCount,
      available: z.boolean(),
      source: z.enum(["workspace", "server", "none"]),
    }),
  ),
  upgrade: z.null(),
});

export const AuditPage = z.strictObject({
  entries: z.array(
    z.strictObject({
      id: z.number().int().positive(),
      at: zTime,
      action: z.string(),
      actorId: z.string().nullable(),
      actorName: z.string().nullable(),
      target: z.string().nullable(),
      detail: z.string().nullable(),
    }),
  ),
  /** Pass as `before` for the next page; null at the end. */
  nextBefore: z.number().int().positive().nullable(),
});

// ───────────── Routes ─────────────

/** Why a role can't be defined this way (permissions/rules.ts roleDefinitionRefusal). */
const DEFINITION_REFUSALS = ["forbidden", "owner_only", "not_restrictable", "grant_and_deny", "beyond_your_powers", "delegation_required"] as const;

const roles = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "roles", auth: true, ...c });

export const roleRoutes = [
  roles({
    method: "GET",
    url: "/v1/orgs/:orgId/roles",
    summary: "The permission catalog, role templates, base roles, the community's custom roles and what the caller may do.",
    params: OrgParams,
    query: RolesQuery,
    response: RolesOverview,
    errors: ["not_found", "forbidden"],
  }),
  roles({
    method: "POST",
    url: "/v1/orgs/:orgId/roles",
    summary: "Create a custom role, from scratch, a template or a copy of another role.",
    params: OrgParams,
    body: RoleCreateBody,
    response: RoleOnly,
    errors: ["not_found", "unknown_template", ...DEFINITION_REFUSALS, "role_name_taken", "conflict", "limit_reached"],
  }),
  roles({
    method: "PATCH",
    url: "/v1/roles/:roleId",
    summary: "Change, archive or restore a role, based on its current revision.",
    params: RoleParams,
    body: RoleUpdateBody,
    response: RoleOnly,
    errors: ["not_found", ...DEFINITION_REFUSALS, "holder_out_of_reach", "role_name_taken", "conflict", "stale"],
  }),
  roles({
    method: "DELETE",
    url: "/v1/roles/:roleId",
    summary: "Delete an archived role for good.",
    params: RoleParams,
    response: z.strictObject({ ok: z.literal(true) }),
    errors: ["not_found", ...DEFINITION_REFUSALS, "not_archived"],
  }),
  roles({
    method: "GET",
    url: "/v1/roles/:roleId/members",
    summary: "Who holds a role (at most 1000).",
    params: RoleParams,
    response: z.strictObject({
      members: z.array(
        z.strictObject({ id: z.string(), username: z.string(), displayName: z.string(), orgRole: OrgRole, assignedAt: zTime, assignedBy: z.string() }),
      ),
    }),
    errors: ["not_found", "forbidden"],
  }),
  roles({
    method: "PUT",
    url: "/v1/roles/:roleId/members/:userId",
    summary: "Give someone a role. Giving it again changes nothing.",
    params: RoleMemberParams,
    response: AssignmentResult,
    errors: ["not_found", "archived", "forbidden", "beyond_your_powers", "delegation_required", "not_for_guests", "conflict"],
  }),
  roles({
    method: "DELETE",
    url: "/v1/roles/:roleId/members/:userId",
    summary: "Take a role away from someone.",
    params: RoleMemberParams,
    response: AssignmentResult,
    errors: ["not_found", "forbidden", "beyond_your_powers", "delegation_required"],
  }),
  roles({
    method: "GET",
    url: "/v1/orgs/:orgId/members/:userId/permissions",
    summary: "One member's effective permissions and where each comes from (\"base\" or a role id).",
    params: OrgMemberParams,
    response: z.strictObject({
      base: OrgRole,
      roles: z.array(RoleBadge),
      effective: z.array(Permission),
      /** Per effective permission: "base" and/or the ids of the roles granting it. */
      sources: z.record(z.string(), z.array(z.string())),
      /** Permissions the person's roles restrict. */
      restricted: z.array(Permission),
    }),
    errors: ["not_found", "forbidden"],
  }),
  roles({
    method: "POST",
    url: "/v1/orgs/:orgId/ownership",
    summary: "Hand ownership to another member (owners, after typing the community's name); the caller becomes an admin.",
    params: OrgParams,
    body: OwnershipBody,
    response: z.strictObject({ ok: z.literal(true), newOwner: z.string(), yourRole: z.literal("ADMIN") }),
    errors: ["not_found", "forbidden", "confirm_mismatch", "conflict"],
  }),
  roles({
    method: "GET",
    url: "/v1/orgs/:orgId/usage",
    summary: "Member, structure, file and invitation figures, limits and 30 days of measured usage.",
    params: OrgParams,
    response: Usage,
    errors: ["not_found", "forbidden"],
  }),
  roles({
    method: "GET",
    url: "/v1/orgs/:orgId/plan",
    summary: "What the community can use: no plans exist yet, so only the limits that apply.",
    params: OrgParams,
    response: Plan,
    errors: ["not_found"],
  }),
  roles({
    method: "GET",
    url: "/v1/orgs/:orgId/audit",
    summary: "The full audit log, newest first, a page at a time.",
    params: OrgParams,
    query: AuditQuery,
    response: AuditPage,
    errors: ["not_found", "forbidden"],
  }),
];
