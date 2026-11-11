import { PLUS_TERMS, type PlusTerm } from "../pricing.js";
import { decimalMinor, parseMinor } from "../money.js";
import type { PayPalCardCapabilities } from "./paypalCapabilities.js";
import { z } from "zod/v4";
import { ApiError } from "../../../shared/errors.js";
import { addMonths } from "../gifts.js";
import type { SubscriptionStatus } from "../lifecycle.js";
import { HttpPayPalApi, type PayPalApi, type PayPalEnvironment } from "./paypalApi.js";
import {
  type BillingProvider,
  type CheckoutInput,
  type CheckoutSnapshot,
  type NormalizedEvent,
  type PaymentCheckoutInput,
  type SubscriptionSnapshot,
  WebhookRejected,
} from "./types.js";

const ref = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+$/);
const money = z.object({
  currency_code: z.literal("USD"),
  value: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
});
const links = z
  .array(z.object({ rel: z.string(), href: z.string() }))
  .default([]);
const capture = z.object({
  id: ref,
  status: z.string(),
  amount: money,
  create_time: z.string().optional(),
});
/** A client success callback cannot override an explicit issuer authentication failure. */
export function assertCardAuthentication(card: unknown): void {
  const auth = z.object({ authentication_result: z.object({ authentication_status: z.string().optional(), three_d_secure: z.object({ authentication_status: z.string().optional() }).optional() }).optional() }).safeParse(card);
  if (!auth.success) return;
  const status = auth.data.authentication_result?.three_d_secure?.authentication_status ?? auth.data.authentication_result?.authentication_status;
  if (status === "N" || status === "R") throw new ApiError(409, "billing_unavailable", "The bank did not authenticate this card payment. Choose another card or complete bank verification.");
}
const order = z.object({
  payment_source: z.object({ card: z.unknown().optional() }).optional(),
  id: ref,
  status: z.string(),
  links,
  purchase_units: z
    .array(
      z.object({
        custom_id: ref,
        amount: money,
        payee: z.object({ merchant_id: ref }),
        payments: z
          .object({ captures: z.array(capture).optional() })
          .optional(),
      }),
    )
    .length(1),
});
const subscription = z.object({
  id: ref,
  plan_id: ref,
  custom_id: ref,
  status: z.enum([
    "APPROVAL_PENDING",
    "APPROVED",
    "ACTIVE",
    "SUSPENDED",
    "CANCELLED",
    "EXPIRED",
  ]),
  plan_overridden: z.boolean().optional(),
  quantity: z.string().optional(),
  status_update_time: z.string().optional(),
  start_time: z.string().optional(),
  billing_info: z
    .object({
      next_billing_time: z.string().optional(),
      cycle_executions: z
        .array(
          z.object({
            tenure_type: z.string(),
            cycles_completed: z.number().int().nonnegative(),
          }),
        )
        .optional(),
      failed_payments_count: z.number().optional(),
      outstanding_balance: money.optional(),
      last_payment: z.object({ amount: money, time: z.string() }).optional(),
    })
    .optional(),
  links,
});

export interface PayPalOptions {
  cardCapabilities?: PayPalCardCapabilities;
  environment?: PayPalEnvironment;
  giftsEnabled?: boolean;
  sparksEnabled?: boolean;
  botsPlanId?: string | null;
  plusProductId?: string | null;
  quarterlyPlanId?: string | null;
  yearlyPlanId?: string | null;
  clientId: string;
  clientSecret: string;
  webhookId: string;
  merchantId: string;
  plusPlanId: string | null;
  subscriptionsApproved: boolean;
  api?: PayPalApi;
  clock?: () => number;
}

export const cents = (value: string): number => {
  return parseMinor(value, 2);
};
const at = (value: string | undefined): number | null => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Existing billing adapter with strictly separated Sandbox and live hosts. All financial values come from REST reads or server-owned inputs. */
export class PayPalProvider implements BillingProvider {
  readonly id = "paypal";
  readonly mode: "test" | "live";
  readonly environment: PayPalEnvironment;
  readonly supportsOneTimePurchases: boolean;
  readonly supportsSparkPurchases: boolean;
  readonly api: PayPalApi;
  private readonly clock: () => number;
  /** Bound to immutable published catalog versions; never infer legacy amounts from the new price. */
  agreementTerms: (priceRef: string) => number | null = () => null;
  agreementMonths: (priceRef: string) => number | null = () => null;
  plusPlanId(term: PlusTerm = "monthly"): string | null { return term === "quarterly" ? this.options.quarterlyPlanId ?? null : term === "yearly" ? this.options.yearlyPlanId ?? null : this.options.plusPlanId; }
  private plusTerm(priceRef: string): PlusTerm | null { return (["monthly", "quarterly", "yearly"] as const).find(k => this.plusPlanId(k) === priceRef) ?? null; }
  private periodMonths(ref: string) { const key = this.plusTerm(ref); return this.agreementMonths(ref) ?? (key ? PLUS_TERMS[key].months : 1); }
  private agreementAmount(priceRef: string): number {
    const amount = this.agreementTerms(priceRef);
    if (amount !== null) return amount;
    const term = this.plusTerm(priceRef); if (term) return PLUS_TERMS[term].amountMinor;
    if (priceRef === this.options.botsPlanId) return 399; // historical agreements only
    throw new Error("Unknown PayPal agreement plan");
  }
  constructor(readonly options: PayPalOptions) {
    this.environment = options.environment ?? "sandbox";
    this.mode = this.environment === "live" ? "live" : "test";
    this.supportsOneTimePurchases = options.giftsEnabled ?? this.environment === "sandbox";
    this.supportsSparkPurchases = options.sparksEnabled ?? this.environment === "sandbox";
    this.api =
      options.api ?? new HttpPayPalApi(options.clientId, options.clientSecret, this.environment);
    this.clock = options.clock ?? Date.now;
  }

  private apiHosts(): string[] { return this.environment === "live" ? ["api.paypal.com", "api-m.paypal.com"] : ["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"]; }

  publicConfig() {
    return {
      provider: "paypal" as const,
      environment: this.environment,
      clientId: this.options.clientId,
      subscriptions:
        this.options.subscriptionsApproved && (!!this.options.plusPlanId || !!this.options.quarterlyPlanId || !!this.options.yearlyPlanId || !!this.options.botsPlanId),
      sparks: this.supportsSparkPurchases,
      botsPlus: this.options.subscriptionsApproved && !!this.options.botsPlanId,
      cards: false as const,
      advancedCards: this.options.cardCapabilities ?? { oneTime: false, vault: false, recurring: false, merchantCountry: null, productionApproved: false, reason: "Embedded card checkout is not enabled." },
    };
  }

  /** Reject a misconfigured remote plan before asking any buyer to approve it. No price overrides or trials. */
  private async verifyRecurringPlan(planId: string | null): Promise<void> {
    const key = planId ? this.plusTerm(planId) : null;
    const expected = key ? PLUS_TERMS[key] : { amountMinor: 399, interval: "month", billingFrequency: 1 };
    if (!this.options.subscriptionsApproved || !planId)
      throw new ApiError(
        409,
        "billing_unavailable",
        "PayPal recurring payments have not been approved for this app.",
      );
    const plan = z
      .object({
        id: ref,
        product_id: ref.optional(),
        status: z.literal("ACTIVE"),
        quantity_supported: z.boolean().optional(),
        billing_cycles: z
          .array(
            z.object({
              tenure_type: z.literal("REGULAR"),
              total_cycles: z.literal(0),
              frequency: z.object({
                interval_unit: z.enum(["MONTH", "YEAR"]),
                interval_count: z.number().int().positive(),
              }),
              pricing_scheme: z.object({
                fixed_price: z.object({
                  currency_code: z.literal("USD"),
                  value: z.string(),
                }),
              }),
            }),
          )
          .length(1),
        payment_preferences: z
          .object({ setup_fee: money.optional() })
          .optional(),
        taxes: z.object({ percentage: z.string() }).optional(),
      })
      .parse(
        await this.api.request(
          "GET",
          `/v1/billing/plans/${planId}`,
        ),
      );
    if (
      plan.id !== planId ||
      cents(plan.billing_cycles[0]!.pricing_scheme.fixed_price.value) !== expected.amountMinor ||
      plan.billing_cycles[0]!.frequency.interval_unit !== expected.interval.toUpperCase() ||
      plan.billing_cycles[0]!.frequency.interval_count !== expected.billingFrequency ||
      (key !== null && this.options.plusProductId != null && plan.product_id !== this.options.plusProductId) ||
      plan.quantity_supported ||
      (plan.payment_preferences?.setup_fee &&
        cents(plan.payment_preferences.setup_fee.value) !== 0) ||
      Number(plan.taxes?.percentage ?? 0) !== 0
    )
      throw new ApiError(
        409,
        "billing_unavailable",
        "The PayPal plan does not match Meldiq Plus USD 4.99/month pricing.",
      );
  }

  verifyPlusPlan(term: PlusTerm = "monthly"): Promise<void> { return this.verifyRecurringPlan(this.plusPlanId(term)); }
  verifyBotsPlan(): Promise<void> { return this.verifyRecurringPlan(this.options.botsPlanId ?? null); }

  async createCheckout(input: CheckoutInput) {
    if (
      ![this.options.plusPlanId, this.options.quarterlyPlanId, this.options.yearlyPlanId, this.options.botsPlanId].includes(input.priceRef) ||
      (input.priceRef === this.options.botsPlanId ? input.owner.kind !== "org" : input.owner.kind !== "account") ||
      (input.quantity && input.quantity !== 1) ||
      input.trialDays
    )
      throw new ApiError(
        409,
        "billing_unavailable",
        "This PayPal checkout supports the selected monthly product without price or trial-cycle overrides only.",
      );
    await this.verifyRecurringPlan(input.priceRef);
    const result = subscription.parse(
      await this.api.request(
        "POST",
        "/v1/billing/subscriptions",
        {
          plan_id: input.priceRef,
          custom_id: input.reference,
          ...(input.trialEndsAt && input.trialEndsAt > this.clock()
            ? { start_time: new Date(input.trialEndsAt).toISOString() }
            : {}),
          application_context: {
            brand_name: "Meldiq",
            shipping_preference: "NO_SHIPPING",
            user_action: "SUBSCRIBE_NOW",
            return_url: input.successUrl,
            cancel_url: input.cancelUrl,
          },
        },
        `create-${input.reference}`,
      ),
    );
    return { sessionRef: result.id, url: this.approvalLink(result.links) };
  }

  async createPaymentCheckout(input: PaymentCheckoutInput) {
    if (!(input.kind === "spark" ? this.supportsSparkPurchases : this.supportsOneTimePurchases)) throw new ApiError(409, "billing_unavailable", "One-time purchases are not enabled for this PayPal app");
    if (
      input.currency !== "USD" ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0
    )
      throw new ApiError(
        409,
        "billing_unavailable",
        "This checkout supports existing USD products only.",
      );
    const result = order.parse(
      await this.api.request(
        "POST",
        "/v2/checkout/orders",
        {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: input.reference,
              custom_id: input.reference,
              invoice_id: input.reference,
              description: input.productName,
              amount: {
                currency_code: input.currency,
                value: (input.amountMinor / 100).toFixed(2),
              },
            },
          ],
          ...(this.options.cardCapabilities?.oneTime ? {} : {
            payment_source: { paypal: { experience_context: {
              brand_name: "Meldiq", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: input.successUrl, cancel_url: input.cancelUrl,
            } } },
          }),
        },
        `create-${input.reference}`,
      ),
    );
    this.checkOrder(result, input.reference, input.amountMinor);
    return { sessionRef: result.id, url: this.approvalLink(result.links) };
  }

  private approvalLink(list: { rel: string; href: string }[]): string | null {
    const link = list.find(
      (l) => l.rel === "approve" || l.rel === "payer-action",
    );
    if (!link) return null;
    const u = new URL(link.href);
    if (
      u.protocol !== "https:" ||
      u.hostname !== (this.environment === "live" ? "www.paypal.com" : "www.sandbox.paypal.com") ||
      u.username ||
      u.password
    )
      throw new Error("Unexpected PayPal approval host");
    return u.href;
  }

  private checkOrder(
    o: z.infer<typeof order>,
    reference?: string,
    amountMinor?: number,
  ) {
    const unit = o.purchase_units[0];
    if (
      unit.payee.merchant_id !== this.options.merchantId ||
      (reference && unit.custom_id !== reference) ||
      (amountMinor !== undefined && cents(unit.amount.value) !== amountMinor)
    )
      throw new ApiError(
        409,
        "conflict",
        "PayPal order details do not match this purchase.",
      );
    return unit;
  }

  async readOrder(
    id: string,
    expected?: { reference: string; amountMinor: number },
  ): Promise<CheckoutSnapshot> {
    ref.parse(id);
    const o = order.parse(
      await this.api.request("GET", `/v2/checkout/orders/${id}`),
    );
    if (o.id !== id) throw new Error("Unexpected PayPal order");
    if (o.payment_source?.card) assertCardAuthentication(o.payment_source.card);
    const unit = this.checkOrder(o, expected?.reference, expected?.amountMinor);
    const captures = unit.payments?.captures ?? [];
    const paid =
      o.status === "COMPLETED" &&
      captures.length === 1 &&
      ["COMPLETED", "PARTIALLY_REFUNDED"].includes(captures[0].status);
    if (
      captures.some(
        (c) =>
          c.amount.currency_code !== unit.amount.currency_code ||
          c.amount.value !== unit.amount.value,
      )
    )
      throw new Error("Unexpected PayPal capture amount");
    return {
      sessionRef: id,
      reference: unit.custom_id,
      outcome: paid ? "completed" : "payment_failed",
      subscriptionRef: null,
      customerRef: null,
      mode: "payment",
      paid,
      paymentRef: captures[0]?.id ?? null,
      captureStatus: captures[0]?.status ?? null,
      currency: "USD",
      amountMinor: cents(unit.amount.value),
    };
  }

  async captureOrder(
    id: string,
    expected: { reference: string; amountMinor: number; requestKey?: string },
  ): Promise<CheckoutSnapshot> {
    const before = await this.readOrder(id, expected);
    if (before.paid) return before;
    // PayPal-Request-Id makes retries and concurrent captures refer to the same operation.
    try {
      await this.api.request(
        "POST",
        `/v2/checkout/orders/${id}/capture`,
        {},
        expected.requestKey ?? `capture-${expected.reference}`,
      );
    } catch {
      /* An ambiguous network result is resolved by the authoritative read below. */
    }
    return this.readOrder(id, expected);
  }

  async fetchSubscription(id: string): Promise<SubscriptionSnapshot> {
    ref.parse(id);
    const s = subscription.parse(
      await this.api.request("GET", `/v1/billing/subscriptions/${id}`),
    );
    if (
      s.id !== id ||
      this.agreementAmount(s.plan_id) <= 0 ||
      s.plan_overridden ||
      (s.quantity && s.quantity !== "1")
    )
      throw new Error("Unexpected PayPal subscription terms");
    const info = s.billing_info;
    const paidAt = at(info?.last_payment?.time);
    if (info?.last_payment && cents(info.last_payment.amount.value) !== this.agreementAmount(s.plan_id))
      throw new Error("Unexpected PayPal subscription payment");
    const anchor = at(s.start_time);
    const completedCycles = info?.cycle_executions?.find(
      (cycle) => cycle.tenure_type === "REGULAR",
    )?.cycles_completed;
    const cycleEnd =
      anchor !== null && completedCycles
        ? addMonths(anchor, completedCycles * this.periodMonths(s.plan_id))
        : null;
    const nextBilling = at(info?.next_billing_time);
    const paidUntil =
      paidAt === null
        ? null
        : nextBilling !== null && nextBilling > paidAt
          ? nextBilling
          : cycleEnd !== null && Number.isFinite(cycleEnd)
            ? cycleEnd
            : addMonths(paidAt, this.periodMonths(s.plan_id));
    const now = this.clock();
    const canceled = s.status === "CANCELLED";
    let status: SubscriptionStatus = "incomplete";
    if (s.status === "ACTIVE" && paidAt !== null)
      status =
        (info?.failed_payments_count ?? 0) > 0 ||
        cents(info?.outstanding_balance?.value ?? "0.00") > 0
          ? "past_due"
          : "active";
    if (canceled)
      status = paidUntil !== null && paidUntil > now ? "active" : "canceled";
    if (s.status === "SUSPENDED") status = "paused";
    if (s.status === "EXPIRED") status = "canceled";
    return {
      ref: id,
      approvalConfirmed: s.status === "APPROVED" || s.status === "ACTIVE",
      customerRef: null,
      status,
      priceRef: s.plan_id,
      checkoutRef: s.custom_id,
      currentPeriodStart: paidAt,
      currentPeriodEnd: paidUntil,
      // A future start date is not an approved trial or renewal until the buyer authorizes it.
      trialEnd: (s.status === "APPROVED" || s.status === "ACTIVE") && at(s.start_time) !== null && at(s.start_time)! > now ? at(s.start_time) : null,
      cancelAtPeriodEnd: canceled,
      canceledAt: canceled ? at(s.status_update_time) : null,
      quantity: 1,
    };
  }

  async cancelSubscription(id: string, initiatedBy: "customer" | "administrator" = "customer", beforeDispatch?: () => Promise<void>): Promise<void> {
    const current = await this.fetchSubscription(id);
    if (current.cancelAtPeriodEnd || current.status === "canceled") return;
    await beforeDispatch?.();
    await this.api.request(
      "POST",
      `/v1/billing/subscriptions/${id}/cancel`,
      { reason: initiatedBy === "administrator" ? "Cancelled by an authorized Meldiq administrator" : "Cancelled by the Meldiq customer" },
      `cancel-${id}`,
    );
  }

  async refundCapture(
    id: string,
    reference: string,
  ): Promise<{ id: string; status: string }> {
    ref.parse(id);
    return z
      .object({ id: ref, status: z.string() })
      .parse(
        await this.api.request(
          "POST",
          `/v2/payments/captures/${id}/refund`,
          {},
          `refund-${reference}`,
        ),
      );
  }

  get merchantId(): string { return this.options.merchantId; }
  get eventScope(): string { return `paypal:${this.mode}:${this.options.merchantId}`; }

  /** Bind a refund to the immutable purchase, authenticated merchant, order and capture before reserving money. */
  async inspectCapture(orderId: string, paymentRef: string, expected: { reference: string; amountMinor: number; currency: string }) {
    if (expected.currency !== "USD") throw new ApiError(409, "conflict", "This PayPal integration supports USD purchases only.");
    ref.parse(orderId); ref.parse(paymentRef);
    const raw = await this.api.request("GET", `/v2/checkout/orders/${orderId}`);
    const o = order.parse(raw);
    if (o.id !== orderId) throw new Error("Unexpected PayPal order");
    const unit = this.checkOrder(o, expected.reference, expected.amountMinor);
    if ((unit.payments?.captures?.length ?? 0) !== 1 || unit.payments?.captures?.[0]?.id !== paymentRef) throw new ApiError(409, "conflict", "PayPal capture does not match this purchase.");
    const c = capture.parse(await this.api.request("GET", `/v2/payments/captures/${paymentRef}`));
    if (c.id !== paymentRef || cents(c.amount.value) !== expected.amountMinor || !["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(c.status)) throw new ApiError(409, "conflict", "PayPal has not confirmed an eligible captured payment.");
    const refunds = z.object({ purchase_units: z.array(z.object({ payments: z.object({ refunds: z.array(z.object({ id: ref, status: z.enum(["CANCELLED", "FAILED", "PENDING", "COMPLETED"]), amount: money })).max(100).optional() }).optional() })) }).parse(raw).purchase_units[0]?.payments?.refunds ?? [];
    const completed = refunds.filter(r => r.status === "COMPLETED").reduce((n, r) => n + cents(r.amount.value), 0);
    if (c.status === "PARTIALLY_REFUNDED" && !completed) throw new ApiError(409, "conflict", "PayPal has not returned complete refund history. Review the provider before issuing another refund.");
    const refundedMinor = c.status === "REFUNDED" ? expected.amountMinor : completed;
    if (refundedMinor > expected.amountMinor) throw new Error("Invalid PayPal refund total");
    return { refundedMinor, pendingMinor: refunds.filter(r => r.status === "PENDING").reduce((n, r) => n + cents(r.amount.value), 0), refundRefs: refunds.map(r => r.id) };
  }

  /** Each operation uses an exact amount and an opaque UUID, never a private case reason in payer-facing fields. */
  async createAdminRefund(paymentRef: string, operationId: string, amountMinor: number) {
    ref.parse(paymentRef);
    const response = z.object({ id: ref, status: z.string() }).parse(await this.api.request("POST", `/v2/payments/captures/${paymentRef}/refund`, { amount: { currency_code: "USD", value: decimalMinor(amountMinor, 2) }, custom_id: operationId }, operationId));
    return response;
  }

  async readAdminRefund(refundId: string, expected: { operationId: string; paymentRef: string; amountMinor: number }) {
    ref.parse(refundId);
    const r = z.object({ id: ref, status: z.enum(["CANCELLED", "FAILED", "PENDING", "COMPLETED"]), custom_id: z.string(), amount: money, links }).parse(await this.api.request("GET", `/v2/payments/refunds/${refundId}`));
    const capturePath = `/v2/payments/captures/${expected.paymentRef}`;
    const bound = r.links.some(link => {
      try { const u = new URL(link.href); return link.rel === "up" && (this.mode === "live" ? ["api-m.paypal.com", "api.paypal.com"] : ["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]).includes(u.hostname) && u.pathname === capturePath; } catch { return false; }
    });
    if (r.id !== refundId || r.custom_id !== expected.operationId || cents(r.amount.value) !== expected.amountMinor || !bound) throw new ApiError(409, "conflict", "PayPal refund does not match this operation. No local outcome was changed.");
    return { id: r.id, status: r.status };
  }

  /** Re-read authoritative resource state on durable processing and every replay, including same-second deliveries. */
  async refreshEvent(event: NormalizedEvent, observedAt: number): Promise<NormalizedEvent> {
    if (event.kind === "batch") {
      const events: NormalizedEvent[] = [];
      for (const item of event.events) events.push(await this.refreshEvent(item, observedAt));
      return { ...event, createdAt: observedAt, events };
    }
    if (event.kind === "subscription") return { ...event, createdAt: observedAt, subscription: await this.fetchSubscription(event.subscription.ref) };
    if (event.kind === "checkout") return { ...event, createdAt: observedAt, checkout: await this.readOrder(event.checkout.sessionRef, event.checkout.reference && event.checkout.amountMinor !== undefined ? { reference: event.checkout.reference, amountMinor: event.checkout.amountMinor } : undefined) };
    if (event.kind === "payment" && event.payment.kind === "refund" && event.payment.orderRef && event.payment.purchaseRef && event.payment.paymentRef) {
      const p = event.payment;
      const current = capture.parse(await this.api.request("GET", `/v2/payments/captures/${p.paymentRef}`));
      if (current.id !== p.paymentRef || cents(current.amount.value) !== p.amountMinor) throw new Error("Unexpected PayPal capture");
      if (current.status === "REVERSED") return { ...event, createdAt: observedAt, payment: { ...p, state: "reversed", affectedMinor: p.amountMinor } };
      const history = await this.inspectCapture(p.orderRef!, p.paymentRef!, { reference: p.purchaseRef!, amountMinor: p.amountMinor, currency: p.currency });
      return { ...event, createdAt: observedAt, payment: { ...p, affectedMinor: history.refundedMinor, state: history.refundedMinor === p.amountMinor ? "refunded" : "partially_refunded" } };
    }
    if (event.kind === "payment" && event.payment.kind === "dispute") {
      const p = event.payment;
      const current = z.object({ dispute_id: ref, status: z.string(), disputed_transactions: z.array(z.object({ seller_transaction_id: ref })).length(1) }).parse(await this.api.request("GET", `/v1/customer/disputes/${p.ref}`));
      if (current.dispute_id !== p.ref || current.disputed_transactions[0].seller_transaction_id !== p.paymentRef) throw new Error("Unexpected PayPal dispute");
      return { ...event, createdAt: observedAt, payment: { ...p, state: current.status } };
    }
    return event;
  }

  async verifyWebhook(
    headers: Readonly<Record<string, string | string[] | undefined>>,
    body: string,
    now: number,
  ): Promise<NormalizedEvent> {
    const get = (name: string) => {
      const value = headers[name];
      if (typeof value !== "string" || !value || value.length > 4096)
        throw new WebhookRejected("missing_signature");
      return value;
    };
    let event: {
      id: string;
      event_type: string;
      create_time: string;
      resource: Record<string, unknown>;
    };
    try {
      event = z
        .object({
          id: ref,
          event_type: z.string().max(150),
          create_time: z.string(),
          resource: z.record(z.string(), z.unknown()),
        })
        .parse(JSON.parse(body));
    } catch {
      throw new WebhookRejected("unreadable_body");
    }
    const transmissionTime = get("paypal-transmission-time");
    const sentAt = at(transmissionTime);
    // PayPal retries for three days; deduplication is durable rather than a five-minute replay window.
    if (
      sentAt === null ||
      sentAt > now + 300_000 ||
      sentAt < now - 4 * 86_400_000
    )
      throw new WebhookRejected("stale_timestamp");
    const certUrl = get("paypal-cert-url");
    let cert: URL;
    try {
      cert = new URL(certUrl);
    } catch {
      throw new WebhookRejected("bad_signature");
    }
    if (
      cert.protocol !== "https:" ||
      !this.apiHosts().includes(
        cert.hostname,
      ) ||
      !cert.pathname.startsWith("/v1/notifications/certs/") ||
      cert.username ||
      cert.password ||
      cert.port
    )
      throw new WebhookRejected("bad_signature");
    const verified = z.object({ verification_status: z.string() }).parse(
      await this.api.request(
        "POST",
        "/v1/notifications/verify-webhook-signature",
        {
          auth_algo: get("paypal-auth-algo"),
          cert_url: certUrl,
          transmission_id: get("paypal-transmission-id"),
          transmission_sig: get("paypal-transmission-sig"),
          transmission_time: transmissionTime,
          webhook_id: this.options.webhookId,
          webhook_event: JSON.parse(body),
        },
      ),
    );
    if (verified.verification_status !== "SUCCESS")
      throw new WebhookRejected("bad_signature");
    const createdAt = at(event.create_time);
    if (createdAt === null) throw new WebhookRejected("unreadable_body");
    const base = { ref: event.id, type: event.event_type, createdAt };
    const resourceId = () => ref.parse(event.resource.id);
    if (event.event_type.startsWith("BILLING.SUBSCRIPTION.")) {
      return {
        ...base,
        kind: "subscription",
        subscription: await this.fetchSubscription(resourceId()),
      };
    }
    if (
      event.event_type === "CHECKOUT.ORDER.APPROVED" ||
      event.event_type === "CHECKOUT.ORDER.COMPLETED"
    ) {
      const snap = await this.readOrder(resourceId());
      // Approval is not capture; never turn an approved order into a paid gift.
      return snap.paid
        ? { ...base, kind: "checkout", checkout: snap }
        : { ...base, kind: "other" };
    }
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const related = z
        .object({
          supplementary_data: z.object({
            related_ids: z.object({ order_id: ref }),
          }),
        })
        .parse(event.resource);
      const snap = await this.readOrder(
        related.supplementary_data.related_ids.order_id,
      );
      return snap.paid
        ? { ...base, kind: "checkout", checkout: snap }
        : { ...base, kind: "other" };
    }
    if (event.event_type === "PAYMENT.SALE.COMPLETED") {
      const sale = z
        .object({
          id: ref,
          billing_agreement_id: ref,
          amount: z.object({ currency: z.literal("USD"), total: z.string() }),
          create_time: z.string(),
        })
        .parse(event.resource);
      const sub = await this.fetchSubscription(sale.billing_agreement_id);
      const amount = cents(sale.amount.total);
      if (amount !== this.agreementAmount(sub.priceRef)) throw new Error("Unexpected PayPal renewal amount");
      return {
        ...base,
        kind: "batch",
        events: [
          { ...base, kind: "subscription", subscription: sub },
          {
            ...base,
            kind: "invoice",
            invoice: {
              ref: sale.id,
              subscriptionRef: sub.ref,
              status: "paid",
              currency: "USD",
              amountDueMinor: amount,
              amountPaidMinor: amount,
              amountRefundedMinor: 0,
              taxMinor: null,
              periodStart: sub.currentPeriodStart,
              periodEnd: sub.currentPeriodEnd,
              issuedAt: at(sale.create_time) ?? createdAt,
              paidAt: at(sale.create_time),
            },
          },
        ],
      };
    }
    const paymentEvents = [
      "PAYMENT.CAPTURE.REFUNDED",
      "PAYMENT.CAPTURE.REVERSED",
      "PAYMENT.SALE.REFUNDED",
      "PAYMENT.SALE.REVERSED",
      "CUSTOMER.DISPUTE.CREATED",
      "CUSTOMER.DISPUTE.RESOLVED",
      "CUSTOMER.DISPUTE.UPDATED",
    ];
    if (paymentEvents.includes(event.event_type)) {
      const dispute = event.event_type.startsWith("CUSTOMER.DISPUTE.");
      const reversed = event.event_type.endsWith(".REVERSED");
      const resource = event.resource;
      const linkId = (raw: unknown, segment: string): string | null => {
        const parsed = z.object({ links }).safeParse(raw);
        for (const link of parsed.success ? parsed.data.links : []) {
          let url: URL;
          try {
            url = new URL(link.href);
          } catch {
            continue;
          }
          if (
            url.protocol !== "https:" ||
            !this.apiHosts().includes(
              url.hostname,
            )
          )
            continue;
          const prefix = `${segment}/`;
          if (url.pathname.startsWith(prefix)) {
            const id = url.pathname.slice(prefix.length);
            if (ref.safeParse(id).success) return id;
          }
        }
        return null;
      };
      let paymentRef: string;
      let disputeState: string | null = null;
      let eventRef =
        typeof resource.id === "string" ? ref.parse(resource.id) : event.id;
      if (dispute) {
        const disputeId = ref.parse(resource.dispute_id ?? resource.id);
        const d = z
          .object({
            dispute_id: ref,
            status: z.string(),
            disputed_transactions: z
              .array(z.object({ seller_transaction_id: ref }))
              .length(1),
          })
          .parse(
            await this.api.request("GET", `/v1/customer/disputes/${disputeId}`),
          );
        eventRef = d.dispute_id;
        paymentRef = d.disputed_transactions[0].seller_transaction_id;
        disputeState = d.status;
      } else if (reversed) paymentRef = resourceId();
      else {
        const related = z
          .object({
            supplementary_data: z.object({
              related_ids: z.object({
                capture_id: ref.optional(),
                sale_id: ref.optional(),
              }),
            }),
          })
          .safeParse(resource);
        paymentRef =
          (related.success
            ? (related.data.supplementary_data.related_ids.capture_id ??
              related.data.supplementary_data.related_ids.sale_id)
            : null) ??
          linkId(resource, "/v2/payments/captures") ??
          linkId(resource, "/v1/payments/sale") ??
          "";
        if (!paymentRef)
          throw new Error("PayPal refund has no original payment reference");
      }
      let raw: unknown;
      let salePayment = event.event_type.startsWith("PAYMENT.SALE.");
      if (salePayment)
        raw = await this.api.request("GET", `/v1/payments/sale/${paymentRef}`);
      else {
        try {
          raw = await this.api.request(
            "GET",
            `/v2/payments/captures/${paymentRef}`,
          );
        } catch (e) {
          if (!dispute) throw e;
          salePayment = true;
          raw = await this.api.request(
            "GET",
            `/v1/payments/sale/${paymentRef}`,
          );
        }
      }
      if (salePayment) {
        const sale = z
          .object({
            id: ref,
            state: z.string(),
            billing_agreement_id: ref,
            amount: z.object({ currency: z.literal("USD"), total: z.string() }),
          })
          .parse(raw);
        if (sale.id !== paymentRef)
          throw new Error("Unexpected PayPal sale reference");
        const sub = await this.fetchSubscription(sale.billing_agreement_id);
        const amount = cents(sale.amount.total);
        const refunded = sale.state === "refunded" || reversed;
        const refundAmount = z
          .object({
            amount: z.object({ currency: z.literal("USD"), total: z.string() }),
          })
          .safeParse(resource);
        const paymentEvent: NormalizedEvent = {
          ...base,
          kind: "payment",
          payment: {
            kind: dispute ? "dispute" : "refund",
            ref: eventRef,
            paymentRef,
            subscriptionRef: sub.ref,
            customerRef: null,
            currency: "USD",
            amountMinor: amount,
            affectedMinor: refunded
              ? amount
              : refundAmount.success
                ? cents(refundAmount.data.amount.total)
                : 0,
            state:
              disputeState ??
              (reversed
                ? "reversed"
                : refunded
                  ? "refunded"
                  : "partially_refunded"),
          },
        };
        return {
          ...base,
          kind: "batch",
          events: [
            { ...base, kind: "subscription", subscription: sub },
            paymentEvent,
          ],
        };
      }
      const c = capture.parse(raw);
      if (c.id !== paymentRef)
        throw new Error("Unexpected PayPal capture reference");
      const related = z
        .object({
          supplementary_data: z.object({
            related_ids: z.object({ order_id: ref }),
          }),
        })
        .safeParse(raw);
      const orderId =
        (related.success
          ? related.data.supplementary_data.related_ids.order_id
          : null) ?? linkId(raw, "/v2/checkout/orders");
      const purchase = orderId ? await this.readOrder(orderId) : null;
      const history = !dispute && c.status !== "REVERSED" && !reversed && orderId && purchase?.reference
        ? await this.inspectCapture(orderId, paymentRef, { reference: purchase.reference, amountMinor: cents(c.amount.value), currency: "USD" }) : null;
      const full =
        c.status === "REFUNDED" || c.status === "REVERSED" || reversed;
      return {
        ...base,
        kind: "payment",
        payment: {
          kind: dispute ? "dispute" : "refund",
          ref: eventRef,
          paymentRef,
          purchaseRef: purchase?.reference,
          orderRef: orderId,
          customerRef: null,
          currency: "USD",
          amountMinor: cents(c.amount.value),
          affectedMinor: history
            ? history.refundedMinor
            : full
              ? cents(c.amount.value)
              : 0,
          state:
            disputeState ??
            (reversed ? "reversed" : full ? "refunded" : "partially_refunded"),
        },
      };
    }
    return { ...base, kind: "other" };
  }
}
