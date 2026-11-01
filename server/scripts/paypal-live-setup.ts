/** Explicit operator setup. Never approves/captures a payment or changes an existing customer's subscription.
 * node --env-file=/private/paypal-live.env --import tsx scripts/paypal-live-setup.ts --live --env-file=/private/paypal-live.env
 */
import { readFileSync, writeFileSync, renameSync, chmodSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { HttpPayPalApi } from "../src/modules/billing/providers/paypalApi.js";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";

const file = process.argv.find((v) => v.startsWith("--env-file="))?.slice(11);
if (!process.argv.includes("--live") || process.env.PAYPAL_ENVIRONMENT !== "live" || !file)
  throw new Error("Explicit live environment and private --env-file path required");
if ((statSync(file).mode & 0o077) !== 0) throw new Error("Private environment must have permissions 0600");
const clientId = process.env.PAYPAL_CLIENT_ID!;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET!;
if (!clientId || !clientSecret) throw new Error("Configure credentials first");
const api = new HttpPayPalApi(clientId, clientSecret, "live");
const requestId = (kind: string) => createHash("sha256").update(`${clientId}:meldiq-live-v1:${kind}`).digest("hex").slice(0, 36);
const save = (key: string, value: string) => {
  if (!/^[A-Z_]+$/.test(key) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Unexpected resource identifier");
  let content = readFileSync(file, "utf8");
  content = new RegExp(`^${key}=.*$`, "m").test(content)
    ? content.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`;
  writeFileSync(`${file}.tmp`, content, { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
  process.env[key] = value;
};
let productId = process.env.PAYPAL_PLUS_PRODUCT_ID;
if (!productId) {
  const product = await api.request("POST", "/v1/catalogs/products", {
    name: "Meldiq Plus", description: "Meldiq Plus monthly subscription", type: "SERVICE", category: "SOFTWARE",
  }, requestId("product")) as { id: string };
  save("PAYPAL_PLUS_PRODUCT_ID", productId = product.id);
}
let plusPlanId = process.env.PAYPAL_PLUS_PLAN_ID;
if (!plusPlanId) {
  const plan = await api.request("POST", "/v1/billing/plans", {
    product_id: productId, name: "Meldiq Plus USD 3.99 monthly", status: "ACTIVE",
    billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: "3.99", currency_code: "USD" } } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
  }, requestId("plan")) as { id: string };
  save("PAYPAL_PLUS_PLAN_ID", plusPlanId = plan.id);
}
console.log("Live monthly plan configured");
let botsPlanId = process.env.PAYPAL_BOTS_PLUS_PLAN_ID;
if (process.argv.includes("--addons")) {
  let botsProductId = process.env.PAYPAL_BOTS_PRODUCT_ID;
  if (!botsProductId) {
    const product = await api.request("POST", "/v1/catalogs/products", { name: "Meldiq Bots+", description: "Premium bots for one Meldiq community", type: "SERVICE", category: "SOFTWARE" }, requestId("bots-product")) as { id: string };
    save("PAYPAL_BOTS_PRODUCT_ID", botsProductId = product.id);
  }
  if (!botsPlanId) {
    const plan = await api.request("POST", "/v1/billing/plans", {
      product_id: botsProductId, name: "Meldiq Bots+ USD 3.99 monthly", status: "ACTIVE",
      billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: "3.99", currency_code: "USD" } } }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
    }, requestId("bots-plan")) as { id: string };
    save("PAYPAL_BOTS_PLUS_PLAN_ID", botsPlanId = plan.id);
  }
}

let merchantId = process.env.PAYPAL_MERCHANT_ID;
if (!merchantId) {
  // No payer or approval link is used; the unapproved order expires without a charge.
  const order = await api.request("POST", "/v2/checkout/orders", {
    intent: "CAPTURE", purchase_units: [{ custom_id: "meldiq-live-uncaptured-capability-probe", amount: { currency_code: "USD", value: "3.99" } }],
  }, requestId("merchant-probe")) as { purchase_units: { payee: { merchant_id: string } }[] };
  save("PAYPAL_MERCHANT_ID", merchantId = order.purchase_units[0].payee.merchant_id);
}
const url = "https://msg.meldiq.app/v1/billing/webhooks/paypal";
const names = ["BILLING.SUBSCRIPTION.CREATED", "BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.UPDATED", "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.EXPIRED", "BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.PAYMENT.FAILED", "PAYMENT.SALE.COMPLETED", "PAYMENT.SALE.REFUNDED", "PAYMENT.SALE.REVERSED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "CHECKOUT.ORDER.APPROVED", "CHECKOUT.ORDER.COMPLETED", "CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"];
const listed = await api.request("GET", "/v1/notifications/webhooks") as { webhooks: { id: string; url: string; event_types: { name: string }[] }[] };
let webhook = listed.webhooks.find((w) => w.url === url);
if (!webhook) webhook = await api.request("POST", "/v1/notifications/webhooks", { url, event_types: names.map((name) => ({ name })) }) as typeof webhook;
if (!webhook || !names.every((name) => webhook!.event_types.some((e) => e.name === name))) throw new Error("Webhook event coverage mismatch");
save("PAYPAL_WEBHOOK_ID", webhook.id);
const provider = new PayPalProvider({ environment: "live", clientId, clientSecret, merchantId, plusPlanId, botsPlanId, webhookId: webhook.id, subscriptionsApproved: true, api });
await provider.verifyPlusPlan();
if (process.argv.includes("--addons")) {
  await provider.verifyBotsPlan();
  save("PAYPAL_SPARKS_ENABLED", "true");
  console.log("Bots+ USD 3.99/month verified; standalone Sparks USD 0.99 one-time enabled");
}
save("PAYPAL_SUBSCRIPTIONS_APPROVED", "true");
console.log("Live merchant and webhook verified; Plus USD 3.99/month; no payment approved or captured");
