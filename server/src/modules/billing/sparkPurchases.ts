import type { FastifyBaseLogger } from "fastify";
import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { ApiError, conflict, forbidden } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { SPARK_LIST_PRICE_MINOR, SPARK_MAX_PURCHASE } from "./perks.js";
import type { CheckoutSnapshot, PaymentSnapshot } from "./providers/types.js";
import type { Billing, CheckoutStarter } from "./service.js";
import type { ApplyOutcome } from "./subscriptions.js";
import type { PaymentEvents } from "./webhooks.js";

export interface SparkPurchaseRow {
  id: string;
  buyer_account_id: string | null;
  buyer_user_id: string | null;
  quantity: number;
  currency: string;
  amount_minor: number;
  status: "pending" | "paid" | "refunded" | "expired" | "failed";
  provider: string;
  provider_session_ref: string | null;
  provider_payment_ref: string | null;
  request_key: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
  updated_at: number;
}

/** Purchased Sparks are durable slots, independent of a personal subscription; only verified payment grants them. */
export class SparkPurchases implements PaymentEvents {
  constructor(private readonly billing: Billing, private readonly rows: Rows, private readonly log: FastifyBaseLogger, private readonly clock: () => number = Date.now) {}

  available(): boolean {
    const provider = this.billing.provider;
    return !!provider?.createPaymentCheckout && (provider.id !== "paypal" || provider.supportsSparkPurchases === true);
  }
  get(id: string): SparkPurchaseRow | null { return this.rows.get<SparkPurchaseRow>("spark_purchases", { id }) ?? null; }
  userIdsOf(accountId: string): string[] {
    return [...new Set(this.rows.all<SparkPurchaseRow>("spark_purchases", { where: { buyer_account_id: accountId } }).flatMap((purchase) => purchase.buyer_user_id ? [purchase.buyer_user_id] : []))];
  }
  slots(userId: string): number {
    return this.rows.all<SparkPurchaseRow>("spark_purchases", { where: { buyer_user_id: userId, status: "paid" } }).reduce((total, purchase) => total + purchase.quantity, 0);
  }

  async start(starter: CheckoutStarter & { accountId: string }, quantity: number, returnUrl: string | null, requestKey?: string): Promise<{ purchaseId: string; url: string | null; expiresAt: number }> {
    const provider = this.billing.provider;
    if (!provider?.createPaymentCheckout || !this.available()) throw new ApiError(503, "billing_unavailable", "Spark purchases aren't available yet.");
    if (!starter.userId) throw forbidden("Set up your account before buying Sparks.");
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > SPARK_MAX_PURCHASE) throw new ApiError(400, "bad_request", `Buy between 1 and ${SPARK_MAX_PURCHASE} Sparks.`);
    const t = this.clock();
    let id = newId("spkpay");
    await this.rows.write((w) => {
      const previous = requestKey
        ? w.get<SparkPurchaseRow>("spark_purchases", { provider: provider.id, buyer_account_id: starter.accountId, request_key: requestKey })
        : w.get<SparkPurchaseRow>("spark_purchases", { provider: provider.id, buyer_account_id: starter.accountId, quantity, status: "pending", expires_at: { gt: t } }, [["created_at", "desc"]]);
      if (previous) {
        if (previous.quantity !== quantity) throw conflict("This purchase request was already used for a different quantity.");
        id = previous.id;
        return;
      }
      w.insert("spark_purchases", { id, buyer_account_id: starter.accountId, buyer_user_id: starter.userId, quantity, currency: "USD", amount_minor: SPARK_LIST_PRICE_MINOR * quantity,
        status: "pending", provider: provider.id, provider_session_ref: null, provider_payment_ref: null, request_key: requestKey ?? null,
        created_at: t, expires_at: t + 24 * 3_600_000, paid_at: null, updated_at: t });
    });
    const purchase = this.get(id)!;
    if (purchase.status !== "pending") return { purchaseId: id, url: null, expiresAt: purchase.expires_at };
    try {
      const owner = { kind: "account" as const, accountId: starter.accountId };
      const customerRef = await this.billing.customerFor(provider, owner, starter);
      const session = await provider.createPaymentCheckout({ reference: id, kind: "spark", customerRef, owner: { kind: "account", id: starter.accountId }, currency: purchase.currency,
        amountMinor: purchase.amount_minor, productName: `${quantity} Meldiq Spark${quantity === 1 ? "" : "s"} — one-time purchase`,
        successUrl: `${returnUrl ?? ""}?spark=success`, cancelUrl: `${returnUrl ?? ""}?spark=canceled` });
      await this.rows.write((w) => w.update("spark_purchases", { id }, { provider_session_ref: session.sessionRef, updated_at: this.clock() }));
      return { purchaseId: id, url: session.url, expiresAt: purchase.expires_at };
    } catch (error) {
      this.log.warn({ err: error }, "Spark checkout could not start");
      throw error;
    }
  }

  applyCheckout(w: RowWriter, provider: string, snap: CheckoutSnapshot, t: number): ApplyOutcome | null {
    if (snap.mode !== "payment" || !snap.reference?.startsWith("spkpay_")) return null;
    const purchase = w.get<SparkPurchaseRow>("spark_purchases", { id: snap.reference, provider });
    if (!purchase) return { result: "stale", subscriptionId: null, owner: null };
    if (snap.sessionRef !== purchase.provider_session_ref || snap.currency !== purchase.currency || snap.amountMinor !== purchase.amount_minor) throw new Error("Spark payment does not match its frozen checkout.");
    const owner = purchase.buyer_account_id ? { kind: "account" as const, accountId: purchase.buyer_account_id } : null;
    if (snap.outcome === "completed" && snap.paid && snap.paymentRef) {
      // Refunds dominate out-of-order capture events. No callback or browser redirect can grant slots.
      if (purchase.status !== "refunded") w.update("spark_purchases", { id: purchase.id }, { status: "paid", paid_at: purchase.paid_at ?? t, provider_payment_ref: snap.paymentRef, updated_at: t });
    } else if (snap.outcome !== "completed" && purchase.status === "pending") {
      w.update("spark_purchases", { id: purchase.id }, { status: snap.outcome === "expired" ? "expired" : "failed", updated_at: t });
    }
    return { result: "applied", subscriptionId: null, owner };
  }

  applyPayment(w: RowWriter, provider: string, payment: PaymentSnapshot, t: number): ApplyOutcome | null {
    if (!payment.paymentRef) return null;
    const purchase = w.get<SparkPurchaseRow>("spark_purchases", { provider, provider_payment_ref: payment.paymentRef })
      ?? (payment.purchaseRef ? w.get<SparkPurchaseRow>("spark_purchases", { id: payment.purchaseRef, provider }) : undefined);
    if (!purchase) return null;
    if (payment.currency !== purchase.currency || payment.amountMinor !== purchase.amount_minor || (payment.orderRef && payment.orderRef !== purchase.provider_session_ref)) throw new Error("Spark refund does not match its payment.");
    if (payment.state === "refunded" || payment.state === "reversed") w.update("spark_purchases", { id: purchase.id }, { status: "refunded", provider_payment_ref: payment.paymentRef, updated_at: t });
    return { result: "applied", subscriptionId: null, owner: purchase.buyer_account_id ? { kind: "account", accountId: purchase.buyer_account_id } : null };
  }
}
