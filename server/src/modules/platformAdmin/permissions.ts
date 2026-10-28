/**
 * Platform roles and what each may do (meldiq_central_admin/docs/ARCHITECTURE_PROPOSAL.md §3.6). Deny by default: a
 * permission not listed for a role is refused. Platform roles never grant anything inside a community, and community
 * roles never grant anything here.
 */
export const PLATFORM_ROLES = ["super_admin", "operations_admin", "support_admin", "billing_admin", "auditor"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PERMISSIONS = [
  "overview.view",
  "users.view",
  "users.view_email",
  "users.suspend",
  "users.restore",
  "users.sessions.revoke",
  "orgs.view",
  "entitlements.view",
  "entitlements.edit",
  "health.view",
  "connectors.view",
  "connectors.check",
  "incidents.view",
  "incidents.manage",
  "audit.view",
  "admins.view",
  "admins.manage",
  // Platform Admin 2.0 (meldiq_central_admin/docs/ADMIN_2_ASSESSMENT.md).
  "analytics.view",
  "presence.view",
  "devices.view",
  "devices.revoke",
  "users.recovery",
  "users.delete",
  "orgs.members.manage",
  "resources.view",
  "quotas.view",
  "quotas.edit",
  "settings.view",
  "settings.edit",
  // Platform controls (docs/PLATFORM_CONTROLS.md): maintenance, sign-ups, blocked email domains, kill switches.
  "controls.edit",
  "alerts.manage",
  "exports.create",
  // Billing (docs/BILLING.md): the catalog, subscriptions, invoices and provider events.
  "billing.view",
  "billing.manage",
  "billing.events.replay",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Actions that need a passkey check in the last few minutes and a written reason (ADMIN_REAUTH_MINUTES). */
export const SENSITIVE: ReadonlySet<Permission> = new Set([
  "users.suspend",
  "users.restore",
  "users.sessions.revoke",
  "entitlements.edit",
  "admins.manage",
  "devices.revoke",
  "users.recovery",
  "users.delete",
  "orgs.members.manage",
  "quotas.edit",
  "settings.edit",
  "controls.edit",
  "alerts.manage",
  "billing.manage",
  "billing.events.replay",
]);

const READ_EVERYTHING: Permission[] = [
  "overview.view",
  "users.view",
  "orgs.view",
  "entitlements.view",
  "health.view",
  "connectors.view",
  "incidents.view",
  "analytics.view",
  "presence.view",
  "devices.view",
  "resources.view",
  "quotas.view",
  "settings.view",
  "billing.view",
];

const GRANTS: Readonly<Record<PlatformRole, ReadonlySet<Permission>>> = {
  super_admin: new Set(PERMISSIONS),
  operations_admin: new Set<Permission>([
    "overview.view",
    "users.view",
    "users.sessions.revoke",
    "orgs.view",
    "health.view",
    "connectors.view",
    "connectors.check",
    "incidents.view",
    "incidents.manage",
    "analytics.view",
    "presence.view",
    "devices.view",
    "resources.view",
    "quotas.view",
    "quotas.edit",
    "settings.view",
    "controls.edit",
    "alerts.manage",
    "exports.create",
  ]),
  support_admin: new Set<Permission>([
    "overview.view",
    "users.view",
    "users.view_email",
    "users.suspend",
    "users.restore",
    "users.sessions.revoke",
    "orgs.view",
    "entitlements.view",
    "health.view",
    "connectors.view",
    "incidents.view",
    "incidents.manage",
    "analytics.view",
    "presence.view",
    "devices.view",
    "devices.revoke",
    "users.recovery",
    "quotas.view",
    "billing.view",
  ]),
  billing_admin: new Set<Permission>([
    "overview.view",
    "orgs.view",
    "entitlements.view",
    "entitlements.edit",
    "analytics.view",
    "resources.view",
    "quotas.view",
    "quotas.edit",
    "settings.view",
    "billing.view",
    "billing.manage",
    "billing.events.replay",
  ]),
  auditor: new Set<Permission>([...READ_EVERYTHING, "audit.view", "admins.view", "exports.create"]),
};

export function isPlatformRole(role: string): role is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(role);
}

export function can(role: PlatformRole, permission: Permission): boolean {
  return GRANTS[role]?.has(permission) ?? false;
}

export function permissionsOf(role: PlatformRole): Permission[] {
  return PERMISSIONS.filter((p) => can(role, p));
}
