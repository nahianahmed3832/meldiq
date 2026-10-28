import type { RowReader, Rows, RowWriter, Where } from "../../infrastructure/database/rows/index.js";
import { newId } from "../../shared/utilities/util.js";
import { type PlanCatalog, type PlanLimits, parseLimits, type VersionRow } from "./catalog.js";
import { canMove, grantsPlan, standing, type Standing, type SubscriptionStatus, TERMINAL } from "./lifecycle.js";
import { type BillingOwner, ownerOfRow, ownerParam } from "./owners.js";
import type { CheckoutSnapshot, InvoiceSnapshot, PaymentSnapshot, SubscriptionSnapshot } from "./providers/types.js";
import { SPARK_PLAN_KEY } from "./perks.js";

/**
 * Subscriptions and invoices as verified provider events describe them (docs/BILLING.md › Lifecycle). Every write here
 * runs inside the event's processing unit (the [RowWriter] it is given, reading its own writes); nothing else writes
 * these tables. The billing domain's rows are SQLite or MongoDB (docs/MONGODB.md › Rows).
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
  /** How many of the plan: 1 for Mojo Go and Plus, the number of Sparks for the Spark add-on (API 0.54.0). */
  quantity: number;
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

/** States that aren't over: an owner has at most one plan subscription in them (and one add-on subscription). */
const LIVE_STATES = ["incomplete", "trialing", "active", "past_due", "unpaid", "paused"] as const;
const LIVE: Where = { status: { in: LIVE_STATES } };

/** The billing rows of [owner] (subscriptions, checkouts and invoices carry the same owner columns). */
export function ownerWhere(owner: BillingOwner): Where {
  return owner.kind === "org" ? { owner_kind: "org", org_id: owner.orgId } : { owner_kind: "account", account_id: owner.accountId };
}

const newest = [["updated_at", "desc"]] as const;

export class Subscriptions {
  /**
   * App stores (Google Play) sell the catalog's plans under their own product ids: how a store's product finds the plan
   * version its subscription is on, when no published version carries that store's price (play.ts). Null: none.
   */
  storeVersion: ((provider: string, priceRef: string) => VersionRow | null) | null = null;

  constructor(
    private readonly rows: Rows,
    private readonly catalog: PlanCatalog,
  ) {}

  get(id: string): SubscriptionRow | null {
    return this.rows.get<SubscriptionRow>("billing_subscriptions", { id }) ?? null;
  }

  /** Versions of add-on plans (the Meldiq Spark add-on): an owner has one plan and, beside it, add-ons (docs/MOJO.md). */
  private addonVersions(): string[] {
    return [...this.catalog.versionIdsOf(SPARK_PLAN_KEY)];
  }

  isAddonVersion(versionId: string): boolean {
    return this.catalog.versionIdsOf(SPARK_PLAN_KEY).has(versionId);
  }

  /** The owner's plan subscription that isn't over (at most one), if any. Add-ons (Sparks) are never the plan. */
  liveForOwner(owner: BillingOwner, r: RowReader = this.rows): SubscriptionRow | null {
    return r.get<SubscriptionRow>("billing_subscriptions", { ...ownerWhere(owner), ...LIVE, plan_version_id: { notIn: this.addonVersions() } }, newest) ?? null;
  }

  /** The owner's Spark add-on subscription that isn't over (at most one), if any. */
  liveAddonForOwner(owner: BillingOwner, r: RowReader = this.rows): SubscriptionRow | null {
    return r.get<SubscriptionRow>("billing_subscriptions", { ...ownerWhere(owner), ...LIVE, plan_version_id: { in: this.addonVersions() } }, newest) ?? null;
  }

  /** Live subscriptions (plans and add-ons) of the account whose encryption identity is [userId]. */
  liveForUser(userId: string): SubscriptionRow[] {
    return this.rows.all<SubscriptionRow>("billing_subscriptions", { where: { owner_kind: "account", owner_user_id: userId, ...LIVE } });
  }

  /** The organization's subscription that isn't over (at most one), if any. */
  liveFor(orgId: string): SubscriptionRow | null {
    return this.liveForOwner({ kind: "org", orgId });
  }

  /** Whether the owner ever had a subscription (a trial is offered only the first time). */
  hadAny(owner: BillingOwner): boolean {
    return !!this.rows.get("billing_subscriptions", ownerWhere(owner));
  }

  standingOf(s: SubscriptionRow, t: number): Standing {
    const v = this.catalog.version(s.plan_version_id);
    return standing({ status: s.status, pastDueSince: s.past_due_since, graceDays: v?.grace_days ?? 0 }, t);
  }

  /** Whether [s] grants its plan (or its Sparks) at [t]: paid for, trialing, or a failing payment within its grace days. */
  grants(s: SubscriptionRow, t: number): boolean {
    const v = this.catalog.version(s.plan_version_id);
    return !!v && grantsPlan({ status: s.status, pastDueSince: s.past_due_since, graceDays: v.grace_days }, t);
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
    const row = this.rows.get<{ account_id: string }>(
      "billing_subscriptions",
      { owner_kind: "account", owner_user_id: scope.id, ...LIVE, plan_version_id: { notIn: this.addonVersions() } },
      newest,
    );
    return row ? (this.granting({ kind: "account", accountId: row.account_id }, t)?.version.quota_plan_id ?? null) : null;
  }

  /** The encryption identities known for an account's subscriptions (where its devices are reached). */
  ownerUserIds(accountId: string): string[] {
    const rows = this.rows.all<{ owner_user_id: string | null }>("billing_subscriptions", { where: { owner_kind: "account", account_id: accountId, owner_user_id: { ne: null } } });
    return [...new Set(rows.map((r) => r.owner_user_id!))];
  }

  /** Records the encryption identity of an account that owns subscriptions (it may have bought before it had one). */
  async linkOwnerUser(accountId: string, userId: string): Promise<number> {
    const where: Where = { owner_kind: "account", account_id: accountId, $or: [{ owner_user_id: null }, { owner_user_id: { ne: userId } }] };
    // Nothing to change (the usual case): no write unit.
    if (!this.rows.get("billing_subscriptions", where)) return 0;
    return this.rows.write((w) => w.update("billing_subscriptions", where, { owner_user_id: userId }));
  }

  /** The owner a provider customer belongs to: only customers Meldiq created or saw on one of its subscriptions. */
  ownerOfCustomer(provider: string, customerRef: string, r: RowReader = this.rows): BillingOwner | null {
    const c = r.get<{ owner_kind: "org" | "account"; owner_id: string }>("billing_customers", { provider, provider_customer_ref: customerRef });
    if (c) return c.owner_kind === "org" ? { kind: "org", orgId: c.owner_id } : { kind: "account", accountId: c.owner_id };
    const s = r.get<SubscriptionRow>("billing_subscriptions", { provider, provider_customer_ref: customerRef }, newest);
    return s ? ownerOfRow(s) : null;
  }

  /** The owner's stored provider customer, if any. */
  customerOf(provider: string, owner: BillingOwner): string | null {
    return this.rows.get<{ provider_customer_ref: string }>("billing_customers", { provider, owner_kind: owner.kind, owner_id: ownerParam(owner) })?.provider_customer_ref ?? null;
  }

  /**
   * Applies a provider's subscription snapshot; [source] says where it came from (`provider_event:<id>`, `reconcile:<time>`). A snapshot older than the newest one applied is
   * skipped ("stale"), so duplicated and out-of-order deliveries settle on the provider's latest state.
   */
  applySnapshot(w: RowWriter, provider: string, snap: SubscriptionSnapshot, providerAt: number, source: string, t: number): ApplyOutcome {
    const version = this.catalog.byPrice(provider, snap.priceRef) ?? this.storeVersion?.(provider, snap.priceRef) ?? null;
    if (!version) throw new BillingEventError("unknown_price", `No published plan version uses the price ${snap.priceRef}`);
    const existing = w.get<SubscriptionRow>("billing_subscriptions", { provider, provider_subscription_ref: snap.ref });
    if (existing) return this.update(w, existing, version.id, snap, providerAt, source, t);
    return this.insert(w, provider, version.id, snap, providerAt, source, t);
  }

  private insert(w: RowWriter, provider: string, versionId: string, snap: SubscriptionSnapshot, providerAt: number, source: string, t: number): ApplyOutcome {
    // A new subscription belongs to the owner who started the checkout it names, never to an id the provider sends on
    // its own (a customer id, metadata naming an owner, an email).
    if (!snap.checkoutRef) throw new BillingEventError("unknown_checkout", "The provider's subscription names no checkout of ours");
    const checkout = w.get<CheckoutRow>("billing_checkouts", { id: snap.checkoutRef, provider });
    if (!checkout) throw new BillingEventError("unknown_checkout", "The provider's subscription names a checkout that doesn't exist");
    if (w.get("billing_subscriptions", { checkout_id: checkout.id })) throw new BillingEventError("checkout_mismatch", "That checkout already has a subscription");
    const plan = this.catalog.plan(this.catalog.version(versionId)!.plan_id)!;
    if ((plan.audience === "personal") !== (checkout.owner_kind === "account")) {
      throw new BillingEventError("audience_mismatch", "The subscription's price is for another kind of owner than the checkout's");
    }
    const owner = ownerOfRow(checkout);
    // One plan and one Spark add-on per owner: each is checked against its own kind.
    const live = this.isAddonVersion(versionId) ? this.liveAddonForOwner(owner, w) : this.liveForOwner(owner, w);
    if (live && !TERMINAL.has(snap.status)) throw new BillingEventError("org_has_subscription", "The owner already has a subscription that isn't over");
    const id = newId("sub");
    w.insert("billing_subscriptions", {
      id, owner_kind: checkout.owner_kind, org_id: checkout.org_id, account_id: checkout.account_id, owner_user_id: checkout.owner_kind === "account" ? checkout.user_id : null,
      billing_user_id: checkout.user_id, billing_account_id: checkout.started_by_account_id, plan_version_id: versionId, status: snap.status, provider,
      provider_customer_ref: snap.customerRef, provider_subscription_ref: snap.ref, checkout_id: checkout.id, current_period_start: snap.currentPeriodStart,
      current_period_end: snap.currentPeriodEnd, trial_end: snap.trialEnd, cancel_at_period_end: snap.cancelAtPeriodEnd ? 1 : 0, canceled_at: snap.canceledAt,
      past_due_since: snap.status === "past_due" || snap.status === "unpaid" ? providerAt : null, provider_updated_at: providerAt, created_at: t, updated_at: t,
      quantity: snap.quantity ?? 1,
    });
    const done = w.get<{ completed_at: number | null }>("billing_checkouts", { id: checkout.id });
    w.update("billing_checkouts", { id: checkout.id }, { status: "completed", completed_at: done?.completed_at ?? t });
    if (snap.customerRef) this.rememberCustomer(w, provider, owner, snap.customerRef, t);
    this.history(w, id, t, null, snap.status, versionId, source, snap.cancelAtPeriodEnd ? { cancelAtPeriodEnd: true } : {});
    return { result: "applied", subscriptionId: id, owner };
  }

  private update(w: RowWriter, s: SubscriptionRow, versionId: string, snap: SubscriptionSnapshot, providerAt: number, source: string, t: number): ApplyOutcome {
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
    const quantity = snap.quantity ?? s.quantity;
    w.update("billing_subscriptions", { id: s.id }, {
      plan_version_id: versionId, status: snap.status, provider_customer_ref: snap.customerRef ?? s.provider_customer_ref, current_period_start: snap.currentPeriodStart,
      current_period_end: snap.currentPeriodEnd, trial_end: snap.trialEnd, cancel_at_period_end: snap.cancelAtPeriodEnd ? 1 : 0, canceled_at: snap.canceledAt,
      past_due_since: pastDueSince, provider_updated_at: providerAt, updated_at: t, quantity,
    });
    const changed: Record<string, unknown> = {};
    if (versionId !== s.plan_version_id) changed.planVersion = { from: s.plan_version_id, to: versionId };
    if (!!s.cancel_at_period_end !== snap.cancelAtPeriodEnd) changed.cancelAtPeriodEnd = snap.cancelAtPeriodEnd;
    if (snap.currentPeriodEnd !== s.current_period_end) changed.renewedTo = snap.currentPeriodEnd;
    if (quantity !== s.quantity) changed.quantity = { from: s.quantity, to: quantity };
    if (snap.status !== s.status || Object.keys(changed).length > 0) this.history(w, s.id, t, s.status, snap.status, versionId, source, changed);
    return { result: "applied", subscriptionId: s.id, owner };
  }

  private history(w: RowWriter, subscriptionId: string, t: number, from: SubscriptionStatus | null, to: SubscriptionStatus, versionId: string, source: string, detail: Record<string, unknown>): void {
    w.insert("billing_subscription_history", { subscription_id: subscriptionId, at: t, from_status: from, to_status: to, plan_version_id: versionId, source, detail: JSON.stringify(detail) });
  }

  /** One customer per owner and provider; a reference already known (for this or another owner) is left alone. */
  rememberCustomer(w: RowWriter, provider: string, owner: BillingOwner, customerRef: string, t: number): void {
    w.insert("billing_customers", { id: newId("bcu"), provider, owner_kind: owner.kind, owner_id: ownerParam(owner), provider_customer_ref: customerRef, created_at: t }, { orIgnore: true });
  }

  /** Records a provider's invoice; its subscription must be known (an invoice that arrives first is retried later). */
  applyInvoice(w: RowWriter, provider: string, inv: InvoiceSnapshot, providerAt: number, t: number): ApplyOutcome {
    const sub = inv.subscriptionRef ? w.get<SubscriptionRow>("billing_subscriptions", { provider, provider_subscription_ref: inv.subscriptionRef }) : undefined;
    if (!sub) throw new BillingEventError("unknown_subscription", "The invoice's subscription isn't known yet");
    const owner = ownerOfRow(sub);
    const existing = w.get<{ id: string; provider_updated_at: number; amount_refunded_minor: number }>("billing_invoices", { provider, provider_invoice_ref: inv.ref });
    if (existing && providerAt < existing.provider_updated_at) return { result: "stale", subscriptionId: sub.id, owner };
    const fields = {
      status: inv.status, currency: inv.currency, amount_due_minor: inv.amountDueMinor, amount_paid_minor: inv.amountPaidMinor,
      amount_refunded_minor: Math.max(existing?.amount_refunded_minor ?? 0, inv.amountRefundedMinor), tax_minor: inv.taxMinor, period_start: inv.periodStart, period_end: inv.periodEnd,
      paid_at: inv.paidAt, provider_updated_at: providerAt, updated_at: t,
    };
    if (existing) w.update("billing_invoices", { id: existing.id }, fields);
    else {
      w.insert("billing_invoices", {
        id: newId("inv"), provider, provider_invoice_ref: inv.ref, subscription_id: sub.id, owner_kind: sub.owner_kind, org_id: sub.org_id, account_id: sub.account_id,
        issued_at: inv.issuedAt, ...fields,
      });
    }
    return { result: "applied", subscriptionId: sub.id, owner };
  }

  /**
   * A hosted checkout finished or ran out. Finishing grants nothing by itself: only the subscription's own events (or a
   * reconciliation that reads it from the provider) do. Checkouts Meldiq didn't start are ignored.
   */
  applyCheckout(w: RowWriter, provider: string, snap: CheckoutSnapshot, t: number): ApplyOutcome {
    const checkout = snap.reference
      ? w.get<CheckoutRow & { completed_at: number | null; provider_subscription_ref: string | null }>("billing_checkouts", { id: snap.reference, provider })
      : w.get<CheckoutRow & { completed_at: number | null; provider_subscription_ref: string | null }>("billing_checkouts", { provider_session_ref: snap.sessionRef, provider });
    if (!checkout) return { result: "stale", subscriptionId: null, owner: null };
    const owner = ownerOfRow(checkout);
    const sub = w.get<{ id: string }>("billing_subscriptions", { checkout_id: checkout.id });
    if (snap.outcome === "completed") {
      w.update("billing_checkouts", { id: checkout.id }, {
        status: "completed", completed_at: checkout.completed_at ?? t, provider_subscription_ref: snap.subscriptionRef ?? checkout.provider_subscription_ref,
      });
      if (snap.customerRef) this.rememberCustomer(w, provider, owner, snap.customerRef, t);
    } else if (checkout.status === "open" || checkout.status === "superseded") {
      w.update("billing_checkouts", { id: checkout.id }, { status: "expired" });
    }
    return { result: "applied", subscriptionId: sub?.id ?? null, owner };
  }

  /**
   * A refund or dispute on one of an owner's payments, written into the subscription's history for support and audit.
   * It changes no state: whether access ends is the provider's subscription event (a cancellation) to say.
   */
  applyPayment(w: RowWriter, provider: string, p: PaymentSnapshot, source: string, t: number): ApplyOutcome {
    const owner = p.customerRef ? this.ownerOfCustomer(provider, p.customerRef, w) : null;
    const s = owner ? w.get<SubscriptionRow>("billing_subscriptions", { ...ownerWhere(owner), provider }, newest) : undefined;
    if (!owner || !s) return { result: "stale", subscriptionId: null, owner };
    this.history(w, s.id, t, s.status, s.status, s.plan_version_id, source, {
      [p.kind]: { ref: p.ref, state: p.state, currency: p.currency, amountMinor: p.amountMinor, affectedMinor: p.affectedMinor },
    });
    return { result: "applied", subscriptionId: s.id, owner };
  }
}
