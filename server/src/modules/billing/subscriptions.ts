import type { DB } from "../../infrastructure/database/db.js";
import { newId } from "../../shared/utilities/util.js";
import { type PlanCatalog, type PlanLimits, parseLimits } from "./catalog.js";
import { canMove, grantsPlan, standing, type Standing, type SubscriptionStatus, TERMINAL } from "./lifecycle.js";
import type { InvoiceSnapshot, SubscriptionSnapshot } from "./providers/types.js";

/**
 * Subscriptions and invoices as verified provider events describe them (docs/BILLING.md › Lifecycle). Every write here
 * runs inside the event's processing transaction; nothing else writes these tables.
 */
export interface SubscriptionRow {
  id: string;
  org_id: string;
  billing_user_id: string;
  plan_version_id: string;
  status: SubscriptionStatus;
  provider: string;
  provider_customer_ref: string | null;
  provider_subscription_ref: string;
  checkout_id: string | null;
  current_period_start: number | null;
  current_period_end: number | null;
  trial_end: number | null;
  cancel_at_period_end: number;
  canceled_at: number | null;
  past_due_since: number | null;
  provider_updated_at: number;
  created_at: number;
  updated_at: number;
}

/** Why an event couldn't be applied. Failed events are retried (the cause may arrive later) and can be replayed. */
export class BillingEventError extends Error {
  constructor(
    readonly code: "unknown_price" | "unknown_checkout" | "unknown_subscription" | "invalid_transition" | "org_has_subscription" | "checkout_mismatch",
    message: string,
  ) {
    super(message);
  }
}

export type ApplyOutcome = { result: "applied" | "stale"; subscriptionId: string };

const LIVE_STATES = "('incomplete', 'trialing', 'active', 'past_due', 'paused')";

export class Subscriptions {
  constructor(
    private readonly db: DB,
    private readonly catalog: PlanCatalog,
  ) {}

  get(id: string): SubscriptionRow | null {
    return (this.db.prepare("SELECT * FROM billing_subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined) ?? null;
  }

  /** The organization's subscription that isn't over (at most one), if any. */
  liveFor(orgId: string): SubscriptionRow | null {
    return (
      (this.db.prepare(`SELECT * FROM billing_subscriptions WHERE org_id = ? AND status IN ${LIVE_STATES} ORDER BY updated_at DESC LIMIT 1`).get(orgId) as
        | SubscriptionRow
        | undefined) ?? null
    );
  }

  standingOf(s: SubscriptionRow, t: number): Standing {
    const v = this.catalog.version(s.plan_version_id);
    return standing({ status: s.status, pastDueSince: s.past_due_since, graceDays: v?.grace_days ?? 0 }, t);
  }

  /** The plan limits that apply to [orgId] at [t], or null when no subscription grants a plan (Entitlements' plan layer). */
  planLimits(orgId: string, t: number): { limits: PlanLimits; planName: string; subscriptionId: string } | null {
    const s = this.liveFor(orgId);
    if (!s) return null;
    const v = this.catalog.version(s.plan_version_id);
    if (!v || !grantsPlan({ status: s.status, pastDueSince: s.past_due_since, graceDays: v.grace_days }, t)) return null;
    return { limits: parseLimits(v.limits), planName: this.catalog.plan(v.plan_id)?.name ?? "", subscriptionId: s.id };
  }

  /**
   * Applies a provider's subscription snapshot from event [eventId]. A snapshot older than the newest one applied is
   * skipped ("stale"), so duplicated and out-of-order deliveries settle on the provider's latest state.
   */
  applySnapshot(provider: string, snap: SubscriptionSnapshot, providerAt: number, eventId: string, t: number): ApplyOutcome {
    const version = this.catalog.byPrice(provider, snap.priceRef);
    if (!version) throw new BillingEventError("unknown_price", `No published plan version uses the price ${snap.priceRef}`);
    const existing = this.db.prepare("SELECT * FROM billing_subscriptions WHERE provider = ? AND provider_subscription_ref = ?").get(provider, snap.ref) as SubscriptionRow | undefined;
    if (existing) return this.update(existing, version.id, snap, providerAt, eventId, t);
    return this.insert(provider, version.id, snap, providerAt, eventId, t);
  }

  private insert(provider: string, versionId: string, snap: SubscriptionSnapshot, providerAt: number, eventId: string, t: number): ApplyOutcome {
    // A new subscription belongs to the organization whose owner started the checkout it names, never to an id the
    // provider sends on its own.
    if (!snap.checkoutRef) throw new BillingEventError("unknown_checkout", "The provider's subscription names no checkout of ours");
    const checkout = this.db.prepare("SELECT * FROM billing_checkouts WHERE id = ? AND provider = ?").get(snap.checkoutRef, provider) as
      | { id: string; org_id: string; user_id: string; status: string }
      | undefined;
    if (!checkout) throw new BillingEventError("unknown_checkout", "The provider's subscription names a checkout that doesn't exist");
    if (this.db.prepare("SELECT 1 FROM billing_subscriptions WHERE checkout_id = ?").get(checkout.id)) {
      throw new BillingEventError("checkout_mismatch", "That checkout already has a subscription");
    }
    const live = this.liveFor(checkout.org_id);
    if (live && !TERMINAL.has(snap.status)) throw new BillingEventError("org_has_subscription", "The organization already has a subscription that isn't over");
    const id = newId("sub");
    this.db
      .prepare(
        `INSERT INTO billing_subscriptions (id, org_id, billing_user_id, plan_version_id, status, provider, provider_customer_ref, provider_subscription_ref, checkout_id,
           current_period_start, current_period_end, trial_end, cancel_at_period_end, canceled_at, past_due_since, provider_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, checkout.org_id, checkout.user_id, versionId, snap.status, provider, snap.customerRef, snap.ref, checkout.id,
        snap.currentPeriodStart, snap.currentPeriodEnd, snap.trialEnd, snap.cancelAtPeriodEnd ? 1 : 0, snap.canceledAt,
        snap.status === "past_due" ? providerAt : null, providerAt, t, t,
      );
    this.db.prepare("UPDATE billing_checkouts SET status = 'completed', completed_at = ? WHERE id = ?").run(t, checkout.id);
    this.history(id, t, null, snap.status, versionId, eventId, snap.cancelAtPeriodEnd ? { cancelAtPeriodEnd: true } : {});
    return { result: "applied", subscriptionId: id };
  }

  private update(s: SubscriptionRow, versionId: string, snap: SubscriptionSnapshot, providerAt: number, eventId: string, t: number): ApplyOutcome {
    if (providerAt < s.provider_updated_at) return { result: "stale", subscriptionId: s.id };
    if (!canMove(s.status, snap.status)) throw new BillingEventError("invalid_transition", `A subscription can't go from ${s.status} to ${snap.status}`);
    const pastDueSince = snap.status === "past_due" ? (s.past_due_since ?? providerAt) : null;
    this.db
      .prepare(
        `UPDATE billing_subscriptions SET plan_version_id = ?, status = ?, provider_customer_ref = COALESCE(?, provider_customer_ref), current_period_start = ?, current_period_end = ?,
           trial_end = ?, cancel_at_period_end = ?, canceled_at = ?, past_due_since = ?, provider_updated_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(versionId, snap.status, snap.customerRef, snap.currentPeriodStart, snap.currentPeriodEnd, snap.trialEnd, snap.cancelAtPeriodEnd ? 1 : 0, snap.canceledAt, pastDueSince, providerAt, t, s.id);
    const changed: Record<string, unknown> = {};
    if (versionId !== s.plan_version_id) changed.planVersion = { from: s.plan_version_id, to: versionId };
    if (!!s.cancel_at_period_end !== snap.cancelAtPeriodEnd) changed.cancelAtPeriodEnd = snap.cancelAtPeriodEnd;
    if (snap.currentPeriodEnd !== s.current_period_end) changed.renewedTo = snap.currentPeriodEnd;
    if (snap.status !== s.status || Object.keys(changed).length > 0) this.history(s.id, t, s.status, snap.status, versionId, eventId, changed);
    return { result: "applied", subscriptionId: s.id };
  }

  private history(subscriptionId: string, t: number, from: SubscriptionStatus | null, to: SubscriptionStatus, versionId: string, eventId: string, detail: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO billing_subscription_history (subscription_id, at, from_status, to_status, plan_version_id, source, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(subscriptionId, t, from, to, versionId, `provider_event:${eventId}`, JSON.stringify(detail));
  }

  /** Records a provider's invoice; its subscription must be known (an invoice that arrives first is retried later). */
  applyInvoice(provider: string, inv: InvoiceSnapshot, providerAt: number, t: number): ApplyOutcome {
    const sub = inv.subscriptionRef
      ? (this.db.prepare("SELECT * FROM billing_subscriptions WHERE provider = ? AND provider_subscription_ref = ?").get(provider, inv.subscriptionRef) as SubscriptionRow | undefined)
      : undefined;
    if (!sub) throw new BillingEventError("unknown_subscription", "The invoice's subscription isn't known yet");
    const existing = this.db.prepare("SELECT id, provider_updated_at FROM billing_invoices WHERE provider = ? AND provider_invoice_ref = ?").get(provider, inv.ref) as
      | { id: string; provider_updated_at: number }
      | undefined;
    if (existing && providerAt < existing.provider_updated_at) return { result: "stale", subscriptionId: sub.id };
    this.db
      .prepare(
        `INSERT INTO billing_invoices (id, provider, provider_invoice_ref, subscription_id, org_id, status, currency, amount_due_minor, amount_paid_minor, amount_refunded_minor, tax_minor,
           period_start, period_end, issued_at, paid_at, provider_updated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_invoice_ref) DO UPDATE SET status = excluded.status, currency = excluded.currency, amount_due_minor = excluded.amount_due_minor,
           amount_paid_minor = excluded.amount_paid_minor, amount_refunded_minor = excluded.amount_refunded_minor, tax_minor = excluded.tax_minor,
           period_start = excluded.period_start, period_end = excluded.period_end, paid_at = excluded.paid_at, provider_updated_at = excluded.provider_updated_at, updated_at = excluded.updated_at`,
      )
      .run(
        existing?.id ?? newId("inv"), provider, inv.ref, sub.id, sub.org_id, inv.status, inv.currency, inv.amountDueMinor, inv.amountPaidMinor, inv.amountRefundedMinor, inv.taxMinor,
        inv.periodStart, inv.periodEnd, inv.issuedAt, inv.paidAt, providerAt, t,
      );
    return { result: "applied", subscriptionId: sub.id };
  }
}
