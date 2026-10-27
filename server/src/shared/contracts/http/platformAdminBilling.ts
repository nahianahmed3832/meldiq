import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { ENTITLEMENT_KEY_VALUES, zCursor, zLimit, zReason } from "./platformAdmin.js";

/**
 * Billing in the Platform Admin Console (docs/BILLING.md): the plan catalog, subscriptions, invoices, provider events
 * and the subscription figures with their definitions. Money is in the currency's minor unit and never converted.
 */

const zMoney = z.array(z.strictObject({ currency: z.string(), amountMinor: zCount }));
const zPlanKey = z.string().trim().regex(/^[a-z][a-z0-9_-]{1,39}$/, "2 to 40 lower-case letters, digits, - or _, starting with a letter");
const zCurrency = z.string().trim().regex(/^[A-Za-z]{3}$/, "A three-letter ISO 4217 code like USD").transform((c) => c.toUpperCase());

export const BILLING_STATUS_VALUES = ["incomplete", "trialing", "active", "past_due", "paused", "canceled", "incomplete_expired"] as const;
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
});

const zPlanMeta = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  segment: z.string().trim().max(120),
  public: z.boolean(),
};

export const AdminPlanCreate = z.strictObject({ key: zPlanKey, ...zPlanMeta, terms: zPlanTerms, reason: zReason });
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
  org: z.strictObject({ id: z.string(), name: z.string().nullable() }),
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
    billingUserId: z.string(),
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
