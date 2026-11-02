import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import type { Mailer } from "../../infrastructure/mail/mailer.js";
import { commerceMail } from "../../infrastructure/mail/commerceMail.js";
import { newId } from "../../shared/utilities/util.js";
export type BillingNotice = "payment_receipt" | "payment_failed" | "renewal_canceled" | "gift_redeemed" | "payment_refunded" | "renewal_reminder";
interface Job { id: string; account_id: string; resource_id: string; kind: BillingNotice; status: string; attempts: number; lease_until: number | null }
const kinds: BillingNotice[] = ["payment_receipt", "payment_failed", "renewal_canceled", "gift_redeemed", "payment_refunded", "renewal_reminder"];
/** A durable outbox. Messages are composed from current owned billing records; no email addresses or links are queued. */
export class BillingNotifications {
 constructor(private readonly rows: Rows, private readonly mailer: Mailer, private readonly account: (id: string) => Promise<{ email: string; email_verified_at: number | null } | null | undefined>, private readonly webUrl: string, private readonly clock: () => number = Date.now, private readonly startedAt = Date.now()) {}
 queue(w: RowWriter, accountId: string | null, kind: BillingNotice, resourceId: string, t: number, occurrence = "") {
  if (!accountId || !this.mailer.available || t < this.startedAt) return;
  w.insert("billing_notification_jobs", { id: newId("bnj"), dedupe_key: `billing:${kind}:${accountId}:${resourceId}:${occurrence}`, account_id: accountId, gift_id: null, kind, resource_id: resourceId, status: "pending", attempts: 0, lease_until: null, next_attempt_at: this.clock(), created_at: this.clock(), sent_at: null, last_error: null }, { orIgnore: true });
 }
 private content(j: Job) {
  const gift = this.rows.get<{ buyer_account_id: string; amount_minor: number; currency: string; months: number; status: string }>("mojo_gifts", { id: j.resource_id });
  const spark = this.rows.get<{ buyer_account_id: string; amount_minor: number; currency: string; quantity: number; status: string }>("spark_purchases", { id: j.resource_id });
  const invoice = this.rows.get<{ amount_paid_minor: number; currency: string; subscription_id: string; status: string }>("billing_invoices", { provider_invoice_ref: j.resource_id });
  const subscription = this.rows.get<{ billing_account_id: string | null; account_id: string | null; current_period_end: number | null; cancel_at_period_end: number; status: string }>("billing_subscriptions", { id: invoice?.subscription_id ?? j.resource_id });
  const paid = gift?.buyer_account_id === j.account_id ? { amount: gift.amount_minor, currency: gift.currency, product: `Plus gift · ${gift.months} months` } : spark?.buyer_account_id === j.account_id ? { amount: spark.amount_minor, currency: spark.currency, product: `${spark.quantity} Meldiq Sparks` } : invoice && (subscription?.billing_account_id === j.account_id || subscription?.account_id === j.account_id) ? { amount: invoice.amount_paid_minor, currency: invoice.currency, product: "Meldiq subscription" } : null;
  const action = { text: j.kind === "gift_redeemed" ? "View gifts" : "View billing", url: new URL(j.kind === "gift_redeemed" ? "/settings/gifts" : "/settings/billing", this.webUrl).href };
  if (j.kind === "payment_receipt") {
   if (!paid) throw new Error("Receipt source unavailable");
   return { subject: "Your Meldiq payment receipt", ...commerceMail("Payment confirmed", [paid.product, new Intl.NumberFormat("en", { style: "currency", currency: paid.currency }).format(paid.amount / 100), `Reference: ${j.resource_id}`, "Your payment has been verified. Open Billing for the order, receipt and current entitlement status."], action) };
  }
  if (j.kind === "renewal_reminder") return { subject: "Your Meldiq renewal is coming up", ...commerceMail("Upcoming renewal", [subscription?.current_period_end ? `Your next subscription period starts ${new Date(subscription.current_period_end).toISOString().slice(0,10)}.` : "Your next subscription period is coming up.", "Open Billing to review the amount and payment method, or cancel before the renewal."], action) };
  if (j.kind === "renewal_canceled") return { subject: "Meldiq renewal canceled", ...commerceMail("Renewal canceled", ["Future renewals have been canceled.", subscription?.current_period_end ? `Your verified paid time continues until ${new Date(subscription.current_period_end).toISOString().slice(0,10)}.` : "Any existing free Plus time remains separate from billing.", "A payment already in progress may still complete; check Billing for its verified status."], action) };
  if (j.kind === "gift_redeemed") return { subject: "Meldiq gift redeemed", ...commerceMail("Gift redeemed", ["Your gift has been redeemed. Gift time follows existing Plus time, or stays as credit until an ongoing renewal ends. Redeeming a gift never starts a recurring payment."], action) };
  if (j.kind === "payment_refunded") return { subject: "Meldiq payment updated", ...commerceMail("Payment refunded", ["PayPal has verified a refund. Open Billing to view the transaction and current access under the product's refund policy."], action) };
  return { subject: "Meldiq payment needs attention", ...commerceMail("Payment needs attention", ["Your payment could not be completed. Open Billing to check its verified status and update your payment method. Do not start another purchase while a payment remains unresolved."], action) };
 }
 async sweep() {
  if (!this.mailer.available) return 0; const t = this.clock(); let sent = 0;
  for (const sub of this.rows.all<{ id: string; account_id: string | null; billing_account_id: string | null; current_period_end: number }>("billing_subscriptions", { where: { provider: { in: ["paypal", "paypal_card"] }, status: "active", cancel_at_period_end: 0, current_period_end: { gt: t, lte: t + 86400000 } }, limit: 100 })) await this.rows.write(w => this.queue(w, sub.billing_account_id ?? sub.account_id, "renewal_reminder", sub.id, t, String(sub.current_period_end)));
  const due = this.rows.all<Job>("billing_notification_jobs", { where: { kind: { in: kinds }, status: { in: ["pending", "failed", "sending"] }, next_attempt_at: { lte: t }, $or: [{ lease_until: null }, { lease_until: { lte: t } }] }, limit: 20 });
  for (const job of due) {
   const claimed = await this.rows.write(w => { const current = w.get<Job>("billing_notification_jobs", { id: job.id }); if (!current || !["pending", "failed", "sending"].includes(current.status) || current.lease_until && current.lease_until > t) return null; w.update("billing_notification_jobs", { id: job.id }, { status: "sending", lease_until: t + 120000, attempts: current.attempts + 1 }); return { ...current, attempts: current.attempts + 1 }; });
   if (!claimed) continue;
   try {
    const account = await this.account(claimed.account_id);
    if (!account?.email_verified_at) { await this.rows.write(w => w.update("billing_notification_jobs", { id: job.id }, { status: "canceled", lease_until: null })); continue; }
    if (claimed.kind === "renewal_reminder" && !this.rows.get("billing_subscriptions", { id: claimed.resource_id, status: "active", cancel_at_period_end: 0, current_period_end: { gt: this.clock() } })) { await this.rows.write(w => w.update("billing_notification_jobs", { id: job.id }, { status: "canceled", lease_until: null })); continue; }
    await this.mailer.send({ to: account.email, ...this.content(claimed) });
    await this.rows.write(w => w.update("billing_notification_jobs", { id: job.id }, { status: "sent", sent_at: this.clock(), lease_until: null })); sent++;
   } catch { await this.rows.write(w => w.update("billing_notification_jobs", { id: job.id }, { status: claimed.attempts >= 8 ? "blocked" : "failed", next_attempt_at: this.clock() + Math.min(3600000, 60000 * 2 ** claimed.attempts), lease_until: null, last_error: "billing_mail_failed" })); }
  }
  return sent;
 }
}
