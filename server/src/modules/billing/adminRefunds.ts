import { randomUUID } from "node:crypto";
import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import type { CardMandate, CardCharge } from "./cardSubscriptions.js";
import type { Billing } from "./service.js";
import { PayPalProvider } from "./providers/paypal.js";
import { PayPalRefundRejected } from "./providers/paypalApi.js";

export type RefundStatus = "reserved" | "submitting" | "pending" | "uncertain" | "completed" | "failed";
export interface AdminRefundRow {
  id: string; request_key: string; provider: string; provider_mode: "test" | "live"; merchant_id: string;
  purchase_kind: "gift" | "spark" | "collectible" | "card"; purchase_id: string; account_id: string; order_ref: string; payment_ref: string;
  currency: string; amount_minor: number; captured_minor: number; baseline_refunded_minor: number; actor_account_id: string; reason: string;
  status: RefundStatus; provider_ref: string | null; last_error: string | null; created_at: number; updated_at: number;
}
interface Purchase {
  id: string; kind: AdminRefundRow["purchase_kind"]; accountId: string; orderRef: string; paymentRef: string; amountMinor: number; currency: string; status: string;
}
type PurchaseRow = { id: string; provider: string; buyer_account_id?: string; account_id?: string; provider_session_ref?: string; session_ref?: string; provider_payment_ref?: string; payment_ref?: string; amount_minor: number; currency: string; status: string };
const UNSETTLED = ["reserved", "submitting", "pending", "uncertain"];

/** Durable identities and reservations protect money independently of a process, browser or provider idempotency TTL. */
export class AdminRefunds {
  constructor(private readonly billing: Billing) {}

  private provider(): PayPalProvider {
    if (!(this.billing.provider instanceof PayPalProvider)) throw new ApiError(409, "billing_unavailable", "PayPal is not configured. Review historical payments in their owning provider console.");
    return this.billing.provider;
  }
  private purchase(id: string, rows: RowReader = this.billing.rows): Purchase {
    for (const [table, kind] of [["mojo_gifts", "gift"], ["spark_purchases", "spark"], ["collectible_orders", "collectible"]] as const) {
      const r = rows.get<PurchaseRow>(table, { id, provider: "paypal" });
      if (!r) continue;
      const accountId = r.buyer_account_id ?? r.account_id, orderRef = r.provider_session_ref ?? r.session_ref, paymentRef = r.provider_payment_ref ?? r.payment_ref;
      if (!accountId || !orderRef || !paymentRef) throw conflict("This purchase has no verified captured payment and billing owner.");
      return { id, kind, accountId, orderRef, paymentRef, amountMinor: r.amount_minor, currency: r.currency, status: r.status };
    }
    const charge = rows.get<CardCharge>("billing_card_charges", { id });
    if (charge) {
      const m = rows.get<CardMandate>("billing_card_mandates", { id: charge.mandate_id });
      const provider = this.provider();
      if (!m || !charge.provider_order_ref || !charge.provider_capture_ref) throw conflict("This charge has no verified capture and mandate.");
      if (m.provider_mode && m.provider_mode !== provider.mode || m.merchant_id && m.merchant_id !== provider.merchantId) throw conflict("The mandate belongs to a different merchant or environment.");
      return { id, kind: "card", accountId: m.account_id, orderRef: charge.provider_order_ref, paymentRef: charge.provider_capture_ref, amountMinor: charge.amount_minor, currency: charge.currency, status: charge.status };
    }
    throw notFound("Captured PayPal purchase not found");
  }
  private operations(purchaseId: string, rows: RowReader = this.billing.rows) {
    return rows.all<AdminRefundRow>("billing_admin_refunds", { where: { purchase_id: purchaseId }, orderBy: [["created_at", "desc"], ["id", "desc"]], limit: 101 });
  }
  private legacy(purchaseId: string, rows: RowReader = this.billing.rows) {
    return rows.get<{ status: string; provider_ref: string | null }>("billing_payment_actions", { provider: "paypal", purchase_id: purchaseId });
  }
  private sameEnvironment(r: AdminRefundRow, provider: PayPalProvider) {
    if (r.provider_mode !== provider.mode || r.merchant_id !== provider.merchantId) throw conflict("This operation belongs to a different PayPal merchant or environment. Use the original configuration to reconcile it.");
  }
  private remaining(p: Purchase, providerRefunded: number, rows: RowReader = this.billing.rows) {
    const ops = this.operations(p.id, rows);
    const completed = ops.filter(r => r.status === "completed").reduce((n, r) => n + r.amount_minor, 0);
    const pending = ops.filter(r => UNSETTLED.includes(r.status)).reduce((n, r) => n + r.amount_minor, 0);
    return { completedMinor: Math.max(completed, providerRefunded), reservedMinor: pending, remainingMinor: Math.max(0, p.amountMinor - Math.max(completed, providerRefunded) - pending) };
  }
  view(r: AdminRefundRow) {
    return { id: r.id, purchaseId: r.purchase_id, accountId: r.account_id, mode: r.provider_mode, currency: r.currency, amountMinor: r.amount_minor, status: r.status,
      providerRef: r.provider_ref, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at, actorAccountId: r.actor_account_id, reason: r.reason };
  }

  async inspect(purchaseId: string) {
    const p = this.purchase(purchaseId), provider = this.provider(), operations = this.operations(purchaseId), legacy = this.legacy(purchaseId);
    for (const r of operations) this.sameEnvironment(r, provider);
    const current = await provider.inspectCapture(p.orderRef, p.paymentRef, { reference: p.id, amountMinor: p.amountMinor, currency: p.currency });
    return { purchase: p, mode: provider.mode, checkedAt: Date.now(), ...this.remaining(p, current.refundedMinor), operations: operations.map(r => this.view(r)),
      legacyReview: !!legacy && legacy.status !== "completed", policy: p.kind === "card" ? "A full refund of the current paid period pauses the mandate and its access under the existing card subscription policy. Partial refunds retain access; refunding a previous period does not revoke the current period." : p.kind === "gift" ? "A full refund prevents an unredeemed gift from being redeemed. Already granted gift time is retained." : p.kind === "spark" ? "A full refund removes purchased Spark capacity under the existing entitlement rules. Partial refunds do not change capacity." : "A full refund removes the purchased collectible under the existing ownership policy. Partial refunds do not change ownership." };
  }

  async request(purchaseId: string, input: { requestKey: string; amountMinor: number; currency: string; accountId: string; reason: string }, actor: string, beforeSend: (operation: AdminRefundRow) => Promise<unknown>) {
    const provider = this.provider();
    const prior = this.billing.rows.get<AdminRefundRow>("billing_admin_refunds", { request_key: input.requestKey });
    if (prior) {
      this.sameEnvironment(prior, provider);
      if (prior.purchase_id !== purchaseId || prior.amount_minor !== input.amountMinor || prior.currency !== input.currency || prior.account_id !== input.accountId) throw conflict("This operation identity belongs to a different refund. Reload its original outcome.");
      return this.view(prior);
    }
    const p = this.purchase(purchaseId);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.currency !== p.currency || input.accountId !== p.accountId) throw conflict("The refund amount, currency or account does not match this purchase.");
    if (!["paid", "redeemed"].includes(p.status)) throw conflict("Only paid purchases can be refunded.");
    const observed = await provider.inspectCapture(p.orderRef, p.paymentRef, { reference: p.id, amountMinor: p.amountMinor, currency: p.currency });
    if (observed.pendingMinor > 0) throw conflict("PayPal has a pending refund for this capture. Wait for its authoritative outcome before another request.");
    const t = Date.now(), operationId = randomUUID();
    const reserved = await this.billing.rows.write(w => {
      const duplicate = w.get<AdminRefundRow>("billing_admin_refunds", { request_key: input.requestKey });
      if (duplicate) {
        if (duplicate.purchase_id !== purchaseId || duplicate.amount_minor !== input.amountMinor || duplicate.currency !== input.currency || duplicate.account_id !== input.accountId) throw conflict("This operation identity belongs to a different refund.");
        return duplicate;
      }
      const current = this.purchase(purchaseId, w);
      if (!["paid", "redeemed"].includes(current.status) || current.paymentRef !== p.paymentRef || current.accountId !== p.accountId || current.amountMinor !== p.amountMinor) throw conflict("The payment changed. Reload before refunding.");
      const history = this.operations(p.id, w);
      for (const r of history) this.sameEnvironment(r, provider);
      if (history.length >= 100) throw conflict("This payment has reached the bounded refund-operation limit; review it with the provider.");
      if (this.legacy(p.id, w)) throw conflict("A legacy refund already exists. Review its provider outcome before any additional refund.");
      if (history.some(r => UNSETTLED.includes(r.status))) throw conflict("A refund is pending or uncertain for this payment. Reconcile it before requesting another.");
      if (input.amountMinor > this.remaining(p, observed.refundedMinor, w).remainingMinor) throw conflict("The requested amount exceeds the remaining refundable balance.");
      const r: AdminRefundRow = { id: operationId, request_key: input.requestKey, provider: "paypal", provider_mode: provider.mode, merchant_id: provider.merchantId, purchase_kind: p.kind,
        purchase_id: p.id, account_id: p.accountId, order_ref: p.orderRef, payment_ref: p.paymentRef, currency: p.currency, amount_minor: input.amountMinor, captured_minor: p.amountMinor,
        baseline_refunded_minor: observed.refundedMinor, actor_account_id: actor, reason: input.reason, status: "reserved", provider_ref: null, last_error: null, created_at: t, updated_at: t };
      w.insert("billing_admin_refunds", { ...r });
      return r;
    });
    if (reserved.id !== operationId) return this.view(reserved);
    try { await beforeSend(reserved); }
    catch (e) {
      await this.billing.rows.write(w => w.update("billing_admin_refunds", { id: operationId, status: "reserved" }, { status: "failed", last_error: "Authorization or audit persistence failed before dispatch. No financial request was sent.", updated_at: Date.now() }));
      throw e;
    }
    // Persist dispatch BEFORE external I/O. A crash here leaves an uncertain reservation, never an automatic new POST.
    const claimed = await this.billing.rows.write(w => w.update("billing_admin_refunds", { id: operationId, status: "reserved" }, { status: "submitting", updated_at: Date.now() }));
    if (!claimed) return this.view(this.billing.rows.get<AdminRefundRow>("billing_admin_refunds", { id: operationId })!);
    try {
      const result = await provider.createAdminRefund(p.paymentRef, operationId, input.amountMinor);
      await this.billing.rows.write(w => w.update("billing_admin_refunds", { id: operationId }, { status: "pending", provider_ref: result.id, updated_at: Date.now() }));
      return await this.reconcile(operationId);
    } catch (e) {
      await this.billing.rows.write(w => w.update("billing_admin_refunds", { id: operationId, status: { in: ["submitting", "pending"] } }, { status: e instanceof PayPalRefundRejected ? "failed" : "uncertain", last_error: e instanceof PayPalRefundRejected ? e.message : "PayPal acceptance or local completion is uncertain. Reconcile this operation; do not issue another refund.", updated_at: Date.now() }));
      return this.view(this.billing.rows.get<AdminRefundRow>("billing_admin_refunds", { id: operationId })!);
    }
  }

  /** Read-only provider recovery. Neither a missing response nor a caller-provided ref can authorize another money movement. */
  async reconcile(id: string, suggestedProviderRef?: string) {
    const provider = this.provider(), r = this.billing.rows.get<AdminRefundRow>("billing_admin_refunds", { id });
    if (!r) throw notFound("Refund operation not found");
    this.sameEnvironment(r, provider);
    if (r.status === "reserved") {
      // Dispatch requires an atomic reserved -> submitting claim. Releasing only reserved cannot race a money request.
      await this.billing.rows.write(w => w.update("billing_admin_refunds", { id, status: "reserved" }, { status: "failed", last_error: "Reservation released before dispatch. No financial request was sent; a new reviewed operation may be created.", updated_at: Date.now() }));
      return this.view(this.billing.rows.get<AdminRefundRow>("billing_admin_refunds", { id })!);
    }
    const p = this.purchase(r.purchase_id);
    if (p.accountId !== r.account_id || p.orderRef !== r.order_ref || p.paymentRef !== r.payment_ref || p.amountMinor !== r.captured_minor) throw conflict("The purchase no longer matches its original refund operation.");
    const observed = await provider.inspectCapture(r.order_ref, r.payment_ref, { reference: r.purchase_id, amountMinor: r.captured_minor, currency: r.currency });
    const refs = r.provider_ref ? [r.provider_ref] : suggestedProviderRef ? [suggestedProviderRef] : observed.refundRefs;
    let matched: { id: string; status: string } | null = null;
    for (const candidate of refs) {
      try { matched = await provider.readAdminRefund(candidate, { operationId: r.id, paymentRef: r.payment_ref, amountMinor: r.amount_minor }); break; }
      catch (e) { if (r.provider_ref || suggestedProviderRef) throw e; }
    }
    if (!matched) {
      if (r.status !== "failed" && r.status !== "completed") await this.billing.rows.write(w => w.update("billing_admin_refunds", { id }, { status: "uncertain", last_error: "No matching refund was returned by PayPal. Its acceptance is still unknown; check the provider console with this operation ID.", updated_at: Date.now() }));
      return this.view(this.billing.rows.get<AdminRefundRow>("billing_admin_refunds", { id })!);
    }
    const status: RefundStatus = matched.status === "COMPLETED" ? "completed" : ["FAILED", "CANCELLED"].includes(matched.status) ? "failed" : "pending";
    if (r.status === "completed" && status !== "completed") throw conflict("PayPal returned a regressing refund state. Keep the completed record for investigation.");
    if (status === "completed") {
      const total = Math.max(observed.refundedMinor, r.baseline_refunded_minor + r.amount_minor);
      if (total > r.captured_minor) throw conflict("PayPal refund total exceeds the captured amount.");
      const applied = await this.billing.webhooks.ingest("paypal", { ref: `admin-refund:${id}:${total}`, type: "MELDIQ.ADMIN.REFUND.VERIFIED", createdAt: Date.now(), kind: "payment", payment: {
        kind: "refund", ref: matched.id, paymentRef: r.payment_ref, orderRef: r.order_ref, purchaseRef: r.purchase_id, customerRef: null, currency: r.currency,
        amountMinor: r.captured_minor, affectedMinor: total, state: total === r.captured_minor ? "refunded" : "partially_refunded",
      } });
      if (applied.status !== "processed") throw new ApiError(503, "unavailable", "PayPal confirmed the refund, but local entitlement processing needs recovery in Provider events.");
    }
    await this.billing.rows.write(w => w.update("billing_admin_refunds", { id }, { status, provider_ref: matched!.id, last_error: status === "failed" ? "PayPal confirmed that this refund failed or was cancelled." : null, updated_at: Date.now() }));
    return this.view(this.billing.rows.get<AdminRefundRow>("billing_admin_refunds", { id })!);
  }
}
