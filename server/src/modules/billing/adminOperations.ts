import type { Billing } from "./service.js";
import type { After } from "./admin.js";
import type { AdminRefundRow } from "./adminRefunds.js";
import type { CardMandate, CardCharge } from "./cardSubscriptions.js";
import { notFound } from "../../shared/errors.js";
import type { Where } from "../../infrastructure/database/rows/index.js";

const keyset = (after?: After, time = "created_at"): Where => after ? { $or: [{ [time]: { lt: after.createdAt } }, { [time]: after.createdAt, id: { lt: after.id } }] } : {};
type Query = { account?: string; status?: string; after?: After; limit: number };

/** Billing-owned records for admin orchestration. Permissions and audit remain at the central-admin boundary. */
export class AdminBillingRecords {
  constructor(private readonly billing: Billing) {}
  refundRows(q: Query) {
    return this.billing.rows.all<AdminRefundRow>("billing_admin_refunds", { where: { ...(q.status ? { status: q.status } : {}), ...(q.account ? { account_id: q.account } : {}), ...keyset(q.after) }, orderBy: [["created_at", "desc"], ["id", "desc"]], limit: q.limit + 1 });
  }
  paymentRows(q: Query & { kind?: string }) {
    type Payment = { id: string; kind: string; accountId: string | null; userId: string | null; subscriptionId: string | null; amountMinor: number; currency: string; status: string; providerRef: string | null; created_at: number; createdAt: number; canReviewRefund: boolean };
    const all: Payment[] = [];
    for (const [table, kind, accountColumn, time] of [["mojo_gifts", "gift", "buyer_account_id", "created_at"], ["spark_purchases", "spark", "buyer_account_id", "created_at"], ["collectible_orders", "collectible", "account_id", "created_at"], ["billing_invoices", "invoice", "account_id", "issued_at"]]) {
      if (q.kind && kind !== q.kind) continue;
      const records = this.billing.rows.all<Record<string, string | number | null>>(table!, { where: { provider: "paypal", ...(q.account ? { [accountColumn!]: q.account } : {}), ...(q.status ? { status: q.status } : {}), ...keyset(q.after, time!) }, orderBy: [[time!, "desc"], ["id", "desc"]], limit: q.limit + 1 });
      for (const r of records) all.push({ id: String(r.id), kind: kind!, accountId: r[accountColumn!] as string | null, userId: (r.buyer_user_id ?? r.user_id ?? null) as string | null, subscriptionId: r.subscription_id as string | null ?? null,
        amountMinor: Number(r.amount_minor ?? r.amount_paid_minor ?? r.amount_due_minor), currency: String(r.currency), status: String(r.status), providerRef: (r.provider_payment_ref ?? r.payment_ref ?? r.provider_invoice_ref ?? r.provider_session_ref ?? r.session_ref ?? null) as string | null,
        created_at: Number(r[time!]), createdAt: Number(r[time!]), canReviewRefund: kind !== "invoice" && !!(r.provider_payment_ref ?? r.payment_ref) });
    }
    all.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return all.slice(0, q.limit + 1);
  }
  cardView(m: CardMandate) {
    const method = this.billing.rows.get<{ brand: string | null; last_four: string | null; expiry: string | null }>("billing_payment_methods", { id: m.payment_method_id, account_id: m.account_id });
    const sub = this.billing.rows.get<{ id: string }>("billing_subscriptions", { provider: "paypal_card", provider_subscription_ref: m.id });
    return { id: m.id, accountId: m.account_id, userId: m.user_id, orgId: m.org_id, subscriptionId: sub?.id ?? null, product: m.org_id ? "bots_plus" : "plus", status: m.status, currency: m.currency, amountMinor: m.amount_minor,
      mode: m.provider_mode === "test" || m.provider_mode === "live" ? m.provider_mode : null, createdAt: m.created_at, updatedAt: m.updated_at, nextBillingAt: m.cancel_at ? null : m.next_billing_at, paidThrough: m.paid_through, cancelAt: m.cancel_at,
      consentVersion: m.consent_version, consentAt: m.consent_at, card: method ? { brand: method.brand, lastFour: method.last_four, expiry: method.expiry } : null };
  }
  cardRows(q: Query) {
    return this.billing.rows.all<CardMandate>("billing_card_mandates", { where: { ...(q.account ? { account_id: q.account } : {}), ...(q.status ? { status: q.status } : {}), ...keyset(q.after) }, orderBy: [["created_at", "desc"], ["id", "desc"]], limit: q.limit + 1 });
  }
  cardMandate(id: string) {
    const m = this.billing.rows.get<CardMandate>("billing_card_mandates", { id });
    if (!m) throw notFound("Card mandate not found");
    return m;
  }
  chargeRows(id: string, q: { after?: After; limit: number }) {
    return this.billing.rows.all<CardCharge>("billing_card_charges", { where: { mandate_id: id, ...keyset(q.after) }, orderBy: [["created_at", "desc"], ["id", "desc"]], limit: q.limit + 1 });
  }
  cancellationOperation(id: string) {
    const s = this.billing.subscriptions.get(id);
    if (!s) throw notFound("Subscription not found");
    const operationId = `admin-cancel:${id}`, op = this.billing.rows.get<{ status: string }>("billing_payment_actions", { id: operationId });
    return op ? { confirmed: op.status === "completed", status: op.status, accessUntil: s.current_period_end, operationId } : null;
  }
  reserveCancellation(id: string, subscriptionRef: string, actor: string, reason: string, t: number) {
    return this.billing.rows.write(w => {
      // Only failed-before-dispatch operations are retryable; uncertain money/provider acceptance never is.
      if (w.update("billing_payment_actions", { id, status: "failed" }, { status: "reserved", updated_at: t })) return true;
      return w.insert("billing_payment_actions", { id, provider: "paypal", purchase_id: id, payment_ref: subscriptionRef, actor_account_id: actor, reason, status: "reserved", created_at: t, updated_at: t }, { orIgnore: true }).inserted;
    });
  }
  cancellationStatus(id: string) { return this.billing.rows.get<{ status: string }>("billing_payment_actions", { id })?.status; }
  claimCancellation(id: string, t: number) { return this.billing.rows.write(w => w.update("billing_payment_actions", { id, status: "reserved" }, { status: "submitting", updated_at: t })); }
  failCancellationBeforeDispatch(id: string, t: number) { return this.billing.rows.write(w => w.update("billing_payment_actions", { id, status: "submitting" }, { status: "failed", updated_at: t })); }
  finishCancellation(id: string, confirmed: boolean, providerRef: string, t: number) { return this.billing.rows.write(w => w.update("billing_payment_actions", { id }, { status: confirmed ? "completed" : "uncertain", provider_ref: providerRef, updated_at: t })); }
}
