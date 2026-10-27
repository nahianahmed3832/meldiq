import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../../infrastructure/database/db.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { PlanCatalog, parseLimits } from "./catalog.js";
import type { BillingConfig } from "./config.js";
import type { BillingProvider } from "./providers/types.js";
import { Subscriptions } from "./subscriptions.js";
import { BillingWebhooks } from "./webhooks.js";

const CHECKOUT_TTL_MS = 24 * 3_600_000;
const ORG_INVOICES = 24;

/** The billing module's one entry point (ctx.billing): catalog, subscriptions, webhooks and checkout. */
export class Billing {
  readonly catalog: PlanCatalog;
  readonly subscriptions: Subscriptions;
  readonly webhooks: BillingWebhooks;
  readonly provider: BillingProvider | null;
  readonly unavailableReason: string | null;

  constructor(
    private readonly db: DB,
    config: BillingConfig,
    log: FastifyBaseLogger,
    private readonly clock: () => number = Date.now,
  ) {
    this.provider = config.provider;
    this.unavailableReason = config.unavailableReason;
    this.catalog = new PlanCatalog(db);
    this.subscriptions = new Subscriptions(db, this.catalog);
    this.webhooks = new BillingWebhooks(db, config.provider, this.subscriptions, log, clock);
  }

  private requireProvider(): BillingProvider {
    if (!this.provider) throw new ApiError(409, "billing_unavailable", this.unavailableReason ?? "Billing isn't available");
    return this.provider;
  }

  /** The cleanup job's part (every minute): retries failed provider events and closes checkouts past their time. */
  sweep(): number {
    const expired = this.db.prepare("UPDATE billing_checkouts SET status = 'expired' WHERE status = 'open' AND expires_at <= ?").run(this.clock()).changes;
    return this.webhooks.retryDue() + expired;
  }

  /** Plans an organization's owner may choose: public, active, with a current version at the configured provider. */
  offers() {
    const provider = this.provider;
    if (!provider) return [];
    return this.catalog
      .all()
      .filter((p) => p.public && p.status === "active")
      .flatMap((p) => {
        const v = this.catalog.current(p.id);
        if (!v || v.provider !== provider.id) return [];
        return [{ key: p.key, name: p.name, description: p.description, interval: v.interval, currency: v.currency, amountMinor: v.amount_minor, trialDays: v.trial_days, limits: parseLimits(v.limits) }];
      });
  }

  /**
   * Starts a hosted checkout for an organization (its owner only; the caller checks the role). Coming back from the
   * provider's page proves nothing: the subscription exists only once the provider's signed event says so.
   */
  async startCheckout(orgId: string, userId: string, planKey: string): Promise<{ checkoutId: string; url: string | null; expiresAt: number }> {
    const provider = this.requireProvider();
    const plan = this.catalog.byKey(planKey);
    const version = plan && plan.public && plan.status === "active" ? this.catalog.current(plan.id) : null;
    if (!plan || !version || version.provider !== provider.id || !version.provider_price_ref) throw notFound("No such plan");
    if (this.subscriptions.liveFor(orgId)) throw conflict("This community already has a subscription. Change it from the billing page instead.");
    const t = this.clock();
    const id = newId("chk");
    const customerRef = (this.db.prepare("SELECT provider_customer_ref FROM billing_subscriptions WHERE org_id = ? AND provider = ? AND provider_customer_ref IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(orgId, provider.id) as
      | { provider_customer_ref: string }
      | undefined)?.provider_customer_ref ?? null;
    const session = await provider.createCheckout({ reference: id, priceRef: version.provider_price_ref, trialDays: version.trial_days, customerRef });
    this.db
      .prepare("INSERT INTO billing_checkouts (id, org_id, user_id, plan_version_id, provider, provider_session_ref, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)")
      .run(id, orgId, userId, version.id, provider.id, session.sessionRef, t, t + CHECKOUT_TTL_MS);
    return { checkoutId: id, url: session.url, expiresAt: t + CHECKOUT_TTL_MS };
  }

  /** What an organization's owners see about its billing: the subscription and its invoices, nothing about others. */
  orgSummary(orgId: string) {
    const t = this.clock();
    const s = this.subscriptions.liveFor(orgId);
    const v = s ? this.catalog.version(s.plan_version_id) : null;
    const plan = v ? this.catalog.plan(v.plan_id) : null;
    const invoices = this.db
      .prepare("SELECT status, currency, amount_due_minor, amount_paid_minor, amount_refunded_minor, period_start, period_end, issued_at, paid_at FROM billing_invoices WHERE org_id = ? ORDER BY issued_at DESC LIMIT ?")
      .all(orgId, ORG_INVOICES) as {
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
    return {
      available: !!this.provider,
      reason: this.unavailableReason,
      subscription:
        s && v && plan
          ? {
              plan: { key: plan.key, name: plan.name },
              status: s.status,
              standing: this.subscriptions.standingOf(s, t),
              interval: v.interval,
              currency: v.currency,
              amountMinor: v.amount_minor,
              currentPeriodEnd: s.current_period_end,
              trialEnd: s.trial_end,
              cancelAtPeriodEnd: !!s.cancel_at_period_end,
            }
          : null,
      invoices: invoices.map((i) => ({
        status: i.status,
        currency: i.currency,
        amountDueMinor: i.amount_due_minor,
        amountPaidMinor: i.amount_paid_minor,
        amountRefundedMinor: i.amount_refunded_minor,
        periodStart: i.period_start,
        periodEnd: i.period_end,
        issuedAt: i.issued_at,
        paidAt: i.paid_at,
      })),
      offers: this.offers(),
    };
  }
}
