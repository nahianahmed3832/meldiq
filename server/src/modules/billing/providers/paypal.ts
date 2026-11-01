import { z } from "zod/v4";
import { ApiError } from "../../../shared/errors.js";
import { addMonths } from "../gifts.js";
import type { SubscriptionStatus } from "../lifecycle.js";
import { HttpPayPalApi, type PayPalApi } from "./paypalApi.js";
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
  seller_receivable_breakdown: z
    .object({ total_refunded_amount: money.optional() })
    .optional(),
});
const order = z.object({
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
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error("Invalid PayPal amount");
  const [whole, fraction] = value.split(".");
  const result = Number(whole) * 100 + Number((fraction ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw new Error("Invalid PayPal amount");
  return result;
};
const at = (value: string | undefined): number | null => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Existing billing adapter, Sandbox only. All financial values come from REST reads or server-owned inputs. */
export class PayPalProvider implements BillingProvider {
  readonly id = "paypal";
  readonly mode = "test";
  readonly api: PayPalApi;
  private readonly clock: () => number;
  constructor(readonly options: PayPalOptions) {
    this.api =
      options.api ?? new HttpPayPalApi(options.clientId, options.clientSecret);
    this.clock = options.clock ?? Date.now;
  }

  publicConfig() {
    return {
      provider: "paypal" as const,
      environment: "sandbox" as const,
      clientId: this.options.clientId,
      subscriptions:
        this.options.subscriptionsApproved && !!this.options.plusPlanId,
      cards: false as const,
    };
  }

  /** Reject a misconfigured remote plan before asking any buyer to approve it. No price overrides or trials. */
  async verifyPlusPlan(): Promise<void> {
    if (!this.options.subscriptionsApproved || !this.options.plusPlanId)
      throw new ApiError(
        409,
        "billing_unavailable",
        "PayPal recurring payments have not been approved for this Sandbox app.",
      );
    const plan = z
      .object({
        id: ref,
        status: z.literal("ACTIVE"),
        quantity_supported: z.boolean().optional(),
        billing_cycles: z
          .array(
            z.object({
              tenure_type: z.literal("REGULAR"),
              total_cycles: z.literal(0),
              frequency: z.object({
                interval_unit: z.literal("MONTH"),
                interval_count: z.literal(1),
              }),
              pricing_scheme: z.object({
                fixed_price: z.object({
                  currency_code: z.literal("USD"),
                  value: z.literal("3.99"),
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
          `/v1/billing/plans/${this.options.plusPlanId}`,
        ),
      );
    if (
      plan.id !== this.options.plusPlanId ||
      plan.quantity_supported ||
      (plan.payment_preferences?.setup_fee &&
        cents(plan.payment_preferences.setup_fee.value) !== 0) ||
      Number(plan.taxes?.percentage ?? 0) !== 0
    )
      throw new ApiError(
        409,
        "billing_unavailable",
        "The PayPal plan does not match Meldiq Plus pricing.",
      );
  }

  async createCheckout(input: CheckoutInput) {
    if (
      input.priceRef !== this.options.plusPlanId ||
      (input.quantity && input.quantity !== 1) ||
      input.trialDays ||
      input.trialEndsAt
    )
      throw new ApiError(
        409,
        "billing_unavailable",
        "This PayPal checkout supports the monthly Plus plan without trial overrides only.",
      );
    await this.verifyPlusPlan();
    const result = subscription.parse(
      await this.api.request(
        "POST",
        "/v1/billing/subscriptions",
        {
          plan_id: this.options.plusPlanId,
          custom_id: input.reference,
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
    if (
      input.currency !== "USD" ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0
    )
      throw new ApiError(
        409,
        "billing_unavailable",
        "This Sandbox checkout supports existing USD products only.",
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
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: "Meldiq",
                shipping_preference: "NO_SHIPPING",
                user_action: "PAY_NOW",
                return_url: input.successUrl,
                cancel_url: input.cancelUrl,
              },
            },
          },
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
      u.hostname !== "www.sandbox.paypal.com" ||
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
    const unit = this.checkOrder(o, expected?.reference, expected?.amountMinor);
    const captures = unit.payments?.captures ?? [];
    const paid =
      o.status === "COMPLETED" &&
      captures.length === 1 &&
      captures[0].status === "COMPLETED";
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
      currency: "USD",
      amountMinor: cents(unit.amount.value),
    };
  }

  async captureOrder(
    id: string,
    expected: { reference: string; amountMinor: number },
  ): Promise<CheckoutSnapshot> {
    const before = await this.readOrder(id, expected);
    if (before.paid) return before;
    // PayPal-Request-Id makes retries and concurrent captures refer to the same operation.
    try {
      await this.api.request(
        "POST",
        `/v2/checkout/orders/${id}/capture`,
        {},
        `capture-${expected.reference}`,
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
      s.plan_id !== this.options.plusPlanId ||
      s.plan_overridden ||
      (s.quantity && s.quantity !== "1")
    )
      throw new Error("Unexpected PayPal subscription terms");
    const info = s.billing_info;
    const paidAt = at(info?.last_payment?.time);
    if (info?.last_payment && cents(info.last_payment.amount.value) !== 399)
      throw new Error("Unexpected PayPal subscription payment");
    const anchor = at(s.start_time);
    const completedCycles = info?.cycle_executions?.find(
      (cycle) => cycle.tenure_type === "REGULAR",
    )?.cycles_completed;
    const cycleEnd =
      anchor !== null && completedCycles
        ? addMonths(anchor, completedCycles)
        : null;
    const nextBilling = at(info?.next_billing_time);
    const paidUntil =
      paidAt === null
        ? null
        : nextBilling !== null && nextBilling > paidAt
          ? nextBilling
          : cycleEnd !== null && Number.isFinite(cycleEnd)
            ? cycleEnd
            : addMonths(paidAt, 1);
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
      customerRef: null,
      status,
      priceRef: s.plan_id,
      checkoutRef: s.custom_id,
      currentPeriodStart: paidAt,
      currentPeriodEnd: paidUntil,
      trialEnd: null,
      cancelAtPeriodEnd: canceled,
      canceledAt: canceled ? at(s.status_update_time) : null,
      quantity: 1,
    };
  }

  async cancelSubscription(id: string): Promise<void> {
    const current = await this.fetchSubscription(id);
    if (current.cancelAtPeriodEnd || current.status === "canceled") return;
    await this.api.request(
      "POST",
      `/v1/billing/subscriptions/${id}/cancel`,
      { reason: "Cancelled by the Meldiq customer" },
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
      !["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"].includes(
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
      if (amount !== 399) throw new Error("Unexpected PayPal renewal amount");
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
            !["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"].includes(
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
      const affected = c.seller_receivable_breakdown?.total_refunded_amount;
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
          affectedMinor: affected
            ? cents(affected.value)
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
