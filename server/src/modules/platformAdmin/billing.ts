import { adminGiftPage, AdminBillingRecords } from "../billing/index.js";
import type { AppContext } from "../../app/context.js";
import { PayPalCheckout, PayPalProvider } from "../billing/index.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { ENTITLEMENT_KEYS, ENTITLEMENT_LABELS, type EntitlementKey, orgLimitOverrides } from "../administration/index.js";
import {
  BILLING_DEFINITIONS,
  billingMetrics,
  eventRows,
  type PlanMeta,
  type PlanRow,
  type PlanTerms,
  subscriptionRecords,
  subscriptionRows,
  type SubscriptionRow,
  termsOf,
  type VersionRow,
} from "../billing/index.js";
import { orgNames, orgRecord } from "../organizations/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminAuthService, AdminPrincipal } from "./auth.js";
import { currentFinancialPrincipal } from "./financialAuthority.js";
import type { RequestMeta } from "./credentials.js";
import { decodeCursor, page } from "./pagination.js";

const DAY_MS = 86_400_000;
/** The longest an operator limit may run before it must be set again (a super admin may choose no end). */
const MAX_LIMIT_DAYS = 366;
const DETAIL_ROWS = 50;

const limitsOf = (ctx: AppContext, orgId: string) => ENTITLEMENT_KEYS.map((key) => ({ key, ...ctx.entitlements.limitFor(key, orgId) }));

/**
 * Billing in the console (docs/BILLING.md): operator limits, the plan catalog, subscriptions, invoices and provider
 * events. Subscription state is never edited here: it comes only from verified provider events. What operators can do is
 * prepare and publish plans, set time-bounded limits, and replay a provider event that failed. Every change is audited.
 */
export class AdminBilling {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
    private readonly auth?: AdminAuthService,
  ) {}

  private get records() { return new AdminBillingRecords(this.ctx.billing); }

  private async record(
    p: AdminPrincipal,
    action: string,
    targetType: string,
    targetId: string,
    reason: string | null,
    meta: RequestMeta,
    detail: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.audit.record({
      action,
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType,
      targetId,
      reason,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail,
    });
  }

  paypalTransactions() {
    const provider = this.ctx.billing.provider;
    const available = provider?.id === "paypal";
    return {
      transactions: PayPalCheckout.records(this.ctx.billing).map((t) => ({ ...t, refundable: available && t.refundable })),
      integration: {
        available,
        mode: available ? provider!.mode : null,
        reason: available ? null : "PayPal is not configured on this server. Historical records remain available; refunds are disabled.",
      },
    };
  }

  async refundPayPal(p: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    const checkout = new PayPalCheckout(this.ctx.billing, this.ctx.gifts);
    const result = await checkout.refund(id, p.account.id, reason, async () => {
      const fresh = await currentFinancialPrincipal(this.ctx, this.auth, p);
      await this.record(fresh, "billing.paypal.refund_requested", "mojo_gift", id, reason, meta, { provider: "paypal", mode: checkout.provider.mode });
    });
    await this.record(p, "billing.paypal.refund_result", "mojo_gift", id, reason, meta, { status: result.status, reference: result.reference });
    return result;
  }

  refundInspection(id: string) { return this.ctx.billing.adminRefunds.inspect(id); }

  refundOperations(q: { status?: string; account?: string; cursor?: string; limit: number }) {
    const rows = this.records.refundRows({ ...q, after: decodeCursor(q.cursor) });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    return { operations: shown.map(r => this.ctx.billing.adminRefunds.view(r)), nextCursor };
  }

  async requestRefund(p: AdminPrincipal, id: string, input: { requestKey: string; amountMinor: number; currency: string; accountId: string; reason: string }, meta: RequestMeta) {
    const result = await this.ctx.billing.adminRefunds.request(id, input, p.account.id, async r => { const fresh = await currentFinancialPrincipal(this.ctx, this.auth, p); await this.record(fresh, "billing.refund.requested", "billing_refund", r.id, input.reason, meta, { purchaseId: id, amountMinor: input.amountMinor, currency: input.currency, mode: r.provider_mode, accountId: r.account_id }); });
    await this.record(p, "billing.refund.result", "billing_refund", result.id, input.reason, meta, { status: result.status, providerRef: result.providerRef });
    return result;
  }

  async reconcileRefund(p: AdminPrincipal, id: string, reason: string, providerRef: string | undefined, meta: RequestMeta) {
    const result = await this.ctx.billing.adminRefunds.reconcile(id, providerRef);
    await this.record(p, "billing.refund.reconciled", "billing_refund", id, reason, meta, { status: result.status, providerRef: result.providerRef });
    return result;
  }

  /** Bounded server-side merged keyset page; no browser page is used as a platform total. */
  paypalPayments(q: { account?: string; status?: string; kind?: string; cursor?: string; limit: number }) {
    const provider = this.ctx.billing.provider;
    const { rows, nextCursor } = page(this.records.paymentRows({ ...q, after: decodeCursor(q.cursor) }), q.limit);
    return { payments: rows.map(({ created_at: _created, ...r }) => r), nextCursor, configuredMode: provider?.id === "paypal" ? provider.mode : null, historicalMode: "unrecorded" as const };
  }

  cardMandates(q: { account?: string; status?: string; cursor?: string; limit: number }) {
    const { rows, nextCursor } = page(this.records.cardRows({ ...q, after: decodeCursor(q.cursor) }), q.limit);
    return { mandates: rows.map(m => this.records.cardView(m)), nextCursor };
  }

  cardMandate(id: string, q: { cursor?: string; limit: number }) {
    const mandate = this.records.cardMandate(id);
    const { rows, nextCursor } = page(this.records.chargeRows(id, { ...q, after: decodeCursor(q.cursor) }), q.limit);
    return { mandate: this.records.cardView(mandate), charges: rows.map(r => ({ id: r.id, status: r.status, amountMinor: r.amount_minor, currency: r.currency, orderRef: r.provider_order_ref, captureRef: r.provider_capture_ref, generation: r.generation, attempts: r.attempts, processingUntil: r.lease_until, periodStart: r.period_start, periodEnd: r.period_end, createdAt: r.created_at, updatedAt: r.updated_at })), nextCursor };
  }

  async cancelCardMandate(p: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    const mandate = this.records.cardMandate(id), service = this.ctx.billing.cardSubscriptions;
    if (!mandate) throw notFound("Card mandate not found");
    if (!service) throw new ApiError(409, "billing_unavailable", "Card recurring billing is not configured on this server. Restore the original merchant configuration before operating this mandate.");
    await this.record(p, "billing.card.cancel_requested", "billing_card_mandate", id, reason, meta, { accountId: mandate.account_id, paidThrough: mandate.paid_through });
    await currentFinancialPrincipal(this.ctx, this.auth, p);
    await service.cancel(mandate.account_id, id);
    await this.record(p, "billing.card.cancel_completed", "billing_card_mandate", id, reason, meta, { paidThrough: mandate.paid_through });
    return this.records.cardView(this.records.cardMandate(id));
  }

  async recoverCardCharge(p: AdminPrincipal, id: string, reason: string, orderRef: string | undefined, meta: RequestMeta) {
    const service = this.ctx.billing.cardSubscriptions;
    if (!service) throw new ApiError(409, "billing_unavailable", "Card billing is not configured; restore the original merchant configuration to reconcile its charges.");
    await this.record(p, "billing.card.reconcile_requested", "billing_card_charge", id, reason, meta, { suppliedOrderRef: orderRef ?? null });
    const result = await service.reconcileCharge(id, orderRef);
    await this.record(p, "billing.card.reconciled", "billing_card_charge", id, reason, meta, { status: result.status, orderRef: result.orderRef, captureRef: result.captureRef });
    return result;
  }

  gifts() {return {gifts:adminGiftPage(this.ctx)};}

  async giftAction(p: AdminPrincipal, id: string, action: "resend" | "revoke", reason: string, meta: RequestMeta) {
    if (!this.ctx.gifts.delivery) throw notFound("Gift delivery is unavailable");
    const gift = this.ctx.gifts.get(id);
    if (!gift) throw notFound("Gift not found");
    await this.record(p, `billing.gift.${action}_requested`, "mojo_gift", id, reason, meta, {});
    if (action === "resend") await this.ctx.gifts.delivery.resend(gift.buyer_account_id, id);
    else await this.ctx.gifts.delivery.revoke(id, p.account.id);
    await this.record(p, `billing.gift.${action}_completed`, "mojo_gift", id, reason, meta, {});
    return { completed: true as const };
  }

  setup() {
    const provider = this.ctx.billing.provider;
    return {
      provider: provider ? { id: provider.id, mode: provider.mode } : null,
      reason: this.ctx.billing.unavailableReason,
      webhookPath: provider ? `/v1/billing/webhooks/${provider.id}` : null,
      entitlementKeys: ENTITLEMENT_KEYS.map((key) => ({ key, label: ENTITLEMENT_LABELS[key] })),
    };
  }

  // ───────────── Operator limits ─────────────

  overview() {
    const t = now();
    const overrides = orgLimitOverrides(this.ctx.ws, t);
    const names = orgNames(this.ctx.ws, [...new Set(overrides.map((o) => o.org_id))]);
    const server = this.ctx.config.entitlements.limits;
    return {
      billing: { available: !!this.ctx.billing.provider, reason: this.ctx.billing.unavailableReason },
      keys: ENTITLEMENT_KEYS.map((key) => ({ key, label: ENTITLEMENT_LABELS[key] })),
      serverLimits: ENTITLEMENT_KEYS.filter((k) => server[k] !== undefined).map((key) => ({ key, limit: server[key]! })),
      overrides: overrides.map((o) => ({ orgId: o.org_id, orgName: names.get(o.org_id) ?? null, key: o.key, limit: o.limit_value, setAt: o.set_at, expiresAt: o.expires_at, reason: o.reason })),
    };
  }

  /**
   * Sets or clears ([null]) an organization's own limits; the change and its before/after are audited together. Setting
   * a limit needs an end date within a year; no end ([expiresAt] null) is a super admin's explicit choice.
   */
  async setLimits(p: AdminPrincipal, orgId: string, limits: Partial<Record<EntitlementKey, number | null>>, expiresAt: number | null | undefined, reason: string, meta: RequestMeta) {
    if (!orgRecord(this.ctx.ws, orgId)) throw notFound("No such workspace or community");
    const t = now();
    const setting = Object.values(limits).some((v) => v !== null && v !== undefined);
    if (setting && expiresAt === undefined) throw new ApiError(400, "bad_request", "Choose when these limits end");
    if (setting && expiresAt === null && p.grant.role !== "super_admin") throw forbidden("Only a super admin may set a limit with no end date");
    if (setting && expiresAt != null && (expiresAt <= t || expiresAt > t + MAX_LIMIT_DAYS * DAY_MS)) throw new ApiError(400, "bad_request", "The end date must be in the next 366 days");
    const before = Object.fromEntries(
      limitsOf(this.ctx, orgId)
        .filter((l) => l.source === "workspace")
        .map((l) => [l.key, l.limit]),
    );
    // The limits live with the community (possibly MongoDB): recorded once they're set.
    await this.ctx.entitlements.setLimits(orgId, `platform:${p.account.id}`, limits, t, expiresAt ?? null, reason);
    await this.record(p, "org.limits", "org", orgId, reason, meta, {
      ...Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, `${before[k] ?? "default"} -> ${v ?? "default"}`])),
      ...(setting ? { until: expiresAt === null ? "no end" : new Date(expiresAt!).toISOString() } : {}),
    });
    return { limits: limitsOf(this.ctx, orgId) };
  }

  // ───────────── Plan catalog ─────────────

  private planView(plan: PlanRow, counts: Map<string, { total: number; live: number }>) {
    const versions = this.ctx.billing.catalog.versions(plan.id);
    const current = this.ctx.billing.catalog.current(plan.id);
    return {
      id: plan.id,
      key: plan.key,
      name: plan.name,
      description: plan.description,
      segment: plan.segment,
      public: plan.public === 1,
      audience: plan.audience,
      status: plan.status,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      versions: versions.map((v: VersionRow) => ({
        id: v.id,
        version: v.version,
        state: v.published_at === null ? ("draft" as const) : v.retired_at === null && plan.status === "active" ? ("current" as const) : ("retired" as const),
        provider: v.provider,
        terms: termsOf(v),
        createdAt: v.created_at,
        publishedAt: v.published_at,
        retiredAt: v.retired_at,
        subscriptions: counts.get(v.id) ?? { total: 0, live: 0 },
      })),
    };
  }

  plans() {
    const counts = this.ctx.billing.catalog.subscriberCounts();
    return { setup: this.setup(), plans: this.ctx.billing.catalog.all().map((p) => this.planView(p, counts)) };
  }

  private one(planId: string) {
    const plan = this.ctx.billing.catalog.plan(planId);
    if (!plan) throw notFound("No such plan");
    return this.planView(plan, this.ctx.billing.catalog.subscriberCounts());
  }

  // Billing's rows (SQLite or MongoDB) and the console's audit are separate stores: each change is made, then recorded.
  async createPlan(p: AdminPrincipal, b: { key: string; terms: PlanTerms; reason: string } & PlanMeta, meta: RequestMeta) {
    if (b.key === "go") throw new ApiError(400, "bad_request", "Go is retired and cannot be recreated.");
    const created = await this.ctx.billing.catalog.create(b.key, b, b.terms, p.account.id, now());
    await this.record(p, "billing.plan_create", "billing_plan", created.id, b.reason, meta, { key: b.key, name: b.name });
    return this.one(created.id);
  }

  async updatePlan(p: AdminPrincipal, planId: string, b: PlanMeta & { reason: string; expectedUpdatedAt: number }, meta: RequestMeta) {
    await this.ctx.billing.catalog.updateMeta(planId, b, now(), b.expectedUpdatedAt);
    await this.record(p, "billing.plan_update", "billing_plan", planId, b.reason, meta, { name: b.name, public: b.public });
    return this.one(planId);
  }

  async saveDraft(p: AdminPrincipal, planId: string, terms: PlanTerms, reason: string, meta: RequestMeta, expectedUpdatedAt: number) {
    const v = await this.ctx.billing.catalog.saveDraft(planId, terms, p.account.id, now(), expectedUpdatedAt);
    await this.record(p, "billing.plan_draft", "billing_plan", planId, reason, meta, {
      version: v.version,
      price: `${terms.amountMinor} ${terms.currency}/${terms.interval}`,
      providerPriceRef: terms.providerPriceRef,
      limits: JSON.stringify(terms.limits),
    });
    return this.one(planId);
  }

  /** Publishes the draft for new subscribers. Existing subscribers keep the version they're on. */
  async publish(p: AdminPrincipal, planId: string, reason: string, meta: RequestMeta, expectedUpdatedAt: number) {
    if (this.ctx.billing.catalog.plan(planId)?.key === "go") throw new ApiError(400, "bad_request", "Go is retired and cannot be published.");
    const provider = this.ctx.billing.provider;
    if (!provider) throw new ApiError(409, "billing_unavailable", this.ctx.billing.unavailableReason ?? "Billing isn't available");
    const { published, retired } = await this.ctx.billing.catalog.publish(planId, provider.id, p.account.id, now(), expectedUpdatedAt);
    await this.record(p, "billing.plan_publish", "billing_plan", planId, reason, meta, { version: published.version, provider: provider.id, retiredVersion: retired?.version ?? null });
    return this.one(planId);
  }

  async archive(p: AdminPrincipal, planId: string, reason: string, meta: RequestMeta, expectedUpdatedAt: number) {
    await this.ctx.billing.catalog.archive(planId, now(), expectedUpdatedAt);
    await this.record(p, "billing.plan_archive", "billing_plan", planId, reason, meta, {});
    return this.one(planId);
  }

  // ───────────── Subscriptions ─────────────

  private summary(s: SubscriptionRow, names: Map<string, string>, t: number) {
    const v = this.ctx.billing.catalog.version(s.plan_version_id)!;
    const plan = this.ctx.billing.catalog.plan(v.plan_id)!;
    return {
      id: s.id,
      owner: { kind: s.owner_kind, id: s.org_id ?? s.account_id! },
      org: s.org_id ? { id: s.org_id, name: names.get(s.org_id) ?? null } : null,
      plan: { key: plan.key, name: plan.name, version: v.version },
      status: s.status,
      standing: this.ctx.billing.subscriptions.standingOf(s, t),
      provider: s.provider,
      providerMode: s.provider_mode ?? null,
      providerSubscriptionRef: s.provider_subscription_ref,
      currentPeriodEnd: s.current_period_end,
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  }

  subscriptions(q: { status?: string; plan?: string; org?: string; account?: string; mode?: "test" | "live" | "unclassified"; provider?: string; currency?: string; cursor?: string; limit: number }) {
    const rows = subscriptionRows(this.ctx.billing.rows, { ...q, after: decodeCursor(q.cursor) });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    const names = orgNames(this.ctx.ws, [...new Set(shown.flatMap((s) => (s.org_id ? [s.org_id] : [])))]);
    const t = now();
    return { subscriptions: shown.map((s) => this.summary(s, names, t)), nextCursor };
  }

  subscription(id: string) {
    const s = this.ctx.billing.subscriptions.get(id);
    if (!s) throw notFound("No such subscription");
    const t = now();
    const names = orgNames(this.ctx.ws, s.org_id ? [s.org_id] : []);
    const v = this.ctx.billing.catalog.version(s.plan_version_id)!;
    const versionOf = (vid: string) => this.ctx.billing.catalog.version(vid)?.version ?? null;
    const { history, invoices, events } = subscriptionRecords(this.ctx.billing.rows, id, DETAIL_ROWS);
    return {
      subscription: {
        ...this.summary(s, names, t),
        billingUserId: s.billing_user_id,
        providerCustomerRef: s.provider_customer_ref,
        currentPeriodStart: s.current_period_start,
        trialEnd: s.trial_end,
        canceledAt: s.canceled_at,
        pastDueSince: s.past_due_since,
        terms: termsOf(v),
      },
      history: history.map((h) => ({
        at: h.at,
        from: h.from_status,
        to: h.to_status,
        planVersion: versionOf(h.plan_version_id),
        source: h.source,
        detail: h.detail ? (JSON.parse(h.detail) as Record<string, unknown>) : {},
      })),
      invoices: invoices.map((i) => ({
        id: i.id,
        providerMode: i.provider_mode ?? null,
        providerInvoiceRef: i.provider_invoice_ref,
        status: i.status,
        currency: i.currency,
        amountDueMinor: i.amount_due_minor,
        amountPaidMinor: i.amount_paid_minor,
        amountRefundedMinor: i.amount_refunded_minor,
        taxMinor: i.tax_minor,
        periodStart: i.period_start,
        periodEnd: i.period_end,
        issuedAt: i.issued_at,
        paidAt: i.paid_at,
      })),
      limits: s.org_id ? limitsOf(this.ctx, s.org_id) : [],
      events: events.map((e) => ({ id: e.id, type: e.type, status: e.status, receivedAt: e.received_at, lastError: e.last_error })),
    };
  }

  /** A subscription's state as Meldiq holds it (the fields operators compare with the provider's). */
  private stateOf(s: SubscriptionRow) {
    return {
      status: s.status,
      priceRef: this.ctx.billing.catalog.version(s.plan_version_id)?.provider_price_ref ?? null,
      currentPeriodEnd: s.current_period_end,
      trialEnd: s.trial_end,
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
      quantity: s.quantity,
    };
  }

  private static differences(a: Record<string, unknown>, b: Record<string, unknown> | null): string[] {
    if (!b) return ["missing_at_provider"];
    return Object.keys(a).filter((k) => a[k] !== b[k]);
  }

  /**
   * A billing discrepancy, investigated: the subscription as Meldiq has it beside what the provider says now (one read
   * at the provider, nothing changed). Webhooks normally keep them equal; a difference means a lost or failed event.
   */
  async compare(id: string) {
    const s = this.ctx.billing.subscriptions.get(id);
    if (!s) throw notFound("No such subscription");
    const provider = this.ctx.billing.provider;
    const meldiq = this.stateOf(s);
    if (provider?.id !== s.provider || !provider.fetchSubscription) throw new ApiError(409, "billing_unavailable", `The ${s.provider} channel cannot be queried through the configured provider. Review this subscription in its owning provider console.`);
    let atProvider: typeof meldiq | null = null;
    if (provider?.id === s.provider && provider.fetchSubscription) {
      let snap;
      try {
        snap = await provider.fetchSubscription(s.provider_subscription_ref);
      } catch (e) {
        this.ctx.log.warn({ err: e, subscription: id }, "admin: the billing provider couldn't be asked about a subscription");
        throw new ApiError(503, "unavailable", "The payment provider couldn't be reached. Try again in a moment.");
      }
      atProvider = snap
        ? { status: snap.status, priceRef: snap.priceRef, currentPeriodEnd: snap.currentPeriodEnd, trialEnd: snap.trialEnd, cancelAtPeriodEnd: snap.cancelAtPeriodEnd, quantity: snap.quantity ?? 1 }
        : null;
    }
    return { subscriptionId: s.id, provider: s.provider, meldiq, atProvider, differences: AdminBilling.differences(meldiq, atProvider), checkedAt: now() };
  }

  /** Applies the provider's current state to the subscription (as a webhook would), audited with what changed. */
  async resync(p: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    const s = this.ctx.billing.subscriptions.get(id);
    if (!s) throw notFound("No such subscription");
    if (this.ctx.billing.provider?.id !== s.provider) throw new ApiError(409, "billing_unavailable", "This subscription's payment provider isn't configured on this server");
    const before = this.stateOf(s);
    const snapshots = await this.ctx.billing.reconcileRefs([s.provider_subscription_ref]);
    if (snapshots.length === 0) throw new ApiError(503, "unavailable", "The provider state could not be read and applied. Nothing is confirmed recovered; retry reconciliation after the provider is available.");
    const after = this.stateOf(this.ctx.billing.subscriptions.get(id)!);
    const changed = AdminBilling.differences(before, after);
    await this.record(p, "billing.subscription_resync", "billing_subscription", id, reason, meta, { changed: changed.join(",") || "nothing", statusBefore: before.status, statusAfter: after.status });
    return { before, after, changed };
  }

  cancellationOperation(id: string) { return this.records.cancellationOperation(id); }

  /** Stop future PayPal collections using its existing cancellation policy; paid-through access remains provider-derived. */
  async cancelSubscription(p: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    const s = this.ctx.billing.subscriptions.get(id), provider = this.ctx.billing.provider;
    if (!s) throw notFound("Subscription not found");
    if (s.provider !== "paypal" || !(provider instanceof PayPalProvider)) throw conflictForProvider();
    if (s.provider_subscription_ref.startsWith("card_")) throw conflictForProvider();
    const snapshots = await this.ctx.billing.reconcileRefs([s.provider_subscription_ref]);
    if (!snapshots.length) throw new ApiError(503, "unavailable", "PayPal state could not be verified. No cancellation was requested.");
    const current = this.ctx.billing.subscriptions.get(id)!;
    const complete = () => { const row = this.ctx.billing.subscriptions.get(id)!; return !!row.cancel_at_period_end || row.status === "canceled"; };
    if (current.status === "incomplete" || current.status === "incomplete_expired") throw new ApiError(409, "conflict", "This subscription is still awaiting approval or has expired; it has no confirmed recurring mandate to cancel.");
    const key = `admin-cancel:${id}`;
    if (complete()) return { confirmed: true, status: current.status, accessUntil: current.current_period_end, operationId: key };
    const reserved = await this.records.reserveCancellation(key, s.provider_subscription_ref, p.account.id, reason, now());
    const waiting = this.records.cancellationStatus(key);
    if (reserved || waiting === "reserved") {
      const claimed = await this.records.claimCancellation(key, now());
      if (claimed) {
        let dispatched = false;
        try {
          await provider.cancelSubscription(s.provider_subscription_ref, "administrator", async () => {
            const fresh = await currentFinancialPrincipal(this.ctx, this.auth, p);
            await this.record(fresh, "billing.subscription.cancel_requested", "billing_subscription", id, reason, meta, { operationId: key, provider: "paypal", mode: provider.mode, accountId: s.account_id, orgId: s.org_id });
            dispatched = true;
          });
        } catch (error) {
          if (!dispatched) { await this.records.failCancellationBeforeDispatch(key, now()); throw error; }
          // After dispatch, read the provider before claiming cancellation succeeded.
        }
      }
    }
    const verified = await this.ctx.billing.reconcileRefs([s.provider_subscription_ref]);
    const confirmed = verified.length > 0 && complete(), updated = this.ctx.billing.subscriptions.get(id)!;
    await this.records.finishCancellation(key, confirmed, s.provider_subscription_ref, now());
    await this.record(p, "billing.subscription.cancel_result", "billing_subscription", id, reason, meta, { operationId: key, confirmed, status: updated.status });
    return { confirmed, status: updated.status, accessUntil: updated.current_period_end, operationId: key };
  }

  /** The organization's subscription for its console page, if one isn't over. */
  orgSubscription(orgId: string) {
    const s = this.ctx.billing.subscriptions.liveFor(orgId);
    if (!s) return null;
    const v = this.ctx.billing.catalog.version(s.plan_version_id)!;
    return { id: s.id, plan: this.ctx.billing.catalog.plan(v.plan_id)!.name, status: s.status, standing: this.ctx.billing.subscriptions.standingOf(s, now()), currentPeriodEnd: s.current_period_end };
  }

  // ───────────── Provider events and figures ─────────────

  events(q: { status?: string; provider?: string; mode?: "test" | "live" | "unclassified"; from?: number; to?: number; cursor?: string; limit: number }) {
    const rows = eventRows(this.ctx.billing.rows, { ...q, after: decodeCursor(q.cursor) });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    return {
      events: shown.map((e) => ({
        id: e.id,
        provider: e.provider,
        eventRef: e.event_ref,
        environment: e.provider_mode === "test" || e.provider_mode === "live" ? e.provider_mode : "unclassified",
        type: e.type,
        status: e.status,
        attempts: e.attempts,
        providerCreatedAt: e.provider_created_at,
        receivedAt: e.created_at,
        processedAt: e.processed_at,
        nextAttemptAt: e.next_attempt_at,
        lastError: e.last_error,
        subscriptionId: e.subscription_id,
      })),
      nextCursor,
    };
  }

  async replay(p: AdminPrincipal, eventId: string, reason: string, meta: RequestMeta) {
    const status = await this.ctx.billing.webhooks.replay(eventId);
    await this.record(p, "billing.event_replay", "billing_event", eventId, reason, meta, { status });
    return { status };
  }

  metrics(days: number, filter: { provider?: string; currency?: string; mode?: "test" | "live" | "unclassified" } = {}) {
    return { setup: this.setup(), ...billingMetrics(this.ctx.billing.rows, days, now(), filter), definitions: BILLING_DEFINITIONS };
  }
}

const conflictForProvider = () => new ApiError(409, "billing_unavailable", "This purchase channel owns cancellation. Use its provider console; a local status edit cannot cancel future charges.");
