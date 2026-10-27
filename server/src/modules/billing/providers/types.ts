import type { SubscriptionStatus } from "../lifecycle.js";

/**
 * A billing provider adapter (docs/BILLING.md). The subscription core only sees these shapes; each adapter verifies its
 * own webhook signatures and maps its own vocabulary. No adapter ever sees card or bank details: checkout and payment
 * methods stay on the provider's hosted pages.
 */
export interface BillingProvider {
  /** Stored with every row this provider produced. */
  readonly id: string;
  /** "test": sandbox or test keys, never real money. "live": real charges. */
  readonly mode: "test" | "live";
  /**
   * Checks the signature of a webhook body exactly as received and returns the provider's event, normalized.
   * Throws [WebhookRejected] when the signature or the body can't be trusted.
   */
  verifyWebhook(headers: Readonly<Record<string, string | string[] | undefined>>, rawBody: string, now: number): NormalizedEvent;
  /** Starts a hosted checkout for [priceRef]; [reference] must come back in the subscription events it produces. */
  createCheckout(input: { reference: string; priceRef: string; trialDays: number; customerRef: string | null }): Promise<{ sessionRef: string; url: string | null }>;
}

export class WebhookRejected extends Error {
  constructor(readonly reason: "missing_signature" | "bad_signature" | "stale_timestamp" | "unreadable_body" | "unknown_event") {
    super(reason);
  }
}

/** A subscription's whole state as the provider reports it: applying a newer snapshot over an older one is safe. */
export interface SubscriptionSnapshot {
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

export type NormalizedEvent =
  | { ref: string; type: string; createdAt: number; kind: "subscription"; subscription: SubscriptionSnapshot }
  | { ref: string; type: string; createdAt: number; kind: "invoice"; invoice: InvoiceSnapshot }
  | { ref: string; type: string; createdAt: number; kind: "other" };
