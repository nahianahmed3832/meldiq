import { createHmac, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingConfig } from "../src/modules/billing/config.js";
import { normalizeStripeEvent, STRIPE_SIGNATURE_HEADER, StripeProvider, type StripeApi } from "../src/modules/billing/providers/stripe.js";
import { type BillingProvider, type CheckoutInput, type NormalizedEvent, WebhookRejected } from "../src/modules/billing/providers/types.js";
import { AccountEntitlements, OwnerBilling, PublicPlans } from "../src/shared/contracts/http/billing.js";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { ADMIN_ORIGIN, consoleAdmin, type ConsoleAdmin } from "./support/adminConsole.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Stripe Billing in test mode (docs/BILLING.md › Stripe) and the provider-independent entitlements every client reads.
 * Stripe's API is replaced by a recording fake (no network, no keys); webhooks are signed exactly as Stripe signs them
 * and verified by the official SDK. These are mocked provider events: they prove Meldiq's handling, not a live
 * integration with Stripe.
 */
const WHSEC = "whsec_testsecretfortestsonly0123456789";
const SK = "sk_test_meldiqfaketestkey0123456789";
const RETURN = "https://meldiq.test/account/billing";
const REASON = "Billing test: checking the change";
const DAY_MS = 86_400_000;

/** Stripe's API as the adapter calls it, answering like Stripe and recording every call. */
class FakeStripe implements StripeApi {
  customers: Stripe.CustomerCreateParams[] = [];
  sessions: { id: string; params: Stripe.Checkout.SessionCreateParams; key: string }[] = [];
  expired: string[] = [];
  portals: Stripe.BillingPortal.SessionCreateParams[] = [];
  subscriptions = new Map<string, Stripe.Subscription>();
  private n = 0;

  async createCustomer(params: Stripe.CustomerCreateParams) {
    this.customers.push(params);
    return { id: `cus_fake_${++this.n}` };
  }
  async createCheckoutSession(params: Stripe.Checkout.SessionCreateParams, key: string) {
    const id = `cs_test_${++this.n}`;
    this.sessions.push({ id, params, key });
    return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
  }
  async expireCheckoutSession(id: string) {
    this.expired.push(id);
  }
  async createPortalSession(params: Stripe.BillingPortal.SessionCreateParams) {
    this.portals.push(params);
    return { url: `https://billing.stripe.test/p/session/${this.portals.length}` };
  }
  async retrieveSubscription(id: string) {
    return this.subscriptions.get(id) ?? null;
  }
}

let seq = 0;

/** Polls [check] until it holds (work the server finishes after answering, like a reconciliation). */
async function until(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const secs = (ms: number) => Math.floor(ms / 1000);

function stripeSubscription(o: { id: string; price: string; status: string; checkout: string | null; customer: string; periodEnd?: number; cancelAtPeriodEnd?: boolean; trialEnd?: number | null }) {
  const start = Date.now();
  return {
    id: o.id,
    object: "subscription",
    customer: o.customer,
    status: o.status,
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    canceled_at: o.status === "canceled" ? secs(Date.now()) : null,
    trial_end: o.trialEnd ?? null,
    metadata: o.checkout ? { meldiq_checkout: o.checkout } : {},
    items: { object: "list", data: [{ id: `si_${o.id}`, object: "subscription_item", price: { id: o.price }, current_period_start: secs(start), current_period_end: secs(o.periodEnd ?? start + 30 * DAY_MS) }] },
  };
}

/** Event times only go forward, starting in the past (Stripe stamps events to the second). */
let lastCreated = secs(Date.now()) - 3600;
const nextCreated = () => ++lastCreated;
const stripeEvent = (type: string, object: object, created = nextCreated()) => ({ id: `evt_${++seq}`, object: "event", type, created, livemode: false, data: { object } });

describe("Stripe configuration", () => {
  const base = { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WHSEC, BILLING_RETURN_URL: RETURN };

  it("accepts test keys and a fixed https return page", () => {
    const c = billingConfig(base);
    expect(c.provider).toMatchObject({ id: "stripe", mode: "test" });
    expect(c.returnUrl).toBe(RETURN);
  });

  it("refuses live keys unless explicitly allowed in production", () => {
    const live = { ...base, STRIPE_SECRET_KEY: ["sk", "live", "meldiqfakelivekey0123456789"].join("_") };
    expect(() => billingConfig(live)).toThrow(/live key/);
    expect(() => billingConfig({ ...live, BILLING_ALLOW_LIVE: "true" })).toThrow(/live key/);
    expect(billingConfig({ ...live, BILLING_ALLOW_LIVE: "true", APP_ENV: "production" }).provider?.mode).toBe("live");
  });

  it("refuses missing or malformed secrets and unsafe return pages", () => {
    expect(() => billingConfig({ ...base, STRIPE_SECRET_KEY: "pk_test_publishable" })).toThrow(/secret key/);
    expect(() => billingConfig({ ...base, STRIPE_WEBHOOK_SECRET: "" })).toThrow(/whsec_/);
    expect(() => billingConfig({ ...base, BILLING_RETURN_URL: "http://meldiq.test/billing" })).toThrow(/https/);
    expect(() => billingConfig({ ...base, BILLING_RETURN_URL: "https://meldiq.test/billing?next=evil" })).toThrow(/query/);
    expect(billingConfig({ ...base, BILLING_RETURN_URL: "http://localhost:3000/account/billing" }).returnUrl).toBe("http://localhost:3000/account/billing");
    expect(() => billingConfig({ ...base, APP_ENV: "production", BILLING_RETURN_URL: "http://localhost:3000/account/billing" })).toThrow(/https/);
  });
});

describe("Stripe webhook verification and mapping", () => {
  const p = new StripeProvider({ secretKey: SK, webhookSecret: WHSEC, allowPromotionCodes: false, api: new FakeStripe() });
  const sign = (payload: string, timestamp?: number) => Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC, timestamp });
  const reason = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof WebhookRejected ? e.reason : "other";
    }
    return "accepted";
  };
  const body = JSON.stringify(stripeEvent("customer.subscription.updated", stripeSubscription({ id: "sub_1", price: "price_1", status: "active", checkout: "chk_1", customer: "cus_1" })));

  it("accepts Stripe's signature over the body as received and maps the subscription", () => {
    const e = p.verifyWebhook({ [STRIPE_SIGNATURE_HEADER]: sign(body) }, body, Date.now());
    expect(e).toMatchObject({ kind: "subscription", subscription: { ref: "sub_1", status: "active", priceRef: "price_1", checkoutRef: "chk_1", customerRef: "cus_1" } });
  });

  it("refuses missing, wrong, stale and tampered signatures", () => {
    expect(reason(() => p.verifyWebhook({}, body, Date.now()))).toBe("missing_signature");
    expect(reason(() => p.verifyWebhook({ [STRIPE_SIGNATURE_HEADER]: Stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_another0123456789abcdef" }) }, body, Date.now()))).toBe("bad_signature");
    expect(reason(() => p.verifyWebhook({ [STRIPE_SIGNATURE_HEADER]: sign(body) }, body.replace("active", "trialing"), Date.now()))).toBe("bad_signature");
    expect(reason(() => p.verifyWebhook({ [STRIPE_SIGNATURE_HEADER]: sign(body, secs(Date.now()) - 600) }, body, Date.now()))).toBe("stale_timestamp");
    expect(reason(() => p.verifyWebhook({ [STRIPE_SIGNATURE_HEADER]: "t=1,v1=abc" }, body, Date.now()))).toBe("bad_signature");
  });

  it("maps invoices (subscription through the invoice's parent), checkouts, refunds and unknown types", () => {
    const inv = normalizeStripeEvent(
      stripeEvent("invoice.payment_failed", {
        id: "in_1",
        object: "invoice",
        status: "open",
        currency: "eur",
        amount_due: 900,
        amount_paid: 0,
        total_taxes: [{ amount: 150 }],
        period_start: 1,
        period_end: 2,
        created: 1,
        status_transitions: { finalized_at: 3, paid_at: null },
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
      }) as unknown as Stripe.Event,
    );
    expect(inv).toMatchObject({ kind: "invoice", invoice: { ref: "in_1", status: "payment_failed", currency: "EUR", subscriptionRef: "sub_1", taxMinor: 150, issuedAt: 3000 } });
    const draft = normalizeStripeEvent(stripeEvent("invoice.updated", { id: "in_2", object: "invoice", status: "draft" }) as unknown as Stripe.Event);
    expect(draft.kind).toBe("other");
    const done = normalizeStripeEvent(stripeEvent("checkout.session.completed", { id: "cs_1", mode: "subscription", client_reference_id: "chk_1", subscription: "sub_1", customer: "cus_1" }) as unknown as Stripe.Event);
    expect(done).toMatchObject({ kind: "checkout", checkout: { reference: "chk_1", outcome: "completed", subscriptionRef: "sub_1" } });
    const refund = normalizeStripeEvent(stripeEvent("charge.refunded", { id: "ch_1", customer: "cus_1", currency: "usd", amount: 900, amount_refunded: 900, refunded: true }) as unknown as Stripe.Event);
    expect(refund).toMatchObject({ kind: "payment", payment: { kind: "refund", state: "refunded", affectedMinor: 900 } });
    expect(normalizeStripeEvent(stripeEvent("customer.created", { id: "cus_1" }) as unknown as Stripe.Event).kind).toBe("other");
  });
});

describe("with Stripe in test mode", () => {
  let h: Harness;
  const mailer = new MemoryMailer();
  const stripe = new FakeStripe();
  let admin: ConsoleAdmin;
  let alice: AccountClient, bob: AccountClient, orgOwner: AccountClient, orgMember: AccountClient;
  let orgId: string;
  let quotaPlanId: string;

  const deliver = async (event: object) => {
    const payload = JSON.stringify(event);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/billing/webhooks/stripe",
      payload,
      headers: { "content-type": "application/json; charset=utf-8", [STRIPE_SIGNATURE_HEADER]: Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) },
    });
    return { status: res.statusCode, body: res.json() };
  };
  const plan = async (key: string, audience: "personal" | "organization", price: string, extra: Record<string, unknown> = {}) => {
    const r = await admin.browser.expect(200, "POST", "/admin/v1/billing/plans", {
      key,
      name: `Meldiq ${key}`,
      description: "For tests",
      segment: audience,
      public: true,
      audience,
      terms: { interval: "month", currency: "USD", amountMinor: 500, providerPriceRef: price, trialDays: 0, graceDays: 3, limits: {}, notes: "", ...extra },
      reason: REASON,
    });
    await admin.browser.expect(200, "POST", `/admin/v1/billing/plans/${r.id}/publish`, { reason: REASON });
    return r.id as string;
  };
  const entitlements = async (c: AccountClient) => {
    const e = await c.req("GET", "/v2/billing/entitlements");
    expect(AccountEntitlements.safeParse(e).success).toBe(true);
    return e;
  };
  const signedIn = async (name: string) => {
    const c = new AccountClient(h.baseUrl, email(name), PASSWORD, name);
    await c.signUp(mailer);
    await c.signIn();
    return c;
  };
  const historyOf = (subRef: string) =>
    h.ctx.db.prepare("SELECT h.from_status, h.to_status, h.detail FROM billing_subscription_history h JOIN billing_subscriptions s ON s.id = h.subscription_id WHERE s.provider_subscription_ref = ? ORDER BY h.id").all(subRef) as {
      from_status: string | null;
      to_status: string;
      detail: string;
    }[];

  beforeAll(async () => {
    const provider = new StripeProvider({ secretKey: SK, webhookSecret: WHSEC, allowPromotionCodes: false, api: stripe });
    h = await startServer(
      { ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WHSEC, BILLING_RETURN_URL: RETURN, WORKFLOW_TICK_MS: "0" },
      { mailer, billingProvider: provider },
    );
    admin = await consoleAdmin(h, mailer, "billing_admin", "stripeadmin");
    quotaPlanId = "qp_premium";
    h.ctx.db.prepare("INSERT INTO quota_plans (id, name, description, created_by, created_at) VALUES (?, 'Premium allowances', '', 'test', ?)").run(quotaPlanId, Date.now());
    await plan("premium", "personal", "price_premium_month", { quotaPlanId, trialDays: 7 });
    await plan("premiumyear", "personal", "price_premium_year", { interval: "year", amountMinor: 5000, quotaPlanId });
    await plan("team", "organization", "price_team_month", { limits: { members: 3 }, graceDays: 0 });
    [alice, bob] = await Promise.all([signedIn("alice"), signedIn("bob")]);
    orgOwner = await AccountClient.ready(h.baseUrl, mailer, "orgowner");
    orgMember = await AccountClient.ready(h.baseUrl, mailer, "orgmember");
    orgId = (await orgOwner.req("POST", "/v1/orgs", { name: "Billing Org" })).org.id;
    const code = (await orgOwner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
    await orgMember.req("POST", "/v1/invites/accept", { code });
  });
  afterAll(async () => h.close());

  it("publishes a public price list without an account", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v2/billing/plans" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(PublicPlans.safeParse(body).success).toBe(true);
    expect(body.mode).toBe("test");
    expect(body.plans.map((p: any) => [p.key, p.audience, p.amountMinor, p.currency])).toEqual(
      expect.arrayContaining([
        ["premium", "personal", 500, "USD"],
        ["team", "organization", 500, "USD"],
      ]),
    );
  });

  it("gives a new account the free answer: signing in grants nothing", async () => {
    const e = await entitlements(alice);
    expect(e.personal).toMatchObject({ plan: null, standing: "none", accessUntil: null, subscription: null });
    expect(e.billing).toEqual({ available: true, mode: "test" });
    await expectStatus(new AccountClient(h.baseUrl, "x@example.test").req("GET", "/v2/billing/entitlements"), 401);
  });

  describe("a personal subscription", () => {
    let firstCheckout: string;
    let checkoutId: string;

    it("needs a signed-in account and a configured plan of the right kind; the client never sets a price or an owner", async () => {
      await expectStatus(new AccountClient(h.baseUrl, "x@example.test").req("POST", "/v2/billing/checkout", { planKey: "premium" }), 401);
      await expectStatus(alice.req("POST", "/v2/billing/checkout", { planKey: "team" }), 404);
      await expectStatus(alice.req("POST", "/v2/billing/checkout", { planKey: "nope" }), 404);
      await expectStatus(alice.req("POST", "/v2/billing/checkout", { planKey: "premium", amountMinor: 1 }), 400);
      await expectStatus(alice.req("POST", "/v2/billing/checkout", { planKey: "premium", accountId: bob.accountId }), 400);
      await expectStatus(alice.req("POST", "/v2/billing/checkout", { planKey: "premium", priceRef: "price_cheap" }), 400);
    });

    it("creates one Stripe customer and a hosted Checkout at the catalog's price, tied to our checkout id", async () => {
      const started = await alice.req("POST", "/v2/billing/checkout", { planKey: "premium" });
      firstCheckout = started.checkoutId;
      expect(started.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
      expect(stripe.customers).toEqual([{ email: alice.email, name: "alice", metadata: { meldiq_owner_kind: "account", meldiq_owner_id: alice.accountId } }]);
      const s = stripe.sessions.at(-1)!;
      expect(s.params).toMatchObject({
        mode: "subscription",
        customer: "cus_fake_1",
        client_reference_id: firstCheckout,
        line_items: [{ price: "price_premium_month", quantity: 1 }],
        subscription_data: { metadata: { meldiq_checkout: firstCheckout, meldiq_owner_kind: "account", meldiq_owner_id: alice.accountId }, trial_period_days: 7 },
        success_url: `${RETURN}?checkout=success`,
        cancel_url: `${RETURN}?checkout=canceled`,
        allow_promotion_codes: false,
      });
      expect(s.key).toBe(`meldiq-checkout-${firstCheckout}`);
    });

    it("supersedes an unfinished checkout instead of opening a second payment page, and reuses the customer", async () => {
      const again = await alice.req("POST", "/v2/billing/checkout", { planKey: "premium" });
      checkoutId = again.checkoutId;
      expect(stripe.expired).toEqual([stripe.sessions.at(-2)!.id]);
      expect(stripe.customers).toHaveLength(1);
      expect(stripe.sessions.at(-1)!.params.customer).toBe("cus_fake_1");
      expect(h.ctx.db.prepare("SELECT status FROM billing_checkouts WHERE id = ?").get(firstCheckout)).toEqual({ status: "superseded" });
    });

    it("grants nothing when the browser comes back from Checkout", async () => {
      expect((await entitlements(alice)).personal.plan).toBeNull();
      const summary = await alice.req("GET", "/v2/billing/account");
      expect(OwnerBilling.safeParse(summary).success).toBe(true);
      expect(summary).toMatchObject({ subscription: null, portal: true });
    });

    it("refuses unsigned webhooks and never attaches a subscription without our checkout", async () => {
      const event = stripeEvent("customer.subscription.created", stripeSubscription({ id: "sub_rogue", price: "price_premium_month", status: "active", checkout: null, customer: "cus_fake_1" }));
      const unsigned = await h.app.inject({ method: "POST", url: "/v1/billing/webhooks/stripe", payload: JSON.stringify(event), headers: { "content-type": "application/json" } });
      expect(unsigned.statusCode).toBe(400);
      expect((await deliver(event)).body).toMatchObject({ received: true, status: "failed" });
      // Metadata naming an owner is not a checkout.
      const forged = stripeSubscription({ id: "sub_forged", price: "price_premium_month", status: "active", checkout: "chk_made_up", customer: "cus_x" });
      (forged.metadata as Record<string, string>).meldiq_owner_id = bob.accountId;
      expect((await deliver(stripeEvent("customer.subscription.created", forged))).body.status).toBe("failed");
      expect((await entitlements(bob)).personal.plan).toBeNull();
    });

    it("activates from verified events, whatever order they arrive in, and ignores duplicates", async () => {
      const t = nextCreated();
      lastCreated += 2;
      const sub = (status: string) => stripeSubscription({ id: "sub_alice", price: "price_premium_month", status, checkout: checkoutId, customer: "cus_fake_1" });
      const created = stripeEvent("customer.subscription.created", sub("incomplete"), t);
      const active = stripeEvent("customer.subscription.updated", sub("active"), t + 2);
      expect((await deliver(active)).body).toEqual({ received: true, duplicate: false, status: "processed" });
      expect((await deliver(created)).body.status).toBe("ignored");
      expect((await deliver(active)).body).toEqual({ received: true, duplicate: true, status: "processed" });
      const e = await entitlements(alice);
      expect(e.personal).toMatchObject({ plan: { key: "premium" }, standing: "entitled", renews: true, quotaPlanId, subscription: { status: "active", provider: "stripe", interval: "month" } });
      expect(e.personal.accessUntil).toBeGreaterThan(Date.now() + 29 * DAY_MS);
      expect(historyOf("sub_alice").map((r) => [r.from_status, r.to_status])).toEqual([[null, "active"]]);
    });

    it("gives every device of the same account the same answer", async () => {
      const phone = new AccountClient(h.baseUrl, alice.email, PASSWORD, "alice");
      await phone.signIn();
      expect(phone.sessionId).not.toBe(alice.sessionId);
      const [a, b] = await Promise.all([entitlements(alice), entitlements(phone)]);
      expect(b.revision).toBe(a.revision);
      expect(b.personal).toEqual(a.personal);
      // Someone else's session sees nothing of it.
      expect((await entitlements(bob)).personal.plan).toBeNull();
    });

    it("puts the person on the plan's quota plan once the account has an encryption identity", async () => {
      await alice.setUpIdentity();
      await alice.req("GET", "/v2/billing/entitlements");
      expect(h.ctx.quotas.planOf({ type: "user", id: alice.userId })).toBe(quotaPlanId);
      expect(h.ctx.quotas.planOf({ type: "user", id: orgMember.userId })).toBeNull();
    });

    it("records renewals and invoices from the provider", async () => {
      const periodEnd = Date.now() + 61 * DAY_MS;
      await deliver(stripeEvent("customer.subscription.updated", stripeSubscription({ id: "sub_alice", price: "price_premium_month", status: "active", checkout: checkoutId, customer: "cus_fake_1", periodEnd })));
      const r = await deliver(
        stripeEvent("invoice.paid", {
          id: "in_alice_2",
          object: "invoice",
          status: "paid",
          currency: "usd",
          amount_due: 500,
          amount_paid: 500,
          total_taxes: [],
          period_start: secs(Date.now()),
          period_end: secs(periodEnd),
          created: secs(Date.now()),
          status_transitions: { finalized_at: secs(Date.now()), paid_at: secs(Date.now()) },
          parent: { type: "subscription_details", subscription_details: { subscription: "sub_alice" } },
        }),
      );
      expect(r.body.status).toBe("processed");
      expect((await entitlements(alice)).personal.accessUntil).toBe(secs(periodEnd) * 1000);
      expect((await alice.req("GET", "/v2/billing/account")).invoices).toMatchObject([{ status: "paid", amountPaidMinor: 500, currency: "USD" }]);
    });

    it("keeps the plan through the grace days after a failed payment, then not once retries are exhausted", async () => {
      const sub = (status: string) => stripeSubscription({ id: "sub_alice", price: "price_premium_month", status, checkout: checkoutId, customer: "cus_fake_1", periodEnd: Date.now() + 61 * DAY_MS });
      await deliver(stripeEvent("customer.subscription.updated", sub("past_due")));
      let e = await entitlements(alice);
      expect(e.personal).toMatchObject({ plan: { key: "premium" }, standing: "grace", renews: false });
      expect(e.personal.accessUntil).toBeLessThanOrEqual(Date.now() + 3 * DAY_MS);
      await deliver(stripeEvent("customer.subscription.updated", sub("unpaid")));
      e = await entitlements(alice);
      expect(e.personal).toMatchObject({ plan: null, standing: "not_entitled", quotaPlanId: null });
      expect(h.ctx.quotas.planOf({ type: "user", id: alice.userId })).toBeNull();
      await deliver(stripeEvent("customer.subscription.updated", sub("active")));
      expect((await entitlements(alice)).personal.standing).toBe("entitled");
    });

    it("changes plan when the provider says so (monthly to yearly)", async () => {
      await deliver(stripeEvent("customer.subscription.updated", stripeSubscription({ id: "sub_alice", price: "price_premium_year", status: "active", checkout: checkoutId, customer: "cus_fake_1" })));
      const e = await entitlements(alice);
      expect(e.personal).toMatchObject({ plan: { key: "premiumyear" }, subscription: { interval: "year" } });
      expect(JSON.parse(historyOf("sub_alice").at(-1)!.detail)).toHaveProperty("planVersion");
    });

    it("records a refund in the history without changing access", async () => {
      expect((await deliver(stripeEvent("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_fake_1", currency: "usd", amount: 500, amount_refunded: 500, refunded: true }))).body.status).toBe("processed");
      expect(JSON.parse(historyOf("sub_alice").at(-1)!.detail)).toEqual({ refund: { ref: "ch_1", state: "refunded", currency: "USD", amountMinor: 500, affectedMinor: 500 } });
      expect((await entitlements(alice)).personal.standing).toBe("entitled");
    });

    it("keeps access to the end of the paid period after cancelling, then ends it", async () => {
      const periodEnd = Date.now() + 10 * DAY_MS;
      await deliver(stripeEvent("customer.subscription.updated", stripeSubscription({ id: "sub_alice", price: "price_premium_year", status: "active", checkout: checkoutId, customer: "cus_fake_1", periodEnd, cancelAtPeriodEnd: true })));
      let e = await entitlements(alice);
      expect(e.personal).toMatchObject({ plan: { key: "premiumyear" }, standing: "entitled", renews: false, accessUntil: secs(periodEnd) * 1000 });
      await deliver(stripeEvent("customer.subscription.deleted", stripeSubscription({ id: "sub_alice", price: "price_premium_year", status: "canceled", checkout: checkoutId, customer: "cus_fake_1", periodEnd })));
      e = await entitlements(alice);
      expect(e.personal).toMatchObject({ plan: null, standing: "none" });
      // A later checkout gets no second trial.
      await alice.req("POST", "/v2/billing/checkout", { planKey: "premium" });
      expect(stripe.sessions.at(-1)!.params.subscription_data).not.toHaveProperty("trial_period_days");
      expect(stripe.customers).toHaveLength(1);
    });

    it("opens the customer portal only for the account's own customer, returning to the fixed page", async () => {
      const { url } = await alice.req("POST", "/v2/billing/portal", {});
      expect(url).toMatch(/^https:\/\/billing\.stripe\.test\//);
      expect(stripe.portals.at(-1)).toEqual({ customer: "cus_fake_1", return_url: RETURN });
      await expectStatus(bob.req("POST", "/v2/billing/portal", {}), 404);
      await expectStatus(bob.req("POST", "/v2/billing/portal", { customer: "cus_fake_1" }), 400);
    });
  });

  describe("reconciliation", () => {
    it("reads a subscription from Stripe when the checkout finished but its subscription event never came", async () => {
      const carol = await signedIn("carol");
      const { checkoutId } = await carol.req("POST", "/v2/billing/checkout", { planKey: "premium" });
      const sub = stripeSubscription({ id: "sub_carol", price: "price_premium_month", status: "trialing", checkout: checkoutId, customer: "cus_carol", trialEnd: secs(Date.now() + 7 * DAY_MS) });
      stripe.subscriptions.set("sub_carol", sub as unknown as Stripe.Subscription);
      const r = await deliver(stripeEvent("checkout.session.completed", { id: stripe.sessions.at(-1)!.id, object: "checkout.session", mode: "subscription", client_reference_id: checkoutId, subscription: "sub_carol", customer: "cus_carol" }));
      expect(r.body.status).toBe("processed");
      await until(async () => !!(await carol.req("GET", "/v2/billing/entitlements")).personal.plan);
      expect((await entitlements(carol)).personal).toMatchObject({ plan: { key: "premium" }, standing: "entitled", subscription: { status: "trialing" } });
      // Asking again reads the same state and changes nothing.
      expect(await carol.req("POST", "/v2/billing/sync", {})).toEqual({ checked: 1 });
      expect(historyOf("sub_carol")).toHaveLength(1);
      // A subscription that still renews keeps the account from being deleted (the provider would go on charging).
      const refused = await expectStatus(carol.req("DELETE", "/v2/account", { password: PASSWORD, confirmEmail: carol.email }), 409);
      expect(refused.error.code).toBe("subscription_active");
    });

    it("forgets nothing an unknown checkout completes, and never reads subscriptions a client names", async () => {
      expect((await deliver(stripeEvent("checkout.session.completed", { id: "cs_elsewhere", object: "checkout.session", mode: "subscription", client_reference_id: null, subscription: "sub_x" }))).body.status).toBe("ignored");
      await expectStatus(bob.req("POST", "/v2/billing/sync", { subscription: "sub_carol" }), 400);
      expect(await bob.req("POST", "/v2/billing/sync", {})).toEqual({ checked: 0 });
    });
  });

  describe("an organization's subscription", () => {
    it("is bought by an owner only; members can't, outsiders don't learn the organization exists", async () => {
      await expectStatus(orgMember.req("POST", "/v2/billing/checkout", { planKey: "team", orgId }), 403);
      await expectStatus(bob.req("POST", "/v2/billing/checkout", { planKey: "team", orgId }), 404);
      await expectStatus(orgOwner.req("POST", "/v2/billing/checkout", { planKey: "premium", orgId }), 404);
      await expectStatus(orgMember.req("GET", `/v2/billing/orgs/${orgId}`), 403);
      await expectStatus(orgMember.req("POST", "/v2/billing/portal", { orgId }), 403);
    });

    it("gives its plan and limits to its members, keeps billing details to owners, and stays apart from personal plans", async () => {
      const { checkoutId } = await orgOwner.req("POST", "/v2/billing/checkout", { planKey: "team", orgId });
      expect(stripe.customers.at(-1)).toMatchObject({ name: "Billing Org", metadata: { meldiq_owner_kind: "org", meldiq_owner_id: orgId } });
      await deliver(stripeEvent("customer.subscription.created", stripeSubscription({ id: "sub_org", price: "price_team_month", status: "active", checkout: checkoutId, customer: "cus_org" })));
      const owner = await entitlements(orgOwner);
      const member = await entitlements(orgMember);
      const o = owner.organizations.find((x: any) => x.orgId === orgId);
      const m = member.organizations.find((x: any) => x.orgId === orgId);
      expect(o).toMatchObject({ role: "OWNER", manageBilling: true, plan: { key: "team" }, subscription: { status: "active" } });
      expect(m).toMatchObject({ role: "MEMBER", manageBilling: false, plan: { key: "team" }, subscription: null });
      expect(m.limits.find((l: any) => l.key === "members")).toEqual({ key: "members", limit: 3, source: "plan" });
      expect(owner.personal.plan).toBeNull();
      expect(member.personal.plan).toBeNull();
      // The same membership limit is enforced on the server, not only shown.
      expect((await orgOwner.req("GET", `/v1/orgs/${orgId}/plan`)).plan).toEqual({ name: "Meldiq team" });
    });

    it("loses its plan at once when payment fails with no grace days, and members follow membership", async () => {
      await deliver(stripeEvent("customer.subscription.updated", stripeSubscription({ id: "sub_org", price: "price_team_month", status: "past_due", checkout: null, customer: "cus_org" })));
      const m = (await entitlements(orgMember)).organizations.find((x: any) => x.orgId === orgId);
      expect(m).toMatchObject({ plan: null, standing: "grace_ended" });
      expect(m.limits.find((l: any) => l.key === "members").source).not.toBe("plan");
      await orgOwner.req("DELETE", `/v1/orgs/${orgId}/members/${orgMember.userId}`);
      expect((await entitlements(orgMember)).organizations.find((x: any) => x.orgId === orgId)).toBeUndefined();
    });
  });
});

/**
 * A stand-in for a future app-store provider (Google Play, Apple): it "verifies" a purchase notification signed with a
 * key only the store and the server know, and normalizes it into the same model. Isolated test adapter: it proves the
 * core takes another provider without change, not that any store integration exists.
 */
class TestStoreProvider implements BillingProvider {
  readonly id = "teststore";
  readonly mode = "test" as const;
  constructor(private readonly key: string) {}

  verifyWebhook(headers: Readonly<Record<string, string | string[] | undefined>>, rawBody: string): NormalizedEvent {
    const sig = headers["x-store-signature"];
    if (typeof sig !== "string") throw new WebhookRejected("missing_signature");
    const expected = createHmac("sha256", this.key).update(rawBody).digest();
    const given = Buffer.from(sig, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookRejected("bad_signature");
    const n = JSON.parse(rawBody) as { notificationId: string; at: number; purchase: { token: string; product: string; state: string; appAccountToken: string; expiresAt: number } };
    const status = n.purchase.state === "ACTIVE" ? "active" : n.purchase.state === "GRACE" ? "past_due" : "canceled";
    return {
      ref: n.notificationId,
      type: "store.purchase",
      createdAt: n.at,
      kind: "subscription",
      subscription: {
        ref: n.purchase.token,
        customerRef: null,
        status,
        priceRef: n.purchase.product,
        // The app passes our checkout id as the store's account token, as Play's obfuscatedAccountId or StoreKit's appAccountToken would.
        checkoutRef: n.purchase.appAccountToken,
        currentPeriodStart: n.at,
        currentPeriodEnd: n.purchase.expiresAt,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
      },
    };
  }

  async createCheckout(input: CheckoutInput) {
    return { sessionRef: `store_intent_${input.reference}`, url: null };
  }
}

describe("another provider normalized into the same entitlements (isolated test adapter)", () => {
  let h: Harness;
  const mailer = new MemoryMailer();
  const KEY = "store-test-key-0123456789abcdef0123456789";
  let dana: AccountClient;

  const notify = async (body: object, key = KEY) => {
    const payload = JSON.stringify(body);
    const sig = createHmac("sha256", key).update(payload).digest("hex");
    const res = await h.app.inject({ method: "POST", url: "/v1/billing/webhooks/teststore", payload, headers: { "content-type": "application/json", "x-store-signature": sig } });
    return { status: res.statusCode, body: res.json() };
  };

  beforeAll(async () => {
    h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, WORKFLOW_TICK_MS: "0" }, { mailer, billingProvider: new TestStoreProvider(KEY) });
    const admin = await consoleAdmin(h, mailer, "billing_admin", "storeadmin");
    const r = await admin.browser.expect(200, "POST", "/admin/v1/billing/plans", {
      key: "premium",
      name: "Premium",
      description: "",
      segment: "",
      public: true,
      audience: "personal",
      terms: { interval: "month", currency: "USD", amountMinor: 500, providerPriceRef: "store.premium.monthly", trialDays: 0, graceDays: 3, limits: {}, notes: "" },
      reason: REASON,
    });
    await admin.browser.expect(200, "POST", `/admin/v1/billing/plans/${r.id}/publish`, { reason: REASON });
    dana = new AccountClient(h.baseUrl, email("dana"), PASSWORD, "dana");
    await dana.signUp(mailer);
    await dana.signIn();
  });
  afterAll(async () => h.close());

  it("grants nothing for an unverified purchase, and the verified one exactly once", async () => {
    const { checkoutId } = await dana.req("POST", "/v2/billing/checkout", { planKey: "premium" });
    const purchase = { notificationId: "n1", at: Date.now(), purchase: { token: "gpa.1", product: "store.premium.monthly", state: "ACTIVE", appAccountToken: checkoutId, expiresAt: Date.now() + 30 * DAY_MS } };
    expect((await notify(purchase, "a-key-the-client-made-up-0123456789abcdef")).status).toBe(400);
    expect((await dana.req("GET", "/v2/billing/entitlements")).personal.plan).toBeNull();
    expect((await notify(purchase)).body.status).toBe("processed");
    expect((await notify(purchase)).body.duplicate).toBe(true);
    const again = { ...purchase, notificationId: "n2", at: Date.now() + 1 };
    expect((await notify(again)).body.status).toBe("processed");
    const e = await dana.req("GET", "/v2/billing/entitlements");
    expect(e.personal).toMatchObject({ plan: { key: "premium" }, standing: "entitled", subscription: { provider: "teststore" } });
    expect(h.ctx.db.prepare("SELECT COUNT(*) n FROM billing_subscriptions").get()).toEqual({ n: 1 });
  });
});
