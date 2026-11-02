throw new Error("This setup is retired. Use paypal-plus-v2-setup.ts to prepare a new versioned $4.99 plan. Existing agreements must not be repriced.");
/** Run explicitly with node --env-file=.env.paypal.sandbox --import tsx scripts/paypal-sandbox-setup.ts.
 * Creates Sandbox resources only. Never prints credentials, access tokens or payer details. */
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { HttpPayPalApi } from "../src/modules/billing/providers/paypalApi.js";

if (
  process.env.PAYPAL_ENVIRONMENT !== "sandbox" ||
  process.env.APP_ENV === "production"
)
  throw new Error("Sandbox environment required");
const { PAYPAL_CLIENT_ID: client, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!client || !secret)
  throw new Error("Configure private Sandbox credentials first");
const api = new HttpPayPalApi(client, secret);
const file = ".env.paypal.sandbox";
const values: Record<string, string> = {};
let productId = process.env.PAYPAL_PLUS_PRODUCT_ID;
if (!productId) {
  const product = (await api.request(
    "POST",
    "/v1/catalogs/products",
    {
      name: "Meldiq Plus Sandbox",
      description: "Monthly Plus subscription, Sandbox testing only",
      type: "SERVICE",
      category: "SOFTWARE",
    },
    "meldiq-plus-sandbox-product-v1",
  )) as { id: string };
  productId = product.id;
  values.PAYPAL_PLUS_PRODUCT_ID = productId;
}
let planId = process.env.PAYPAL_PLUS_PLAN_ID;
if (!planId) {
  const plan = (await api.request(
    "POST",
    "/v1/billing/plans",
    {
      product_id: productId,
      name: "Meldiq Plus USD 3.99 monthly Sandbox",
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: "3.99", currency_code: "USD" },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        payment_failure_threshold: 2,
      },
    },
    "meldiq-plus-sandbox-plan-v1",
  )) as { id: string };
  planId = plan.id;
  values.PAYPAL_PLUS_PLAN_ID = planId;
}
const retrieved = (await api.request("GET", `/v1/billing/plans/${planId}`)) as {
  status: string;
};
// A non-captured order proves Orders API access; no buyer is charged or given entitlements.
const probe = (await api.request(
  "POST",
  "/v2/checkout/orders",
  {
    intent: "CAPTURE",
    purchase_units: [
      {
        custom_id: "meldiq-sandbox-capability-probe",
        description: "Uncaptured Sandbox API capability probe",
        amount: { currency_code: "USD", value: "3.99" },
      },
    ],
  },
  "meldiq-sandbox-capability-order-v1",
)) as { id: string; purchase_units: { payee: { merchant_id: string } }[] };
values.PAYPAL_MERCHANT_ID = probe.purchase_units[0].payee.merchant_id;
const webhookUrl = process.argv
  .find((a) => a.startsWith("--webhook-url="))
  ?.slice("--webhook-url=".length);
if (webhookUrl) {
  const u = new URL(webhookUrl);
  if (u.protocol !== "https:" || u.pathname !== "/v1/billing/webhooks/paypal")
    throw new Error(
      "Use an HTTPS Sandbox tunnel ending /v1/billing/webhooks/paypal",
    );
  const webhook = (await api.request("POST", "/v1/notifications/webhooks", {
    url: u.href,
    event_types: [
      "BILLING.SUBSCRIPTION.CREATED",
      "BILLING.SUBSCRIPTION.ACTIVATED",
      "BILLING.SUBSCRIPTION.UPDATED",
      "BILLING.SUBSCRIPTION.CANCELLED",
      "BILLING.SUBSCRIPTION.EXPIRED",
      "BILLING.SUBSCRIPTION.SUSPENDED",
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      "PAYMENT.SALE.COMPLETED",
      "PAYMENT.SALE.REFUNDED",
      "PAYMENT.SALE.REVERSED",
      "PAYMENT.CAPTURE.COMPLETED",
      "PAYMENT.CAPTURE.REFUNDED",
      "PAYMENT.CAPTURE.REVERSED",
      "CHECKOUT.ORDER.APPROVED",
      "CHECKOUT.ORDER.COMPLETED",
      "CUSTOMER.DISPUTE.CREATED",
      "CUSTOMER.DISPUTE.UPDATED",
      "CUSTOMER.DISPUTE.RESOLVED",
    ].map((name) => ({ name })),
  })) as { id: string };
  values.PAYPAL_WEBHOOK_ID = webhook.id;
}
let content = readFileSync(file, "utf8");
for (const [key, value] of Object.entries(values)) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Unexpected resource identifier");
  content = new RegExp(`^${key}=.*$`, "m").test(content)
    ? content.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    : `${content}${key}=${value}\n`;
}
writeFileSync(file, content, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(
  JSON.stringify({
    environment: "sandbox",
    productCreatedOrReused: true,
    planStatus: retrieved.status,
    planVerified: true,
    orderCreatedWithoutCapture: true,
    webhookRegistered: !!webhookUrl,
    subscriptionsApproval: "not enabled automatically",
    realMoney: false,
  }),
);
