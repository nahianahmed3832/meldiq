import Stripe from "stripe";
import { isSubscriptionStatus, type SubscriptionStatus } from "../lifecycle.js";
import {
  type BillingProvider,
  type CheckoutInput,
  type CheckoutSnapshot,
  type InvoiceSnapshot,
  type NormalizedEvent,
  type OwnerRef,
  type PaymentCheckoutInput,
  type PaymentSnapshot,
  type SubscriptionSnapshot,
  WebhookRejected,
} from "./types.js";

/**
 * Stripe Billing with Stripe-hosted Checkout and the customer portal (BILLING_PROVIDER=stripe, docs/BILLING.md › Stripe).
 *
 * - Webhooks are verified with the official SDK against the body exactly as received (`Stripe-Signature`, 5 minutes).
 * - Subscriptions carry our checkout id in `metadata.meldiq_checkout`, set through `subscription_data.metadata` when the
 *   checkout is created: that, never a customer id or an owner id in the payload, is how a subscription finds its owner.
 * - Only references, states, periods and amounts are read from Stripe's objects; card and bank details never are.
 *
 * Network calls go through [StripeApi], so tests can stand in for Stripe without a network; the webhook signature is
 * always checked by the real SDK.
 */
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
const TOLERANCE_S = 300;
const META_CHECKOUT = "meldiq_checkout";

/** The Stripe calls this adapter makes (the real one is [stripeApi]). */
export interface StripeApi {
  createCustomer(params: Stripe.CustomerCreateParams, idempotencyKey: string): Promise<{ id: string }>;
  createCheckoutSession(params: Stripe.Checkout.SessionCreateParams, idempotencyKey: string): Promise<{ id: string; url: string | null }>;
  expireCheckoutSession(id: string): Promise<void>;
  createPortalSession(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<Stripe.Subscription | null>;
}

export function stripeApi(client: Stripe): StripeApi {
  return {
    createCustomer: (params, idempotencyKey) => client.customers.create(params, { idempotencyKey }),
    createCheckoutSession: (params, idempotencyKey) => client.checkout.sessions.create(params, { idempotencyKey }),
    expireCheckoutSession: async (id) => {
      try {
        await client.checkout.sessions.expire(id);
      } catch (e) {
        // Already complete or expired: nothing is left to stop.
        if (!(e instanceof Stripe.errors.StripeInvalidRequestError)) throw e;
      }
    },
    createPortalSession: (params) => client.billingPortal.sessions.create(params),
    retrieveSubscription: async (id) => {
      try {
        return await client.subscriptions.retrieve(id);
      } catch (e) {
        if (e instanceof Stripe.errors.StripeInvalidRequestError && e.statusCode === 404) return null;
        throw e;
      }
    },
  };
}

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  allowPromotionCodes: boolean;
  /** Stands in for Stripe's API in tests. */
  api?: StripeApi;
}

/** Test or live, from the key's own prefix (sk_test_ / rk_test_ / sk_live_ / rk_live_). */
export function stripeKeyMode(key: string): "test" | "live" | null {
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) return "test";
  if (/^(sk|rk)_live_[A-Za-z0-9]+$/.test(key)) return "live";
  return null;
}

const ms = (s: number | null | undefined): number | null => (typeof s === "number" ? s * 1000 : null);
const idOf = (v: string | { id: string } | null | undefined): string | null => (v == null ? null : typeof v === "string" ? v : v.id);

/** Stripe's subscription status in Meldiq's vocabulary (they are the same words; anything new is refused). */
function statusOf(s: string): SubscriptionStatus {
  if (!isSubscriptionStatus(s)) throw new WebhookRejected("unknown_event");
  return s;
}

export function subscriptionSnapshot(sub: Stripe.Subscription): SubscriptionSnapshot {
  // Billing periods live on the subscription's items (Stripe API 2025-03-31 and later). Meldiq subscriptions have one.
  const item = sub.items?.data?.[0];
  if (!item?.price?.id) throw new WebhookRejected("unreadable_body");
  return {
    ref: sub.id,
    customerRef: idOf(sub.customer),
    status: statusOf(sub.status),
    priceRef: item.price.id,
    checkoutRef: sub.metadata?.[META_CHECKOUT] ?? null,
    currentPeriodStart: ms(item.current_period_start),
    currentPeriodEnd: ms(item.current_period_end),
    trialEnd: ms(sub.trial_end),
    // A cancellation scheduled for a date (cancel_at) also ends the subscription without renewing it.
    cancelAtPeriodEnd: sub.cancel_at_period_end || sub.cancel_at !== null,
    canceledAt: ms(sub.canceled_at),
    // The Spark add-on is bought by quantity (the customer portal may change it); plans are always 1.
    quantity: typeof item.quantity === "number" && item.quantity >= 0 ? item.quantity : 1,
  };
}

const INVOICE_STATUSES = ["open", "paid", "void", "uncollectible"] as const;

function invoiceSnapshot(inv: Stripe.Invoice, eventType: string): InvoiceSnapshot | null {
  // Drafts can still change and owe nothing yet; they are recorded once finalized.
  if (!inv.id || !inv.status || inv.status === "draft") return null;
  const failed = eventType === "invoice.payment_failed" && inv.status === "open";
  const status = failed ? "payment_failed" : INVOICE_STATUSES.find((s) => s === inv.status);
  if (!status) return null;
  const taxes = inv.total_taxes;
  return {
    ref: inv.id,
    subscriptionRef: idOf(inv.parent?.subscription_details?.subscription ?? null),
    status,
    currency: inv.currency.toUpperCase(),
    amountDueMinor: inv.amount_due,
    amountPaidMinor: inv.amount_paid,
    amountRefundedMinor: 0,
    taxMinor: Array.isArray(taxes) ? taxes.reduce((n, t) => n + t.amount, 0) : null,
    periodStart: ms(inv.period_start),
    periodEnd: ms(inv.period_end),
    issuedAt: ms(inv.status_transitions?.finalized_at) ?? ms(inv.created)!,
    paidAt: ms(inv.status_transitions?.paid_at),
  };
}

function checkoutSnapshot(s: Stripe.Checkout.Session, eventType: string): CheckoutSnapshot | null {
  if (s.mode !== "subscription" && s.mode !== "payment") return null;
  const outcome =
    eventType === "checkout.session.expired" ? "expired" : eventType === "checkout.session.async_payment_failed" ? "payment_failed" : "completed";
  return {
    sessionRef: s.id,
    reference: s.client_reference_id ?? s.metadata?.[META_CHECKOUT] ?? null,
    outcome,
    subscriptionRef: idOf(s.subscription),
    customerRef: idOf(s.customer),
    mode: s.mode === "payment" ? "payment" : "subscription",
    // A completed checkout paid by a delayed method (a bank debit) is paid only at async_payment_succeeded.
    paid: s.payment_status === "paid" || s.payment_status === "no_payment_required",
    paymentRef: idOf(s.payment_intent),
  };
}

function refundSnapshot(c: Stripe.Charge): PaymentSnapshot {
  return {
    kind: "refund",
    ref: c.id,
    customerRef: idOf(c.customer),
    currency: c.currency.toUpperCase(),
    amountMinor: c.amount,
    affectedMinor: c.amount_refunded,
    state: c.refunded ? "refunded" : "partially_refunded",
    paymentRef: idOf(c.payment_intent),
  };
}

function disputeSnapshot(d: Stripe.Dispute, customerRef: string | null): PaymentSnapshot {
  return { kind: "dispute", ref: d.id, customerRef, currency: d.currency.toUpperCase(), amountMinor: d.amount, affectedMinor: d.amount, state: d.status };
}

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
]);
const INVOICE_EVENTS = new Set([
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "invoice.updated",
]);
const CHECKOUT_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"]);

/** The Stripe events Meldiq's webhook endpoint should be subscribed to (docs/BILLING.md › Stripe Dashboard). */
export const STRIPE_WEBHOOK_EVENTS: readonly string[] = [...SUBSCRIPTION_EVENTS, ...INVOICE_EVENTS, ...CHECKOUT_EVENTS, "charge.refunded", "charge.dispute.created", "charge.dispute.closed"];

/** A verified Stripe event in Meldiq's shapes. */
export function normalizeStripeEvent(e: Stripe.Event): NormalizedEvent {
  const base = { ref: e.id, type: e.type, createdAt: e.created * 1000 };
  const object = e.data.object as unknown;
  if (SUBSCRIPTION_EVENTS.has(e.type)) return { ...base, kind: "subscription", subscription: subscriptionSnapshot(object as Stripe.Subscription) };
  if (INVOICE_EVENTS.has(e.type)) {
    const invoice = invoiceSnapshot(object as Stripe.Invoice, e.type);
    return invoice ? { ...base, kind: "invoice", invoice } : { ...base, kind: "other" };
  }
  if (CHECKOUT_EVENTS.has(e.type)) {
    const checkout = checkoutSnapshot(object as Stripe.Checkout.Session, e.type);
    return checkout ? { ...base, kind: "checkout", checkout } : { ...base, kind: "other" };
  }
  if (e.type === "charge.refunded") return { ...base, kind: "payment", payment: refundSnapshot(object as Stripe.Charge) };
  if (e.type === "charge.dispute.created" || e.type === "charge.dispute.closed") {
    const d = object as Stripe.Dispute;
    const charge = typeof d.charge === "string" ? null : d.charge;
    return { ...base, kind: "payment", payment: disputeSnapshot(d, idOf(charge?.customer ?? null)) };
  }
  return { ...base, kind: "other" };
}

export class StripeProvider implements BillingProvider {
  readonly id = "stripe";
  readonly mode: "test" | "live";
  private readonly api: StripeApi;
  private readonly webhooks = Stripe.webhooks;

  constructor(private readonly opts: StripeOptions) {
    const mode = stripeKeyMode(opts.secretKey);
    if (!mode) throw new Error("STRIPE_SECRET_KEY is not a Stripe secret or restricted key");
    this.mode = mode;
    // The SDK pins its API version (2026-09-30.endive for stripe 23.0.0); Meldiq reads only fields that version has.
    this.api = opts.api ?? stripeApi(new Stripe(opts.secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "Meldiq" } }));
  }

  verifyWebhook(headers: Readonly<Record<string, string | string[] | undefined>>, rawBody: string, now: number): NormalizedEvent {
    const sig = headers[STRIPE_SIGNATURE_HEADER];
    if (typeof sig !== "string" || !sig) throw new WebhookRejected("missing_signature");
    let event: Stripe.Event;
    try {
      event = this.webhooks.constructEvent(rawBody, sig, this.opts.webhookSecret, TOLERANCE_S, undefined, now);
    } catch (e) {
      if (e instanceof Stripe.errors.StripeSignatureVerificationError) {
        throw new WebhookRejected(/tolerance/i.test(e.message) ? "stale_timestamp" : "bad_signature");
      }
      throw new WebhookRejected("unreadable_body");
    }
    return normalizeStripeEvent(event);
  }

  async createCustomer(input: { owner: OwnerRef; email: string | null; name: string | null }): Promise<string> {
    const c = await this.api.createCustomer(
      {
        ...(input.email ? { email: input.email } : {}),
        ...(input.name ? { name: input.name } : {}),
        metadata: { meldiq_owner_kind: input.owner.kind, meldiq_owner_id: input.owner.id },
      },
      // The same owner asking twice at once gets the same customer back.
      `meldiq-customer-${input.owner.kind}-${input.owner.id}`,
    );
    return c.id;
  }

  async createCheckout(input: CheckoutInput): Promise<{ sessionRef: string; url: string | null }> {
    const metadata = { [META_CHECKOUT]: input.reference, meldiq_owner_kind: input.owner.kind, meldiq_owner_id: input.owner.id };
    const session = await this.api.createCheckoutSession(
      {
        mode: "subscription",
        client_reference_id: input.reference,
        ...(input.customerRef ? { customer: input.customerRef } : {}),
        line_items: [{ price: input.priceRef, quantity: input.quantity ?? 1 }],
        subscription_data: {
          metadata,
          ...(input.trialEndsAt ? { trial_end: Math.floor(input.trialEndsAt / 1000) } : input.trialDays > 0 ? { trial_period_days: input.trialDays } : {}),
        },
        metadata,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        allow_promotion_codes: this.opts.allowPromotionCodes,
      },
      `meldiq-checkout-${input.reference}`,
    );
    return { sessionRef: session.id, url: session.url };
  }

  /** A one-time payment priced by the server (a gift): the amount and the name come from the catalog, never a client. */
  async createPaymentCheckout(input: PaymentCheckoutInput): Promise<{ sessionRef: string; url: string | null }> {
    const metadata = { [META_CHECKOUT]: input.reference, meldiq_owner_kind: input.owner.kind, meldiq_owner_id: input.owner.id };
    const session = await this.api.createCheckoutSession(
      {
        mode: "payment",
        client_reference_id: input.reference,
        ...(input.customerRef ? { customer: input.customerRef } : {}),
        line_items: [{ quantity: 1, price_data: { currency: input.currency.toLowerCase(), unit_amount: input.amountMinor, product_data: { name: input.productName } } }],
        payment_intent_data: { metadata },
        metadata,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        allow_promotion_codes: this.opts.allowPromotionCodes,
      },
      `meldiq-payment-${input.reference}`,
    );
    return { sessionRef: session.id, url: session.url };
  }

  async createPortal(input: { customerRef: string; returnUrl: string; configuration?: string | null }): Promise<string> {
    return (await this.api.createPortalSession({ customer: input.customerRef, return_url: input.returnUrl, ...(input.configuration ? { configuration: input.configuration } : {}) })).url;
  }

  async fetchSubscription(ref: string): Promise<SubscriptionSnapshot | null> {
    const sub = await this.api.retrieveSubscription(ref);
    return sub ? subscriptionSnapshot(sub) : null;
  }

  async expireCheckout(sessionRef: string): Promise<void> {
    await this.api.expireCheckoutSession(sessionRef);
  }
}
