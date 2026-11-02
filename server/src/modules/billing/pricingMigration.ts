import type { Billing } from "./service.js";
import type { SubscriptionRow } from "./subscriptions.js";
import { PRICING_VERSION, PLUS_PRICE_MINOR, plusTermViews } from "./pricing.js";

/** Read-only inventory: returns aggregate counts and plan IDs, never rewrites an agreement or transaction. */
export function pricingMigrationReport(billing: Billing) {
 const groups = new Map<string, { plan: string; version: number; amountMinor: number; currency: string; provider: string | null; providerPlanId: string | null; status: string; subscriptions: number; action: string }>();
 for (const s of billing.rows.all<SubscriptionRow>("billing_subscriptions")) {
  const v = billing.catalog.version(s.plan_version_id); if (!v) throw new Error("Subscription references a missing pricing version");
  const p = billing.catalog.plan(v.plan_id); if (!p) throw new Error("Pricing version references a missing plan");
  const key = `${v.id}:${s.status}`;
  const group = groups.get(key) ?? { plan: p.key, version: v.version, amountMinor: v.amount_minor, currency: v.currency, provider: v.provider, providerPlanId: v.provider_price_ref, status: s.status, subscriptions: 0, action: "Keep current agreement and price; do not migrate or notify of an unapproved price change" };
  group.subscriptions++; groups.set(key, group);
 }
 return { pricingVersion: PRICING_VERSION, plusTerms: plusTermViews(), newPurchases: { plan: "plus", amountMinor: PLUS_PRICE_MINOR, currency: "USD", interval: "month" }, existingAgreements: [...groups.values()], giftsByState: Object.fromEntries(["pending", "paid", "redeemed", "refunded", "expired", "failed"].map(status => [status, billing.rows.count("mojo_gifts", { status })])), pendingCheckouts: billing.rows.count("billing_checkouts", { status: "open" }), repricingEnabled: false, consent: "A new subscription requires buyer approval. Existing agreements are untouched. Any future repricing needs a separate review of PayPal procedures, applicable customer consent, notifications and effective dates." };
}
