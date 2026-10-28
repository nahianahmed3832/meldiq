import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../../infrastructure/database/db.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { type PlanAudience, PlanCatalog, type QuotaPlanCheck, parseLimits } from "./catalog.js";
import type { BillingConfig } from "./config.js";
import { type BillingOwner, ownerClause, ownerParam, ownerRef } from "./owners.js";
import type { BillingProvider } from "./providers/types.js";
import { type SubscriptionRow, Subscriptions } from "./subscriptions.js";
import { Grants } from "./grants.js";
import { BillingWebhooks } from "./webhooks.js";

const CHECKOUT_TTL_MS = 24 * 3_600_000;
const OWNER_INVOICES = 24;
/** Reconciliation stamps what it read slightly in the past, so a provider clock a little behind ours can still win. */
const RECONCILE_SKEW_MS = 30_000;

/** Who started a checkout: the signed-in account (and its encryption identity, when it has one). */
export interface CheckoutStarter {
  accountId: string | null;
  userId: string | null;
  /** Sent to the provider for receipts (the account's verified address); never taken from the request body. */
  email: string | null;
  /** The provider customer's display name (the person's or the organization's). */
  name: string | null;
}

const audienceOf = (owner: BillingOwner): PlanAudience => (owner.kind === "account" ? "personal" : "organization");

/** The billing module's one entry point (ctx.billing): catalog, subscriptions, webhooks, checkout and the portal. */
export class Billing {
  readonly catalog: PlanCatalog;
  readonly subscriptions: Subscriptions;
  readonly webhooks: BillingWebhooks;
  readonly provider: BillingProvider | null;
  readonly unavailableReason: string | null;
  readonly returnUrl: string | null;
  readonly grants: Grants;
  private readonly portalConfiguration: string | null;
  /** Told when an owner's subscription (and so its entitlements) may have changed (server.ts: realtime notices). */
  onChange: ((owner: BillingOwner) => void) | null = null;

  constructor(
    private readonly db: DB,
    config: BillingConfig,
    private readonly log: FastifyBaseLogger,
    private readonly clock: () => number = Date.now,
    quotaPlanExists?: QuotaPlanCheck,
  ) {
    this.provider = config.provider;
    this.unavailableReason = config.unavailableReason;
    this.returnUrl = config.returnUrl;
    this.catalog = new PlanCatalog(db, quotaPlanExists);
    this.subscriptions = new Subscriptions(db, this.catalog);
    this.webhooks = new BillingWebhooks(db, config.provider, this.subscriptions, log, clock);
    this.grants = new Grants(db, config.trials, clock);
    this.portalConfiguration = config.portalConfiguration;
    this.webhooks.afterApply = (event, outcome) => {
      if (outcome.owner) this.changed(outcome.owner);
      // The checkout finished but its subscription's own event hasn't arrived (or was lost): read it from the provider.
      if (event.kind === "checkout" && event.checkout.outcome === "completed" && event.checkout.subscriptionRef && !outcome.subscriptionId) {
        void this.reconcileRefs([event.checkout.subscriptionRef]).catch((e) => this.log.warn({ err: e }, "billing reconciliation after checkout failed"));
      }
    };
  }

  private changed(owner: BillingOwner): void {
    try {
      this.onChange?.(owner);
    } catch (e) {
      this.log.error({ err: e }, "billing change notice failed");
    }
  }

  private requireProvider(): BillingProvider {
    if (!this.provider) throw new ApiError(409, "billing_unavailable", this.unavailableReason ?? "Billing isn't available");
    return this.provider;
  }

  /** The cleanup job's part (every minute): retries failed provider events and closes checkouts past their time. */
  sweep(): number {
    const expired = this.db.prepare("UPDATE billing_checkouts SET status = 'expired' WHERE status IN ('open', 'superseded') AND expires_at <= ?").run(this.clock()).changes;
    return this.webhooks.retryDue() + expired;
  }

  /** Plans that can be bought now (public, active, current at the configured provider), for one audience or all. */
  offers(audience: PlanAudience | null = "organization") {
    const provider = this.provider;
    if (!provider) return [];
    return this.catalog
      .all()
      .filter((p) => p.public && p.status === "active" && (audience === null || p.audience === audience))
      .flatMap((p) => {
        const v = this.catalog.current(p.id);
        if (!v || v.provider !== provider.id) return [];
        return [{ key: p.key, name: p.name, description: p.description, audience: p.audience, interval: v.interval, currency: v.currency, amountMinor: v.amount_minor, trialDays: v.trial_days, graceDays: v.grace_days, limits: parseLimits(v.limits) }];
      });
  }

  /** The public price list (the website's pricing page): no account needed, nothing about anyone's subscription. */
  publicCatalog() {
    const c = this.grants.config;
    return {
      available: !!this.provider,
      mode: this.provider?.mode ?? null,
      plans: this.offers(null),
      /** The free periods on offer: every account's trial and the invite-link bonus (null while trials are off). */
      trial: c && this.clock() >= c.startsAt ? { planKey: c.planKey, days: c.days, referralDays: c.referralDays, referralYearlyCapDays: c.referralCapDays } : null,
    };
  }

  /**
   * The quota plan a person (users.id) or an organization is on through billing: a granting subscription first, else a
   * free period (grants) of the plan whose current terms name one.
   */
  quotaPlanFor(scope: { type: string; id: string }, t: number): string | null {
    const fromSubscription = this.subscriptions.quotaPlanFor(scope, t);
    if (fromSubscription || scope.type !== "user") return fromSubscription;
    const g = this.grants.activeForUser(scope.id, t);
    const plan = g ? this.catalog.byKey(g.plan_key) : null;
    return plan ? (this.catalog.current(plan.id)?.quota_plan_id ?? null) : null;
  }

  /** Organization checkout started from a device session (GET/POST /v1/orgs/:orgId/billing…, API 0.49.0). */
  startCheckout(orgId: string, userId: string, planKey: string): Promise<{ checkoutId: string; url: string | null; expiresAt: number }> {
    return this.startOwnerCheckout({ kind: "org", orgId }, { accountId: null, userId, email: null, name: null }, planKey);
  }

  /**
   * Starts a hosted checkout for [owner] (the caller has checked that the signed-in person may: themselves, or an
   * organization's owner). Only a configured, public, current plan for the owner's audience can be bought, at the price
   * the catalog holds; the client names a plan key, never an amount or a provider price. Coming back from the
   * provider's page proves nothing: the subscription exists only once the provider's signed event (or a reconciliation
   * that reads it from the provider) says so.
   */
  async startOwnerCheckout(owner: BillingOwner, starter: CheckoutStarter, planKey: string): Promise<{ checkoutId: string; url: string | null; expiresAt: number }> {
    const provider = this.requireProvider();
    const plan = this.catalog.byKey(planKey);
    const version = plan && plan.public && plan.status === "active" && plan.audience === audienceOf(owner) ? this.catalog.current(plan.id) : null;
    if (!plan || !version || version.provider !== provider.id || !version.provider_price_ref) throw notFound("No such plan");
    if (this.subscriptions.liveForOwner(owner)) throw conflict("There is already a subscription here. Change it from the billing page instead.");
    const t = this.clock();
    const id = newId("chk");
    // One unfinished checkout per owner: an earlier one is superseded (and expired at the provider below), so two open
    // payment pages can't both become subscriptions.
    const superseded = this.db.transaction(() => {
      const open = this.db.prepare(`SELECT provider_session_ref ref FROM billing_checkouts WHERE ${ownerClause(owner)} AND status = 'open'`).all(ownerParam(owner)) as { ref: string | null }[];
      this.db.prepare(`UPDATE billing_checkouts SET status = 'superseded' WHERE ${ownerClause(owner)} AND status = 'open'`).run(ownerParam(owner));
      this.db
        .prepare(
          `INSERT INTO billing_checkouts (id, owner_kind, org_id, account_id, user_id, started_by_account_id, plan_version_id, provider, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(id, owner.kind, owner.kind === "org" ? owner.orgId : null, owner.kind === "account" ? owner.accountId : null, starter.userId, starter.accountId, version.id, provider.id, t, t + CHECKOUT_TTL_MS);
      return open.flatMap((o) => (o.ref ? [o.ref] : []));
    })();
    for (const ref of superseded) await this.expireAtProvider(provider, ref);
    let session: { sessionRef: string; url: string | null };
    try {
      const customerRef = await this.customerFor(provider, owner, starter);
      session = await provider.createCheckout({
        reference: id,
        priceRef: version.provider_price_ref,
        // A trial is for an owner's first subscription only.
        trialDays: this.subscriptions.hadAny(owner) ? 0 : version.trial_days,
        trialEndsAt: this.freePeriodEnd(owner),
        customerRef,
        owner: ownerRef(owner),
        successUrl: `${this.returnUrl ?? ""}?checkout=success`,
        cancelUrl: `${this.returnUrl ?? ""}?checkout=canceled`,
      });
    } catch (e) {
      this.db.prepare("UPDATE billing_checkouts SET status = 'expired' WHERE id = ?").run(id);
      if (e instanceof ApiError) throw e;
      this.log.error({ err: e, checkout: id }, "billing provider checkout failed");
      throw new ApiError(503, "unavailable", "The payment provider couldn't be reached. Nothing was charged. Try again in a moment.");
    }
    const kept = this.db.prepare("UPDATE billing_checkouts SET provider_session_ref = ? WHERE id = ? AND status = 'open'").run(session.sessionRef, id).changes;
    if (kept === 0) {
      // A newer checkout replaced this one while the provider answered.
      await this.expireAtProvider(provider, session.sessionRef);
      throw conflict("A newer checkout was started. Use that one.");
    }
    return { checkoutId: id, url: session.url, expiresAt: t + CHECKOUT_TTL_MS };
  }

  /**
   * When the owner's free period (a grant) ends, if it still has more than two days left: a subscription bought during
   * it starts charging then, so subscribing early never costs free days. (Providers need a trial end some time ahead.)
   */
  private freePeriodEnd(owner: BillingOwner): number | null {
    if (owner.kind !== "account") return null;
    const t = this.clock();
    const g = this.grants.active(owner.accountId, t);
    return g && g.ends_at > t + 2 * 86_400_000 ? g.ends_at : null;
  }

  private async expireAtProvider(provider: BillingProvider, sessionRef: string): Promise<void> {
    try {
      await provider.expireCheckout?.(sessionRef);
    } catch (e) {
      this.log.warn({ err: e }, "billing provider couldn't expire a superseded checkout");
    }
  }

  /** The provider customer Meldiq already has for [owner], if any (never one named by a client). */
  storedCustomer(owner: BillingOwner): string | null {
    const provider = this.provider;
    if (!provider) return null;
    const row = this.db.prepare("SELECT provider_customer_ref ref FROM billing_customers WHERE provider = ? AND owner_kind = ? AND owner_id = ?").get(provider.id, owner.kind, ownerParam(owner)) as
      | { ref: string }
      | undefined;
    if (row) return row.ref;
    const fromSub = this.db
      .prepare(`SELECT provider_customer_ref ref FROM billing_subscriptions WHERE ${ownerClause(owner)} AND provider = ? AND provider_customer_ref IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)
      .get(ownerParam(owner), provider.id) as { ref: string } | undefined;
    return fromSub?.ref ?? null;
  }

  /** The owner's provider customer, created once at the provider when it has customers and none exists yet. */
  private async customerFor(provider: BillingProvider, owner: BillingOwner, starter: CheckoutStarter): Promise<string | null> {
    const known = this.storedCustomer(owner);
    if (known || !provider.createCustomer) return known;
    const ref = await provider.createCustomer({ owner: ownerRef(owner), email: starter.email, name: starter.name });
    this.subscriptions.rememberCustomer(provider.id, owner, ref, this.clock());
    // Two checkouts at once get the same customer from the provider (an idempotency key); the stored one wins anyway.
    return this.storedCustomer(owner) ?? ref;
  }

  /** Whether the account's own subscription will charge again (not ending, not over): account deletion waits for it. */
  renewsPersonal(accountId: string): boolean {
    const s = this.subscriptions.liveForOwner({ kind: "account", accountId });
    return !!s && !s.cancel_at_period_end && s.status !== "paused";
  }

  /** A hosted page where the owner manages payment methods, invoices, plan changes and cancellation. */
  async portal(owner: BillingOwner): Promise<{ url: string }> {
    const provider = this.requireProvider();
    if (!provider.createPortal || !this.returnUrl) throw new ApiError(409, "billing_unavailable", "This billing provider has no customer portal");
    const customerRef = this.storedCustomer(owner);
    if (!customerRef) throw notFound("There is no billing account to manage yet");
    try {
      return { url: await provider.createPortal({ customerRef, returnUrl: this.returnUrl, configuration: this.portalConfiguration }) };
    } catch (e) {
      this.log.error({ err: e }, "billing provider portal failed");
      throw new ApiError(503, "unavailable", "The payment provider couldn't be reached. Try again in a moment.");
    }
  }

  /**
   * Reads the owner's subscriptions from the provider and applies what it says (restoring after a missed webhook, or
   * after the person comes back from checkout). Only subscriptions already tied to this owner, or created through its
   * own checkouts, are read: nothing a client names.
   */
  async reconcile(owner: BillingOwner): Promise<{ checked: number }> {
    const provider = this.requireProvider();
    if (!provider.fetchSubscription) return { checked: 0 };
    const refs = new Set<string>();
    const live = this.subscriptions.liveForOwner(owner);
    if (live) refs.add(live.provider_subscription_ref);
    const pending = this.db
      .prepare(
        `SELECT c.provider_subscription_ref ref FROM billing_checkouts c WHERE ${ownerClause(owner, "c.")}
           AND c.provider = ? AND c.provider_subscription_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.checkout_id = c.id)`,
      )
      .all(ownerParam(owner), provider.id) as { ref: string }[];
    for (const p of pending) refs.add(p.ref);
    await this.reconcileRefs([...refs]);
    return { checked: refs.size };
  }

  private async reconcileRefs(refs: string[]): Promise<void> {
    const provider = this.provider;
    if (!provider?.fetchSubscription) return;
    for (const ref of refs) {
      const snap = await provider.fetchSubscription(ref);
      if (!snap) continue;
      const existing = this.db.prepare("SELECT provider_updated_at FROM billing_subscriptions WHERE provider = ? AND provider_subscription_ref = ?").get(provider.id, ref) as
        | { provider_updated_at: number }
        | undefined;
      const t = this.clock();
      const at = Math.max(existing?.provider_updated_at ?? 0, t - RECONCILE_SKEW_MS);
      try {
        const outcome = this.db.transaction(() => this.subscriptions.applySnapshot(provider.id, snap, at, `reconcile:${t}`, t))();
        if (outcome.owner && outcome.result === "applied") this.changed(outcome.owner);
      } catch (e) {
        this.log.warn({ err: e, subscription: ref }, "billing reconciliation couldn't apply the provider's state");
      }
    }
  }

  private subscriptionView(s: SubscriptionRow, t: number) {
    const v = this.catalog.version(s.plan_version_id)!;
    const plan = this.catalog.plan(v.plan_id)!;
    return {
      plan: { key: plan.key, name: plan.name },
      status: s.status,
      standing: this.subscriptions.standingOf(s, t),
      interval: v.interval,
      currency: v.currency,
      amountMinor: v.amount_minor,
      currentPeriodEnd: s.current_period_end,
      trialEnd: s.trial_end,
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
    };
  }

  private invoices(owner: BillingOwner) {
    const rows = this.db
      .prepare(
        `SELECT status, currency, amount_due_minor, amount_paid_minor, amount_refunded_minor, period_start, period_end, issued_at, paid_at FROM billing_invoices
         WHERE ${ownerClause(owner)} ORDER BY issued_at DESC LIMIT ?`,
      )
      .all(ownerParam(owner), OWNER_INVOICES) as {
      status: string;
      currency: string;
      amount_due_minor: number;
      amount_paid_minor: number;
      amount_refunded_minor: number;
      period_start: number | null;
      period_end: number | null;
      issued_at: number;
      paid_at: number | null;
    }[];
    return rows.map((i) => ({
      status: i.status,
      currency: i.currency,
      amountDueMinor: i.amount_due_minor,
      amountPaidMinor: i.amount_paid_minor,
      amountRefundedMinor: i.amount_refunded_minor,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      issuedAt: i.issued_at,
      paidAt: i.paid_at,
    }));
  }

  /** What an organization's owners see about its billing (API 0.49.0 shape): its subscription and invoices only. */
  orgSummary(orgId: string) {
    const owner: BillingOwner = { kind: "org", orgId };
    const s = this.subscriptions.liveForOwner(owner);
    return {
      available: !!this.provider,
      reason: this.unavailableReason,
      subscription: s ? this.subscriptionView(s, this.clock()) : null,
      invoices: this.invoices(owner),
      offers: this.offers("organization").map(({ audience: _a, graceDays: _g, ...o }) => o),
    };
  }

  /** An owner's billing page (the website's account and organization pages). */
  summary(owner: BillingOwner) {
    const s = this.subscriptions.liveForOwner(owner);
    return {
      available: !!this.provider,
      reason: this.unavailableReason,
      mode: this.provider?.mode ?? null,
      subscription: s ? this.subscriptionView(s, this.clock()) : null,
      invoices: this.invoices(owner),
      offers: this.offers(audienceOf(owner)),
      portal: !!this.provider?.createPortal && !!this.returnUrl && this.storedCustomer(owner) !== null,
    };
  }
}
