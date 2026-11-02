import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { expect, it } from "vitest";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { startServer } from "./support/harness.js";

/** Explicit opt-in only. Uses throwaway Meldiq accounts and PayPal Sandbox; never production data or live credentials. */
it.skipIf(process.env.MELDIQ_RUN_PAYPAL_SANDBOX_LIFECYCLE !== "1")("captures a real Sandbox gift and atomically redeems its verified entitlement", async () => {
 if (process.env.PAYPAL_ENVIRONMENT !== "sandbox") throw new Error("This integration test refuses live mode");
 const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MERCHANT_ID, PAYPAL_SANDBOX_VAULT_FIXTURE } = process.env;
 if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_MERCHANT_ID || !PAYPAL_SANDBOX_VAULT_FIXTURE) throw new Error("Configure private Sandbox credentials and a hosted-SDK-approved test vault fixture");
 const fixture = JSON.parse(fs.readFileSync(PAYPAL_SANDBOX_VAULT_FIXTURE, "utf8")) as { token?: string; webhookId?: string };
 if (!fixture.token) throw new Error("Sandbox SDK card approval must complete first");
 const provider = new PayPalProvider({ environment: "sandbox", clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, webhookId: fixture.webhookId ?? "SANDBOX-ISOLATED", merchantId: PAYPAL_MERCHANT_ID, plusPlanId: "P-SANDBOX-TEST-ONE-TIME", subscriptionsApproved: true, giftsEnabled: true, cardCapabilities: { oneTime: true, vault: true, recurring: false, merchantCountry: "CN", productionApproved: false, reason: null } });
 const mailer = new MemoryMailer();
 const h = await startServer({ PLATFORM_SECRETS_KEY: randomBytes(32).toString("hex"), WORKFLOW_TICK_MS: "0", BILLING_RETURN_URL: "https://meldiq.test/settings/checkout", BILLING_WEB_RETURN_URL: "https://meldiq.test/settings/checkout" }, { mailer, billingProvider: provider });
 let capture: string | null = null;
 let orderRef: string | null = null;
 try {
  const v = await h.ctx.billing.catalog.create("plus", { name: "Meldiq Plus", description: "Isolated Sandbox only", segment: "personal", public: true, audience: "personal" }, { interval: "month", currency: "USD", amountMinor: 499, providerPriceRef: "P-SANDBOX-TEST-ONE-TIME", trialDays: 0, graceDays: 0, limits: {}, notes: "Sandbox lifecycle verification" }, "sandbox-test", Date.now());
  await h.ctx.billing.catalog.publish(v.id, "paypal", "sandbox-test", Date.now());
  const buyer = await AccountClient.ready(h.baseUrl, mailer, `sandboxbuyer${randomBytes(3).toString("hex")}`);
  const recipient = await AccountClient.ready(h.baseUrl, mailer, `sandboxfriend${randomBytes(3).toString("hex")}`);
  const purchase = await buyer.req("POST", "/v2/billing/paypal/checkouts", { product: "gift", recipient: { kind: "link" }, months: 1, note: "Sandbox lifecycle verification", requestKey: randomUUID() });
  orderRef = purchase.providerRef;
  expect(purchase.amountMinor).toBe(499); expect(purchase.confirmed).toBe(false);
  await provider.api.request("POST", `/v2/checkout/orders/${purchase.providerRef}/confirm-payment-source`, { payment_source: { card: { vault_id: fixture.token, stored_credential: { payment_initiator: "CUSTOMER", payment_type: "UNSCHEDULED", usage: "SUBSEQUENT" } } } }, `sandbox-gift-approve-${purchase.id}`);
  const paid = await buyer.req("POST", `/v2/billing/paypal/checkouts/${purchase.id}/confirm`, {});
  expect(paid.confirmed).toBe(true);
  capture = h.ctx.gifts.get(purchase.id)?.provider_payment_ref ?? null;
  expect(capture).toBeTruthy();
  const shared = await buyer.req("POST", `/v2/billing/gifts/${purchase.id}/link`, {});
  const token = new URLSearchParams(new URL(shared.url).hash.slice(1)).get("gift");
  const a = await recipient.req("POST", "/v2/billing/gifts/redeem", { token });
  const b = await recipient.req("POST", "/v2/billing/gifts/redeem", { token });
  expect(a).toEqual(b); expect(a.credited).toBe(false); expect(a.endsAt).toBeGreaterThan(Date.now());
  expect(h.ctx.billing.rows.count("billing_grants", { source: "gift", reference: purchase.id })).toBe(1);
  const orders = await buyer.req("GET", "/v2/billing/orders");
  expect(orders.orders.some((order: { totalMinor: number; status: string }) => order.totalMinor === 499 && order.status === "redeemed")).toBe(true);
 } finally {
  if (!capture && orderRef) { try { const snapshot = await provider.readOrder(orderRef); if (snapshot.paid) capture = snapshot.paymentRef ?? null; } catch { /* Keep original test refusal; no unverified refund is attempted. */ } }
  if (capture) { const refund = await provider.refundCapture(capture, `sandbox-gift-cleanup-${capture}`); expect(refund.status).toBe("COMPLETED"); }
  await h.close();
 }
}, 120000);
