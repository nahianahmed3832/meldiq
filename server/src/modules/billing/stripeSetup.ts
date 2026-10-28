import Stripe from "stripe";
import type { PlanCatalog } from "./catalog.js";
import { STRIPE_WEBHOOK_EVENTS } from "./providers/stripe.js";

/**
 * One-command Stripe setup for Meldiq Mojo (admin.js stripe-setup; deploy/scripts/stripe-setup.sh runs it). Safe to run
 * again: everything it creates is found again by its metadata or lookup key and reused, never duplicated.
 *
 * - the product "Meldiq Mojo" and its monthly USD prices (lookup keys meldiq_mojo_go_monthly, meldiq_mojo_plus_monthly);
 * - the webhook endpoint for the API, with the events Meldiq handles (its signing secret exists only in the answer to
 *   its creation: a second run reports it as existing and returns no secret, unless asked to replace it);
 * - a customer portal configuration: payment method, invoices, cancellation at the period's end, switching between the
 *   two prices, with Meldiq's terms and privacy links.
 */
export const MOJO_PRICES = [
  { tier: "go", name: "Mojo Go", lookupKey: "meldiq_mojo_go_monthly", amountMinor: 99 },
  { tier: "plus", name: "Mojo Plus", lookupKey: "meldiq_mojo_plus_monthly", amountMinor: 399 },
] as const;

const META = "meldiq";

/** The Stripe calls the setup makes (the real one is [stripeSetupApi]; tests use a fake). */
export interface StripeSetupApi {
  findProduct(): Promise<{ id: string } | null>;
  createProduct(params: Stripe.ProductCreateParams): Promise<{ id: string }>;
  findPrice(lookupKey: string): Promise<{ id: string; unit_amount: number | null; currency: string; product: string } | null>;
  createPrice(params: Stripe.PriceCreateParams): Promise<{ id: string }>;
  findWebhook(url: string): Promise<{ id: string } | null>;
  deleteWebhook(id: string): Promise<void>;
  createWebhook(params: Stripe.WebhookEndpointCreateParams): Promise<{ id: string; secret?: string }>;
  findPortalConfiguration(): Promise<{ id: string } | null>;
  createPortalConfiguration(params: Stripe.BillingPortal.ConfigurationCreateParams): Promise<{ id: string }>;
  updatePortalConfiguration(id: string, params: Stripe.BillingPortal.ConfigurationUpdateParams): Promise<{ id: string }>;
}

export function stripeSetupApi(client: Stripe): StripeSetupApi {
  return {
    findProduct: async () => (await client.products.list({ active: true, limit: 100 })).data.find((p) => p.metadata?.[META] === "mojo") ?? null,
    createProduct: (params) => client.products.create(params),
    findPrice: async (lookupKey) => {
      const p = (await client.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data[0];
      return p ? { id: p.id, unit_amount: p.unit_amount, currency: p.currency, product: typeof p.product === "string" ? p.product : p.product.id } : null;
    },
    createPrice: (params) => client.prices.create(params),
    findWebhook: async (url) => (await client.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === url) ?? null,
    deleteWebhook: async (id) => {
      await client.webhookEndpoints.del(id);
    },
    createWebhook: (params) => client.webhookEndpoints.create(params),
    findPortalConfiguration: async () => (await client.billingPortal.configurations.list({ active: true, limit: 100 })).data.find((c) => c.metadata?.[META] === "mojo") ?? null,
    createPortalConfiguration: (params) => client.billingPortal.configurations.create(params),
    updatePortalConfiguration: (id, params) => client.billingPortal.configurations.update(id, params),
  };
}

export interface StripeSetupOptions {
  /** The API's webhook address, e.g. https://msg.meldiq.app/v1/billing/webhooks/stripe. */
  webhookUrl: string;
  /** The website, for the portal's links and return page, e.g. https://meldiq.app. */
  siteUrl: string;
  /** Delete and recreate an existing webhook endpoint (to get a new signing secret). */
  replaceWebhook?: boolean;
}

export interface StripeSetupResult {
  productId: string;
  prices: Record<(typeof MOJO_PRICES)[number]["tier"], string>;
  webhook: { id: string; created: boolean; secret: string | null };
  portalConfiguration: string;
  steps: string[];
}

export async function stripeSetup(api: StripeSetupApi, opts: StripeSetupOptions): Promise<StripeSetupResult> {
  const steps: string[] = [];
  let product = await api.findProduct();
  if (product) steps.push(`product: found ${product.id}`);
  else {
    product = await api.createProduct({ name: "Meldiq Mojo", description: "Meldiq's subscription, in two tiers: Mojo Go and Mojo Plus.", metadata: { [META]: "mojo" } });
    steps.push(`product: created ${product.id}`);
  }

  const prices = {} as StripeSetupResult["prices"];
  for (const p of MOJO_PRICES) {
    const found = await api.findPrice(p.lookupKey);
    if (found) {
      // A price never changes at Stripe: one with the wrong amount means someone made it by hand; don't sell it.
      if (found.unit_amount !== p.amountMinor || found.currency !== "usd" || found.product !== product.id) {
        throw new Error(`The price with lookup key ${p.lookupKey} (${found.id}) isn't ${p.amountMinor} USD cents on ${product.id}: archive it in Stripe, then run this again`);
      }
      prices[p.tier] = found.id;
      steps.push(`price ${p.name}: found ${found.id}`);
      continue;
    }
    const created = await api.createPrice({
      product: product.id,
      currency: "usd",
      unit_amount: p.amountMinor,
      recurring: { interval: "month" },
      lookup_key: p.lookupKey,
      nickname: p.name,
      metadata: { [META]: `mojo_${p.tier}` },
    });
    prices[p.tier] = created.id;
    steps.push(`price ${p.name}: created ${created.id} (${(p.amountMinor / 100).toFixed(2)} USD a month)`);
  }

  let webhook: StripeSetupResult["webhook"];
  const existing = await api.findWebhook(opts.webhookUrl);
  if (existing && !opts.replaceWebhook) {
    webhook = { id: existing.id, created: false, secret: null };
    steps.push(`webhook: found ${existing.id} (its signing secret can't be read again; it must already be in .env)`);
  } else {
    if (existing) {
      await api.deleteWebhook(existing.id);
      steps.push(`webhook: replaced ${existing.id}`);
    }
    const created = await api.createWebhook({
      url: opts.webhookUrl,
      enabled_events: [...STRIPE_WEBHOOK_EVENTS] as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
      description: "Meldiq API: subscriptions, invoices, checkouts, refunds and disputes",
      metadata: { [META]: "api" },
    });
    if (!created.secret) throw new Error("Stripe didn't return the webhook's signing secret");
    webhook = { id: created.id, created: true, secret: created.secret };
    steps.push(`webhook: created ${created.id} for ${opts.webhookUrl}`);
  }

  const portal: Stripe.BillingPortal.ConfigurationCreateParams = {
    business_profile: { headline: "Manage Meldiq Mojo", privacy_policy_url: `${opts.siteUrl}/legal/privacy`, terms_of_service_url: `${opts.siteUrl}/legal/terms` },
    default_return_url: `${opts.siteUrl}/account/billing`,
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "name", "address"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: { enabled: true, default_allowed_updates: ["price"], proration_behavior: "create_prorations", products: [{ product: product.id, prices: [prices.go, prices.plus] }] },
    },
    metadata: { [META]: "mojo" },
  };
  const foundPortal = await api.findPortalConfiguration();
  let portalConfiguration: string;
  if (foundPortal) {
    const { metadata: _m, ...update } = portal;
    portalConfiguration = (await api.updatePortalConfiguration(foundPortal.id, update)).id;
    steps.push(`portal: updated ${portalConfiguration}`);
  } else {
    portalConfiguration = (await api.createPortalConfiguration(portal)).id;
    steps.push(`portal: created ${portalConfiguration}`);
  }

  return { productId: product.id, prices, webhook, portalConfiguration, steps };
}

/**
 * Puts Mojo Go and Mojo Plus in the plan catalog at their Stripe prices, published for the configured provider (keys
 * "go" and "plus", personal, monthly USD). Safe to run again: a plan already current at that price is left alone; a new
 * price becomes a new version (subscribers keep theirs). Trial and grace days are 0: free periods are grants
 * (grants.ts), and the grace period isn't decided yet.
 */
export async function publishMojoPlans(
  catalog: PlanCatalog,
  provider: string,
  prices: StripeSetupResult["prices"],
  actor: string,
  t: number,
): Promise<string[]> {
  const done: string[] = [];
  for (const p of MOJO_PRICES) {
    const terms = { interval: "month" as const, currency: "USD", amountMinor: p.amountMinor, providerPriceRef: prices[p.tier], trialDays: 0, graceDays: 0, limits: {}, notes: "", quotaPlanId: null };
    let plan = catalog.byKey(p.tier);
    if (!plan) {
      plan = await catalog.create(p.tier, { name: p.name, description: "", segment: "personal", public: true, audience: "personal" }, terms, actor, t);
      await catalog.publish(plan.id, provider, actor, t);
      done.push(`${p.name}: created and published at ${prices[p.tier]}`);
      continue;
    }
    const current = catalog.current(plan.id);
    if (current && current.provider === provider && current.provider_price_ref === prices[p.tier]) {
      done.push(`${p.name}: already published at ${prices[p.tier]}`);
      continue;
    }
    await catalog.saveDraft(plan.id, terms, actor, t);
    await catalog.publish(plan.id, provider, actor, t);
    done.push(`${p.name}: new version published at ${prices[p.tier]}`);
  }
  return done;
}
