import { z } from "zod/v4";
import { zEmail } from "./accounts.js";
import { zCount, zTime } from "./primitives.js";
import { ENTITLEMENT_KEY_VALUES, zCursor, zLimit, zReason } from "./platformAdmin.js";

/**
 * Billing in the Platform Admin Console (docs/BILLING.md): the plan catalog, subscriptions, invoices, provider events
 * and the subscription figures with their definitions. Money is in the currency's minor unit and never converted.
 */

const zMoney = z.array(z.strictObject({ currency: z.string(), amountMinor: zCount }));
const zPlanKey = z.string().trim().regex(/^[a-z][a-z0-9_-]{1,39}$/, "2 to 40 lower-case letters, digits, - or _, starting with a letter");
const zCurrency = z.string().trim().regex(/^[A-Za-z]{3}$/, "A three-letter ISO 4217 code like USD").transform((c) => c.toUpperCase());

export const BILLING_STATUS_VALUES = ["incomplete", "trialing", "active", "past_due", "unpaid", "paused", "canceled", "incomplete_expired"] as const;
export const BILLING_EVENT_STATUS_VALUES = ["received", "processed", "ignored", "failed", "dead"] as const;

// ───────────── Requests ─────────────

export const zPlanTerms = z.strictObject({
  interval: z.enum(["month", "year"]),
  currency: zCurrency,
  /** List price per interval in the currency's minor unit (cents for USD). */
  amountMinor: z.number().int().min(0).max(100_000_000_00),
  /** The provider's price id; needed before publishing. */
  providerPriceRef: z.string().trim().min(1).max(200).nullable(),
  trialDays: z.number().int().min(0).max(365),
  graceDays: z.number().int().min(0).max(60),
  limits: z.partialRecord(z.enum(ENTITLEMENT_KEY_VALUES), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
  notes: z.string().trim().max(1000),
  /** The quota plan (storage and transfer allowances) subscribers are on while the plan grants (API 0.52.0). */
  quotaPlanId: z.string().trim().min(1).max(64).nullable().optional(),
});

const zPlanMeta = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  segment: z.string().trim().max(120),
  public: z.boolean(),
};

/** [audience] is fixed at creation (API 0.52.0; default organization): a plan never changes who it is for. */
export const AdminPlanCreate = z.strictObject({ key: zPlanKey, ...zPlanMeta, audience: z.enum(["personal", "organization"]).optional(), terms: zPlanTerms, reason: zReason });
export const AdminPlanMeta = z.strictObject({ ...zPlanMeta, reason: zReason });
export const AdminPlanTerms = z.strictObject({ terms: zPlanTerms, reason: zReason });
export const AdminBillingPlanParams = z.strictObject({ planId: z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/) });
export const AdminSubscriptionParams = z.strictObject({ subscriptionId: z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/) });
export const AdminBillingEventParams = z.strictObject({ eventId: z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/) });

export const AdminSubscriptionsQuery = z.strictObject({
  status: z.enum(BILLING_STATUS_VALUES).optional(),
  plan: zPlanKey.optional(),
  org: z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  cursor: zCursor.optional(),
  limit: zLimit,
});
export const AdminBillingEventsQuery = z.strictObject({ status: z.enum(BILLING_EVENT_STATUS_VALUES).optional(), cursor: zCursor.optional(), limit: zLimit });
export const AdminBillingMetricsQuery = z.strictObject({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), "7, 30 or 90 days").default(30) });

// ───────────── Answers ─────────────

const zTermsView = z.strictObject({
  interval: z.enum(["month", "year"]),
  currency: z.string(),
  amountMinor: zCount,
  providerPriceRef: z.string().nullable(),
  trialDays: zCount,
  graceDays: zCount,
  limits: z.record(z.string(), zCount),
  notes: z.string(),
  quotaPlanId: z.string().nullable(),
});

const zVersion = z.strictObject({
  id: z.string(),
  version: zCount,
  /** draft: editable; current: what new subscribers get; retired: kept only by existing subscribers. */
  state: z.enum(["draft", "current", "retired"]),
  provider: z.string().nullable(),
  terms: zTermsView,
  createdAt: zTime,
  publishedAt: zTime.nullable(),
  retiredAt: zTime.nullable(),
  subscriptions: z.strictObject({ total: zCount, live: zCount }),
});

export const AdminPlan = z.strictObject({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  segment: z.string(),
  public: z.boolean(),
  audience: z.enum(["personal", "organization"]),
  status: z.enum(["draft", "active", "archived"]),
  createdAt: zTime,
  updatedAt: zTime,
  versions: z.array(zVersion),
});

export const AdminBillingSetup = z.strictObject({
  provider: z.strictObject({ id: z.string(), mode: z.enum(["test", "live"]) }).nullable(),
  /** Why nothing can be bought, when no provider is configured. */
  reason: z.string().nullable(),
  /** The URL path the provider must send webhooks to. */
  webhookPath: z.string().nullable(),
  entitlementKeys: z.array(z.strictObject({ key: z.string(), label: z.string() })),
});

export const AdminPlans = z.strictObject({ setup: AdminBillingSetup, plans: z.array(AdminPlan) });

export const AdminSubscriptionSummary = z.strictObject({
  id: z.string(),
  /** Whose subscription: an organization, or a person's account (API 0.52.0). */
  owner: z.strictObject({ kind: z.enum(["org", "account"]), id: z.string() }),
  org: z.strictObject({ id: z.string(), name: z.string().nullable() }).nullable(),
  plan: z.strictObject({ key: z.string(), name: z.string(), version: zCount }),
  status: z.enum(BILLING_STATUS_VALUES),
  standing: z.enum(["entitled", "grace", "grace_ended", "not_entitled"]),
  provider: z.string(),
  providerSubscriptionRef: z.string(),
  currentPeriodEnd: zTime.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  createdAt: zTime,
  updatedAt: zTime,
});
export const AdminSubscriptionsPage = z.strictObject({ subscriptions: z.array(AdminSubscriptionSummary), nextCursor: z.string().nullable() });

export const AdminSubscriptionDetail = z.strictObject({
  subscription: AdminSubscriptionSummary.extend({
    billingUserId: z.string().nullable(),
    providerCustomerRef: z.string().nullable(),
    currentPeriodStart: zTime.nullable(),
    trialEnd: zTime.nullable(),
    canceledAt: zTime.nullable(),
    pastDueSince: zTime.nullable(),
    terms: zTermsView,
  }),
  history: z.array(z.strictObject({ at: zTime, from: z.string().nullable(), to: z.string(), planVersion: zCount.nullable(), source: z.string(), detail: z.record(z.string(), z.unknown()) })),
  invoices: z.array(
    z.strictObject({
      id: z.string(),
      providerInvoiceRef: z.string(),
      status: z.string(),
      currency: z.string(),
      amountDueMinor: zCount,
      amountPaidMinor: zCount,
      amountRefundedMinor: zCount,
      taxMinor: zCount.nullable(),
      periodStart: zTime.nullable(),
      periodEnd: zTime.nullable(),
      issuedAt: zTime,
      paidAt: zTime.nullable(),
    }),
  ),
  limits: z.array(z.strictObject({ key: z.string(), limit: zCount.nullable(), source: z.enum(["workspace", "plan", "server", "none"]) })),
  events: z.array(z.strictObject({ id: z.string(), type: z.string(), status: z.enum(BILLING_EVENT_STATUS_VALUES), receivedAt: zTime, lastError: z.string().nullable() })),
});

export const AdminBillingEvent = z.strictObject({
  id: z.string(),
  provider: z.string(),
  eventRef: z.string(),
  type: z.string(),
  status: z.enum(BILLING_EVENT_STATUS_VALUES),
  attempts: zCount,
  providerCreatedAt: zTime,
  receivedAt: zTime,
  processedAt: zTime.nullable(),
  nextAttemptAt: zTime.nullable(),
  lastError: z.string().nullable(),
  subscriptionId: z.string().nullable(),
});
export const AdminBillingEventsPage = z.strictObject({ events: z.array(AdminBillingEvent), nextCursor: z.string().nullable() });
export const AdminBillingEventReplay = z.strictObject({ status: z.enum(BILLING_EVENT_STATUS_VALUES) });

export const AdminBillingMetrics = z.strictObject({
  setup: AdminBillingSetup,
  generatedAt: zTime,
  days: zCount,
  subscriptions: z.strictObject({
    byStatus: z.record(z.string(), zCount),
    byPlan: z.array(z.strictObject({ key: z.string(), name: z.string(), subscriptions: zCount })),
    granting: zCount,
    cancellationsScheduled: zCount,
    started: zCount,
    canceled: zCount,
    trialsStarted: zCount,
    trialConversions: zCount,
    trialsEnded: zCount,
    trialsEndingSoon: zCount,
    paidAtStart: zCount,
    logoChurn: z.number().min(0).max(1).nullable(),
  }),
  money: z.strictObject({ mrrEstimate: zMoney, collected: zMoney, refunds: zMoney, outstanding: zMoney, failedPayments: zCount }),
  webhooks: z.strictObject({
    byStatus: z.record(z.string(), zCount),
    rejected: z.array(z.strictObject({ reason: z.string(), count: zCount })),
    backlog: zCount,
    oldestBacklogAt: zTime.nullable(),
    lastReceivedAt: zTime.nullable(),
  }),
  definitions: z.array(z.strictObject({ key: z.string(), label: z.string(), definition: z.string(), kind: z.enum(["measured", "calculated", "estimate"]) })),
});
// ───────────── Meldiq Mojo: trials, invite links and free periods (API 0.58.0) ─────────────

export const GRANT_SOURCE_VALUES = ["signup_trial", "referral_invitee", "referral_inviter", "gift", "operator"] as const;
const zId = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);
const zDays = (max: number) => z.number().int().min(0).max(max);

/** The trial and invite program: whether it's on, from when, which plan it gives and for how long. */
export const zProgramSettings = z.strictObject({
  enabled: z.boolean(),
  /** Trials and invite links count from here (null while off; turning it on without a date starts it now). */
  startsAt: zTime.nullable(),
  planKey: zPlanKey,
  /** Every account's trial. */
  days: zDays(365),
  /** The trial through an invite link, and each inviter's bonus. */
  referralDays: zDays(365),
  /** At most this many bonus days per inviter in any 365 days. */
  referralCapDays: zDays(3650),
  /** An invite link counts only for an account at most this many days old. */
  claimWindowDays: zDays(90),
});

/** Saves the console's program, or ({ useEnvironment: true }) hands the decision back to the server's environment. */
export const AdminProgramBody = z.union([z.strictObject({ useEnvironment: z.literal(true), reason: zReason }), zProgramSettings.extend({ reason: zReason })]);

export const AdminMojoGrantsQuery = z.strictObject({
  account: zId.optional(),
  source: z.enum(GRANT_SOURCE_VALUES).optional(),
  state: z.enum(["active", "upcoming", "over"]).optional(),
  cursor: zCursor.optional(),
  limit: zLimit,
});

/** A free period an operator gives: to an account by id (from its page) or by email (needs users.view_email). */
export const AdminMojoGrantBody = z
  .strictObject({ accountId: zId.optional(), email: zEmail.optional(), days: z.number().int().min(1).max(365), planKey: zPlanKey.optional(), reason: zReason })
  .refine((b) => (b.accountId === undefined) !== (b.email === undefined), "Name the account by id or by email, not both");
export const AdminMojoGrantParams = z.strictObject({ grantId: zId });
export const AdminMojoAccountParams = z.strictObject({ accountId: zId });

const zAccountRef = z.strictObject({
  accountId: z.string(),
  name: z.string().nullable(),
  /** Only with users.view_email. */
  email: z.string().nullable(),
  /** The account's person in the console (users), once it has signed in to an app. */
  userId: z.string().nullable(),
});
const zAdminRef = z.strictObject({ accountId: z.string(), name: z.string().nullable() });

export const AdminMojoGrant = z.strictObject({
  id: z.string(),
  account: zAccountRef,
  planKey: z.string(),
  source: z.enum(GRANT_SOURCE_VALUES),
  startsAt: zTime,
  endsAt: zTime,
  createdAt: zTime,
  /** active: gives the plan now; upcoming: starts later (after another free period); over: ran out; ended: an operator ended it. */
  state: z.enum(["active", "upcoming", "over", "ended"]),
  grantedBy: zAdminRef.nullable(),
  note: z.string().nullable(),
  endedAt: zTime.nullable(),
  endedBy: zAdminRef.nullable(),
});
export const AdminMojoGrantsPage = z.strictObject({ grants: z.array(AdminMojoGrant), nextCursor: z.string().nullable() });
export const AdminMojoGrantChanged = z.strictObject({ grant: AdminMojoGrant, changed: z.boolean() });

export const AdminProgram = z.strictObject({
  /** console: saved here; environment: the server's BILLING_TRIAL_* settings (none saved here yet). */
  source: z.enum(["console", "environment"]),
  settings: zProgramSettings,
  /** On and started: new accounts get a trial and invite links count. */
  live: z.boolean(),
  environment: zProgramSettings,
  updatedBy: zAdminRef.nullable(),
  updatedAt: zTime.nullable(),
  /** Plans a free period can give (personal ones first). */
  plans: z.array(z.strictObject({ key: z.string(), name: z.string(), audience: z.enum(["personal", "organization"]), status: z.enum(["draft", "active", "archived"]), hasLimits: z.boolean() })),
  /** Things to know before relying on the settings (a plan that doesn't exist yet, and so on). */
  warnings: z.array(z.string()),
  figures: z.strictObject({
    accountsInFreePeriod: zCount,
    activeBySource: z.record(z.enum(GRANT_SOURCE_VALUES), zCount),
    referrals: z.strictObject({ total: zCount, last30Days: zCount, inviters: zCount, bonusDaysGiven: zCount, atCap: zCount }),
  }),
  referrals: z.array(z.strictObject({ id: z.string(), inviter: zAccountRef, invitee: zAccountRef, inviterDays: zCount, createdAt: zTime })),
});

export const AdminMojoAccount = z.strictObject({
  account: zAccountRef.extend({ createdAt: zTime }),
  /** What the account has now: a subscription's plan, a free period's, or none. */
  current: z.strictObject({
    plan: z.strictObject({ key: z.string(), name: z.string() }).nullable(),
    from: z.enum(["subscription", "free_period", "none"]),
    accessUntil: zTime.nullable(),
    renews: z.boolean().nullable(),
  }),
  subscriptionId: z.string().nullable(),
  grants: z.array(AdminMojoGrant),
  referral: z.strictObject({ code: z.string().nullable(), invited: zCount, bonusDaysThisYear: zCount, invitedBy: zAccountRef.nullable() }),
});

// ───────────── Meldiq Mojo: enforcement, limits, gifts and Sparks (API 0.58.0, docs/MOJO.md › Running Mojo from the console) ─────────────

const zPlanLimits = z.strictObject({
  messageChars: z.number().int().optional(),
  uploadBytes: z.number().int().optional(),
  sparks: z.number().int().optional(),
  customItems: z.number().int().optional(),
});
const zLevelLimits = z.strictObject({
  sparks: z.number().int().optional(),
  emojiSlots: z.number().int().optional(),
  uploadBytes: z.number().int().optional(),
  voiceKbps: z.number().int().optional(),
});

/** The console's controls: enforcement (null: MOJO_ENFORCE decides) and changes to the built-in numbers (absent keys keep them). */
export const AdminMojoControlsBody = z.strictObject({
  enforce: z.enum(["on", "off", "auto"]).nullable(),
  plans: z.strictObject({ free: zPlanLimits.optional(), go: zPlanLimits.optional(), plus: zPlanLimits.optional() }),
  levels: z.strictObject({ "1": zLevelLimits.optional(), "2": zLevelLimits.optional(), "3": zLevelLimits.optional() }),
  reason: zReason,
});

const zPlanPerksView = z.strictObject({
  key: z.enum(["free", "go", "plus"]),
  name: z.string(),
  listPriceMinor: zCount,
  messageChars: zCount,
  uploadBytes: zCount,
  screen: z.array(z.string()),
  sparks: zCount,
  badge: z.enum(["go", "plus"]).nullable(),
  check: z.boolean(),
  customItems: zCount,
  bots: zCount,
  botReview: z.enum(["regular", "priority"]),
});
const zLevelView = z.strictObject({
  level: zCount,
  sparks: zCount,
  emojiSlots: zCount,
  stickerSlots: zCount,
  uploadBytes: zCount.nullable(),
  voiceKbps: zCount,
  screen: z.array(z.string()),
});

export const AdminMojoControls = z.strictObject({
  /** Whether plan limits apply now, and why. */
  enforced: z.boolean(),
  enforce: z.strictObject({ console: z.enum(["on", "off", "auto"]).nullable(), environment: z.enum(["on", "off", "auto"]), effective: z.enum(["on", "off", "auto"]) }),
  /** The numbers in effect (built-in values with the console's changes), and the built-in ones for comparison. */
  plans: z.array(zPlanPerksView),
  builtInPlans: z.array(zPlanPerksView),
  levels: z.array(zLevelView),
  builtInLevels: z.array(zLevelView),
  overrides: z.strictObject({ plans: z.record(z.string(), z.record(z.string(), z.number())), levels: z.record(z.string(), z.record(z.string(), z.number())) }),
  bounds: z.record(z.string(), z.strictObject({ min: z.number(), max: z.number() })),
  /** The server's own cap on any file (FILE_MAX_BYTES): a plan's larger limit can't go above it. */
  serverFileMaxBytes: zCount,
  catalogVersion: z.string(),
  updatedBy: zAdminRef.nullable(),
  updatedAt: zTime.nullable(),
  figures: z.strictObject({
    accountsByPlan: z.record(z.string(), zCount),
    sparks: z.strictObject({ assigned: zCount, communitiesWithSparks: zCount, byLevel: z.record(z.string(), zCount) }),
    gifts: z.record(z.string(), zCount),
  }),
});

export const AdminMojoGiftsQuery = z.strictObject({ status: z.enum(["pending", "paid", "redeemed", "refunded", "expired", "failed"]).optional(), cursor: zCursor.optional(), limit: zLimit });
/** Gifts as metadata: who, which plan, how long, paid or started. The note people write isn't shown in the console. */
export const AdminMojoGiftsPage = z.strictObject({
  gifts: z.array(
    z.strictObject({
      id: z.string(),
      buyer: zAccountRef,
      recipientUserId: z.string(),
      planKey: z.string(),
      months: zCount,
      currency: z.string(),
      amountMinor: zCount,
      status: z.string(),
      provider: z.string(),
      createdAt: zTime,
      paidAt: zTime.nullable(),
      redeemedAt: zTime.nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

/** The communities with the most active Sparks, and their level. */
export const AdminMojoSparks = z.strictObject({
  communities: z.array(z.strictObject({ orgId: z.string(), name: z.string().nullable(), active: zCount, level: zCount, nextAt: zCount.nullable() })),
});
