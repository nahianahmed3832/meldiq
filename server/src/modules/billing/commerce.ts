import { newId } from "../../shared/utilities/util.js";
import { notFound } from "../../shared/errors.js";
import type { Billing } from "./service.js";
import { PayPalCheckout } from "./paypalCheckout.js";
export interface CommerceOrder { id: string; account_id: string; product: string; product_ref: string; subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number; currency: string; coupon_id: string | null; tax_status: string; provider: string; purchase_ref: string; status: string; entitlement_status: string; metadata: string; created_at: number; updated_at: number }
/** A projection of existing verified purchases, not a second payment or entitlement writer. Prices freeze on first observation. */
export class Commerce {
 constructor(private readonly billing: Billing, private readonly clock: () => number = Date.now) {}
 async refresh(accountId?: string) {
  const records: { id: string; userId: string | null; customer: string | null; product: string; currency: string; amountMinor: number; provider: string; providerRef: string | null; status: string; refundStatus: string; createdAt: number; completedAt: number | null; refundable: boolean }[] = PayPalCheckout.records(this.billing, accountId);
  const invoices = this.billing.rows.all<{ id: string; subscription_id: string; provider_invoice_ref: string; currency: string; amount_due_minor: number; amount_paid_minor: number; amount_refunded_minor: number; issued_at: number; paid_at: number | null; status: string }>("billing_invoices", { where: { provider: "paypal_card" }, orderBy: [["issued_at", "desc"]], limit: 100 });
  for (const invoice of invoices) {
   const sub = this.billing.subscriptions.get(invoice.subscription_id); const customer = sub?.billing_account_id ?? sub?.account_id;
   if (!customer || accountId && customer !== accountId) continue;
   records.push({ id: invoice.id, userId: sub?.billing_user_id ?? null, customer, product: sub?.org_id ? "Meldiq Bots+" : "Meldiq Plus", currency: invoice.currency, amountMinor: invoice.amount_paid_minor || invoice.amount_due_minor, provider: "paypal_card", providerRef: invoice.provider_invoice_ref, status: invoice.status, refundStatus: invoice.amount_refunded_minor ? "refunded" : "none", createdAt: invoice.issued_at, completedAt: invoice.paid_at, refundable: false });
  }
  await this.billing.rows.write(w => {
   for (const r of records) {
    const sub = this.billing.rows.get<{ subscription_id: string }>("billing_invoices", { id: r.id });
    const subscription = sub && this.billing.subscriptions.get(sub.subscription_id);
    const customer = accountId ?? subscription?.billing_account_id ?? r.customer;
    if (!customer) continue;
    const isPaid = ["paid", "redeemed"].includes(r.status); const refunded = r.status === "refunded" || r.refundStatus === "refunded";
    const status = refunded ? "refunded" : r.status;
    const existing = w.get<CommerceOrder>("billing_commerce_orders", { purchase_ref: r.id });
    // Refunds do not rewrite the original gross amount or quietly claim an entitlement was removed.
    const fields = { status, entitlement_status: isPaid ? r.product.includes("gift") ? "gift_available_or_redeemed" : "verified" : refunded ? "refund_policy_applies" : "pending", metadata: JSON.stringify({ providerReference: r.providerRef, completedAt: r.completedAt, refundStatus: r.refundStatus }), updated_at: this.clock() };
    if (existing) { if (existing.account_id !== customer || existing.currency !== r.currency || existing.total_minor !== r.amountMinor) throw new Error("Commerce purchase projection changed immutable terms"); w.update("billing_commerce_orders", { id: existing.id }, fields); }
    else w.insert("billing_commerce_orders", { id: newId("ord"), account_id: customer, product: r.product, product_ref: r.id, subtotal_minor: r.amountMinor, discount_minor: 0, tax_minor: 0, total_minor: r.amountMinor, currency: r.currency, coupon_id: null, tax_status: "not_collected", provider: r.provider, purchase_ref: r.id, created_at: r.createdAt, ...fields });
   }
  });
 }
 private view(o: CommerceOrder) { const meta = JSON.parse(o.metadata) as { providerReference?: string | null; completedAt?: number | null; refundStatus?: string }; return { id: o.id, product: o.product, subtotalMinor: o.subtotal_minor, discountMinor: o.discount_minor, taxMinor: o.tax_minor, totalMinor: o.total_minor, currency: o.currency, taxStatus: o.tax_status, provider: o.provider, status: o.status, entitlementStatus: o.entitlement_status, createdAt: o.created_at, completedAt: meta.completedAt ?? null, providerReference: meta.providerReference ?? null, refundStatus: meta.refundStatus ?? "none" }; }
 list(accountId: string) { return this.billing.rows.all<CommerceOrder>("billing_commerce_orders", { where: { account_id: accountId }, orderBy: [["created_at", "desc"]], limit: 100 }).map(o => this.view(o)); }
 receipt(accountId: string, id: string) { const o = this.billing.rows.get<CommerceOrder>("billing_commerce_orders", { id, account_id: accountId }); if (!o) throw notFound("Order not found"); return { ...this.view(o), receiptNumber: o.id, paid: ["paid", "redeemed", "refunded"].includes(o.status), seller: "Meldiq", statement: "This receipt records the payment status verified by Meldiq. Provider conversion fees are separate. Tax was not collected on this order." }; }
 admin() { return this.billing.rows.all<CommerceOrder>("billing_commerce_orders", { orderBy: [["created_at", "desc"]], limit: 100 }).map(o => ({ ...this.view(o), accountId: o.account_id })); }
}
