import { z } from "zod/v4";
import { zEmail, zName, zPassword } from "./accounts.js";
import { zCount, zTime } from "./primitives.js";

/**
 * The Platform Admin Console's API, /admin/v1 (meldiq_central_admin/docs/ARCHITECTURE_PROPOSAL.md §5). A separate
 * surface from the apps' /v1 and /v2: cookie sessions instead of bearer tokens, its own roles, its own audit. Not part
 * of the apps' published contract (docs/api/openapi.json); the console mirrors these schemas. Bodies are strict:
 * unknown keys are refused, so nothing can be mass-assigned.
 */

export const PLATFORM_ROLE_VALUES = ["super_admin", "operations_admin", "support_admin", "billing_admin", "auditor"] as const;
export const zPlatformRole = z.enum(PLATFORM_ROLE_VALUES);

/** Why a sensitive action is taken: shown in the audit trail. */
export const zReason = z.string().trim().min(8, "Say why, in a few words (at least 8 characters)").max(500);

/** A WebAuthn ceremony's answer as the browser gives it (base64url fields); verified by the server. */
const zWebAuthnResponse = z.object({ id: z.string().min(1).max(1024), rawId: z.string().min(1).max(1024), type: z.literal("public-key") }).passthrough();

// ───────────── Requests ─────────────

export const AdminPasswordBody = z.strictObject({ email: zEmail, password: zPassword });
export const AdminPasskeyBody = z.strictObject({ response: zWebAuthnResponse });
export const AdminEnrolStartBody = z.strictObject({ email: zEmail, password: zPassword, code: z.string().trim().min(10).max(20) });
export const AdminEnrolFinishBody = z.strictObject({ response: zWebAuthnResponse, name: zName.optional() });

// ───────────── Answers ─────────────

export const AdminCeremony = z.strictObject({ options: z.record(z.string(), z.unknown()) });

export const AdminMe = z.strictObject({
  account: z.strictObject({ id: z.string(), email: z.string(), name: z.string() }),
  role: zPlatformRole,
  permissions: z.array(z.string()),
  session: z.strictObject({ id: z.string(), createdAt: zTime, expiresAt: zTime, idleExpiresAt: zTime, reauthUntil: zTime }),
  passkeys: zCount,
});

export const AdminOk = z.strictObject({ ok: z.literal(true) });

// ───────────── Pagination ─────────────

/** Keyset pagination: an opaque cursor from the previous page, and a page size of at most 100. */
export const zCursor = z.string().max(200).regex(/^[A-Za-z0-9_-]+$/);
export const zLimit = z.coerce.number().int().min(1).max(100).default(25);
const zSearch = z.string().trim().max(120).optional();

// ───────────── Overview ─────────────

const zPerDay = z.array(z.strictObject({ day: z.string(), count: zCount }));

export const AdminOverview = z.strictObject({
  generatedAt: zTime,
  people: z.strictObject({ total: zCount, suspended: zCount, deleted: zCount, seen24h: zCount, seen30d: zCount, newPerDay: zPerDay }),
  organizations: z.strictObject({ total: zCount, teams: zCount, communities: zCount, newPerDay: zPerDay }),
  /** Workspace file bytes (latest daily gauge); personal files aren't counted per workspace. */
  storage: z.strictObject({ workspaceBytes: zCount, measuredAt: z.string().nullable() }),
  requests: z.strictObject({ since: zTime, windowMinutes: zCount, requests: zCount, serverErrors: zCount, errorRate: z.number().nullable(), p95Ms: z.number().nullable() }).nullable(),
  health: z
    .strictObject({
      version: z.string(),
      uptimeSeconds: zCount,
      database: z.boolean().nullable(),
      mongodb: z.boolean().nullable(),
      storage: z.boolean().nullable(),
      onlineDevices: zCount,
      queuedDeliveries: zCount,
      warnings: z.array(z.string()),
    })
    .nullable(),
  billing: z.strictObject({ available: z.boolean(), reason: z.string().nullable() }),
  recentActions: z.array(z.strictObject({ at: zTime, action: z.string(), outcome: z.string(), actorRole: z.string().nullable(), targetType: z.string().nullable() })).nullable(),
  openIncidents: zCount,
});

// ───────────── People ─────────────

export const USER_STATUSES = ["active", "suspended", "deleted"] as const;
export const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A day like 2026-10-24");
export const AdminUsersQuery = z.strictObject({
  q: zSearch,
  status: z.enum(USER_STATUSES).optional(),
  /** active7d: qualifying activity in the last 7 days; inactive30d: none in 30 days (telemetry, since it began). */
  activity: z.enum(["active7d", "inactive30d"]).optional(),
  /** Sign-up day range (UTC, inclusive). */
  createdFrom: zDay.optional(),
  createdTo: zDay.optional(),
  cursor: zCursor.optional(),
  limit: zLimit,
});
export const AdminUserParams = z.strictObject({ userId: z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/) });
export const AdminReasonBody = z.strictObject({ reason: zReason });
/** A suspension, optionally temporary: it ends by itself at [until] (audited by the job that lifts it). */
export const AdminSuspendBody = z.strictObject({ reason: zReason, until: zTime.optional() });

export const AdminUserSummary = z.strictObject({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  status: z.enum(USER_STATUSES),
  createdAt: zTime,
  suspendedAt: zTime.nullable(),
  activeDevices: zCount,
  lastSeenAt: zTime.nullable(),
  newAccountLimitsUntil: zTime.nullable(),
  /** Last qualifying activity (telemetry; null before collection began or with none since). */
  lastActiveAt: zTime.nullable(),
  /** A temporary suspension's end, if one is set. */
  suspendedUntil: zTime.nullable(),
});

export const AdminUsersPage = z.strictObject({ users: z.array(AdminUserSummary), nextCursor: z.string().nullable() });

export const AdminUserDetail = z.strictObject({
  user: AdminUserSummary,
  account: z
    .strictObject({
      id: z.string(),
      /** Only with users.view_email. */
      email: z.string().nullable(),
      emailVerified: z.boolean(),
      createdAt: zTime,
      disabledAt: zTime.nullable(),
      activeSessions: zCount,
      passkeys: zCount,
    })
    .nullable(),
  devices: z.array(z.strictObject({ id: z.string(), name: z.string(), createdAt: zTime, lastSeenAt: zTime.nullable(), revokedAt: zTime.nullable() })),
  memberships: z.array(z.strictObject({ orgId: z.string(), name: z.string(), kind: z.string(), role: z.string(), joinedAt: zTime, customRoles: z.array(z.string()) })),
  platformRole: zPlatformRole.nullable(),
  securityEvents: z.array(z.strictObject({ at: zTime, action: z.string() })),
  interventions: z.array(z.strictObject({ at: zTime, action: z.string(), outcome: z.string(), actorRole: z.string().nullable(), reason: z.string().nullable() })),
});

export const AdminUserChanged = z.strictObject({ user: AdminUserSummary, changed: z.boolean() });
export const AdminSessionsRevoked = z.strictObject({ accountSessions: zCount, legacySessions: zCount });

// ───────────── Organizations ─────────────

export const ORG_KINDS = ["team", "community"] as const;
export const AdminOrgsQuery = z.strictObject({ q: zSearch, kind: z.enum(ORG_KINDS).optional(), cursor: zCursor.optional(), limit: zLimit });
export const AdminOrgParams = z.strictObject({ orgId: z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/) });

export const AdminOrgSummary = z.strictObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  kind: z.enum(ORG_KINDS),
  visibility: z.string(),
  createdAt: zTime,
  members: zCount,
});

export const AdminOrgsPage = z.strictObject({ organizations: z.array(AdminOrgSummary), nextCursor: z.string().nullable() });

export const AdminOrgDetail = z.strictObject({
  organization: AdminOrgSummary.extend({
    joinPolicy: z.string(),
    updatedAt: zTime,
    invitesPausedUntil: zTime.nullable(),
    dmsPausedUntil: zTime.nullable(),
    guestsAllowed: z.boolean(),
    activityAlerts: z.boolean(),
    raidAlertAt: zTime.nullable(),
  }),
  owners: z.array(z.strictObject({ id: z.string(), username: z.string().nullable() })),
  composition: z.strictObject({ byRole: z.record(z.string(), zCount), customRoles: zCount, bans: zCount, activeInvites: zCount }),
  channels: z.strictObject({ total: zCount, private: zCount }),
  usage: z.strictObject({ days: zCount, metrics: z.record(z.string(), z.number()) }),
  limits: z.array(z.strictObject({ key: z.string(), limit: zCount.nullable(), source: z.enum(["workspace", "plan", "server", "none"]) })),
  /** The subscription that isn't over, if any (docs/BILLING.md); null when there is none. */
  subscription: z.strictObject({ id: z.string(), plan: z.string(), status: z.string(), standing: z.string(), currentPeriodEnd: zTime.nullable() }).nullable(),
  /** Org suspension is designed but not enforced yet (owner's decision 2026-10-23). */
  suspension: z.strictObject({ supported: z.literal(false) }),
});

// ───────────── Entitlements and billing status (phase 4) ─────────────

export const ENTITLEMENT_KEY_VALUES = ["roles.custom", "members", "storage.bytes"] as const;
const zLimitValue = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const AdminEntitlements = z.strictObject({
  /** Whether a billing provider is configured: without one the console says so instead of showing invented figures. */
  billing: z.strictObject({ available: z.boolean(), reason: z.string().nullable() }),
  keys: z.array(z.strictObject({ key: z.string(), label: z.string() })),
  serverLimits: z.array(z.strictObject({ key: z.string(), limit: zCount })),
  overrides: z.array(
    z.strictObject({ orgId: z.string(), orgName: z.string().nullable(), key: z.string(), limit: zCount, setAt: zTime, expiresAt: zTime.nullable(), reason: z.string().nullable() }),
  ),
});

export const AdminLimitsBody = z.strictObject({
  /** null clears an organization's own limit (the server-wide one, if any, applies again). */
  limits: z.partialRecord(z.enum(ENTITLEMENT_KEY_VALUES), zLimitValue.nullable()).refine((l) => Object.keys(l).length > 0, "Change at least one limit"),
  /** When the limits set here stop applying. Required to set a limit; null (no end) is for super admins only. */
  expiresAt: zTime.nullable().optional(),
  reason: zReason,
});
export const AdminLimits = z.strictObject({ limits: z.array(z.strictObject({ key: z.string(), limit: zCount.nullable(), source: z.enum(["workspace", "plan", "server", "none"]) })) });

// ───────────── Infrastructure (phase 4) ─────────────

const zCheckStatus = z.enum(["ok", "failing", "not_measured", "off"]);
export const CONNECTOR_IDS = ["email", "storage", "push-fcm", "mongodb"] as const;

export const AdminInfrastructure = z.strictObject({
  version: z.string(),
  generatedAt: zTime,
  uptimeSeconds: zCount,
  checks: z.array(z.strictObject({ id: z.string(), label: z.string(), status: zCheckStatus, detail: z.string().nullable() })),
  process: z.strictObject({ rssBytes: zCount, heapUsedBytes: zCount, eventLoopDelayP99Ms: z.number().nullable() }),
  onlineDevices: zCount,
  queues: z.strictObject({ deliveryItems: zCount, deliveryOldestAgeSeconds: z.number().int().nullable(), remindersOverdue: zCount, remindersRetrying: zCount }),
  window: z.strictObject({ since: zTime, minutes: zCount, requests: zCount, serverErrors: zCount, errorRate: z.number().nullable(), p95Ms: z.number().nullable() }),
  routes: z.array(z.strictObject({ route: z.string(), count: zCount, clientErrors: zCount, serverErrors: zCount, avgMs: z.number(), p95Ms: z.number().nullable(), maxMs: z.number() })),
  jobs: z.array(z.strictObject({ name: z.string(), runs: zCount, failures: zCount, lastRunAt: zTime.nullable(), lastFailureAt: zTime.nullable(), lastErrorKind: z.string().nullable() })),
  providers: z.array(z.strictObject({ name: z.string(), ok: zCount, failed: zCount, lastOkAt: zTime.nullable(), lastFailureAt: zTime.nullable(), lastErrorKind: z.string().nullable() })),
  connectors: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      category: z.string(),
      state: z.string(),
      missing: z.array(z.string()),
      detail: z.string(),
      lastOkAt: zTime.nullable(),
      lastFailureAt: zTime.nullable(),
      lastErrorKind: z.string().nullable(),
      checkable: z.boolean(),
      ownerAction: z.string().nullable(),
    }),
  ),
  warnings: z.array(z.string()),
});
export const AdminConnectorParams = z.strictObject({ id: z.enum(CONNECTOR_IDS) });
export const AdminConnectorCheck = z.strictObject({ ok: z.boolean(), errorKind: z.string().nullable() });

// ───────────── Incidents (phase 4) ─────────────

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
/** The lifecycle: open → acknowledged → investigating → monitoring → resolved → closed. */
export const INCIDENT_STATUSES = ["open", "acknowledged", "investigating", "monitoring", "resolved", "closed"] as const;
export const INCIDENT_KINDS = ["incident", "maintenance", "support"] as const;
export const zRef = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const zPerson = z.strictObject({ accountId: z.string(), name: z.string().nullable() });
const zService = z.string().trim().min(1).max(60);

export const AdminIncidentsQuery = z.strictObject({
  status: z.enum([...INCIDENT_STATUSES, "active"]).optional(),
  severity: z.enum(["sev1", "sev2", "sev3", "sev4"]).optional(),
  source: z.enum(["manual", "rule"]).optional(),
  kind: z.enum(INCIDENT_KINDS).optional(),
  userRef: zRef.optional(),
  orgRef: zRef.optional(),
  cursor: zCursor.optional(),
  limit: zLimit,
});
export const AdminIncidentParams = z.strictObject({ incidentId: zRef });
export const AdminIncidentCreate = z.strictObject({
  title: z.string().trim().min(3).max(160),
  severity: z.enum(INCIDENT_SEVERITIES),
  kind: z.enum(INCIDENT_KINDS),
  userRef: zRef.optional(),
  orgRef: zRef.optional(),
  notice: z.string().trim().max(2000).optional(),
  description: z.string().trim().min(1).max(4000),
  service: zService.optional(),
});
export const AdminIncidentPatch = z
  .strictObject({
    status: z.enum(INCIDENT_STATUSES).optional(),
    severity: z.enum(INCIDENT_SEVERITIES).optional(),
    assigneeAccountId: zRef.nullable().optional(),
    notice: z.string().trim().max(2000).nullable().optional(),
    /** What happened and what fixed it: required to resolve. */
    resolution: z.string().trim().max(4000).nullable().optional(),
    service: zService.nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "Change at least one thing");
export const AdminIncidentNote = z.strictObject({ body: z.string().trim().min(1).max(4000) });

export const AdminIncident = z.strictObject({
  id: z.string(),
  title: z.string(),
  severity: z.enum(INCIDENT_SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  kind: z.enum(INCIDENT_KINDS),
  service: z.string().nullable(),
  /** Opened by a person, or by an alert rule (ruleKey). */
  source: z.enum(["manual", "rule"]),
  ruleKey: z.string().nullable(),
  firstSeenAt: zTime.nullable(),
  lastSeenAt: zTime.nullable(),
  acknowledgedAt: zTime.nullable(),
  closedAt: zTime.nullable(),
  resolution: z.string().nullable(),
  assignee: zPerson.nullable(),
  userRef: z.string().nullable(),
  orgRef: z.string().nullable(),
  notice: z.string().nullable(),
  createdBy: zPerson,
  createdAt: zTime,
  updatedAt: zTime,
  resolvedAt: zTime.nullable(),
});
export const AdminIncidentsPage = z.strictObject({ incidents: z.array(AdminIncident), nextCursor: z.string().nullable() });
export const AdminIncidentDetail = z.strictObject({
  incident: AdminIncident,
  events: z.array(z.strictObject({ at: zTime, kind: z.enum(["note", "status", "severity", "assign", "created"]), body: z.string(), actor: zPerson })),
});

// ───────────── Audit (phase 4) ─────────────

export const AUDIT_OUTCOMES = ["success", "denied", "failed"] as const;
const zAuditCursor = z.coerce.number().int().positive();
export const AdminAuditQuery = z.strictObject({
  actor: zRef.optional(),
  /** The start of an action name, e.g. "user." or "admin.login". */
  action: z.string().trim().max(60).regex(/^[a-z_.]*$/).optional(),
  targetType: z.string().max(40).regex(/^[a-z_]+$/).optional(),
  targetId: zRef.optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  cursor: zAuditCursor.optional(),
  limit: zLimit,
});
export const AdminAuditRow = z.strictObject({
  id: zCount,
  at: zTime,
  requestId: z.string().nullable(),
  actor: zPerson.nullable(),
  actorRole: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  outcome: z.enum(AUDIT_OUTCOMES),
  reason: z.string().nullable(),
  network: z.string().nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
});
export const AdminAuditPage = z.strictObject({ events: z.array(AdminAuditRow), nextCursor: z.string().nullable() });
export const AdminAuditVerify = z.strictObject({ rows: zCount, brokenAt: zCount.nullable(), lastHash: z.string(), verifiedAt: zTime });

// ───────────── Admins (phase 4) ─────────────

export const AdminAccountParams = z.strictObject({ accountId: zRef });
export const AdminSessionParams = z.strictObject({ sessionId: zRef });
export const AdminGrantBody = z.strictObject({ email: zEmail, role: zPlatformRole, reason: zReason });
export const AdminRoleBody = z.strictObject({ role: zPlatformRole, reason: zReason });

export const AdminEntry = z.strictObject({
  accountId: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: zPlatformRole,
  status: z.enum(["active", "revoked"]),
  grantedAt: zTime,
  grantedBy: zPerson.nullable(),
  revokedAt: zTime.nullable(),
  passkeys: zCount,
  activeSessions: zCount,
  lastSignInAt: zTime.nullable(),
  enrolmentPending: z.boolean(),
});
export const AdminAdminsList = z.strictObject({ admins: z.array(AdminEntry), activeSuperAdmins: zCount });
export const AdminGrantResult = z.strictObject({ admin: AdminEntry, enrolmentCode: z.string().nullable() });
export const AdminSessionsList = z.strictObject({
  sessions: z.array(z.strictObject({ id: z.string(), createdAt: zTime, lastUsedAt: zTime, expiresAt: zTime, idleExpiresAt: zTime, network: z.string(), current: z.boolean() })),
});
/** Who an incident can be assigned to: active admins whose role may manage incidents (names only). */
export const AdminAssignees = z.strictObject({ assignees: z.array(zPerson) });
