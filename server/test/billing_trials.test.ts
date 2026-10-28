import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trialConfig } from "../src/modules/billing/config.js";
import { Grants } from "../src/modules/billing/grants.js";
import { StripeProvider, type StripeApi } from "../src/modules/billing/providers/stripe.js";
import { MOJO_PRICES, publishMojoPlans, stripeSetup, type StripeSetupApi } from "../src/modules/billing/stripeSetup.js";
import { AccountEntitlements, PublicPlans, ReferralInfo } from "../src/shared/contracts/http/billing.js";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Meldiq Mojo free periods (docs/BILLING.md › Trials and invite links): every account's 14-day trial of Mojo Plus, the
 * 30 days both people get through an invite link, the inviter's 90-day yearly cap, how a Stripe subscription bought
 * during a free period starts charging only when it ends, and the one-command Stripe setup against a fake Stripe.
 */
const DAY = 86_400_000;
const WHSEC = "whsec_testsecretfortestsonly0123456789";
const SK = "sk_test_meldiqfaketestkey0123456789";

class FakeCheckoutApi implements StripeApi {
  sessions: Stripe.Checkout.SessionCreateParams[] = [];
  async createCustomer() {
    return { id: "cus_trial" };
  }
  async createCheckoutSession(params: Stripe.Checkout.SessionCreateParams) {
    this.sessions.push(params);
    return { id: `cs_${this.sessions.length}`, url: "https://checkout.stripe.test/x" };
  }
  async expireCheckoutSession() {}
  async createPortalSession() {
    return { url: "https://billing.stripe.test/p" };
  }
  async retrieveSubscription() {
    return null;
  }
}

describe("trial settings", () => {
  it("are off without a start date and refuse nonsense", () => {
    expect(trialConfig({})).toBeNull();
    expect(trialConfig({ BILLING_TRIAL_STARTS_AT: "2026-11-01T00:00:00Z" })).toEqual({
      startsAt: Date.parse("2026-11-01T00:00:00Z"),
      planKey: "plus",
      days: 14,
      referralDays: 30,
      referralCapDays: 90,
      claimWindowDays: 7,
    });
    expect(() => trialConfig({ BILLING_TRIAL_STARTS_AT: "soon" })).toThrow(/ISO/);
    expect(() => trialConfig({ BILLING_TRIAL_STARTS_AT: "2026-11-01", BILLING_TRIAL_DAYS: "-1" })).toThrow(/whole number/);
  });
});

describe("with trials and invite links", () => {
  let h: Harness;
  const mailer = new MemoryMailer();
  const stripe = new FakeCheckoutApi();
  const signedIn = async (name: string) => {
    const c = new AccountClient(h.baseUrl, email(name), PASSWORD, name);
    await c.signUp(mailer);
    await c.signIn();
    return c;
  };
  const ent = async (c: AccountClient) => {
    const e = await c.req("GET", "/v2/billing/entitlements");
    expect(AccountEntitlements.safeParse(e).success).toBe(true);
    return e;
  };

  beforeAll(async () => {
    h = await startServer(
      {
        BILLING_PROVIDER: "stripe",
        STRIPE_SECRET_KEY: SK,
        STRIPE_WEBHOOK_SECRET: WHSEC,
        BILLING_RETURN_URL: "https://meldiq.test/account/billing",
        BILLING_TRIAL_STARTS_AT: new Date(Date.now() - 60 * DAY).toISOString(),
        WORKFLOW_TICK_MS: "0",
      },
      { mailer, billingProvider: new StripeProvider({ secretKey: SK, webhookSecret: WHSEC, allowPromotionCodes: false, api: stripe }) },
    );
    await publishMojoPlans(h.ctx.billing.catalog, "stripe", { go: "price_go", plus: "price_plus", spark: "price_spark" }, "test", Date.now());
  });
  afterAll(async () => h.close());

  it("publish Mojo Go and Mojo Plus once, at their prices, and say trials are on", async () => {
    expect(await publishMojoPlans(h.ctx.billing.catalog, "stripe", { go: "price_go", plus: "price_plus", spark: "price_spark" }, "test", Date.now())).toEqual([
      "Mojo Go: already published at price_go",
      "Mojo Plus: already published at price_plus",
      "Meldiq Spark: already published at price_spark",
    ]);
    const plans = (await h.app.inject({ method: "GET", url: "/v2/billing/plans" })).json();
    expect(PublicPlans.safeParse(plans).success).toBe(true);
    expect(plans.plans.map((p: any) => [p.key, p.name, p.amountMinor, p.currency, p.interval, p.audience])).toEqual([
      // By name: the Spark add-on, then the plans.
      ["spark", "Meldiq Spark", 99, "USD", "month", "personal"],
      ["go", "Mojo Go", 99, "USD", "month", "personal"],
      ["plus", "Mojo Plus", 399, "USD", "month", "personal"],
    ]);
    expect(plans.trial).toEqual({ planKey: "plus", days: 14, referralDays: 30, referralYearlyCapDays: 90 });
  });

  it("give every new account 14 days of Mojo Plus from sign-up, without a card", async () => {
    const dana = await signedIn("dana");
    const e = await ent(dana);
    expect(e.personal).toMatchObject({ plan: { key: "plus", name: "Mojo Plus" }, standing: "entitled", renews: false, subscription: null, trial: { source: "signup" } });
    const created = (await h.ctx.accounts.store.accountById(dana.accountId))!.created_at;
    expect(e.personal.accessUntil).toBe(created + 14 * DAY);
    // Asking again doesn't restart it.
    expect((await ent(dana)).personal.accessUntil).toBe(created + 14 * DAY);
  });

  it("give both people 30 days through an invite link, once, and never through one's own link", async () => {
    const inviter = await signedIn("inviter");
    const info = await inviter.req("GET", "/v2/billing/referral");
    expect(ReferralInfo.safeParse(info).success).toBe(true);
    expect(info).toMatchObject({ available: true, invited: 0, bonusDaysThisYear: 0, yearlyCapDays: 90, daysEach: 30 });
    expect(info.code).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
    expect((await inviter.req("GET", "/v2/billing/referral")).code).toBe(info.code);
    await expectStatus(inviter.req("POST", "/v2/billing/referral/claim", { code: info.code }), 409);

    const friend = await signedIn("friend");
    await expectStatus(friend.req("POST", "/v2/billing/referral/claim", { code: "NOSUCHCODE" }), 404);
    const claimed = await friend.req("POST", "/v2/billing/referral/claim", { code: info.code.toLowerCase() });
    expect(claimed.inviterDays).toBe(30);
    const created = (await h.ctx.accounts.store.accountById(friend.accountId))!.created_at;
    expect((await ent(friend)).personal).toMatchObject({ plan: { key: "plus" }, accessUntil: created + 30 * DAY, trial: { source: "invite" } });
    // The inviter's 30 days follow on from their own 14-day trial.
    const inviterCreated = (await h.ctx.accounts.store.accountById(inviter.accountId))!.created_at;
    const ie = await ent(inviter);
    expect(ie.personal.trial.source).toBe("signup");
    const bonus = h.ctx.billing.rows.get<{ starts_at: number; ends_at: number }>("billing_grants", { account_id: inviter.accountId, source: "referral_inviter" }) as any;
    expect(bonus.starts_at).toBe(inviterCreated + 14 * DAY);
    expect(bonus.ends_at - bonus.starts_at).toBe(30 * DAY);
    await expectStatus(friend.req("POST", "/v2/billing/referral/claim", { code: info.code }), 409);
    expect(await inviter.req("GET", "/v2/billing/referral")).toMatchObject({ invited: 1, bonusDaysThisYear: 30 });
  });

  it("stop the inviter's bonus at 90 days a year, while each invited person still gets theirs", async () => {
    const inviter = await signedIn("busy");
    const { code } = await inviter.req("GET", "/v2/billing/referral");
    for (let i = 0; i < 4; i++) {
      const f = await signedIn(`pal${i}`);
      const r = await f.req("POST", "/v2/billing/referral/claim", { code });
      expect(r.inviterDays).toBe(i < 3 ? 30 : 0);
      expect((await ent(f)).personal.trial.source).toBe("invite");
    }
    expect(await inviter.req("GET", "/v2/billing/referral")).toMatchObject({ invited: 4, bonusDaysThisYear: 90 });
    const total = { d: h.ctx.billing.rows.all<{ starts_at: number; ends_at: number }>("billing_grants", { where: { account_id: inviter.accountId, source: "referral_inviter" } }).reduce((n, g) => n + g.ends_at - g.starts_at, 0) } as any;
    expect(total.d).toBe(90 * DAY);
  });

  it("don't count an invite link for an account older than the claim window", async () => {
    const inviter = await signedIn("oldinviter");
    const { code } = await inviter.req("GET", "/v2/billing/referral");
    // An account that signed up 8 days ago.
    await expect(h.ctx.billing.grants.claim({ accountId: "acc_eight_days_old", createdAt: Date.now() - 8 * DAY, userId: null }, code)).rejects.toThrow(/last few days/);
    expect(h.ctx.billing.rows.count("billing_referrals", { invitee_account_id: "acc_eight_days_old" })).toBe(0);
  });

  it("start an existing account's trial on launch day, not at its old sign-up time", async () => {
    const launch = Date.now() - 2 * DAY;
    const grants = new Grants(h.ctx.billing.rows, () => ({ startsAt: launch, planKey: "plus", days: 14, referralDays: 30, referralCapDays: 90, claimWindowDays: 7 }), () => Date.now());
    await grants.ensureSignupTrial({ accountId: "acc_veteran", createdAt: Date.now() - 400 * DAY, userId: null });
    expect(grants.active("acc_veteran", Date.now())).toMatchObject({ starts_at: launch, ends_at: launch + 14 * DAY, source: "signup_trial" });
    const before = new Grants(h.ctx.billing.rows, () => ({ startsAt: Date.now() + DAY, planKey: "plus", days: 14, referralDays: 30, referralCapDays: 90, claimWindowDays: 7 }), () => Date.now());
    await before.ensureSignupTrial({ accountId: "acc_early", createdAt: Date.now(), userId: null });
    expect(before.active("acc_early", Date.now() + 2 * DAY)).toBeNull();
  });

  it("start charging a subscription bought during a free period only when the period ends", async () => {
    const buyer = await signedIn("buyer");
    const e = await ent(buyer);
    await buyer.req("POST", "/v2/billing/checkout", { planKey: "go" });
    const params = stripe.sessions.at(-1)!;
    expect(params.subscription_data).toMatchObject({ trial_end: Math.floor(e.personal.accessUntil / 1000) });
    expect(params.subscription_data).not.toHaveProperty("trial_period_days");
    expect(params.line_items).toEqual([{ price: "price_go", quantity: 1 }]);
  });

  it("give the trial's quota plan while it lasts", async () => {
    const qp = "qp_trial";
    await h.ctx.platform.write((w) => w.insert("quota_plans", { id: qp, name: "Mojo Plus allowances", description: "", created_by: "test", created_at: Date.now() }));
    // A published version never changes: the allowances come with a new version, as an operator would publish it.
    const plan = h.ctx.billing.catalog.byKey("plus")!;
    await h.ctx.billing.catalog.saveDraft(plan.id, { interval: "month", currency: "USD", amountMinor: 399, providerPriceRef: "price_plus_v2", trialDays: 0, graceDays: 0, limits: {}, notes: "", quotaPlanId: qp }, "test", Date.now());
    await h.ctx.billing.catalog.publish(plan.id, "stripe", "test", Date.now());
    const c = await AccountClient.ready(h.baseUrl, mailer, "quotaperson");
    await ent(c);
    expect(h.ctx.quotas.planOf({ type: "user", id: c.userId })).toBe(qp);
  });
});

/** Stripe's setup calls, answered like Stripe and remembered between runs. */
class FakeStripeSetup implements StripeSetupApi {
  products: { id: string; metadata: Record<string, string> }[] = [];
  prices: { id: string; unit_amount: number; currency: string; product: string; lookup_key: string }[] = [];
  webhooks: { id: string; url: string }[] = [];
  portals: { id: string }[] = [];
  calls: string[] = [];
  private n = 0;
  async findProduct(kind = "mojo") {
    return this.products.find((p) => p.metadata.meldiq === kind) ?? null;
  }
  async createProduct(p: Stripe.ProductCreateParams) {
    this.calls.push("createProduct");
    const prod = { id: `prod_${++this.n}`, metadata: (p.metadata ?? {}) as Record<string, string> };
    this.products.push(prod);
    return prod;
  }
  async findPrice(lookupKey: string) {
    return this.prices.find((p) => p.lookup_key === lookupKey) ?? null;
  }
  async createPrice(p: Stripe.PriceCreateParams) {
    this.calls.push(`createPrice:${p.lookup_key}`);
    const price = { id: `price_${++this.n}`, unit_amount: p.unit_amount!, currency: p.currency, product: p.product as string, lookup_key: p.lookup_key! };
    this.prices.push(price);
    return price;
  }
  async findWebhook(url: string) {
    return this.webhooks.find((w) => w.url === url) ?? null;
  }
  async deleteWebhook(id: string) {
    this.calls.push(`deleteWebhook:${id}`);
    this.webhooks = this.webhooks.filter((w) => w.id !== id);
  }
  async createWebhook(p: Stripe.WebhookEndpointCreateParams) {
    this.calls.push("createWebhook");
    expect(p.enabled_events).toContain("customer.subscription.updated");
    const w = { id: `we_${++this.n}`, url: p.url };
    this.webhooks.push(w);
    return { ...w, secret: `whsec_fake${this.n}` };
  }
  async findPortalConfiguration() {
    return this.portals[0] ?? null;
  }
  async createPortalConfiguration(p: Stripe.BillingPortal.ConfigurationCreateParams) {
    this.calls.push("createPortal");
    expect(p.features.subscription_cancel).toEqual({ enabled: true, mode: "at_period_end" });
    const c = { id: `bpc_${++this.n}` };
    this.portals.push(c);
    return c;
  }
  async updatePortalConfiguration(id: string) {
    this.calls.push("updatePortal");
    return { id };
  }
}

describe("one-command Stripe setup", () => {
  const opts = { webhookUrl: "https://msg.meldiq.test/v1/billing/webhooks/stripe", siteUrl: "https://meldiq.test" };

  it("creates the products, the three prices, the webhook and the portal, then finds them again instead of duplicating", async () => {
    const api = new FakeStripeSetup();
    const first = await stripeSetup(api, opts);
    expect(api.prices.map((p) => [p.lookup_key, p.unit_amount, p.currency])).toEqual(MOJO_PRICES.map((p) => [p.lookupKey, p.amountMinor, "usd"]));
    expect(first.webhook).toMatchObject({ created: true, secret: expect.stringMatching(/^whsec_/) });
    const again = await stripeSetup(api, opts);
    expect(again.prices).toEqual(first.prices);
    expect(again.webhook).toEqual({ id: first.webhook.id, created: false, secret: null });
    expect(api.calls.filter((c) => c.startsWith("create"))).toEqual([
      "createProduct",
      "createProduct",
      "createPrice:meldiq_mojo_go_monthly",
      "createPrice:meldiq_mojo_plus_monthly",
      "createPrice:meldiq_spark_monthly",
      "createWebhook",
      "createPortal",
    ]);
    // Sparks are their own product (their own line on invoices).
    expect(api.prices.find((p) => p.lookup_key === "meldiq_spark_monthly")?.product).not.toBe(api.prices[0]!.product);
    expect(api.calls).toContain("updatePortal");
    const replaced = await stripeSetup(api, { ...opts, replaceWebhook: true });
    expect(replaced.webhook.created).toBe(true);
    expect(api.webhooks).toHaveLength(1);
  });

  it("refuses to sell a price someone made by hand at another amount", async () => {
    const api = new FakeStripeSetup();
    await stripeSetup(api, opts);
    api.prices[0]!.unit_amount = 199;
    await expect(stripeSetup(api, opts)).rejects.toThrow(/isn't 99 USD cents/);
  });
});
