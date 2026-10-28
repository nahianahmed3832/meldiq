import type { DB } from "../../infrastructure/database/db.js";
import { newId } from "../../shared/utilities/util.js";
import { type PlanCatalog, type PlanLimits, parseLimits } from "./catalog.js";
import { canMove, grantsPlan, standing, type Standing, type SubscriptionStatus, TERMINAL } from "./lifecycle.js";
import { type BillingOwner, ownerClause, ownerOfRow, ownerParam } from "./owners.js";
import type { CheckoutSnapshot, InvoiceSnapshot, PaymentSnapshot, SubscriptionSnapshot } from "./providers/types.js";

/**
 * Subscriptions and invoices as verified provider events describe them (docs/BILLING.md › Lifecycle). Every write here
 * runs inside the event's processing transaction; nothing else writes these tables.
 */
export interface SubscriptionRow {
  id: string;
  owner_kind: "org" | "account";
  org_id: string | null;
  account_id: string | null;
  owner_user_id: string | null;
  billing_user_id: string | null;
  billing_account_id: string | null;
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

interface CheckoutRow {
  id: string;
  owner_kind: "org" | "account";
  org_id: string | null;
  account_id: string | null;
  user_id: string | null;
  started_by_account_id: string | null;
  status: string;
}

/** Why an event couldn't be applied. Failed events are retried (the cause may arrive later) and can be replayed. */
export class BillingEventError extends Error {
  constructor(
    readonly code: "unknown_price" | "unknown_checkout" | "unknown_subscription" | "invalid_transition" | "org_has_subscription" | "checkout_mismatch" | "audience_mismatch",
    message: string,
  ) {
    super(message);
  }
}

export type ApplyOutcome = { result: "applied" | "stale"; subscriptionId: string | null; owner: BillingOwner | null };

/** States that aren't over: an owner has at most one subscription in them. */
const LIVE_STATES = "('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused')";

export class Subscriptions {
  constructor(
    private readonly db: DB,
    private readonly catalog: PlanCatalog,
  ) {}

  get(id: string): SubscriptionRow | null {
    return (this.db.prepare("SELECT * FROM billing_subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined) ?? null;
  }

  /** The owner's subscription that isn't over (at most one), if any. */
  liveForOwner(owner: BillingOwner): SubscriptionRow | null {
    return (
      (this.db.prepare(`SELECT * FROM billing_subscriptions WHERE ${ownerClause(owner)} AND status IN ${LIVE_STATES} ORDER BY updated_at DESC LIMIT 1`).get(ownerParam(owner)) as
        | SubscriptionRow
        | undefined) ?? null
    );
  }

  /** The organization's subscription that isn't over (at most one), if any. */
  liveFor(orgId: string): SubscriptionRow | null {
    return this.liveForOwner({ kind: "org", orgId });
  }

  /** Whether the owner ever had a subscription (a trial is offered only the first time). */
  hadAny(owner: BillingOwner): boolean {
    return !!this.db.prepare(`SELECT 1 FROM billing_subscriptions WHERE ${ownerClause(owner)} LIMIT 1`).get(ownerParam(owner));
  }

  standingOf(s: SubscriptionRow, t: number): Standing {
    const v = this.catalog.version(s.plan_version_id);
    return standing({ status: s.status, pastDueSince: s.past_due_since, graceDays: v?.grace_days ?? 0 }, t);
  }

  /** The owner's live subscription and its terms while it grants its plan at [t], else null. */
  granting(owner: BillingOwner, t: number) {
    const s = this.liveForOwner(owner);
    const v = s ? this.catalog.version(s.plan_version_id) : null;
    if (!s || !v || !grantsPlan({ status: s.status, pastDueSince: s.past_due_since, graceDays: v.grace_days }, t)) return null;
    return { subscription: s, version: v };
  }

  /** The plan limits that apply to [orgId] at [t], or null when no subscription grants a plan (Entitlements' plan layer). */
  planLimits(orgId: string, t: number): { limits: PlanLimits; planName: string; subscriptionId: string } | null {
    const g = this.granting({ kind: "org", orgId }, t);
    if (!g) return null;
    return { limits: parseLimits(g.version.limits), planName: this.catalog.plan(g.version.plan_id)?.name ?? "", subscriptionId: g.subscription.id };
  }

  /**
   * The quota plan (modules/quotas) a granting subscription puts a scope on: a person (users.id, through the account
   * that owns a personal subscription) or an organization. The quota engine asks this after operator assignments.
   */
  quotaPlanFor(scope: { type: string; id: string }, t: number): string | null {
    if (scope.type === "org") return this.granting({ kind: "org", orgId: scope.id }, t)?.version.quota_plan_id ?? null;
    if (scope.type !== "user") return null;
    const row = this.db
      .prepare(`SELECT account_id FROM billing_subscriptions WHERE owner_kind = 'account' AND owner_user_id = ? AND status IN ${LIVE_STATES} ORDER BY updated_at DESC LIMIT 1`)
      .get(scope.id) as { account_id: string } | undefined;
    return row ? (this.granting({ kind: "account", accountId: row.account_id }, t)?.version.quota_plan_id ?? null) : null;
  }

  /** The encryption identities known for an account's subscriptions (where its devices are reached). */
  ownerUserIds(accountId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT owner_user_id u FROM billing_subscriptions WHERE owner_kind = 'account' AND account_id = ? AND owner_user_id IS NOT NULL").all(accountId) as { u: string }[]).map(
      (r) => r.u,
    );
  }

  /** Records the encryption identity of an account that owns subscriptions (it may have bought before it had one). */
  linkOwnerUser(accountId: string, userId: string): number {
    return this.db
      .prepare("UPDATE billing_subscriptions SET owner_user_id = ? WHERE owner_kind = 'account' AND account_id = ? AND (owner_user_id IS NULL OR owner_user_id != ?)")
      .run(userId, accountId, userId).changes;
  }

  /** The owner a provider customer belongs to: only customers Meldiq created or saw on one of its subscriptions. */
  ownerOfCustomer(provider: string, customerRef: string): BillingOwner | null {
    const c = this.db.prepare("SELECT owner_kind, owner_id FROM billing_customers WHERE provider = ? AND provider_customer_ref = ?").get(provider, customerRef) as
      | { owner_kind: "org" | "account"; owner_id: string }
      | undefined;
    if (c) return c.owner_kind === "org" ? { kind: "org", orgId: c.owner_id } : { kind: "account", accountId: c.owner_id };
    const s = this.db.prepare("SELECT * FROM billing_subscriptions WHERE provider = ? AND provider_customer_ref = ? ORDER BY updated_at DESC LIMIT 1").get(provider, customerRef) as
      | SubscriptionRow
      | undefined;
    return s ? ownerOfRow(s) : null;
  }

  /**
   * Applies a provider's subscription snapshot; [source] says where it came from (`provider_event:<id>`, `reconcile:<time>`). A snapshot older than the newest one applied is
   * skipped ("stale"), so duplicated and out-of-order deliveries settle on the provider's latest state.
   */
  applySnapshot(provider: string, snap: SubscriptionSnapshot, providerAt: number, source: string, t: number): ApplyOutcome {
    const version = this.catalog.byPrice(provider, snap.priceRef);
    if (!version) throw new BillingEventError("unknown_price", `No published plan version uses the price ${snap.priceRef}`);
    const existing = this.db.prepare("SELECT * FROM billing_subscriptions WHERE provider = ? AND provider_subscription_ref = ?").get(provider, snap.ref) as SubscriptionRow | undefined;
    if (existing) return this.update(existing, version.id, snap, providerAt, source, t);
    return this.insert(provider, version.id, snap, providerAt, source, t);
  }

  private insert(provider: string, versionId: string, snap: SubscriptionSnapshot, providerAt: number, source: string, t: number): ApplyOutcome {
    // A new subscription belongs to the owner who started the checkout it names, never to an id the provider sends on
    // its own (a customer id, metadata naming an owner, an email).
    if (!snap.checkoutRef) throw new BillingEventError("unknown_checkout", "The provider's subscription names no checkout of ours");
    const checkout = this.db.prepare("SELECT * FROM billing_checkouts WHERE id = ? AND provider = ?").get(snap.checkoutRef, provider) as CheckoutRow | undefined;
    if (!checkout) throw new BillingEventError("unknown_checkout", "The provider's subscription names a checkout that doesn't exist");
    if (this.db.prepare("SELECT 1 FROM billing_subscriptions WHERE checkout_id = ?").get(checkout.id)) {
      throw new BillingEventError("checkout_mismatch", "That checkout already has a subscription");
    }
    const plan = this.catalog.plan(this.catalog.version(versionId)!.plan_id)!;
    if ((plan.audience === "personal") !== (checkout.owner_kind === "account")) {
      throw new BillingEventError("audience_mismatch", "The subscription's price is for another kind of owner than the checkout's");
    }
    const owner = ownerOfRow(checkout);
    const live = this.liveForOwner(owner);
    if (live && !TERMINAL.has(snap.status)) throw new BillingEventError("org_has_subscription", "The owner already has a subscription that isn't over");
    const id = newId("sub");
    this.db
      .prepare(
        `INSERT INTO billing_subscriptions (id, owner_kind, org_id, account_id, owner_user_id, billing_user_id, billing_account_id, plan_version_id, status, provider, provider_customer_ref,
           provider_subscription_ref, checkout_id, current_period_start, current_period_end, trial_end, cancel_at_period_end, canceled_at, past_due_since, provider_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, checkout.owner_kind, checkout.org_id, checkout.account_id, checkout.owner_kind === "account" ? checkout.user_id : null, checkout.user_id, checkout.started_by_account_id,
        versionId, snap.status, provider, snap.customerRef, snap.ref, checkout.id, snap.currentPeriodStart, snap.currentPeriodEnd, snap.trialEnd,
        snap.cancelAtPeriodEnd ? 1 : 0, snap.canceledAt, snap.status === "past_due" || snap.status === "unpaid" ? providerAt : null, providerAt, t, t,
      );
    this.db.prepare("UPDATE billing_checkouts SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?").run(t, checkout.id);
    if (snap.customerRef) this.rememberCustomer(provider, owner, snap.customerRef, t);
    this.history(id, t, null, snap.status, versionId, source, snap.cancelAtPeriodEnd ? { cancelAtPeriodEnd: true } : {});
    return { result: "applied", subscriptionId: id, owner };
  }

  private update(s: SubscriptionRow, versionId: string, snap: SubscriptionSnapshot, providerAt: number, source: string, t: number): ApplyOutcome {
    const owner = ownerOfRow(s);
    if (providerAt < s.provider_updated_at) return { result: "stale", subscriptionId: s.id, owner };
    if (!canMove(s.status, snap.status)) {
      // Providers stamp events to the second: a snapshot from the same instant that would move backwards (created after
      // updated) is the older of the two.
      if (providerAt === s.provider_updated_at) return { result: "stale", subscriptionId: s.id, owner };
      throw new BillingEventError("invalid_transition", `A subscription can't go from ${s.status} to ${snap.status}`);
    }
    const unpaid = snap.status === "past_due" || snap.status === "unpaid";
    const pastDueSince = unpaid ? (s.past_due_since ?? providerAt) : null;
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
    if (snap.status !== s.status || Object.keys(changed).length > 0) this.history(s.id, t, s.status, snap.status, versionId, source, changed);
    return { result: "applied", subscriptionId: s.id, owner };
  }

  private history(subscriptionId: string, t: number, from: SubscriptionStatus | null, to: SubscriptionStatus, versionId: string, source: string, detail: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO billing_subscription_history (subscription_id, at, from_status, to_status, plan_version_id, source, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(subscriptionId, t, from, to, versionId, source, JSON.stringify(detail));
  }

  /** One customer per owner and provider; a reference already known (for this or another owner) is left alone. */
  rememberCustomer(provider: string, owner: BillingOwner, customerRef: string, t: number): void {
    this.db
      .prepare("INSERT INTO billing_customers (id, provider, owner_kind, owner_id, provider_customer_ref, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(newId("bcu"), provider, owner.kind, ownerParam(owner), customerRef, t);
  }

  /** Records a provider's invoice; its subscription must be known (an invoice that arrives first is retried later). */
  applyInvoice(provider: string, inv: InvoiceSnapshot, providerAt: number, t: number): ApplyOutcome {
    const sub = inv.subscriptionRef
      ? (this.db.prepare("SELECT * FROM billing_subscriptions WHERE provider = ? AND provider_subscription_ref = ?").get(provider, inv.subscriptionRef) as SubscriptionRow | undefined)
      : undefined;
    if (!sub) throw new BillingEventError("unknown_subscription", "The invoice's subscription isn't known yet");
    const owner = ownerOfRow(sub);
    const existing = this.db.prepare("SELECT id, provider_updated_at FROM billing_invoices WHERE provider = ? AND provider_invoice_ref = ?").get(provider, inv.ref) as
      | { id: string; provider_updated_at: number }
      | undefined;
    if (existing && providerAt < existing.provider_updated_at) return { result: "stale", subscriptionId: sub.id, owner };
    this.db
      .prepare(
        `INSERT INTO billing_invoices (id, provider, provider_invoice_ref, subscription_id, owner_kind, org_id, account_id, status, currency, amount_due_minor, amount_paid_minor,
           amount_refunded_minor, tax_minor, period_start, period_end, issued_at, paid_at, provider_updated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_invoice_ref) DO UPDATE SET status = excluded.status, currency = excluded.currency, amount_due_minor = excluded.amount_due_minor,
           amount_paid_minor = excluded.amount_paid_minor, amount_refunded_minor = MAX(amount_refunded_minor, excluded.amount_refunded_minor), tax_minor = excluded.tax_minor,
           period_start = excluded.period_start, period_end = excluded.period_end, paid_at = excluded.paid_at, provider_updated_at = excluded.provider_updated_at, updated_at = excluded.updated_at`,
      )
      .run(
        existing?.id ?? newId("inv"), provider, inv.ref, sub.id, sub.owner_kind, sub.org_id, sub.account_id, inv.status, inv.currency, inv.amountDueMinor, inv.amountPaidMinor,
        inv.amountRefundedMinor, inv.taxMinor, inv.periodStart, inv.periodEnd, inv.issuedAt, inv.paidAt, providerAt, t,
      );
    return { result: "applied", subscriptionId: sub.id, owner };
  }

  /**
   * A hosted checkout finished or ran out. Finishing grants nothing by itself: only the subscription's own events (or a
   * reconciliation that reads it from the provider) do. Checkouts Meldiq didn't start are ignored.
   */
  applyCheckout(provider: string, snap: CheckoutSnapshot, t: number): ApplyOutcome {
    const checkout = (snap.reference
      ? this.db.prepare("SELECT * FROM billing_checkouts WHERE id = ? AND provider = ?").get(snap.reference, provider)
      : this.db.prepare("SELECT * FROM billing_checkouts WHERE provider_session_ref = ? AND provider = ?").get(snap.sessionRef, provider)) as CheckoutRow | undefined;
    if (!checkout) return { result: "stale", subscriptionId: null, owner: null };
    const owner = ownerOfRow(checkout);
    const sub = this.db.prepare("SELECT id FROM billing_subscriptions WHERE checkout_id = ?").get(checkout.id) as { id: string } | undefined;
    if (snap.outcome === "completed") {
      this.db
        .prepare("UPDATE billing_checkouts SET status = 'completed', completed_at = COALESCE(completed_at, ?), provider_subscription_ref = COALESCE(?, provider_subscription_ref) WHERE id = ?")
        .run(t, snap.subscriptionRef, checkout.id);
      if (snap.customerRef) this.rememberCustomer(provider, owner, snap.customerRef, t);
    } else if (checkout.status === "open" || checkout.status === "superseded") {
      this.db.prepare("UPDATE billing_checkouts SET status = 'expired' WHERE id = ?").run(checkout.id);
    }
    return { result: "applied", subscriptionId: sub?.id ?? null, owner };
  }

  /**
   * A refund or dispute on one of an owner's payments, written into the subscription's history for support and audit.
   * It changes no state: whether access ends is the provider's subscription event (a cancellation) to say.
   */
  applyPayment(provider: string, p: PaymentSnapshot, source: string, t: number): ApplyOutcome {
    const owner = p.customerRef ? this.ownerOfCustomer(provider, p.customerRef) : null;
    const s = owner
      ? (this.db.prepare(`SELECT * FROM billing_subscriptions WHERE ${ownerClause(owner)} AND provider = ? ORDER BY updated_at DESC LIMIT 1`).get(ownerParam(owner), provider) as
          | SubscriptionRow
          | undefined)
      : undefined;
    if (!owner || !s) return { result: "stale", subscriptionId: null, owner };
    this.history(s.id, t, s.status, s.status, s.plan_version_id, source, {
      [p.kind]: { ref: p.ref, state: p.state, currency: p.currency, amountMinor: p.amountMinor, affectedMinor: p.affectedMinor },
    });
    return { result: "applied", subscriptionId: s.id, owner };
  }
}
