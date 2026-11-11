import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { grantsPlan, SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "./lifecycle.js";

/**
 * Subscription and billing figures for the console (docs/BILLING.md › Metrics, definitions repeated in the answer).
 * Money is summed per currency in integer minor units and never converted. Every figure comes from rows that verified
 * provider events wrote; with no subscriptions the counts are real zeros, and the console says when billing isn't set up.
 */
const DAY_MS = 86_400_000;

type Money = { currency: string; amountMinor: number }[];
export const BILLING_METRIC_MODES = ["unclassified", "test", "live"] as const;
export type BillingMetricMode = typeof BILLING_METRIC_MODES[number];
export interface BillingMetricFilter { provider?: string; currency?: string; mode?: BillingMetricMode; }
const environmentOf = (row: { provider_mode: string | null }) => row.provider_mode === "test" || row.provider_mode === "live" ? row.provider_mode : "unclassified";
const exact = (value: bigint) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("The monetary total exceeds the safe reporting range.");
  return result;
};
const integer = (value: number) => {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid stored monetary amount.");
  return BigInt(value);
};
const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);

const money = (rows: { currency: string; n: number | null }[]): Money =>
  rows.filter((r) => r.n !== null && r.n >= 0).map((r) => ({ currency: r.currency, amountMinor: r.n ?? 0 }));

interface SubRow {
  provider_mode: string | null;
  id: string;
  provider: string;
  quantity: number;
  status: SubscriptionStatus;
  past_due_since: number | null;
  plan_version_id: string;
  cancel_at_period_end: number;
  created_at: number;
  trial_end: number | null;
}
interface HistRow {
  id: number;
  subscription_id: string;
  at: number;
  from_status: string | null;
  to_status: string;
}
interface InvRow {
  provider_mode: string | null;
  provider: string;
  status: string;
  currency: string;
  amount_due_minor: number;
  amount_paid_minor: number;
  amount_refunded_minor: number;
  paid_at: number | null;
  updated_at: number;
}

/** Sums [value] per currency over [rows] (SQL's SUM … GROUP BY currency). */
function perCurrency<R extends { currency: string }>(rows: readonly R[], value: (r: R) => number): Money {
  const sums = new Map<string, bigint>();
  for (const r of rows) sums.set(r.currency, (sums.get(r.currency) ?? 0n) + integer(value(r)));
  return money([...sums].sort(([a], [b]) => a.localeCompare(b)).map(([currency, n]) => ({ currency, n: exact(n) })));
}

export function billingMetrics(rows: RowReader, days: number, t: number, filter: BillingMetricFilter = {}) {
  const since = t - days * DAY_MS;
  const mode = filter.mode ?? "unclassified";

  // Subscriptions granting a plan now, with their terms, for plan distribution and the MRR estimate.
  const versions = new Map(rows.all<{ id: string; plan_id: string; grace_days: number; billing_frequency: number; interval: "month" | "year"; currency: string; amount_minor: number }>("billing_plan_versions").map((v) => [v.id, v]));
  const plans = new Map(rows.all<{ id: string; key: string; name: string }>("billing_plans").map((p) => [p.id, p]));
  const providerWhere = filter.provider ? { provider: filter.provider } : {};
  const allSubs = rows.all<SubRow>("billing_subscriptions", { where: providerWhere }).filter(s => s.created_at < t && (!filter.currency || versions.get(s.plan_version_id)?.currency === filter.currency));
  const subs = allSubs.filter(s => environmentOf(s) === mode);
  const subIds = new Set(subs.map(s => s.id));
  const byStatus = Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, subs.filter((x) => x.status === s).length])) as Record<SubscriptionStatus, number>;
  const live = subs.flatMap((s) => {
    const v = versions.get(s.plan_version_id);
    const p = v ? plans.get(v.plan_id) : undefined;
    if (!v || !p || !["trialing", "active", "past_due"].includes(s.status)) return [];
    return [{ ...s, grace_days: v.grace_days, billing_frequency: v.billing_frequency ?? 1, interval: v.interval, currency: v.currency, amount_minor: v.amount_minor, plan_key: p.key, plan_name: p.name }];
  });
  const granting = live.filter((s) => grantsPlan({ status: s.status, pastDueSince: s.past_due_since, graceDays: s.grace_days }, t));
  const byPlan = new Map<string, { key: string; name: string; subscriptions: number }>();
  for (const s of granting) byPlan.set(s.plan_key, { key: s.plan_key, name: s.plan_name, subscriptions: (byPlan.get(s.plan_key)?.subscriptions ?? 0) + 1 });
  // Exact rational arithmetic: normalize each price × quantity to months, then round down ONCE per currency.
  // This is a list-price estimate, not revenue or provider collections.
  const monthly = new Map<string, { numerator: bigint; denominator: bigint }>();
  for (const s of granting.filter(s => s.status !== "trialing")) {
    const denominator = BigInt((s.interval === "year" ? 12 : 1) * s.billing_frequency);
    if (denominator <= 0n) throw new Error("Invalid stored billing frequency.");
    const numerator = integer(s.amount_minor) * integer(s.quantity ?? 1);
    const prior = monthly.get(s.currency) ?? { numerator: 0n, denominator: 1n };
    const total = prior.numerator * denominator + numerator * prior.denominator;
    const divisor = prior.denominator * denominator;
    const common = gcd(total, divisor);
    monthly.set(s.currency, { numerator: total / common, denominator: divisor / common });
  }
  const mrr = [...monthly].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, amountMinor: exact(value.numerator / value.denominator) }));

  const history = rows.all<HistRow>("billing_subscription_history", { where: { subscription_id: { in: [...subIds] }, at: { lt: t } }, orderBy: [["id", "asc"]] });
  const recent = history.filter((h) => h.at >= since);
  const started = subs.filter((s) => s.created_at >= since).length;
  const trialsStarted = recent.filter((h) => h.from_status === null && h.to_status === "trialing").length;
  const trialConversions = recent.filter((h) => h.from_status === "trialing" && h.to_status === "active").length;
  const trialsEnded = recent.filter((h) => h.from_status === "trialing" && h.to_status !== "trialing").length;
  const canceled = new Set(recent.filter((h) => h.to_status === "canceled" && h.from_status !== "canceled").map(h => h.subscription_id)).size;
  // Each subscription's status at the window's start: its last history entry at or before it.
  const statusAt = new Map<string, string>();
  for (const h of history) if (h.at <= since) statusAt.set(h.subscription_id, h.to_status);
  const paidAtStartIds = subs.filter((s) => ["active", "past_due"].includes(statusAt.get(s.id) ?? "")).map((s) => s.id);
  const paidAtStart = paidAtStartIds.length;
  const canceledSince = new Set(history.filter((h) => h.to_status === "canceled" && h.at > since).map((h) => h.subscription_id));
  const paidAtStartCanceled = paidAtStartIds.filter((id) => canceledSince.has(id)).length;
  const trialsEndingSoon = subs.filter((s) => s.status === "trialing" && s.trial_end !== null && s.trial_end >= t && s.trial_end <= t + 7 * DAY_MS).length;

  const allInvoices = rows.all<InvRow>("billing_invoices", { where: { ...providerWhere, ...(filter.currency ? { currency: filter.currency } : {}) } });
  const invoices = allInvoices.filter(invoice => environmentOf(invoice) === mode);
  const paid = invoices.filter((i) => i.status === "paid" && i.paid_at !== null && i.paid_at >= since && i.paid_at < t);
  const collected = perCurrency(paid, (i) => i.amount_paid_minor);
  // Historical invoice snapshots keep a cumulative refunded amount but no refund timestamp. Do not invent a refund flow.
  const refunds = perCurrency(invoices, (i) => i.amount_refunded_minor);
  const outstanding = perCurrency(invoices.filter((i) => i.status === "open" || i.status === "payment_failed"), (i) => Math.max(0, i.amount_due_minor - i.amount_paid_minor));
  const failedPayments = invoices.filter((i) => i.status === "payment_failed" && i.updated_at >= since && i.updated_at < t).length;

  const allEvents = rows.all<{ status: string; received_at: number; provider_mode: string | null }>("billing_provider_events", { where: { ...providerWhere, received_at: { lt: t } } });
  const events = allEvents.filter(event => environmentOf(event) === mode);
  const eventRows = ["received", "processed", "ignored", "failed", "dead"].map((status) => ({ status, n: events.filter((e) => e.status === status && e.received_at >= since).length }));
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  const rejectionSums = new Map<string, number>();
  for (const r of rows.all<{ reason: string; count: number; day: string }>("billing_webhook_rejections", { where: providerWhere })) if (r.day >= sinceDay && r.day <= new Date(t).toISOString().slice(0, 10)) rejectionSums.set(r.reason, (rejectionSums.get(r.reason) ?? 0) + r.count);
  const rejections = mode === "unclassified" ? [...rejectionSums].map(([reason, n]) => ({ reason, n })) : [];
  const pending = events.filter((e) => e.status === "received" || e.status === "failed");
  const backlog = { n: pending.length, oldest: pending.length ? Math.min(...pending.map((e) => e.received_at)) : null };
  const lastReceivedAt = events.length ? Math.max(...events.map((e) => e.received_at)) : null;

  return {
    generatedAt: t,
    days,
    scope: {
      provider: filter.provider ?? null,
      currency: filter.currency ?? null,
      environment: mode,
      from: since,
      to: t,
      timezone: "UTC" as const,
      note: "Each financial total uses only the selected persisted environment. Test, live and unclassified records are never combined. Unclassified means verified environment was not retained; current provider settings never reclassify history. Currency applies to financial records; provider applies throughout. Subscription invoices only: one-time gifts, Sparks and collectibles remain separate payment records. Counts reflect current state; a later view may include subsequent updates. Refused-delivery counters have no environment attribution and appear only in the unclassified scope.",
    },
    environmentTotals: BILLING_METRIC_MODES.map(environment => {
      const environmentInvoices = allInvoices.filter(invoice => environmentOf(invoice) === environment);
      const environmentEvents = allEvents.filter(event => environmentOf(event) === environment);
      return {
        environment,
        subscriptions: allSubs.filter(subscription => environmentOf(subscription) === environment).length,
        invoices: environmentInvoices.length,
        collected: perCurrency(environmentInvoices.filter(invoice => invoice.status === "paid" && invoice.paid_at !== null && invoice.paid_at >= since && invoice.paid_at < t), invoice => invoice.amount_paid_minor),
        failedEvents: environmentEvents.filter(event => event.status === "failed" && event.received_at >= since).length,
        deadEvents: environmentEvents.filter(event => event.status === "dead" && event.received_at >= since).length,
        backlog: environmentEvents.filter(event => event.status === "received" || event.status === "failed").length,
      };
    }),
    collectionDays: Array.from({ length: days + 1 }, (_, i) => {
      const start = Math.floor(since / DAY_MS) * DAY_MS + i * DAY_MS;
      const end = start + DAY_MS;
      return { day: new Date(start).toISOString().slice(0, 10), partial: start < since || end > t, collected: perCurrency(paid.filter(row => row.paid_at! >= start && row.paid_at! < end), row => row.amount_paid_minor) };
    }),
    subscriptions: {
      byStatus,
      byPlan: [...byPlan.values()].sort((a, b) => b.subscriptions - a.subscriptions),
      granting: granting.length,
      cancellationsScheduled: granting.filter((s) => s.cancel_at_period_end).length,
      started,
      canceled,
      trialsStarted,
      trialConversions,
      trialsEnded,
      trialsEndingSoon,
      paidAtStart,
      logoChurn: paidAtStart > 0 ? paidAtStartCanceled / paidAtStart : null,
    },
    money: { mrrEstimate: mrr, collected, refunds, outstanding, failedPayments },
    webhooks: {
      byStatus: Object.fromEntries(eventRows.map((r) => [r.status, r.n])),
      rejected: rejections.map((r) => ({ reason: r.reason, count: r.n })),
      backlog: backlog.n,
      oldestBacklogAt: backlog.oldest,
      lastReceivedAt,
    },
  };
}

/** What each figure means, shown next to it in the console (docs/BILLING.md › Metrics). */
export const BILLING_DEFINITIONS: { key: string; label: string; definition: string; kind: "measured" | "calculated" | "estimate" }[] = [
  { key: "byStatus", label: "Subscriptions by state", definition: "Every subscription's current state as the provider last reported it. Instantaneous.", kind: "measured" },
  { key: "granting", label: "Subscriptions granting a plan", definition: "Trialing, active, or past due within the plan version's grace days. Instantaneous.", kind: "calculated" },
  { key: "mrrEstimate", label: "MRR estimate (list price)", definition: "Sum of list prices of subscriptions granting a plan, trials excluded; each price × quantity divided by its term in months, with exact rational arithmetic and one final floor to a minor unit per currency. Per currency, never converted. No discounts, taxes or prorations are modelled, so this is not recognised revenue.", kind: "estimate" },
  { key: "collected", label: "Collected payments", definition: "Amount paid on invoices the provider marked paid, by payment time within the window. Cash collected, not revenue.", kind: "measured" },
  { key: "refunds", label: "Cumulative invoice refunds", definition: "All-time refunded amounts in the current invoice snapshots for this scope. Refund event timestamps were not retained, so a refund flow within the selected period is unavailable. This is not deducted from period collections.", kind: "measured" },
  { key: "outstanding", label: "Outstanding", definition: "Amount due minus amount paid on open and payment-failed invoices. Instantaneous.", kind: "calculated" },
  { key: "failedPayments", label: "Failed payments", definition: "Invoices whose latest state is payment failed, updated within the window.", kind: "measured" },
  { key: "started", label: "New subscriptions", definition: "Subscriptions first seen within the window (any state, including incomplete).", kind: "measured" },
  { key: "canceled", label: "Cancellations", definition: "Moves to canceled within the window (the provider ended them).", kind: "measured" },
  { key: "trialConversions", label: "Trial conversions", definition: "Moves from trialing to active within the window, out of trials that ended within it.", kind: "calculated" },
  { key: "logoChurn", label: "Subscription churn", definition: "Of the subscriptions that were active or past due at the window's start, the share canceled since. Counts subscriptions, not distinct paying accounts. Null when none were.", kind: "calculated" },
  { key: "webhooks", label: "Provider events", definition: "Verified provider events received within the window by processing state; rejected deliveries by reason; backlog = received or failed and not yet applied.", kind: "measured" },
];
