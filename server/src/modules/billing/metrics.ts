import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { grantsPlan, SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "./lifecycle.js";

/**
 * Subscription and billing figures for the console (docs/BILLING.md › Metrics, definitions repeated in the answer).
 * Money is summed per currency in integer minor units and never converted. Every figure comes from rows that verified
 * provider events wrote; with no subscriptions the counts are real zeros, and the console says when billing isn't set up.
 */
const DAY_MS = 86_400_000;

type Money = { currency: string; amountMinor: number }[];

const money = (rows: { currency: string; n: number | null }[]): Money =>
  rows.filter((r) => (r.n ?? 0) > 0).map((r) => ({ currency: r.currency, amountMinor: r.n ?? 0 }));

interface SubRow {
  id: string;
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
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.currency, (sums.get(r.currency) ?? 0) + value(r));
  return money([...sums].map(([currency, n]) => ({ currency, n })));
}

export function billingMetrics(rows: RowReader, days: number, t: number) {
  const since = t - days * DAY_MS;
  const subs = rows.all<SubRow>("billing_subscriptions");
  const byStatus = Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, subs.filter((x) => x.status === s).length])) as Record<SubscriptionStatus, number>;

  // Subscriptions granting a plan now, with their terms, for plan distribution and the MRR estimate.
  const versions = new Map(rows.all<{ id: string; plan_id: string; grace_days: number; interval: "month" | "year"; currency: string; amount_minor: number }>("billing_plan_versions").map((v) => [v.id, v]));
  const plans = new Map(rows.all<{ id: string; key: string; name: string }>("billing_plans").map((p) => [p.id, p]));
  const live = subs.flatMap((s) => {
    const v = versions.get(s.plan_version_id);
    const p = v ? plans.get(v.plan_id) : undefined;
    if (!v || !p || !["trialing", "active", "past_due"].includes(s.status)) return [];
    return [{ ...s, grace_days: v.grace_days, interval: v.interval, currency: v.currency, amount_minor: v.amount_minor, plan_key: p.key, plan_name: p.name }];
  });
  const granting = live.filter((s) => grantsPlan({ status: s.status, pastDueSince: s.past_due_since, graceDays: s.grace_days }, t));
  const byPlan = new Map<string, { key: string; name: string; subscriptions: number }>();
  for (const s of granting) byPlan.set(s.plan_key, { key: s.plan_key, name: s.plan_name, subscriptions: (byPlan.get(s.plan_key)?.subscriptions ?? 0) + 1 });
  // MRR estimate: paying subscriptions only (not trials), list price, yearly divided by 12 after summing per currency.
  const monthly = new Map<string, number>();
  const yearly = new Map<string, number>();
  for (const s of granting.filter((s) => s.status !== "trialing")) {
    const bucket = s.interval === "month" ? monthly : yearly;
    bucket.set(s.currency, (bucket.get(s.currency) ?? 0) + s.amount_minor);
  }
  const currencies = [...new Set([...monthly.keys(), ...yearly.keys()])].sort();
  const mrr = currencies.map((currency) => ({ currency, amountMinor: (monthly.get(currency) ?? 0) + Math.floor((yearly.get(currency) ?? 0) / 12) }));

  const history = rows.all<HistRow>("billing_subscription_history", { orderBy: [["id", "asc"]] });
  const recent = history.filter((h) => h.at >= since);
  const started = subs.filter((s) => s.created_at >= since).length;
  const trialsStarted = recent.filter((h) => h.from_status === null && h.to_status === "trialing").length;
  const trialConversions = recent.filter((h) => h.from_status === "trialing" && h.to_status === "active").length;
  const trialsEnded = recent.filter((h) => h.from_status === "trialing" && h.to_status !== "trialing").length;
  const canceled = recent.filter((h) => h.to_status === "canceled" && h.from_status !== "canceled").length;
  // Each subscription's status at the window's start: its last history entry at or before it.
  const statusAt = new Map<string, string>();
  for (const h of history) if (h.at <= since) statusAt.set(h.subscription_id, h.to_status);
  const paidAtStartIds = subs.filter((s) => ["active", "past_due"].includes(statusAt.get(s.id) ?? "")).map((s) => s.id);
  const paidAtStart = paidAtStartIds.length;
  const canceledSince = new Set(history.filter((h) => h.to_status === "canceled" && h.at > since).map((h) => h.subscription_id));
  const paidAtStartCanceled = paidAtStartIds.filter((id) => canceledSince.has(id)).length;
  const trialsEndingSoon = subs.filter((s) => s.status === "trialing" && s.trial_end !== null && s.trial_end >= t && s.trial_end <= t + 7 * DAY_MS).length;

  const invoices = rows.all<InvRow>("billing_invoices");
  const collected = perCurrency(invoices.filter((i) => i.status === "paid" && (i.paid_at ?? 0) >= since), (i) => i.amount_paid_minor);
  const refunds = perCurrency(invoices.filter((i) => i.updated_at >= since), (i) => i.amount_refunded_minor);
  const outstanding = perCurrency(invoices.filter((i) => i.status === "open" || i.status === "payment_failed"), (i) => i.amount_due_minor - i.amount_paid_minor);
  const failedPayments = invoices.filter((i) => i.status === "payment_failed" && i.updated_at >= since).length;

  const events = rows.all<{ status: string; received_at: number }>("billing_provider_events");
  const eventRows = ["received", "processed", "ignored", "failed", "dead"].map((status) => ({ status, n: events.filter((e) => e.status === status && e.received_at >= since).length }));
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  const rejectionSums = new Map<string, number>();
  for (const r of rows.all<{ reason: string; count: number; day: string }>("billing_webhook_rejections")) if (r.day >= sinceDay) rejectionSums.set(r.reason, (rejectionSums.get(r.reason) ?? 0) + r.count);
  const rejections = [...rejectionSums].map(([reason, n]) => ({ reason, n }));
  const pending = events.filter((e) => e.status === "received" || e.status === "failed");
  const backlog = { n: pending.length, oldest: pending.length ? Math.min(...pending.map((e) => e.received_at)) : null };
  const lastReceivedAt = events.length ? Math.max(...events.map((e) => e.received_at)) : null;

  return {
    generatedAt: t,
    days,
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
  { key: "mrrEstimate", label: "MRR estimate (list price)", definition: "Sum of list prices of subscriptions granting a plan, trials excluded; yearly prices divided by 12. Per currency, never converted. No discounts, taxes or prorations are modelled, so this is not recognised revenue.", kind: "estimate" },
  { key: "collected", label: "Collected payments", definition: "Amount paid on invoices the provider marked paid, by payment time within the window. Cash collected, not revenue.", kind: "measured" },
  { key: "refunds", label: "Refunds recorded", definition: "Refunded amounts on invoices the provider updated within the window (the provider's refund time isn't kept).", kind: "measured" },
  { key: "outstanding", label: "Outstanding", definition: "Amount due minus amount paid on open and payment-failed invoices. Instantaneous.", kind: "calculated" },
  { key: "failedPayments", label: "Failed payments", definition: "Invoices whose latest state is payment failed, updated within the window.", kind: "measured" },
  { key: "started", label: "New subscriptions", definition: "Subscriptions first seen within the window (any state, including incomplete).", kind: "measured" },
  { key: "canceled", label: "Cancellations", definition: "Moves to canceled within the window (the provider ended them).", kind: "measured" },
  { key: "trialConversions", label: "Trial conversions", definition: "Moves from trialing to active within the window, out of trials that ended within it.", kind: "calculated" },
  { key: "logoChurn", label: "Logo churn", definition: "Of the subscriptions that were active or past due at the window's start, the share canceled since. Null when none were.", kind: "calculated" },
  { key: "webhooks", label: "Provider events", definition: "Verified provider events received within the window by processing state; rejected deliveries by reason; backlog = received or failed and not yet applied.", kind: "measured" },
];
