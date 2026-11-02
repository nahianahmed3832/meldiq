import { PLUS_TERMS, type PlusTerm } from "./pricing.js";
import { z } from "zod/v4";
import type { RowWriter } from "../../infrastructure/database/rows/index.js";
import { conflict, notFound, ApiError } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { addMonths } from "./gifts.js";
import type { Billing } from "./service.js";
import type { CardVault } from "./cardVault.js";
import type { BillingOwner } from "./owners.js";
import type { CheckoutSnapshot, PaymentSnapshot } from "./providers/types.js";
import type { SubscriptionStatus } from "./lifecycle.js";
import type { ApplyOutcome } from "./subscriptions.js";

export const CARD_CONSENT_VERSION = "meldiq-card-recurring-2026-11-02";
export interface CardMandate { id: string; account_id: string; org_id: string | null; user_id: string | null; payment_method_id: string; plan_version_id: string; status: string; currency: string; amount_minor: number; interval_months: number; consent_version: string; consent_at: number; consent_request_id: string; billing_anchor_at: number; cycle_index: number; next_billing_at: number; paid_through: number | null; cancel_at: number | null; retry_count: number; created_at: number; updated_at: number }
interface Charge { generation: number; request_started_at: number | null; id: string; mandate_id: string; period_start: number; period_end: number; status: string; provider_order_ref: string | null; provider_capture_ref: string | null; amount_minor: number; currency: string; lease_until: number | null; attempts: number; next_attempt_at: number; created_at: number; updated_at: number }
const RETRY_WINDOW = 4 * 3600000; // Shorter than PayPal's documented default idempotency retention. Never recreate an unknown older order.
const provider = "paypal_card";
const owner = (m: CardMandate): BillingOwner => m.org_id ? { kind: "org", orgId: m.org_id } : { kind: "account", accountId: m.account_id };

/** Application-managed billing using owner-bound vaulted cards. Entitlements still use the existing subscription core. */
export class CardSubscriptions {
  constructor(private readonly billing: Billing, readonly vault: CardVault, private readonly clock: () => number = Date.now) {}
  private enabled() { if (!this.vault.provider.options.cardCapabilities?.recurring) throw new ApiError(409, "billing_unavailable", "Recurring card payments are not enabled for this merchant."); }
  private get(id: string, accountId?: string) { const m = this.billing.rows.get<CardMandate>("billing_card_mandates", { id, ...(accountId ? { account_id: accountId } : {}) }); if (!m) throw notFound("Card subscription not found"); return m; }
  private view(m: CardMandate) { return { id: m.id, orgId: m.org_id, product: m.org_id ? "bots_plus" : "plus", paymentMethodId: m.payment_method_id, status: m.status, currency: m.currency, amountMinor: m.amount_minor, nextBillingAt: m.cancel_at ? null : m.next_billing_at, paidThrough: m.paid_through, cancelAt: m.cancel_at, processing: !!this.billing.rows.get("billing_card_charges", { mandate_id: m.id, status: "processing", lease_until: { gt: this.clock() } }) }; }
  list(accountId: string) { return this.billing.rows.all<CardMandate>("billing_card_mandates", { where: { account_id: accountId }, orderBy: [["created_at", "desc"]], limit: 100 }).map(m => this.view(m)); }
  quote(product: "plus" | "bots_plus", accountId: string, term: PlusTerm = "monthly") {
    this.enabled();
    const plan = this.billing.catalog.byKey(product); const v = plan && this.billing.catalog.current(plan.id, product === "plus" ? term : undefined);
    if (!plan || plan.status !== "active" || !plan.public || !v || v.provider !== "paypal" || (product === "bots_plus" && v.interval !== "month") || v.currency !== "USD" || v.amount_minor !== (product === "plus" ? PLUS_TERMS[term].amountMinor : 399)) throw conflict("This product is not available for card subscription.");
    return { version: v, intervalMonths: (v.interval === "year" ? 12 : 1) * (v.billing_frequency ?? 1), consentVersion: CARD_CONSENT_VERSION, amountMinor: v.amount_minor, currency: v.currency, firstBillingAt: product === "plus" ? Math.max(this.clock(), this.billing.freePeriodEnd({ kind: "account", accountId }) ?? 0) : this.clock() };
  }
  async start(input: { accountId: string; userId: string | null; orgId?: string; product: "plus" | "bots_plus"; term?: PlusTerm; paymentMethodId: string; requestKey: string; consentVersion: string }) {
    this.enabled();
    if (input.consentVersion !== CARD_CONSENT_VERSION) throw conflict("Review the current recurring-payment terms before subscribing.");
    if ((input.product === "bots_plus") !== !!input.orgId) throw conflict("Choose a community for Bots+.");
    const quote = this.quote(input.product, input.accountId, input.term); const t = this.clock();
    const id = await this.billing.rows.write(w => {
      const prior = w.get<CardMandate>("billing_card_mandates", { account_id: input.accountId, consent_request_id: input.requestKey });
      if (prior) { if (prior.payment_method_id !== input.paymentMethodId || prior.org_id !== (input.orgId ?? null) || prior.consent_version !== input.consentVersion || prior.plan_version_id !== quote.version.id) throw conflict("This request was used for a different subscription."); return prior.id; }
      // The removal claim and attachment are serialized in the same billing transaction.
      if (!w.get("billing_payment_methods", { id: input.paymentMethodId, account_id: input.accountId, status: "active" })) throw notFound("Payment method not found");
      const scope: BillingOwner = input.orgId ? { kind: "org", orgId: input.orgId } : { kind: "account", accountId: input.accountId };
      if (input.orgId ? this.billing.subscriptions.liveAddonForOwner(scope, w) : this.billing.subscriptions.liveForOwner(scope, w)) throw conflict("Manage the existing subscription before starting another renewal.");
      const id = newId("cm");
      const m: CardMandate = { id, account_id: input.accountId, org_id: input.orgId ?? null, user_id: input.userId, payment_method_id: input.paymentMethodId, plan_version_id: quote.version.id, status: "pending", currency: quote.currency, amount_minor: quote.amountMinor, interval_months: quote.intervalMonths, consent_version: input.consentVersion, consent_at: t, consent_request_id: input.requestKey, billing_anchor_at: quote.firstBillingAt, cycle_index: 0, next_billing_at: quote.firstBillingAt, paid_through: null, cancel_at: null, retry_count: 0, created_at: t, updated_at: t };
      w.insert("billing_card_mandates", { ...m });
      w.insert("billing_checkouts", { id, owner_kind: scope.kind === "org" ? "org" : "account", org_id: m.org_id, account_id: scope.kind === "account" ? input.accountId : null, user_id: input.userId, started_by_account_id: input.accountId, plan_version_id: quote.version.id, provider, provider_session_ref: id, provider_subscription_ref: id, status: "open", created_at: t, expires_at: quote.firstBillingAt + 86400000, completed_at: null });
      this.snapshot(w, m, "incomplete", null, null, t);
      return id;
    });
    await this.process(id);
    return this.view(this.get(id, input.accountId));
  }
  private snapshot(w: RowWriter, m: CardMandate, status: SubscriptionStatus, start: number | null, end: number | null, t: number) {
    return this.billing.subscriptions.applySnapshot(w, provider, { ref: m.id, checkoutRef: m.id, priceRef: m.plan_version_id, customerRef: null, status, currentPeriodStart: start, currentPeriodEnd: end, trialEnd: null, cancelAtPeriodEnd: m.cancel_at !== null, canceledAt: m.cancel_at, quantity: 1 }, t, "card-billing:verified", t);
  }
  async cancel(accountId: string, id: string) {
    await this.billing.rows.write(w => {
      const m = w.get<CardMandate>("billing_card_mandates", { id, account_id: accountId }); if (!m) throw notFound("Card subscription not found");
      if (m.cancel_at) return;
      const t = this.clock(); const unresolved = !!w.get("billing_card_charges", { mandate_id: id, status: { in: ["pending", "processing", "attention"] } });
      const next = { ...m, cancel_at: t, status: m.paid_through && m.paid_through > t ? "active" : "canceled", updated_at: t };
      w.update("billing_card_mandates", { id }, { cancel_at: t, status: next.status, updated_at: t });
      const sub = w.get<{ current_period_start: number | null }>("billing_subscriptions", { provider, provider_subscription_ref: id });
      this.snapshot(w, next, next.status === "active" ? "active" : unresolved ? "incomplete" : "canceled", sub?.current_period_start ?? null, m.paid_through, t);
    });
    const m = this.get(id, accountId); this.billing.changed(owner(m)); return this.view(m);
  }
  async updateMethod(accountId: string, id: string, methodId: string) {
    this.enabled();
    await this.billing.rows.write(w => {
      const m = w.get<CardMandate>("billing_card_mandates", { id, account_id: accountId }); if (!m) throw notFound("Card subscription not found");
      if (m.cancel_at || ["canceled", "paused"].includes(m.status)) throw conflict("This renewal is not active.");
      if (!w.get("billing_payment_methods", { id: methodId, account_id: accountId, status: "active" })) throw notFound("Payment method not found");
      if (w.get("billing_card_charges", { mandate_id: id, status: { in: ["pending", "processing", "attention"] } })) throw conflict("A payment is being processed. Check its status before changing cards.");
      const declined = w.get<Charge>("billing_card_charges", { mandate_id: id, period_start: m.next_billing_at, status: "declined" });
      if (declined) {
        if (methodId === m.payment_method_id) throw conflict("Choose a different verified card before retrying this declined payment.");
        w.insert("billing_card_charge_attempts", { id: newId("cca"), charge_id: declined.id, generation: declined.generation, provider_order_ref: declined.provider_order_ref, provider_capture_ref: declined.provider_capture_ref, status: "declined", created_at: declined.request_started_at ?? declined.created_at });
        w.update("billing_card_charges", { id: declined.id, status: "declined" }, { generation: declined.generation + 1, request_started_at: this.clock(), status: "pending", provider_order_ref: null, provider_capture_ref: null, attempts: 0, lease_until: null, next_attempt_at: this.clock() });
      }
      w.update("billing_card_mandates", { id }, { payment_method_id: methodId, ...(declined ? { status: "attention" } : {}), updated_at: this.clock() });
    });
    await this.process(id);
    return this.view(this.get(id, accountId));
  }
  async process(id: string) {
    this.enabled(); const t = this.clock();
    const claimed = await this.billing.rows.write(w => {
      const m = w.get<CardMandate>("billing_card_mandates", { id });
      if (!m || m.cancel_at || !["pending", "active", "attention"].includes(m.status) || m.next_billing_at > t) return null;
      let charge = w.get<Charge>("billing_card_charges", { mandate_id: id, period_start: m.next_billing_at });
      if (!charge) { const c = { id: newId("cc"), mandate_id: id, period_start: m.next_billing_at, period_end: addMonths(m.billing_anchor_at, (m.cycle_index + 1) * m.interval_months), status: "pending", generation: 0, request_started_at: t, provider_order_ref: null, provider_capture_ref: null, amount_minor: m.amount_minor, currency: m.currency, lease_until: null, attempts: 0, next_attempt_at: t, created_at: t, updated_at: t, grant_id: null }; w.insert("billing_card_charges", c); charge = c; }
      if (["paid", "refunded", "reversed", "declined"].includes(charge.status) || charge.next_attempt_at > t || charge.lease_until && charge.lease_until > t) return null;
      if (t - (charge.request_started_at ?? charge.created_at) > RETRY_WINDOW && !charge.provider_order_ref) { w.update("billing_card_charges", { id: charge.id }, { status: "attention" }); w.update("billing_card_mandates", { id }, { status: "attention" }); return null; }
      w.update("billing_card_charges", { id: charge.id }, { status: "processing", lease_until: t + 120000, attempts: charge.attempts + 1, updated_at: t });
      return { m, charge };
    });
    if (!claimed) return;
    const { m, charge } = claimed;
    try {
      let orderId = charge.provider_order_ref;
      if (!orderId) {
        const ref = this.vault.reference(m.account_id, m.payment_method_id);
        const created = z.object({ id: z.string().regex(/^[A-Za-z0-9]+$/) }).parse(await this.vault.provider.api.request("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ custom_id: charge.id, invoice_id: `${charge.id}-${charge.generation}`, description: m.org_id ? "Meldiq Bots+ monthly renewal" : "Meldiq Plus renewal", amount: { currency_code: charge.currency, value: (charge.amount_minor / 100).toFixed(2) } }], payment_source: { card: { vault_id: ref.token, stored_credential: { payment_initiator: "MERCHANT", payment_type: "RECURRING", usage: "SUBSEQUENT" } } } }, `card-order-${charge.id}-${charge.generation}`));
        orderId = created.id;
        await this.billing.rows.write(w => w.update("billing_card_charges", { id: charge.id }, { provider_order_ref: orderId }));
      }
      const expected = { reference: charge.id, amountMinor: charge.amount_minor, requestKey: `card-capture-${charge.id}-${charge.generation}` };
      const canceled = this.get(m.id).cancel_at !== null;
      const snap = !canceled && t - (charge.request_started_at ?? charge.created_at) <= RETRY_WINDOW ? await this.vault.provider.captureOrder(orderId, expected) : await this.vault.provider.readOrder(orderId, expected);
      await this.billing.rows.write(w => {
        const latest = w.get<Charge>("billing_card_charges", { id: charge.id });
        if (!latest || ["paid", "refunded", "reversed"].includes(latest.status)) return;
        if (!snap.paid) {
          const declined = snap.captureStatus === "DECLINED";
          w.update("billing_card_charges", { id: charge.id }, { status: declined ? "declined" : "attention", provider_capture_ref: declined ? snap.paymentRef ?? null : null, lease_until: null, next_attempt_at: t + 300000 });
          const current = w.get<CardMandate>("billing_card_mandates", { id })!;
          if (!current.cancel_at) w.update("billing_card_mandates", { id }, { status: declined ? "past_due" : "attention" });
          if (declined && !current.cancel_at) {
            const sub = w.get<{ current_period_start: number | null }>("billing_subscriptions", { provider, provider_subscription_ref: id });
            this.snapshot(w, current, m.paid_through ? "past_due" : "incomplete", sub?.current_period_start ?? null, m.paid_through, t);
            this.billing.subscriptions.applyInvoice(w, provider, { ref: `declined-${charge.id}-${charge.generation}`, subscriptionRef: id, status: "payment_failed", currency: charge.currency, amountDueMinor: charge.amount_minor, amountPaidMinor: 0, amountRefundedMinor: 0, taxMinor: null, periodStart: charge.period_start, periodEnd: charge.period_end, issuedAt: t, paidAt: null }, t, t);
          }
          this.billing.notifications?.queue(w, m.account_id, "payment_failed", charge.id, t); return;
        }
        this.applyCheckout(w, "paypal", snap, this.clock());
      });
      this.billing.changed(owner(m));
    } catch {
      await this.billing.rows.write(w => { if (!w.update("billing_card_charges", { id: charge.id, status: "processing" }, { status: "attention", lease_until: null, next_attempt_at: this.clock() + 300000 })) return; w.update("billing_card_mandates", { id, cancel_at: null }, { status: "attention" }); this.billing.notifications?.queue(w, m.account_id, "payment_failed", charge.id, this.clock()); });
    }
  }
  applyCheckout(w: RowWriter, source: string, snap: CheckoutSnapshot, t: number): ApplyOutcome | null {
    if (source !== "paypal" || !snap.reference) return null;
    const charge = w.get<Charge>("billing_card_charges", { id: snap.reference }); if (!charge) return null;
    const m = w.get<CardMandate>("billing_card_mandates", { id: charge.mandate_id })!;
    if (charge.status === "paid" || charge.status === "refunded" || charge.status === "reversed") return { result: "stale", subscriptionId: null, owner: owner(m) };
    if (!snap.paid) return { result: "stale", subscriptionId: null, owner: owner(m) };
    if (charge.provider_order_ref && charge.provider_order_ref !== snap.sessionRef || snap.amountMinor !== charge.amount_minor || snap.currency !== charge.currency || !snap.paymentRef) throw conflict("Card payment did not match its stored charge.");
    w.update("billing_card_charges", { id: charge.id }, { status: "paid", provider_order_ref: snap.sessionRef, provider_capture_ref: snap.paymentRef, lease_until: null, updated_at: t });
    const updated = { ...m, paid_through: charge.period_end, cycle_index: m.cycle_index + 1, next_billing_at: charge.period_end, status: "active" };
    w.update("billing_card_mandates", { id: m.id }, { paid_through: updated.paid_through, cycle_index: updated.cycle_index, next_billing_at: updated.next_billing_at, status: updated.status, retry_count: 0, updated_at: t });
    // A capture begun before cancellation may finish after it. Record the paid time while keeping cancellation intact.
    const outcome = this.snapshot(w, updated, "active", charge.period_start, charge.period_end, t);
    this.billing.subscriptions.applyInvoice(w, provider, { ref: snap.paymentRef, subscriptionRef: m.id, status: "paid", currency: charge.currency, amountDueMinor: charge.amount_minor, amountPaidMinor: charge.amount_minor, amountRefundedMinor: 0, taxMinor: null, periodStart: charge.period_start, periodEnd: charge.period_end, issuedAt: charge.created_at, paidAt: t }, t, t);
    return outcome;
  }
  applyPayment(w: RowWriter, source: string, payment: PaymentSnapshot, t: number): ApplyOutcome | null {
    if (source !== "paypal" || !payment.paymentRef) return null;
    const charge = w.get<Charge>("billing_card_charges", { provider_capture_ref: payment.paymentRef }); if (!charge) return null;
    const m = w.get<CardMandate>("billing_card_mandates", { id: charge.mandate_id })!;
    if (payment.currency !== charge.currency || payment.amountMinor !== charge.amount_minor) throw conflict("Card payment adjustment amount mismatch.");
    if (["refunded", "reversed"].includes(payment.state)) {
      w.update("billing_card_charges", { id: charge.id }, { status: payment.state, updated_at: t });
      w.update("billing_invoices", { provider, provider_invoice_ref: payment.paymentRef }, { amount_refunded_minor: charge.amount_minor, updated_at: t });
      if (m.paid_through === charge.period_end) { const updated = { ...m, cancel_at: m.cancel_at ?? t, status: "paused" }; w.update("billing_card_mandates", { id: m.id }, { cancel_at: updated.cancel_at, status: updated.status, updated_at: t }); return this.snapshot(w, updated, "paused", charge.period_start, charge.period_end, t); }
    }
    return { result: "applied", subscriptionId: null, owner: owner(m) };
  }
  async sweep() {
    if (!this.vault.provider.options.cardCapabilities?.recurring) return 0;
    const rows = this.billing.rows; const t = this.clock();
    for (const m of rows.all<CardMandate>("billing_card_mandates", { where: { cancel_at: { ne: null }, status: "active", paid_through: { lte: t } }, limit: 100 })) await rows.write(w => { w.update("billing_card_mandates", { id: m.id }, { status: "canceled", updated_at: t }); this.snapshot(w, m, "canceled", null, m.paid_through, t); });
    // Read-only reconciliation remains possible after cancellation. No new orders or captures are made here.
    for (const charge of rows.all<Charge>("billing_card_charges", { where: { status: { in: ["processing", "attention"] }, provider_order_ref: { ne: null }, next_attempt_at: { lte: t } }, limit: 20 })) {
      const m = this.get(charge.mandate_id);
      if (!m.cancel_at) continue;
      try { const snap = await this.vault.provider.readOrder(charge.provider_order_ref!, { reference: charge.id, amountMinor: charge.amount_minor }); await rows.write(w => this.applyCheckout(w, "paypal", snap, t)); this.billing.changed(owner(m)); } catch { /* Verified webhooks and the next sweep can reconcile; never recreate a charge. */ }
    }
    const due = rows.all<CardMandate>("billing_card_mandates", { where: { status: { in: ["pending", "active", "attention"] }, cancel_at: null, next_billing_at: { lte: t } }, orderBy: [["next_billing_at", "asc"]], limit: 20 });
    for (const m of due) await this.process(m.id);
    return due.length;
  }
}
