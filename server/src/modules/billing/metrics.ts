import type { DB } from "../../infrastructure/database/db.js";
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

/** A subscription's status at [at] (from its history), or null when it didn't exist yet. */
const STATUS_AT = `(SELECT h.to_status FROM billing_subscription_history h WHERE h.subscription_id = s.id AND h.at <= ? ORDER BY h.id DESC LIMIT 1)`;

export function billingMetrics(db: DB, days: number, t: number) {
  const since = t - days * DAY_MS;
  const statusRows = db.prepare("SELECT status, COUNT(*) n FROM billing_subscriptions GROUP BY status").all() as { status: SubscriptionStatus; n: number }[];
  const byStatus = Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, statusRows.find((r) => r.status === s)?.n ?? 0])) as Record<SubscriptionStatus, number>;

  // Subscriptions granting a plan now, with their terms, for plan distribution and the MRR estimate.
  const live = db
    .prepare(
      `SELECT s.status, s.past_due_since, v.grace_days, v.interval, v.currency, v.amount_minor, p.key plan_key, p.name plan_name, s.cancel_at_period_end
       FROM billing_subscriptions s JOIN billing_plan_versions v ON v.id = s.plan_version_id JOIN billing_plans p ON p.id = v.plan_id
       WHERE s.status IN ('trialing', 'active', 'past_due')`,
    )
    .all() as { status: SubscriptionStatus; past_due_since: number | null; grace_days: number; interval: "month" | "year"; currency: string; amount_minor: number; plan_key: string; plan_name: string; cancel_at_period_end: number }[];
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

  const one = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number | null }).n ?? 0;
  const started = one("SELECT COUNT(*) n FROM billing_subscriptions WHERE created_at >= ?", since);
  const trialsStarted = one("SELECT COUNT(*) n FROM billing_subscription_history WHERE from_status IS NULL AND to_status = 'trialing' AND at >= ?", since);
  const trialConversions = one("SELECT COUNT(*) n FROM billing_subscription_history WHERE from_status = 'trialing' AND to_status = 'active' AND at >= ?", since);
  const trialsEnded = one("SELECT COUNT(*) n FROM billing_subscription_history WHERE from_status = 'trialing' AND to_status != 'trialing' AND at >= ?", since);
  const canceled = one("SELECT COUNT(*) n FROM billing_subscription_history WHERE to_status = 'canceled' AND from_status != 'canceled' AND at >= ?", since);
  const paidAtStart = one(`SELECT COUNT(*) n FROM billing_subscriptions s WHERE ${STATUS_AT} IN ('active', 'past_due')`, since);
  const paidAtStartCanceled = one(
    `SELECT COUNT(*) n FROM billing_subscriptions s WHERE ${STATUS_AT} IN ('active', 'past_due') AND EXISTS (SELECT 1 FROM billing_subscription_history h WHERE h.subscription_id = s.id AND h.to_status = 'canceled' AND h.at > ?)`,
    since,
    since,
  );
  const trialsEndingSoon = one("SELECT COUNT(*) n FROM billing_subscriptions WHERE status = 'trialing' AND trial_end BETWEEN ? AND ?", t, t + 7 * DAY_MS);

  const collected = money(db.prepare("SELECT currency, SUM(amount_paid_minor) n FROM billing_invoices WHERE status = 'paid' AND paid_at >= ? GROUP BY currency").all(since) as { currency: string; n: number }[]);
  const refunds = money(db.prepare("SELECT currency, SUM(amount_refunded_minor) n FROM billing_invoices WHERE updated_at >= ? GROUP BY currency").all(since) as { currency: string; n: number }[]);
  const outstanding = money(
    db.prepare("SELECT currency, SUM(amount_due_minor - amount_paid_minor) n FROM billing_invoices WHERE status IN ('open', 'payment_failed') GROUP BY currency").all() as { currency: string; n: number }[],
  );
  const failedPayments = one("SELECT COUNT(*) n FROM billing_invoices WHERE status = 'payment_failed' AND updated_at >= ?", since);

  const eventRows = db.prepare("SELECT status, COUNT(*) n FROM billing_provider_events WHERE received_at >= ? GROUP BY status").all(since) as { status: string; n: number }[];
  const rejections = db
    .prepare("SELECT reason, SUM(count) n FROM billing_webhook_rejections WHERE day >= ? GROUP BY reason")
    .all(new Date(since).toISOString().slice(0, 10)) as { reason: string; n: number }[];
  const backlog = db.prepare("SELECT COUNT(*) n, MIN(received_at) oldest FROM billing_provider_events WHERE status IN ('received', 'failed')").get() as { n: number; oldest: number | null };
  const lastReceivedAt = (db.prepare("SELECT MAX(received_at) at FROM billing_provider_events").get() as { at: number | null }).at;

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
      byStatus: Object.fromEntries(["received", "processed", "ignored", "failed", "dead"].map((s) => [s, eventRows.find((r) => r.status === s)?.n ?? 0])),
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
