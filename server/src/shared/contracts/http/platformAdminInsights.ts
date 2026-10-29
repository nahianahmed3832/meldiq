import { z } from "zod/v4";
import { zEmail, zName, zPassword } from "./accounts.js";
import { zCount, zTime } from "./primitives.js";
import { zCursor, zDay, zLimit, zPerson, zReason, zRef } from "./platformAdmin.js";

/**
 * Platform Admin 2.0 (meldiq_central_admin/docs/ADMIN_2_ASSESSMENT.md): analytics, live connections, devices and
 * sessions, resources and traffic, quotas, settings, alerts, search and exports. Same rules as
 * platformAdmin.ts: strict bodies, every figure either measured or null with a reason. The console mirrors this file.
 */

/** A figure that couldn't be measured is null, never zero; [why] says why. */
const zMaybe = z.number().nullable();
const zBytes = z.number().nonnegative();

// ───────────── Time ranges ─────────────

export const RANGES = ["1h", "24h", "7d", "30d", "90d"] as const;
export const AdminRangeQuery = z.strictObject({ range: z.enum(RANGES).default("24h") });
/** UTC days, inclusive; at most 120 days. */
export const AdminDaysQuery = z.strictObject({ from: zDay.optional(), to: zDay.optional() });

// ───────────── Analytics ─────────────

const zCompare = z.strictObject({ current: zMaybe, previous: zMaybe, change: zMaybe });

export const AdminAnalyticsOverview = z.strictObject({
  generatedAt: zTime,
  range: z.enum(RANGES),
  /** When activity collection began (no figures before it). */
  collectingSince: zTime.nullable(),
  excluded: z.strictObject({ synthetic: zCount, listed: zCount, admins: zCount }),
  people: z.strictObject({ registered: zCount, usable: zCount, suspended: zCount, newAccountLimited: zCount, withSession: zCount }),
  activity: z.strictObject({ dau: zCompare, wau: zCompare, mau: zCompare, activeInRange: zCompare, newSignups: zCompare, dauOverMau: zMaybe, wauOverMau: zMaybe }),
  live: z.strictObject({ users: zCount, activeUsers: zCount, devices: zCount, sockets: zCount, calls: zCount, callParticipants: zCount, peakUsers: zMaybe, peakAt: zTime.nullable() }),
  organizations: z.strictObject({ total: zCount, active: zMaybe, newInRange: zCompare }),
  messaging: z.strictObject({ messagesAccepted: zMaybe, why: z.string() }),
  files: z.strictObject({ uploadedBytes: zMaybe, downloadedBytes: zMaybe, storedWorkspaceBytes: zMaybe }),
  requests: z
    .strictObject({ requests: zMaybe, serverErrors: zMaybe, errorRate: zMaybe, p50Ms: zMaybe, p95Ms: zMaybe, p99Ms: zMaybe, wsAuthFailures: zMaybe, wsAbnormal: zMaybe, wsConnects: zMaybe })
    .nullable(),
  push: z.strictObject({ providers: z.array(z.strictObject({ name: z.string(), ok: zCount, failed: zCount, lastFailureAt: zTime.nullable() })) }).nullable(),
  incidents: z.strictObject({ open: zCount, critical: zCount, breachingRules: zCount }),
  billing: z.strictObject({ available: z.boolean(), reason: z.string().nullable() }),
});

export const AdminActiveUsers = z.strictObject({
  from: z.string(),
  to: z.string(),
  collectingSince: z.string().nullable(),
  definition: z.string(),
  days: z.array(z.strictObject({ day: z.string(), dau: zCount, wau: zCount, mau: zCount, newActive: zCount, returningActive: zCount, collected: z.boolean() })),
});

export const AdminRetention = z.strictObject({
  from: z.string(),
  to: z.string(),
  collectingSince: z.string().nullable(),
  cohorts: z.array(z.strictObject({ day: z.string(), size: zCount, d1: zMaybe, d7: zMaybe, d30: zMaybe })),
  activation: z.strictObject({ eligible: zCount, activated: zCount, rate: zMaybe, medianMsToFirstAction: zMaybe, windowDays: zCount }),
  definitions: z.record(z.string(), z.string()),
});

export const AdminClients = z.strictObject({
  from: z.string(),
  to: z.string(),
  platforms: z.array(z.strictObject({ platform: z.string(), users: zCount, requests: zCount })),
  versions: z.array(z.strictObject({ platform: z.string(), version: z.string(), users: zCount })),
  accountAge: z.array(z.strictObject({ bucket: z.string(), users: zCount })),
  note: z.string(),
});

export const AdminOrgActivity = z.strictObject({
  from: z.string(),
  to: z.string(),
  organizations: z.array(z.strictObject({ id: z.string(), name: z.string(), kind: z.string(), members: zCount, activeMembers: zCount, lastActiveAt: zTime.nullable() })),
});

const zTrafficMetric = z.enum(["api.in", "api.out", "ws.in", "ws.out", "files.upload", "files.download"]);
export const AdminTraffic = z.strictObject({
  from: z.string(),
  to: z.string(),
  totals: z.record(z.string(), zBytes),
  days: z.array(z.strictObject({ day: z.string(), metric: zTrafficMetric, value: zBytes })),
  topUsers: z.array(z.strictObject({ userId: z.string(), username: z.string().nullable(), total: zBytes, byMetric: z.record(z.string(), zBytes) })),
  network: z.strictObject({
    hostTxBytes: zMaybe,
    hostRxBytes: zMaybe,
    apiTxBytes: zMaybe,
    apiRxBytes: zMaybe,
    services: z.array(z.strictObject({ service: z.string(), txBytes: zMaybe, rxBytes: zMaybe })),
    source: z.string(),
  }),
  costs: z.strictObject({
    transferAllowanceBytes: zMaybe,
    projectedMonthHostTxBytes: zMaybe,
    storageEstimateMicro: zMaybe,
    egressEstimateMicro: zMaybe,
    serverMonthlyMicro: zMaybe,
    sources: z.record(z.string(), z.string()),
    note: z.string(),
  }),
  notes: z.array(z.string()),
});

// ───────────── Live connections ─────────────

export const AdminPresence = z.strictObject({
  generatedAt: zTime,
  range: z.enum(RANGES),
  now: z.strictObject({ users: zCount, activeUsers: zCount, devices: zCount, sockets: zCount, platforms: z.record(z.string(), zCount), calls: zCount, callParticipants: zCount }),
  resolution: z.enum(["minute", "hour"]),
  points: z.array(z.strictObject({ at: zTime, users: zCount, activeUsers: zCount, sockets: zCount, connects: zCount, disconnects: zCount, abnormal: zCount, authFailures: zCount })),
  peakUsers: zMaybe,
  peakAt: zTime.nullable(),
  totals: z.strictObject({ connects: zCount, disconnects: zCount, abnormal: zCount, authFailures: zCount }),
  avgConnectionMinutes: zMaybe,
  definitions: z.record(z.string(), z.string()),
  screenSharing: z.strictObject({ available: z.literal(false), why: z.string() }),
});

export const AdminConnections = z.strictObject({
  connections: z.array(
    z.strictObject({
      userId: z.string(),
      username: z.string().nullable(),
      deviceId: z.string(),
      session: z.string().nullable(),
      platform: z.string(),
      client: z.string(),
      version: z.string(),
      openedAt: zTime,
      lastFrameAt: zTime.nullable(),
    }),
  ),
  truncated: z.boolean(),
});
export const AdminDisconnectBody = z.strictObject({ userId: zRef, deviceId: zRef.optional(), reason: zReason });
export const AdminDisconnected = z.strictObject({ sockets: zCount });

// ───────────── Devices and sessions ─────────────

export const AdminDevicesQuery = z.strictObject({
  platform: z.enum(["android", "ios", "web", "other", "unknown"]).optional(),
  /** Devices not seen for at least this many days (stale). */
  staleDays: z.coerce.number().int().min(1).max(365).optional(),
  status: z.enum(["active", "revoked"]).optional(),
  cursor: zCursor.optional(),
  limit: zLimit,
});

const zDeviceRow = z.strictObject({
  id: z.string(),
  userId: z.string(),
  username: z.string().nullable(),
  name: z.string(),
  createdAt: zTime,
  lastSeenAt: zTime.nullable(),
  revokedAt: zTime.nullable(),
  platform: z.string().nullable(),
  client: z.string().nullable(),
  version: z.string().nullable(),
  os: z.string().nullable(),
  online: z.boolean(),
  push: z.strictObject({ fcm: z.enum(["none", "ok", "failing"]), unifiedPush: z.enum(["none", "ok", "failing"]), lastWakeAt: zTime.nullable() }),
});
export const AdminDevicesPage = z.strictObject({ devices: z.array(zDeviceRow), nextCursor: z.string().nullable(), counts: z.strictObject({ active: zCount, revoked: zCount, online: zCount }) });

export const AdminUserDevices = z.strictObject({
  devices: z.array(zDeviceRow),
  sessions: z.array(
    z.strictObject({
      id: z.string(),
      /** The session id with its middle hidden. */
      masked: z.string(),
      label: z.string(),
      deviceId: z.string().nullable(),
      createdAt: zTime,
      lastUsedAt: zTime,
      expiresAt: zTime,
      idleExpiresAt: zTime,
      revokedAt: zTime.nullable(),
      revokeReason: z.string().nullable(),
      state: z.enum(["active", "expired", "revoked"]),
      client: z.string().nullable(),
      platform: z.string().nullable(),
      connected: z.boolean(),
    }),
  ),
  legacySessions: zCount,
  connections: z.array(z.strictObject({ deviceId: z.string(), platform: z.string(), client: z.string(), openedAt: zTime, lastFrameAt: zTime.nullable() })),
  authHistory: z.array(z.strictObject({ at: zTime, event: z.string(), detail: z.string().nullable() })),
  findings: z.array(z.string()),
});
export const AdminSessionTarget = z.strictObject({ userId: zRef, sessionId: zRef });
export const AdminDeviceTarget = z.strictObject({ userId: zRef, deviceId: zRef });

// ───────────── People and organizations: insights and actions ─────────────

export const AdminUserInsights = z.strictObject({
  activity: z.array(z.strictObject({ day: z.string(), platform: z.string(), version: z.string(), requests: zCount, actions: zCount, firstAt: zTime, lastAt: zTime })),
  traffic30d: z.record(z.string(), zBytes),
  quotas: z.array(z.lazy(() => zEffectiveQuota)),
  restriction: z.strictObject({ until: zTime.nullable(), reason: z.string(), setAt: zTime }).nullable(),
  incidents: z.array(z.strictObject({ id: z.string(), title: z.string(), status: z.string(), kind: z.string(), createdAt: zTime })),
  deletion: z.strictObject({ possible: z.boolean(), blockers: z.array(z.string()) }),
  verification: z.strictObject({ emailVerified: z.boolean().nullable(), mailAvailable: z.boolean() }),
});
export const AdminDeleteUserBody = z.strictObject({ reason: zReason, confirm: z.string().trim().min(1).max(254) });
export const AdminDeletedUser = z.strictObject({ deleted: z.literal(true), summary: z.record(z.string(), z.unknown()) });
export const AdminSent = z.strictObject({ sent: z.boolean(), detail: z.string() });

export const AdminOrgInsights = z.strictObject({
  activeMembers30d: zCount,
  activeMembers7d: zCount,
  lastActiveAt: zTime.nullable(),
  storageBytes: zMaybe,
  usage30d: z.record(z.string(), z.number()),
  quotas: z.array(z.lazy(() => zEffectiveQuota)),
  incidents: z.array(z.strictObject({ id: z.string(), title: z.string(), status: z.string(), kind: z.string(), createdAt: zTime })),
  health: z.array(z.string()),
});
export const AdminOrgMemberTarget = z.strictObject({ orgId: zRef, userId: zRef });
export const AdminMemberRemoved = z.strictObject({ removed: z.boolean() });

// ───────────── Resources ─────────────

const zSeriesStats = z.strictObject({
  series: z.string(),
  resolution: z.enum(["minute", "hour"]),
  points: z.array(z.strictObject({ at: zTime, value: z.number(), min: z.number().optional(), max: z.number().optional() })),
  latest: zMaybe,
  latestAt: zTime.nullable(),
  min: zMaybe,
  avg: zMaybe,
  max: zMaybe,
  p95: zMaybe,
});
export const AdminSeriesQuery = z.strictObject({ series: z.string().regex(/^[a-z0-9_.,]{1,400}$/), range: z.enum(RANGES).default("24h") });
export const AdminSeries = z.strictObject({ range: z.enum(RANGES), series: z.array(zSeriesStats) });

export const AdminResources = z.strictObject({
  generatedAt: zTime,
  server: z.strictObject({
    name: z.string().nullable(),
    provider: z.string(),
    environment: z.string(),
    os: z.string().nullable(),
    kernel: z.string().nullable(),
    cpus: zMaybe,
    uptimeSeconds: zMaybe,
    /** Provisioned (in the deployment config) → reachable (this process runs on it) → monitored (samples arriving). */
    coverage: z.strictObject({ processMetrics: z.boolean(), hostMetrics: z.boolean(), collector: z.enum(["not_configured", "reporting", "stale"]), lastCollectorAt: zTime.nullable() }),
    version: z.string(),
    startedAt: zTime,
    versions: z.array(z.strictObject({ version: z.string(), firstStartedAt: zTime })),
  }),
  now: z.record(z.string(), z.strictObject({ value: z.number(), at: zTime })),
  services: z.array(
    z.strictObject({
      service: z.string(),
      label: z.string(),
      cpuPct: zMaybe,
      memBytes: zMaybe,
      memLimitBytes: zMaybe,
      netRxBps: zMaybe,
      netTxBps: zMaybe,
      ioReadBps: zMaybe,
      ioWriteBps: zMaybe,
      source: z.string(),
    }),
  ),
  capacity: z.array(z.strictObject({ resource: z.string(), used: zMaybe, total: zMaybe, pct: zMaybe, projection: z.string().nullable() })),
  /** All live attachments in the file store (measured hourly). */
  files: z.strictObject({ storedBytes: zMaybe, storedCount: zMaybe }),
  database: z.strictObject({ sizeBytes: zMaybe, walBytes: zMaybe, growthPerDayBytes: zMaybe, engine: z.string() }),
  unavailable: z.array(z.strictObject({ what: z.string(), why: z.string() })),
});

// ───────────── Quotas ─────────────

const zQuotaMode = z.enum(["observe", "warn", "soft", "throttle", "block"]);
const zScopeType = z.enum(["global", "pool", "plan", "org", "user"]);

const zPolicy = z.strictObject({
  id: z.string(),
  scopeType: zScopeType,
  scopeId: z.string(),
  scopeName: z.string().nullable(),
  key: z.string(),
  limit: zMaybe,
  mode: zQuotaMode,
  hard: z.boolean(),
  warnPct: zCount,
  gracePct: zCount,
  override: z.boolean(),
  expiresAt: zTime.nullable(),
  reason: z.string(),
  createdBy: zPerson,
  createdAt: zTime,
  supersededAt: zTime.nullable(),
});

export const zEffectiveQuota = z.strictObject({
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  scope: z.strictObject({ type: z.string(), id: z.string() }),
  source: z.enum(["override", "own", "plan", "default", "hard_default", "none"]),
  policyId: z.string().nullable(),
  limit: zMaybe,
  mode: zQuotaMode,
  used: zMaybe,
  reserved: zMaybe,
  period: z.string(),
  resetsAt: zTime.nullable(),
  /** Other limits that also apply (the server's environment, a workspace limit): shown so the full picture is clear. */
  alsoLimitedBy: z.array(z.string()),
});

export const AdminQuotas = z.strictObject({
  keys: z.array(z.strictObject({ key: z.string(), label: z.string(), unit: z.string(), kind: z.string(), period: z.string(), scopes: z.array(z.string()), enforceable: z.array(z.string()), enforcedAt: z.string() })),
  policies: z.array(zPolicy),
  plans: z.array(z.strictObject({ id: z.string(), name: z.string(), description: z.string(), members: zCount, createdAt: zTime })),
  serverLimits: z.array(z.strictObject({ name: z.string(), value: z.string(), appliesTo: z.string() })),
  usage: z.array(z.strictObject({ key: z.string(), scopeType: z.string(), scopeId: z.string(), scopeName: z.string().nullable(), period: z.string(), used: zCount, reserved: zCount, limit: zMaybe, pct: zMaybe })),
  events: z.strictObject({ last24h: z.record(z.string(), zCount) }),
  resolution: z.string(),
});
export const AdminQuotaEffectiveQuery = z.strictObject({ scopeType: z.enum(["org", "user"]), scopeId: zRef });
export const AdminQuotaEffective = z.strictObject({ quotas: z.array(zEffectiveQuota) });

export const AdminPolicyBody = z.strictObject({
  scopeType: zScopeType,
  scopeId: z.string().max(64).regex(/^[A-Za-z0-9_:-]*$/),
  key: z.string().max(60),
  limit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  mode: zQuotaMode,
  hard: z.boolean().default(false),
  warnPct: z.number().int().min(1).max(100).default(80),
  gracePct: z.number().int().min(0).max(100).default(0),
  override: z.boolean().default(false),
  expiresAt: zTime.nullable().default(null),
  reason: zReason,
});
export const AdminPolicyParams = z.strictObject({ policyId: zRef });
export const AdminPolicySaved = z.strictObject({ policy: zPolicy, impact: z.strictObject({ scopesOverNow: zCount, note: z.string() }) });
export const AdminPlanBody = z.strictObject({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).default(""), reason: zReason });
export const AdminPlanParams = z.strictObject({ planId: zRef });
export const AdminPlanMemberBody = z.strictObject({ scopeType: z.enum(["org", "user"]), scopeId: zRef, reason: zReason });
export const AdminAdjustBody = z.strictObject({ key: z.string().max(60), scopeType: z.enum(["global", "pool", "org", "user"]), scopeId: z.string().max(64).regex(/^[A-Za-z0-9_:-]*$/), delta: z.number().int(), reason: zReason });
export const AdminQuotaEventsQuery = z.strictObject({ key: z.string().max(60).optional(), scopeType: z.string().max(10).optional(), scopeId: zRef.optional(), cursor: z.coerce.number().int().positive().optional(), limit: zLimit });
export const AdminQuotaEvents = z.strictObject({
  events: z.array(
    z.strictObject({ id: zCount, at: zTime, key: z.string(), scopeType: z.string(), scopeId: z.string(), outcome: z.string(), amount: z.number(), used: z.number(), limit: zMaybe, actor: zPerson.nullable(), detail: z.string().nullable() }),
  ),
  nextCursor: z.number().nullable(),
});

// ───────────── Settings and alerts ─────────────

export const AdminSettings = z.strictObject({
  settings: z.array(z.strictObject({ key: z.string(), label: z.string(), description: z.string(), value: z.unknown(), default: z.unknown(), updatedBy: zPerson.nullable(), updatedAt: zTime.nullable() })),
  experiments: z.array(z.strictObject({ id: z.string(), description: z.string(), status: z.string(), effectiveStatus: z.string() })),
  environment: z.array(z.strictObject({ name: z.string(), value: z.string() })),
});
export const AdminSettingParams = z.strictObject({ key: z.string().max(60).regex(/^[a-z_.]+$/) });
export const AdminSettingBody = z.strictObject({ value: z.unknown(), reason: zReason });

const zSeverity = z.enum(["sev1", "sev2", "sev3", "sev4"]);
export const AdminAlerts = z.strictObject({
  rules: z.array(
    z.strictObject({
      key: z.string(),
      label: z.string(),
      service: z.string(),
      unit: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      threshold: z.number(),
      windowMinutes: zCount,
      severity: zSeverity,
      isDefault: z.boolean(),
      state: z.strictObject({ breaching: z.boolean(), since: zTime.nullable(), lastValue: zMaybe, lastEvalAt: zTime.nullable(), incidentId: z.string().nullable() }),
    }),
  ),
  deliveries: z.array(z.strictObject({ at: zTime, incidentId: z.string(), channel: z.string(), outcome: z.string(), detail: z.string().nullable() })),
});
export const AdminRuleParams = z.strictObject({ key: z.string().max(60).regex(/^[a-z_.]+$/) });
export const AdminRuleBody = z.strictObject({ enabled: z.boolean(), threshold: z.number().min(0).max(1e12), windowMinutes: z.number().int().min(1).max(1440), severity: zSeverity, reason: zReason });

// ───────────── Search and exports ─────────────

export const AdminSearchQuery = z.strictObject({ q: z.string().trim().min(2).max(120) });
export const AdminSearch = z.strictObject({
  users: z.array(z.strictObject({ id: z.string(), username: z.string(), displayName: z.string(), status: z.string() })).nullable(),
  organizations: z.array(z.strictObject({ id: z.string(), name: z.string(), kind: z.string() })).nullable(),
  incidents: z.array(z.strictObject({ id: z.string(), title: z.string(), status: z.string() })).nullable(),
  devices: z.array(z.strictObject({ id: z.string(), userId: z.string(), name: z.string() })).nullable(),
  audit: z.array(z.strictObject({ id: zCount, at: zTime, action: z.string() })).nullable(),
  sections: z.array(z.string()),
});

export const EXPORT_KINDS = ["users", "organizations", "devices", "audit", "incidents", "quota-events", "active-users"] as const;
export const AdminExportParams = z.strictObject({ kind: z.enum(EXPORT_KINDS) });
export const AdminExportQuery = z.strictObject({ from: zDay.optional(), to: zDay.optional(), reason: zReason });

// ───────────── Platform controls (docs/PLATFORM_CONTROLS.md) ─────────────

/** A domain name like example.com: lower-case labels of letters, digits and hyphens, at least one dot. */
const zDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "A domain like example.com");

export const SIGNUP_MODES = ["environment", "open", "invite", "closed"] as const;

/** Each control's value: what the server does while it's set. */
export const CONTROL_SCHEMAS = {
  /** On: every app request answers 503 with [message]; health, server info, webhooks and the console keep working. */
  maintenance: z.strictObject({ enabled: z.boolean(), message: z.string().trim().max(280) }),
  /** environment: the server's REGISTRATION_MODE; open, invite (an invitation code) or closed (no new accounts). */
  signups: z.strictObject({ mode: z.enum(SIGNUP_MODES) }),
  /** New accounts can't use an address at these domains or their subdomains. */
  email_domains: z.strictObject({ blocked: z.array(zDomain).max(2000) }),
  /** Kill switches: false stops new calls (start and join), new uploads, or new organizations. */
  features: z.strictObject({ calls: z.boolean(), uploads: z.boolean(), orgCreation: z.boolean() }),
} as const;
export const CONTROL_KEYS = Object.keys(CONTROL_SCHEMAS) as (keyof typeof CONTROL_SCHEMAS)[];

const zControl = <T extends z.ZodType>(value: T) => z.strictObject({ value, updatedBy: zPerson.nullable(), updatedAt: zTime.nullable() });

export const AdminControls = z.strictObject({
  controls: z.strictObject({
    maintenance: zControl(CONTROL_SCHEMAS.maintenance),
    signups: zControl(CONTROL_SCHEMAS.signups),
    email_domains: zControl(CONTROL_SCHEMAS.email_domains),
    features: zControl(CONTROL_SCHEMAS.features),
  }),
  /** The sign-up mode the server's environment sets, and the one in force once the control is applied. */
  signups: z.strictObject({ environment: z.enum(["open", "invite"]), effective: z.enum(["open", "invite", "closed"]) }),
});
export const AdminControlParams = z.strictObject({ key: z.string().max(40).regex(/^[a-z_]+$/) });
export const AdminControlBody = z.strictObject({ value: z.unknown(), reason: zReason });

// ───────────── Site and legal details (API 0.60.0, docs/SITE_DETAILS.md) ─────────────

const zDetailText = (max: number) => z.string().trim().min(1).max(max).nullable();
const zContactEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter an email address like support@example.com")
  .nullable();

/**
 * What the website and apps say about who runs Meldiq and its policies, edited in the console instead of written into
 * code. A null field isn't decided yet: the website shows it as "to be confirmed", never an invented value.
 */
export const SiteDetails = z.strictObject({
  operator: z.strictObject({
    legalName: zDetailText(120),
    /** The registered address, as it should be printed. */
    address: zDetailText(300),
    /** Where the company is organised, e.g. "Delaware, USA". */
    jurisdiction: zDetailText(120),
    registration: zDetailText(120),
    governingLaw: zDetailText(300),
  }),
  contacts: z.strictObject({
    supportEmail: zContactEmail,
    privacyEmail: zContactEmail,
    /** The data protection contact or representative, where one is required. */
    dpo: zDetailText(300),
  }),
  policies: z.strictObject({
    minimumAge: z.number().int().min(13).max(21).nullable(),
    /** Days after a payment in which a refund can be asked for. */
    refundWindowDays: z.number().int().min(0).max(90).nullable(),
    /** The specific refund rules, as people read them (plain text; blank lines separate paragraphs). */
    refundRules: zDetailText(4000),
    /** How long Meldiq Mojo stays on after a renewal payment fails, while it's retried. */
    failedPaymentGraceDays: z.number().int().min(0).max(30).nullable(),
    /** The legal bases for processing, per purpose (privacy policy). */
    legalBases: zDetailText(4000),
    /** How long billing records are kept. */
    billingRecordRetention: zDetailText(500),
    /** Safeguards for international transfers of personal data. */
    transferSafeguards: zDetailText(2000),
  }),
  /** The date the legal pages were last changed (YYYY-MM-DD). */
  legalUpdatedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date like 2026-10-29"),
});

export const AdminSiteDetailsBody = z.strictObject({ details: SiteDetails, reason: zReason });
export const AdminSiteDetails = z.strictObject({
  details: SiteDetails,
  /** Fields still to be decided (null), by their path, e.g. "operator.address". */
  missing: z.array(z.string()),
  updatedBy: z.strictObject({ accountId: z.string(), name: z.string().nullable() }).nullable(),
  updatedAt: zTime.nullable(),
});

// ───────────── Accounts created from the console (docs/ADMIN_ACCOUNTS.md) ─────────────

/**
 * How a console-made account proves its email: verified (no code, the operator vouches), static_code (a fixed six-digit
 * code the operator sets, for testers; works only for this account's email verification) or email (the normal emailed
 * code, as after a public sign-up).
 */
export const ACCOUNT_VERIFICATION_VALUES = ["verified", "static_code", "email"] as const;
const zStaticCode = z.string().regex(/^\d{6}$/, "Six digits");
const zVerification = z.strictObject({
  verification: z.enum(ACCOUNT_VERIFICATION_VALUES),
  /** Only with static_code. */
  staticCode: zStaticCode.optional(),
  /** Only with static_code: after this instant the fixed code stops working (the emailed code still does). */
  codeExpiresAt: zTime.optional(),
});
const fixedCodeOnly = (b: { verification: string; staticCode?: string; codeExpiresAt?: number }) =>
  (b.verification === "static_code") === (b.staticCode !== undefined) && (b.codeExpiresAt === undefined || b.verification === "static_code");
const FIXED_CODE_MESSAGE = "A fixed code (and its end) goes with fixed-code verification only, and that needs one";

export const AdminAccountCreateBody = zVerification
  .extend({
    name: zName,
    email: zEmail,
    /** Omitted: the server makes a strong one and answers it once. */
    password: zPassword.optional(),
    /** Marks the account as a tester's (shown in the console; nothing else changes). */
    tester: z.boolean().default(false),
    note: z.string().trim().max(200).optional(),
    /** With email verification: send the code now (it can be sent again from the app or the console). */
    sendCode: z.boolean().default(true),
    reason: zReason,
  })
  .refine(fixedCodeOnly, FIXED_CODE_MESSAGE);
export const AdminAccountVerificationBody = zVerification.extend({ reason: zReason }).refine(fixedCodeOnly, FIXED_CODE_MESSAGE);
export const AdminCreatedAccountParams = z.strictObject({ accountId: zRef });
export const AdminCreatedAccountsQuery = z.strictObject({ cursor: zCursor.optional(), limit: zLimit });

export const AdminCreatedAccount = z.strictObject({
  accountId: z.string(),
  name: z.string(),
  /** Only with users.view_email. */
  email: z.string().nullable(),
  verification: z.enum(ACCOUNT_VERIFICATION_VALUES),
  /** The address is verified (signing in works). */
  verified: z.boolean(),
  codeExpiresAt: zTime.nullable(),
  tester: z.boolean(),
  note: z.string().nullable(),
  /** The person in the console (users), once they've set up the app. */
  userId: z.string().nullable(),
  /** False: the account was deleted since. */
  exists: z.boolean(),
  createdBy: zPerson,
  createdAt: zTime,
  updatedAt: zTime,
});
export const AdminCreatedAccountsPage = z.strictObject({ accounts: z.array(AdminCreatedAccount), nextCursor: z.string().nullable() });
export const AdminAccountCreated = z.strictObject({
  account: AdminCreatedAccount,
  /** The generated password, shown once; null when the operator chose it. */
  password: z.string().nullable(),
  codeSent: z.boolean(),
});
