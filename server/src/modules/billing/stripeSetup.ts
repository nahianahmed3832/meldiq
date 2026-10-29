import Stripe from "stripe";
import type { PlanCatalog } from "./catalog.js";
import { STRIPE_WEBHOOK_EVENTS } from "./providers/stripe.js";

/**
 * One-command Stripe setup for Meldiq Mojo (admin.js stripe-setup; deploy/scripts/stripe-setup.sh runs it). Safe to run
 * again: everything it creates is found again by its metadata or lookup key and reused, never duplicated.
 *
 * - a product per plan, "Mojo Go" and "Mojo Plus", and "Meldiq Spark", each with its monthly USD price (lookup keys
 *   meldiq_mojo_go_monthly, meldiq_mojo_plus_monthly, meldiq_spark_monthly). One product per plan because the portal
 *   only switches between products that each have one price per billing interval. Prices an earlier version put on a
 *   single "Meldiq Mojo" product are moved (a new price takes the lookup key, the old one is archived) while nobody
 *   subscribes to them;
 * - the webhook endpoint for the API, with the events Meldiq handles (its signing secret exists only in the answer to
 *   its creation: a second run reports it as existing and returns no secret, unless asked to replace it);
 * - a customer portal configuration: payment method, invoices, cancellation at the period's end, switching between the
 *   two prices, with Meldiq's terms and privacy links.
 */
export const MOJO_PRICES = [
  { tier: "go", name: "Mojo Go", lookupKey: "meldiq_mojo_go_monthly", amountMinor: 99, product: "go" },
  { tier: "plus", name: "Mojo Plus", lookupKey: "meldiq_mojo_plus_monthly", amountMinor: 399, product: "plus" },
  // Meldiq Spark (docs/MOJO.md): $0.99 per Spark per month, bought by quantity, on its own product (its own invoice line).
  { tier: "spark", name: "Meldiq Spark", lookupKey: "meldiq_spark_monthly", amountMinor: 99, product: "spark" },
] as const;

const PRODUCTS = {
  go: { name: "Mojo Go", description: "Meldiq Mojo, the Go tier." },
  plus: { name: "Mojo Plus", description: "Meldiq Mojo, the Plus tier." },
  spark: { name: "Meldiq Spark", description: "A server boost: each Spark you give a community unlocks more for everyone in it." },
} as const;

const META = "meldiq";
/** The single product API 0.60.0 put both plans on (metadata meldiq=mojo); archived once its prices are moved. */
const LEGACY_PRODUCT = "mojo";

/** The Stripe calls the setup makes (the real one is [stripeSetupApi]; tests use a fake). */
export interface StripeSetupApi {
  /** The active product with metadata meldiq=[kind]. */
  findProduct(kind: string): Promise<{ id: string } | null>;
  createProduct(params: Stripe.ProductCreateParams): Promise<{ id: string }>;
  archiveProduct(id: string): Promise<void>;
  findPrice(lookupKey: string): Promise<{ id: string; unit_amount: number | null; currency: string; product: string } | null>;
  createPrice(params: Stripe.PriceCreateParams): Promise<{ id: string }>;
  archivePrice(id: string): Promise<void>;
  /** Whether any subscription, in any state, uses [id]. */
  priceInUse(id: string): Promise<boolean>;
  findWebhook(url: string): Promise<{ id: string } | null>;
  deleteWebhook(id: string): Promise<void>;
  createWebhook(params: Stripe.WebhookEndpointCreateParams): Promise<{ id: string; secret?: string }>;
  findPortalConfiguration(): Promise<{ id: string } | null>;
  createPortalConfiguration(params: Stripe.BillingPortal.ConfigurationCreateParams): Promise<{ id: string }>;
  updatePortalConfiguration(id: string, params: Stripe.BillingPortal.ConfigurationUpdateParams): Promise<{ id: string }>;
}

export function stripeSetupApi(client: Stripe): StripeSetupApi {
  return {
    findProduct: async (kind) => (await client.products.list({ active: true, limit: 100 })).data.find((p) => p.metadata?.[META] === kind) ?? null,
    createProduct: (params) => client.products.create(params),
    archiveProduct: async (id) => {
      await client.products.update(id, { active: false });
    },
    findPrice: async (lookupKey) => {
      const p = (await client.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data[0];
      return p ? { id: p.id, unit_amount: p.unit_amount, currency: p.currency, product: typeof p.product === "string" ? p.product : p.product.id } : null;
    },
    createPrice: (params) => client.prices.create(params),
    archivePrice: async (id) => {
      await client.prices.update(id, { active: false });
    },
    priceInUse: async (id) => (await client.subscriptions.list({ price: id, status: "all", limit: 1 })).data.length > 0,
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
  products: Record<keyof typeof PRODUCTS, string>;
  prices: Record<(typeof MOJO_PRICES)[number]["tier"], string>;
  webhook: { id: string; created: boolean; secret: string | null };
  portalConfiguration: string;
  steps: string[];
}

export async function stripeSetup(api: StripeSetupApi, opts: StripeSetupOptions): Promise<StripeSetupResult> {
  const steps: string[] = [];
  const products = {} as Record<keyof typeof PRODUCTS, { id: string }>;
  for (const kind of Object.keys(PRODUCTS) as (keyof typeof PRODUCTS)[]) {
    const found = await api.findProduct(kind);
    if (found) {
      products[kind] = found;
      steps.push(`product ${PRODUCTS[kind].name}: found ${found.id}`);
      continue;
    }
    products[kind] = await api.createProduct({ ...PRODUCTS[kind], metadata: { [META]: kind } });
    steps.push(`product ${PRODUCTS[kind].name}: created ${products[kind].id}`);
  }

  const prices = {} as StripeSetupResult["prices"];
  for (const p of MOJO_PRICES) {
    const productId = products[p.product].id;
    const found = await api.findPrice(p.lookupKey);
    // A price never changes at Stripe: one with the wrong amount means someone made it by hand; don't sell it.
    if (found && (found.unit_amount !== p.amountMinor || found.currency !== "usd")) {
      throw new Error(`The price with lookup key ${p.lookupKey} (${found.id}) isn't ${p.amountMinor} USD cents: archive it in Stripe, then run this again`);
    }
    if (found && found.product === productId) {
      prices[p.tier] = found.id;
      steps.push(`price ${p.name}: found ${found.id}`);
      continue;
    }
    // On another product (API 0.60.0 put Go and Plus on one): moving it is only safe while nobody pays it.
    if (found && (await api.priceInUse(found.id))) {
      throw new Error(`The price ${found.id} (${p.lookupKey}) is on another product and has subscriptions: move its subscribers in Stripe first`);
    }
    const created = await api.createPrice({
      product: productId,
      currency: "usd",
      unit_amount: p.amountMinor,
      recurring: { interval: "month" },
      lookup_key: p.lookupKey,
      transfer_lookup_key: !!found,
      nickname: p.name,
      metadata: { [META]: `mojo_${p.tier}` },
    });
    prices[p.tier] = created.id;
    if (found) {
      await api.archivePrice(found.id);
      steps.push(`price ${p.name}: moved to its own product as ${created.id} (archived ${found.id})`);
    } else steps.push(`price ${p.name}: created ${created.id} (${(p.amountMinor / 100).toFixed(2)} USD a month)`);
  }
  const legacy = await api.findProduct(LEGACY_PRODUCT);
  if (legacy) {
    await api.archiveProduct(legacy.id);
    steps.push(`product Meldiq Mojo (both plans, API 0.60.0): archived ${legacy.id}`);
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
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        // One entry per plan: Stripe allows only one price per billing interval for each product listed here.
        products: [
          { product: products.go.id, prices: [prices.go] },
          { product: products.plus.id, prices: [prices.plus] },
        ],
      },
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

  return { products: { go: products.go.id, plus: products.plus.id, spark: products.spark.id }, prices, webhook, portalConfiguration, steps };
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
  /** Days a plan stays on after a failed renewal payment (the console's site details; API 0.60.0). */
  graceDays = 0,
): Promise<string[]> {
  const done: string[] = [];
  for (const p of MOJO_PRICES) {
    const terms = { interval: "month" as const, currency: "USD", amountMinor: p.amountMinor, providerPriceRef: prices[p.tier], trialDays: 0, graceDays, limits: {}, notes: "", quotaPlanId: null };
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
