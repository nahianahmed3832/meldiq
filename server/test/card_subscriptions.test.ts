import { CardMandatePage, CardMandateDetail, CardMandateView, CardRecoveryResult } from "../src/shared/contracts/http/adminRefunds.js";
import { ADMIN_ORIGIN, consoleAdmin, type ConsoleAdmin } from "./support/adminConsole.js";
import { parseMinor } from "../src/modules/billing/money.js";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";
import type { PayPalApi } from "../src/modules/billing/providers/paypalApi.js";
import { SecretBox } from "../src/infrastructure/crypto/secretBox.js";
import { CardVault } from "../src/modules/billing/cardVault.js";
import { CardSubscriptions } from "../src/modules/billing/cardSubscriptions.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { startServer, type Harness } from "./support/harness.js";
class CardApi implements PayPalApi {
 refunds = new Map<string, any>(); refundPosts = 0; orders = new Map<string, any>(); keys = new Map<string, any>(); captures = 0; uncertain = false; wrongAmount = false; decline = false;
 async request(method: string, path: string, raw?: unknown, key?: string): Promise<unknown> {
  if (key && this.keys.has(key)) return structuredClone(this.keys.get(key));
  const body = raw as any; let result: any;
  if (method === "POST" && path === "/v2/checkout/orders") {
   const id = `O${randomBytes(5).toString("hex")}`;
   expect(body.payment_source.card).toMatchObject({ stored_credential: { payment_initiator: "MERCHANT", payment_type: "RECURRING", usage: "SUBSEQUENT" } });
   result = { id, status: "APPROVED", purchase_units: body.purchase_units.map((u: any) => ({ ...u, payee: { merchant_id: "MERCHANT" } })), links: [] };
   this.orders.set(id, result);
   if (key) this.keys.set(key, structuredClone(result));
   if (this.uncertain) throw new Error("Response lost after order creation");
  } else if (method === "POST" && path.endsWith("/capture")) {
   const id = path.split("/").at(-2)!; result = this.orders.get(id)!;
   if (result.status !== "COMPLETED") { this.captures++; result.status = "COMPLETED"; result.purchase_units[0].payments = { captures: [{ id: `C${id}`, status: this.decline ? "DECLINED" : "COMPLETED", amount: this.wrongAmount ? { currency_code: "USD", value: "0.01" } : result.purchase_units[0].amount, create_time: new Date().toISOString() }] }; }
  } else if (method === "GET" && path.startsWith("/v2/payments/refunds/")) result = this.refunds.get(path.split("/").at(-1)!);
  else if (path.startsWith("/v2/payments/captures/")) {
    const capture = path.split("/")[4]!;
    const o = [...this.orders.values()].find(o => o.purchase_units[0].payments?.captures[0].id === capture);
    if (!o) throw new Error("Missing capture");
    if (method === "GET") result = o.purchase_units[0].payments.captures[0];
    else {
      this.refundPosts++;
      result = { id: `REF${this.refundPosts}`, custom_id: body.custom_id, amount: body.amount, status: "COMPLETED", links: [{ rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${capture}` }] };
      this.refunds.set(result.id, result); (o.purchase_units[0].payments.refunds ??= []).push(result);
      const total = o.purchase_units[0].payments.refunds.reduce((n: number, r: any) => n + parseMinor(r.amount.value, 2), 0);
      o.purchase_units[0].payments.captures[0].status = total === parseMinor(o.purchase_units[0].amount.value, 2) ? "REFUNDED" : "PARTIALLY_REFUNDED";
    }
  } else if (method === "GET" && path.startsWith("/v2/checkout/orders/")) result = this.orders.get(path.split("/").at(-1)!);
  else throw new Error("Unexpected test API call");
  if (key) this.keys.set(key, structuredClone(result)); return structuredClone(result);
 }
}
describe("card renewal lifecycle with isolated provider boundary", () => {
 let h: Harness, admin: ConsoleAdmin, auditor: ConsoleAdmin; const api = new CardApi(); const mailer = new MemoryMailer(); const secretKey = randomBytes(32); let now = Date.parse("2027-01-31T12:00:00Z"); let service: CardSubscriptions;
 const provider = new PayPalProvider({ environment: "sandbox", clientId: "test", clientSecret: "private", webhookId: "hook", merchantId: "MERCHANT", plusPlanId: "P-PLUS", subscriptionsApproved: true, api, cardCapabilities: { oneTime: true, vault: true, recurring: true, merchantCountry: "CN", productionApproved: false, reason: null } });
 beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, PLATFORM_SECRETS_KEY: secretKey.toString("hex"), WORKFLOW_TICK_MS: "0" }, { mailer, billingProvider: provider });
  const v = await h.ctx.billing.catalog.create("plus", { name: "Plus", description: "Plus", segment: "personal", public: true, audience: "personal" }, { interval: "month", currency: "USD", amountMinor: 499, providerPriceRef: "P-PLUS", trialDays: 0, graceDays: 3, limits: {}, notes: "" }, "test", now);
  await h.ctx.billing.catalog.publish(v.id, "paypal", "test", now);
  service = new CardSubscriptions(h.ctx.billing, new CardVault(h.ctx.billing.rows, provider, new SecretBox(secretKey), "https://example.com/settings/billing", () => now), () => now);
  h.ctx.billing.cardSubscriptions = service;
  admin = await consoleAdmin(h, mailer, "billing_admin", "cardoperator");
  auditor = await consoleAdmin(h, mailer, "auditor", "cardreader");
 });
 afterAll(async () => h?.close());
 async function customer(name: string) {
  const c = await AccountClient.ready(h.baseUrl, mailer, name); const id = `pm_${name}`; const box = new SecretBox(secretKey);
  await h.ctx.billing.rows.write(w => w.insert("billing_payment_methods", { id, account_id: c.accountId, provider: "paypal", token_encrypted: box.seal("TOKEN", `billing-card:${c.accountId}:${id}:token`), customer_encrypted: box.seal("CUSTOMER", `billing-card:${c.accountId}:${id}:customer`), brand: "VISA", last_four: "1111", expiry: "2030-12", status: "active", created_at: now, updated_at: now }));
  return { c, id, input: { accountId: c.accountId, userId: c.userId, product: "plus" as const, paymentMethodId: id, requestKey: randomUUID(), consentVersion: service.quote("plus", c.accountId).consentVersion } };
 }
 it("charges once per period, preserves the monthly anchor and stops future payments after cancellation", async () => {
  const { c, id, input } = await customer("cardmonthly"); const captures = api.captures;
  const [a, b] = await Promise.all([service.start(input), service.start(input)]);
  expect(a.id).toBe(b.id); expect(api.captures - captures).toBe(1);
  expect(a.paidThrough).toBe(Date.parse("2027-02-28T12:00:00Z"));
  expect(h.ctx.billing.subscriptions.liveForOwner({ kind: "account", accountId: c.accountId })?.provider).toBe("paypal_card");
  await expect(service.vault.remove(c.accountId, id)).rejects.toThrow(/cancel/);
  now = Date.parse("2027-02-28T12:00:00Z"); await Promise.all([service.sweep(), service.sweep()]);
  const renewed = service.list(c.accountId)[0]; expect(renewed.paidThrough).toBe(Date.parse("2027-03-31T12:00:00Z")); expect(api.captures - captures).toBe(2);
  const canceled = await service.cancel(c.accountId, a.id); expect(canceled.cancelAt).toBe(now); expect(canceled.paidThrough).toBe(renewed.paidThrough);
  expect(h.ctx.billing.subscriptions.grants(h.ctx.billing.subscriptions.liveForOwner({ kind: "account", accountId: c.accountId })!, now)).toBe(true);
  now = Date.parse("2027-03-31T12:00:00Z"); await service.sweep(); expect(api.captures - captures).toBe(2); expect(service.list(c.accountId)[0].status).toBe("canceled");
 });
 it("does not grant from an ambiguous create response, retries the same operation and refuses a different owner's method", async () => {
  const { c, input } = await customer("carduncertain"); const outsider = await customer("cardoutsider");
  await expect(service.start({ ...input, paymentMethodId: outsider.id })).rejects.toThrow(/not found/);
  api.uncertain = true; const captures = api.captures; const pending = await service.start(input); api.uncertain = false;
  expect(pending.status).toBe("attention"); expect(pending.paidThrough).toBeNull(); expect(api.captures).toBe(captures);
  now += 300001; await service.sweep(); expect(service.list(c.accountId)[0].paidThrough).not.toBeNull(); expect(api.captures).toBe(captures + 1);
  expect(h.ctx.billing.rows.count("billing_card_charges", { mandate_id: pending.id })).toBe(1);
  await expect(service.cancel(outsider.c.accountId, pending.id)).rejects.toThrow(/not found/);
 });
 it("never grants a first-payment grace period after a verified decline and retries only after choosing another owned card", async () => {
  const { c, id, input } = await customer("carddeclined"); api.decline = true;
  const declined = await service.start(input); api.decline = false;
  expect(declined.status).toBe("past_due");
  const sub = h.ctx.billing.subscriptions.liveForOwner({ kind: "account", accountId: c.accountId })!;
  expect(sub.status).toBe("incomplete"); expect(h.ctx.billing.subscriptions.grants(sub, now)).toBe(false);
  const count = api.orders.size; await service.sweep(); expect(api.orders.size).toBe(count);
  await expect(service.updateMethod(c.accountId, declined.id, id)).rejects.toThrow(/different/);
  const alternative = id + "_alt"; const box = new SecretBox(secretKey);
  await h.ctx.billing.rows.write(w => w.insert("billing_payment_methods", { id: alternative, account_id: c.accountId, provider: "paypal", token_encrypted: box.seal("TOKEN-ALTERNATIVE", `billing-card:${c.accountId}:${alternative}:token`), customer_encrypted: box.seal("CUSTOMER", `billing-card:${c.accountId}:${alternative}:customer`), brand: "VISA", last_four: "2222", expiry: "2030-12", status: "active", created_at: now, updated_at: now }));
  const recovered = await service.updateMethod(c.accountId, declined.id, alternative);
  expect(recovered.status).toBe("active"); expect(recovered.paidThrough).not.toBeNull();
  expect(h.ctx.billing.rows.count("billing_card_charges", { mandate_id: declined.id })).toBe(1);
  expect(h.ctx.billing.rows.count("billing_card_charge_attempts")).toBe(1);
 });
 it("holds an old unknown order instead of creating a new charge after idempotency retention", async () => {
  const { c, input } = await customer("cardheld"); api.uncertain = true;
  const pending = await service.start(input); api.uncertain = false; const orders = api.orders.size;
  now += 5 * 3600000; await service.sweep(); expect(api.orders.size).toBe(orders); expect(service.list(c.accountId)[0].paidThrough).toBeNull();
  await service.cancel(c.accountId, pending.id); await service.sweep(); expect(api.orders.size).toBe(orders);
 });
 it("exposes safe keyset mandate/charge views, enforces permissions, and cancels without shortening paid time", async () => {
   const { c, input } = await customer("cardadmin"); const mandate = await service.start(input), captures = api.captures;
   const detail = CardMandateDetail.parse(await admin.browser.expect(200, "GET", `/admin/v1/billing/card-mandates/${mandate.id}`));
   expect(detail.mandate).toMatchObject({ accountId: c.accountId, mode: "test", card: { brand: "VISA", lastFour: "1111" } });
   expect(JSON.stringify(detail)).not.toMatch(/TOKEN|token_encrypted|customer_encrypted/);
   expect(detail.charges).toHaveLength(1);
   expect(CardMandatePage.parse(await admin.browser.expect(200, "GET", `/admin/v1/billing/card-mandates?account=${c.accountId}&limit=1`)).mandates[0]!.id).toBe(mandate.id);
   expect((await auditor.browser.req("POST", `/admin/v1/billing/card-mandates/${mandate.id}/cancel`, { reason: "Customer requested cancellation" })).status).toBe(403);
   const canceled = CardMandateView.parse(await admin.browser.expect(200, "POST", `/admin/v1/billing/card-mandates/${mandate.id}/cancel`, { reason: "Customer requested cancellation" }));
   expect(canceled.paidThrough).toBe(mandate.paidThrough); expect(canceled.cancelAt).not.toBeNull(); expect(canceled.nextBillingAt).toBeNull(); expect(api.captures).toBe(captures);
   expect(h.ctx.billing.subscriptions.grants(h.ctx.billing.subscriptions.liveForOwner({ kind: "account", accountId: c.accountId })!, now)).toBe(true);
 });
 it("recovers a lost order response after cancellation through verified reads, never creating or capturing another charge", async () => {
   const { c, input } = await customer("cardadminrecover"); api.uncertain = true; const mandate = await service.start(input); api.uncertain = false;
   const charge = h.ctx.billing.rows.get<{ id: string }>("billing_card_charges", { mandate_id: mandate.id })!;
   const order = [...api.orders.values()].find(o => o.purchase_units[0].custom_id === charge.id)!;
   now += 5 * 3600000; await service.cancel(c.accountId, mandate.id);
   expect((await admin.browser.req("POST", `/admin/v1/billing/card-charges/${charge.id}/reconcile`, { confirm: true, reason: "Investigate unknown acceptance" })).status).toBe(409);
   const other = [...api.orders.values()].find(o => o.id !== order.id)!;
   expect((await admin.browser.req("POST", `/admin/v1/billing/card-charges/${charge.id}/reconcile`, { confirm: true, reason: "Verify supplied order binding", orderRef: other.id })).status).toBe(409);
   const before = api.captures, orders = api.orders.size;
   const unresolved = CardRecoveryResult.parse(await admin.browser.expect(200, "POST", `/admin/v1/billing/card-charges/${charge.id}/reconcile`, { confirm: true, reason: "Read the original provider order", orderRef: order.id }));
   expect(unresolved.status).toBe("attention"); expect(api.captures).toBe(before); expect(api.orders.size).toBe(orders);
   // Simulate a previously in-flight provider capture settling independently of the administrator.
   await api.request("POST", `/v2/checkout/orders/${order.id}/capture`);
   const settled = CardRecoveryResult.parse(await admin.browser.expect(200, "POST", `/admin/v1/billing/card-charges/${charge.id}/reconcile`, { confirm: true, reason: "Confirm late provider settlement" }));
   expect(settled.status).toBe("paid"); expect(api.captures).toBe(before + 1); expect(api.orders.size).toBe(orders);
   const updated = service.list(c.accountId)[0]!; expect(updated.cancelAt).not.toBeNull(); expect(updated.paidThrough).not.toBeNull();
   await service.reconcileCharge(charge.id); expect(api.captures).toBe(before + 1);
 });
 it("records partial card capture refunds without changing access, then applies the existing full-current-period policy", async () => {
   now = Date.now(); // Align this real HTTP/event processor case with its clock; earlier tests deliberately advance a renewal clock.
   const { c, input } = await customer("cardrefund"); const mandate = await service.start(input);
   const charge = h.ctx.billing.rows.get<{ id: string; provider_capture_ref: string }>("billing_card_charges", { mandate_id: mandate.id })!;
   const refund = (amountMinor: number) => h.ctx.billing.adminRefunds.request(charge.id, { requestKey: randomUUID(), amountMinor, currency: "USD", accountId: c.accountId, reason: "Refund current paid period" }, admin.account.accountId, async () => {});
   expect((await refund(199)).status).toBe("completed");
   expect(h.ctx.billing.rows.get<{ amount_refunded_minor: number }>("billing_invoices", { provider: "paypal_card", provider_invoice_ref: charge.provider_capture_ref })?.amount_refunded_minor).toBe(199);
   expect(service.list(c.accountId)[0]!.status).toBe("active");
   expect((await refund(300)).status).toBe("completed"); expect(service.list(c.accountId)[0]!.status).toBe("paused");
   const sub = h.ctx.billing.rows.get<{ status: string }>("billing_subscriptions", { provider: "paypal_card", provider_subscription_ref: mandate.id }); expect(sub?.status).toBe("paused");
 });

});
