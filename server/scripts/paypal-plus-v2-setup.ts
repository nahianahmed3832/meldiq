/** Preparation only: creates a NEW versioned plan, never changes an existing price or publishes billing. */
import { createHash } from "node:crypto";
import { PRICING, PRICING_VERSION, PLUS_TERMS, type PlusTerm } from "../src/modules/billing/pricing.js";
import { HttpPayPalApi } from "../src/modules/billing/providers/paypalApi.js";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";

const environment = process.env.PAYPAL_ENVIRONMENT;
if (environment !== "sandbox" && environment !== "live") throw new Error("Set PAYPAL_ENVIRONMENT=sandbox or live");
const term = (process.argv.find(a => a.startsWith("--term="))?.slice(7) ?? "monthly") as PlusTerm;
if (!(term in PLUS_TERMS)) throw new Error("Choose monthly, quarterly or yearly");
const pricing = PLUS_TERMS[term];
const value = (pricing.amountMinor / 100).toFixed(2);
const body = {
 name: `Meldiq Plus ${term} ${PRICING_VERSION}`, status: "ACTIVE",
 billing_cycles: [{ frequency: { interval_unit: pricing.interval.toUpperCase(), interval_count: pricing.billingFrequency }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value, currency_code: "USD" } } }],
 payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
};
if (!process.argv.includes("--execute")) {
 console.log(JSON.stringify({ dryRun: true, environment, version: PRICING_VERSION, product: PRICING.plus.name, plan: body, publishesBilling: false, existingAgreements: "unchanged" }, null, 2));
} else {
 if (environment === "live" && !process.argv.some(a => /^--compatibility-approval=[A-Za-z0-9_.-]{5,100}$/.test(a))) throw new Error("Live preparation requires a separately reviewed compatibility approval reference");
 if (environment === "sandbox" && process.env.APP_ENV === "production") throw new Error("Sandbox cannot run in production");
 const { PAYPAL_CLIENT_ID: client, PAYPAL_CLIENT_SECRET: secret, PAYPAL_MERCHANT_ID: merchant, PAYPAL_WEBHOOK_ID: webhook } = process.env;
 if (!client || !secret || !merchant) throw new Error("Configure private provider credentials and a verified merchant identifier");
 const api = new HttpPayPalApi(client, secret, environment);
 const key = (kind: string) => createHash("sha256").update(`${client}:${environment}:${PRICING_VERSION}:${kind === "product" ? "product" : `${term}:${kind}`}`).digest("hex").slice(0, 36);
 // Explicit v2 resource variables avoid treating the old 3.99 id as the new offer. No PATCH/update-pricing API exists here.
 let productId = process.env.PAYPAL_PLUS_V2_PRODUCT_ID;
 if (!productId) productId = (await api.request("POST", "/v1/catalogs/products", { name: PRICING.plus.name, description: "Monthly Meldiq Plus subscription", type: "SERVICE", category: "SOFTWARE" }, key("product")) as { id: string }).id;
 const product = await api.request("GET", `/v1/catalogs/products/${productId}`) as { id: string; name: string };
 if (product.name !== PRICING.plus.name || product.id !== productId) throw new Error("Product branding mismatch");
 let planId = process.env[term === "monthly" ? "PAYPAL_PLUS_V2_PLAN_ID" : term === "quarterly" ? "PAYPAL_PLUS_V2_QUARTERLY_PLAN_ID" : "PAYPAL_PLUS_V2_YEARLY_PLAN_ID"];
 if (!planId) planId = (await api.request("POST", "/v1/billing/plans", { ...body, product_id: productId }, key("plan")) as { id: string }).id;
 await new PayPalProvider({ environment, clientId: client, clientSecret: secret, merchantId: merchant, webhookId: webhook ?? "", plusPlanId: term === "monthly" ? planId : null, quarterlyPlanId: term === "quarterly" ? planId : null, yearlyPlanId: term === "yearly" ? planId : null, plusProductId: productId, subscriptionsApproved: true, api }).verifyPlusPlan(term);
 console.log(JSON.stringify({ environment, term, amountMinor: pricing.amountMinor, billingInterval: pricing.interval, billingFrequency: pricing.billingFrequency, pricingVersion: PRICING_VERSION, productId, planId, verified: true, webhookConfigured: !!webhook, published: false, instruction: "Save these versioned IDs privately. Complete Sandbox/compatibility checks, then separately publish a new catalog version. Keep historical versions." }, null, 2));
}
