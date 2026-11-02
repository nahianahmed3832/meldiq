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
 orders = new Map<string, any>(); keys = new Map<string, any>(); captures = 0; uncertain = false; wrongAmount = false; decline = false;
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
  } else if (method === "GET" && path.startsWith("/v2/checkout/orders/")) result = this.orders.get(path.split("/").at(-1)!);
  else throw new Error("Unexpected test API call");
  if (key) this.keys.set(key, structuredClone(result)); return structuredClone(result);
 }
}
describe("card renewal lifecycle with isolated provider boundary", () => {
 let h: Harness; const api = new CardApi(); const mailer = new MemoryMailer(); const secretKey = randomBytes(32); let now = Date.parse("2027-01-31T12:00:00Z"); let service: CardSubscriptions;
 const provider = new PayPalProvider({ environment: "sandbox", clientId: "test", clientSecret: "private", webhookId: "hook", merchantId: "MERCHANT", plusPlanId: "P-PLUS", subscriptionsApproved: true, api, cardCapabilities: { oneTime: true, vault: true, recurring: true, merchantCountry: "CN", productionApproved: false, reason: null } });
 beforeAll(async () => {
  h = await startServer({ PLATFORM_SECRETS_KEY: secretKey.toString("hex"), WORKFLOW_TICK_MS: "0" }, { mailer, billingProvider: provider });
  const v = await h.ctx.billing.catalog.create("plus", { name: "Plus", description: "Plus", segment: "personal", public: true, audience: "personal" }, { interval: "month", currency: "USD", amountMinor: 499, providerPriceRef: "P-PLUS", trialDays: 0, graceDays: 3, limits: {}, notes: "" }, "test", now);
  await h.ctx.billing.catalog.publish(v.id, "paypal", "test", now);
  service = new CardSubscriptions(h.ctx.billing, new CardVault(h.ctx.billing.rows, provider, new SecretBox(secretKey), "https://example.com/settings/billing", () => now), () => now);
  h.ctx.billing.cardSubscriptions = service;
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
});
