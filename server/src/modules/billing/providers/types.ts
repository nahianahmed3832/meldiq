export interface ProviderSource { mode: "test" | "live"; scope: string | null; }

import type { SubscriptionStatus } from "../lifecycle.js";

/**
 * A billing provider adapter (docs/BILLING.md). The subscription core only sees these shapes; each adapter verifies its
 * own webhook signatures and maps its own vocabulary. No adapter ever sees card or bank details: checkout and payment
 * methods stay on the provider's hosted pages.
 *
 * The optional methods are what a provider with customer accounts and a hosted portal offers (Stripe); the sandbox has
 * none of them, and the core works without them.
 */
export interface BillingProvider {
  /** Stored with every row this provider produced. */
  readonly id: string;
  /** "test": sandbox or test keys, never real money. "live": real charges. */
  readonly mode: "test" | "live";
  /** Opaque source binding for durable replay; never a provider credential. */
  readonly eventScope?: string;
  readonly supportsOneTimePurchases?: boolean;
  readonly supportsSparkPurchases?: boolean;
  /**
   * Checks the signature of a webhook body exactly as received and returns the provider's event, normalized.
   * Throws [WebhookRejected] when the signature or the body can't be trusted.
   */
  verifyWebhook(headers: Readonly<Record<string, string | string[] | undefined>>, rawBody: string, now: number): NormalizedEvent | Promise<NormalizedEvent>;
  /** Durable event processing/replay may require a current provider read instead of trusting payload ordering. */
  refreshEvent?(event: NormalizedEvent, now: number): Promise<NormalizedEvent>;
  /** Starts a hosted checkout for [priceRef]; [reference] must come back in the subscription events it produces. */
  createCheckout(input: CheckoutInput): Promise<{ sessionRef: string; url: string | null }>;
  /**
   * Starts a hosted one-time payment (a gift, docs/MOJO.md): [reference] comes back in its checkout events. Absent:
   * this provider can't take one-time payments.
   */
  createPaymentCheckout?(input: PaymentCheckoutInput): Promise<{ sessionRef: string; url: string | null }>;
  refundPayment?(paymentRef: string, requestKey: string): Promise<{id: string; status: string}>;
  /** Creates the provider's customer for an owner (once: the caller stores it and reuses it). */
  createCustomer?(input: { owner: OwnerRef; email: string | null; name: string | null }): Promise<string>;
  /**
   * Sells Mojo Go, Mojo Plus and Sparks at [amounts] (US cents a month) from now on: new provider prices and the portal
   * switched to them; subscribers keep the prices they have (docs/PLANS.md › Prices). Answers the new price refs.
   */
  setMojoPrices?(siteUrl: string, amounts: { go: number; plus: number; spark: number }): Promise<{ prices: { go: string; plus: string; spark: string }; steps: string[] }>;
  /** A hosted page where the customer manages payment methods, invoices and cancellation. */
  createPortal?(input: { customerRef: string; returnUrl: string; configuration?: string | null }): Promise<string>;
  /** The provider's current state of a subscription (reconciliation); null when the provider doesn't know it. */
  fetchSubscription?(ref: string): Promise<SubscriptionSnapshot | null>;
  /** Ends an unfinished hosted checkout so it can't be paid any more (a newer one replaced it). */
  expireCheckout?(sessionRef: string): Promise<void>;
}

/** Who a checkout, customer or subscription belongs to: an organization, or a person's account (docs/BILLING.md). */
export interface OwnerRef {
  kind: "org" | "account";
  id: string;
}

export interface CheckoutInput {
  reference: string;
  priceRef: string;
  trialDays: number;
  /** A free period the owner already has ends then: charging starts at that time (overrides [trialDays]). */
  trialEndsAt?: number | null;
  customerRef: string | null;
  owner: OwnerRef;
  /** Where the provider sends the browser afterwards (fixed by the server's configuration, never by the client). */
  successUrl: string;
  cancelUrl: string;
  /** How many of the price (the Spark add-on's number of Sparks; 1 for a plan). */
  quantity?: number;
}

/** A one-time payment the server prices itself (a gift): never an amount a client sent. */
export interface PaymentCheckoutInput {
  kind?: "gift" | "spark" | "collectible";
  reference: string;
  customerRef: string | null;
  owner: OwnerRef;
  currency: string;
  amountMinor: number;
  /** What the receipt and the payment page call it ("Mojo Plus for 3 months, a gift"). */
  productName: string;
  successUrl: string;
  cancelUrl: string;
}

export class WebhookRejected extends Error {
  constructor(readonly reason: "missing_signature" | "bad_signature" | "stale_timestamp" | "unreadable_body" | "unknown_event") {
    super(reason);
  }
}

/** A subscription's whole state as the provider reports it: applying a newer snapshot over an older one is safe. */
export interface SubscriptionSnapshot {
  approvalConfirmed?: boolean;
  ref: string;
  customerRef: string | null;
  status: SubscriptionStatus;
  priceRef: string;
  /** The checkout reference we gave the provider (billing_checkouts.id), when the provider echoes it. */
  checkoutRef: string | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  /** How many of the price (the Spark add-on's number of Sparks); 1 when the provider doesn't say. */
  quantity?: number;
}

export interface InvoiceSnapshot {
  ref: string;
  subscriptionRef: string | null;
  status: "open" | "paid" | "payment_failed" | "void" | "uncollectible";
  currency: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  amountRefundedMinor: number;
  taxMinor: number | null;
  periodStart: number | null;
  periodEnd: number | null;
  issuedAt: number;
  paidAt: number | null;
}

/** A hosted checkout finished or ran out (the subscription itself arrives in its own events). */
export interface CheckoutSnapshot {
  sessionRef: string;
  /** Our checkout id (billing_checkouts.id), as the provider echoes it. */
  reference: string | null;
  outcome: "completed" | "expired" | "payment_failed";
  subscriptionRef: string | null;
  customerRef: string | null;
  /** "payment": a one-time payment (a gift); absent or "subscription": a plan's checkout. */
  mode?: "subscription" | "payment";
  /** One-time payments: whether the money is in (a completed bank payment can still be on its way), and its reference. */
  paid?: boolean;
  paymentRef?: string | null;
  captureStatus?: string | null;
  currency?: string;
  amountMinor?: number;
}

/** A refund or a dispute on a customer's payment: recorded with the owner's subscription, never applied on its own. */
export interface PaymentSnapshot {
  subscriptionRef?: string | null;
  purchaseRef?: string | null;
  orderRef?: string | null;
  kind: "refund" | "dispute";
  ref: string;
  customerRef: string | null;
  currency: string;
  amountMinor: number;
  /** Refunds: how much of the payment is refunded so far. Disputes: the disputed amount. */
  affectedMinor: number;
  /** The provider's word for where it stands (a dispute's status; "refunded"/"partially_refunded"). */
  state: string;
  /** The payment it's about (a gift's payment is found by it). */
  paymentRef?: string | null;
}

export type NormalizedEvent =
  | { ref: string; type: string; createdAt: number; kind: "batch"; events: NormalizedEvent[] }
  | { ref: string; type: string; createdAt: number; kind: "subscription"; subscription: SubscriptionSnapshot }
  | { ref: string; type: string; createdAt: number; kind: "invoice"; invoice: InvoiceSnapshot }
  | { ref: string; type: string; createdAt: number; kind: "checkout"; checkout: CheckoutSnapshot }
  | { ref: string; type: string; createdAt: number; kind: "payment"; payment: PaymentSnapshot }
  | { ref: string; type: string; createdAt: number; kind: "other" };
