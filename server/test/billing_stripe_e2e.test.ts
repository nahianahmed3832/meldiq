import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STRIPE_SIGNATURE_HEADER, STRIPE_WEBHOOK_EVENTS, StripeProvider, stripeApi, stripeKeyMode, type StripeApi } from "../src/modules/billing/providers/stripe.js";
import { AccountEntitlements } from "../src/shared/contracts/http/billing.js";
import { MojoMe } from "../src/shared/contracts/http/mojo.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Stripe Billing end to end in Stripe's test mode (docs/BILLING.md › Stripe): real Checkout Sessions, real
 * subscriptions on test clocks, real invoices and test cards, and Stripe's own signed webhooks delivered by
 * `stripe listen` to this test server. Opt-in: STRIPE_E2E_KEY_FILE names a file with a line
 * `STRIPE_SECRET_KEY=sk_test_…` (test keys only; a live key is refused). Needs the Stripe CLI on the PATH.
 *
 * What it can't do: pay on Stripe's hosted Checkout page (that needs a browser). Instead it creates the subscription
 * Checkout would create, with our checkout id in its metadata, the one thing Meldiq reads.
 */
const KEY = readTestKey(process.env.STRIPE_E2E_KEY_FILE);
const RETURN = "https://meldiq.test/account/billing";
const WEB_RETURN = "https://web.meldiq.test/settings/mojo";
const SLOW = 180_000;
const HOUR_S = 3600;
// Prices this test reuses at Stripe, never the real Mojo prices (lookup keys meldiq_mojo_*).
const E2E_PRICES = [
  { key: "go", lookupKey: "meldiq_e2e_go_monthly", amountMinor: 99, name: "Mojo Go (e2e test)" },
  { key: "plus", lookupKey: "meldiq_e2e_plus_monthly", amountMinor: 399, name: "Mojo Plus (e2e test)" },
  { key: "spark", lookupKey: "meldiq_e2e_spark_monthly", amountMinor: 99, name: "Meldiq Spark (e2e test)" },
] as const;

function readTestKey(file: string | undefined): string | null {
  if (!file) return null;
  const line = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith("STRIPE_SECRET_KEY="));
  const key = line?.split("=")[1]?.trim() ?? "";
  if (stripeKeyMode(key) !== "test") throw new Error(`${file}: STRIPE_SECRET_KEY must be a Stripe test key (sk_test_… or rk_test_…)`);
  return key;
}

/** Polls [check] until it holds: webhooks arrive through the Stripe CLI a few seconds after the change. */
async function until(what: string, check: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(!KEY)("Stripe test mode end to end (stripe listen)", () => {
  // Made in beforeAll: the SDK refuses to construct without a key, and this body runs even when skipped.
  let stripe: Stripe;
  const cliEnv = { ...process.env, STRIPE_API_KEY: KEY ?? "" };
  const mailer = new MemoryMailer();
  const clocks: string[] = [];
  const prices = {} as Record<(typeof E2E_PRICES)[number]["key"], string>;
  let whsec: string;
  let listener: ChildProcess;
  let h: Harness;
  let alice: AccountClient, bob: AccountClient;

  /** The real Stripe API, except that every customer Meldiq creates lives on its own test clock. */
  const clockedApi = (real: StripeApi): StripeApi => ({
    ...real,
    createCustomer: async (params, idempotencyKey) => {
      const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: "meldiq e2e" });
      clocks.push(clock.id);
      return real.createCustomer({ ...params, test_clock: clock.id }, idempotencyKey);
    },
  });

  const ensurePrice = async (p: (typeof E2E_PRICES)[number]) => {
    const found = (await stripe.prices.list({ lookup_keys: [p.lookupKey], active: true, limit: 1 })).data[0];
    if (found) return found.id;
    const created = await stripe.prices.create({ currency: "usd", unit_amount: p.amountMinor, recurring: { interval: "month" }, lookup_key: p.lookupKey, product_data: { name: p.name } });
    return created.id;
  };

  const publish = async (key: string, price: string, amountMinor: number, graceDays: number) => {
    const terms = { interval: "month" as const, currency: "USD", amountMinor, providerPriceRef: price, trialDays: 0, graceDays, limits: {}, notes: "" };
    const p = await h.ctx.billing.catalog.create(key, { name: key, description: "", segment: "personal", public: true, audience: "personal" }, terms, "test", Date.now());
    await h.ctx.billing.catalog.publish(p.id, "stripe", "test", Date.now());
  };

  const startListener = (forwardTo: string) =>
    new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn("stripe", ["listen", "--forward-to", forwardTo, "--events", STRIPE_WEBHOOK_EVENTS.join(",")], { env: cliEnv });
      const timer = setTimeout(() => reject(new Error("stripe listen didn't get ready")), 60_000);
      child.stderr.on("data", (d: Buffer) => {
        if (d.toString().includes("Ready!")) {
          clearTimeout(timer);
          resolve(child);
        }
      });
      child.on("exit", (code) => reject(new Error(`stripe listen exited (${code})`)));
    });

  const entitlements = async (c: AccountClient) => {
    const e = await c.req("GET", "/v2/billing/entitlements");
    expect(AccountEntitlements.safeParse(e).success).toBe(true);
    return e;
  };
  const me = async (c: AccountClient) => {
    const m = await c.req("GET", "/v2/mojo/me");
    expect(MojoMe.safeParse(m).success).toBe(true);
    return m;
  };
  const customerOf = (c: AccountClient) => h.ctx.billing.rows.get<{ provider_customer_ref: string }>("billing_customers", { provider: "stripe", owner_kind: "account", owner_id: c.accountId })!.provider_customer_ref;
  const invoicesOf = async (c: AccountClient) => ((await c.req("GET", "/v2/billing/account")).invoices ?? []) as { status: string; amountPaidMinor: number }[];
  const recorded = (eventRef: string) => !!h.ctx.billing.rows.get("billing_provider_events", { provider: "stripe", event_ref: eventRef });

  /** Moves a customer's test clock to [to] (unix seconds) and waits until Stripe has run everything due by then. */
  const advance = async (customer: string, to: number) => {
    const c = await stripe.customers.retrieve(customer);
    const clock = (c as Stripe.Customer).test_clock as string;
    await stripe.testHelpers.testClocks.advance(clock, { frozen_time: to });
    await until("the test clock", async () => (await stripe.testHelpers.testClocks.retrieve(clock)).status === "ready");
  };
  const periodEnd = async (subRef: string) => (await stripe.subscriptions.retrieve(subRef)).items.data[0]!.current_period_end;

  /** What Stripe's hosted Checkout does once paid: the subscription, carrying our checkout id. */
  const subscribeLikeCheckout = async (c: AccountClient, checkoutId: string, price: string, quantity = 1) => {
    const customer = customerOf(c);
    const card = await stripe.paymentMethods.attach("pm_card_visa", { customer });
    const sub = await stripe.subscriptions.create({
      customer,
      items: [{ price, quantity }],
      default_payment_method: card.id,
      metadata: { meldiq_checkout: checkoutId, meldiq_owner_kind: "account", meldiq_owner_id: c.accountId },
    });
    return { sub, card: card.id };
  };

  beforeAll(async () => {
    stripe = new Stripe(KEY!, { maxNetworkRetries: 2 });
    for (const p of E2E_PRICES) prices[p.key] = await ensurePrice(p);
    whsec = execFileSync("stripe", ["listen", "--print-secret"], { env: cliEnv }).toString().trim();
    const provider = new StripeProvider({ secretKey: KEY!, webhookSecret: whsec, allowPromotionCodes: false, api: clockedApi(stripeApi(stripe)) });
    h = await startServer(
      { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: KEY!, STRIPE_WEBHOOK_SECRET: whsec, BILLING_RETURN_URL: RETURN, BILLING_WEB_RETURN_URL: WEB_RETURN },
      { mailer, billingProvider: provider },
    );
    await publish("go", prices.go, 99, 3);
    await publish("plus", prices.plus, 399, 0);
    await publish("spark", prices.spark, 99, 0);
    [alice, bob] = await Promise.all(["e2ealice", "e2ebob"].map((n) => AccountClient.ready(h.baseUrl, mailer, n)));
    const orgId = (await alice.req("POST", "/v1/orgs", { name: "Stripe e2e" })).org.id;
    const code = (await alice.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
    await bob.req("POST", "/v1/invites/accept", { code });
    listener = await startListener(`${h.baseUrl}/v1/billing/webhooks/stripe`);
  }, SLOW);

  afterAll(async () => {
    listener?.kill();
    // Deleting a test clock deletes its customers and their subscriptions at Stripe.
    await Promise.allSettled(clocks.map((id) => stripe.testHelpers.testClocks.del(id)));
    await h?.close();
  }, SLOW);

  describe("a Mojo Go subscription", () => {
    let checkoutId: string;
    let subRef: string;
    let card: string;

    it("opens a real Checkout Session at the catalog's price, tied to our checkout id, returning to the web Mojo page", async () => {
      const first = await alice.req("POST", "/v2/billing/checkout", { planKey: "go", returnTo: "web" });
      const again = await alice.req("POST", "/v2/billing/checkout", { planKey: "go", returnTo: "web" });
      checkoutId = again.checkoutId;
      expect(again.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      const sessions = (await stripe.checkout.sessions.list({ customer: customerOf(alice), limit: 10 })).data;
      const firstSession = sessions.find((s) => s.client_reference_id === first.checkoutId)!;
      const session = sessions.find((s) => s.client_reference_id === checkoutId)!;
      // A newer checkout ends the unfinished one at Stripe, so two payment pages can't both become subscriptions.
      expect(firstSession.status).toBe("expired");
      expect(session).toMatchObject({ mode: "subscription", status: "open", livemode: false, success_url: `${WEB_RETURN}?checkout=success`, cancel_url: `${WEB_RETURN}?checkout=canceled` });
      const items = await stripe.checkout.sessions.listLineItems(session.id);
      expect(items.data.map((i) => [i.price?.id, i.quantity])).toEqual([[prices.go, 1]]);
      expect((await entitlements(alice)).personal.plan).toBeNull();
    }, SLOW);

    it("grants Mojo Go once Stripe's signed events arrive, and records the first invoice", async () => {
      const subscribed = await subscribeLikeCheckout(alice, checkoutId, prices.go);
      subRef = subscribed.sub.id;
      card = subscribed.card;
      await until("the plan", async () => (await entitlements(alice)).personal.standing === "entitled");
      expect((await entitlements(alice)).personal).toMatchObject({ plan: { key: "go" }, renews: true, subscription: { status: "active", provider: "stripe" } });
      // An invoice that arrives before its subscription is retried by the cleanup job (a minute later).
      await until("the first invoice", async () => (await invoicesOf(alice)).some((i) => i.status === "paid" && i.amountPaidMinor === 99), SLOW - 10_000);
    }, SLOW);

    it("renews when the test clock passes the period's end", async () => {
      const before = (await entitlements(alice)).personal.accessUntil as number;
      await advance(customerOf(alice), (await periodEnd(subRef)) + 3 * HOUR_S);
      await until("the renewal", async () => ((await entitlements(alice)).personal.accessUntil as number) > before);
      await until("the renewal invoice", async () => (await invoicesOf(alice)).filter((i) => i.status === "paid").length >= 2, SLOW - 10_000);
    }, SLOW);

    it("keeps the plan through the grace days when a renewal payment fails, and again once it's paid", async () => {
      const failing = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: customerOf(alice) });
      await stripe.subscriptions.update(subRef, { default_payment_method: failing.id });
      await advance(customerOf(alice), (await periodEnd(subRef)) + 3 * HOUR_S);
      await until("past due", async () => (await entitlements(alice)).personal.standing === "grace");
      expect((await entitlements(alice)).personal).toMatchObject({ plan: { key: "go" }, renews: false });
      await until("the failed invoice", async () => (await invoicesOf(alice)).some((i) => i.status === "payment_failed"));

      const latest = (await stripe.subscriptions.retrieve(subRef)).latest_invoice as string;
      await stripe.subscriptions.update(subRef, { default_payment_method: card });
      await stripe.invoices.pay(latest, { payment_method: card });
      await until("active again", async () => (await entitlements(alice)).personal.standing === "entitled");
    }, SLOW);

    it("keeps access to the period's end after cancelling, and ends it when Stripe cancels", async () => {
      await stripe.subscriptions.update(subRef, { cancel_at_period_end: true });
      await until("the scheduled cancellation", async () => (await entitlements(alice)).personal.renews === false);
      expect((await entitlements(alice)).personal.standing).toBe("entitled");
      await stripe.subscriptions.cancel(subRef);
      await until("the cancellation", async () => (await entitlements(alice)).personal.standing === "none");
    }, SLOW);

    it("stored every subscription event once, acknowledges a resent one, and ignores an older snapshot arriving late", async () => {
      const events = (await stripe.events.list({ type: "customer.subscription.*", limit: 100 })).data
        .filter((e) => (e.data.object as Stripe.Subscription).id === subRef)
        .sort((a, b) => a.created - b.created);
      expect(events.length).toBeGreaterThanOrEqual(4);
      await until("every event stored", async () => events.every((e) => recorded(e.id)));

      const deliver = async (event: object) => {
        const payload = JSON.stringify(event);
        const headers = { "content-type": "application/json; charset=utf-8", [STRIPE_SIGNATURE_HEADER]: Stripe.webhooks.generateTestHeaderString({ payload, secret: whsec }) };
        return (await h.app.inject({ method: "POST", url: "/v1/billing/webhooks/stripe", payload, headers })).json();
      };
      const newest = events.at(-1)!;
      expect(await deliver(newest)).toMatchObject({ received: true, duplicate: true });
      // Stripe's first snapshot (still active) arriving after the cancellation, as if delivered late.
      expect(await deliver({ ...events[0]!, id: `${events[0]!.id}_late` })).toMatchObject({ received: true, duplicate: false, status: "ignored" });
      expect((await entitlements(alice)).personal.standing).toBe("none");
    }, SLOW);
  });

  describe("Meldiq Spark and gifts", () => {
    it("sells Sparks by quantity and counts them once Stripe confirms", async () => {
      const started = await bob.req("POST", "/v2/mojo/sparks/checkout", { quantity: 2, returnTo: "web" });
      const session = (await stripe.checkout.sessions.list({ customer: customerOf(bob), limit: 5 })).data.find((s) => s.client_reference_id === started.checkoutId)!;
      expect(session.mode).toBe("subscription");
      expect((await stripe.checkout.sessions.listLineItems(session.id)).data.map((i) => [i.price?.id, i.quantity])).toEqual([[prices.spark, 2]]);
      await subscribeLikeCheckout(bob, started.checkoutId, prices.spark, 2);
      await until("the Sparks", async () => (await me(bob)).sparks.purchased === 2);
      expect((await me(bob)).plan).toBe("free");
    }, SLOW);

    it("prices a gift on the server as a one-time payment, and records it expired when its page runs out", async () => {
      const started = await bob.req("POST", "/v2/mojo/gifts", { recipientUserId: alice.userId, planKey: "plus", months: 3, note: "e2e", returnTo: "web" });
      const session = (await stripe.checkout.sessions.list({ limit: 20 })).data.find((s) => s.client_reference_id === started.giftId)!;
      expect(session).toMatchObject({ mode: "payment", amount_total: 399 * 3, currency: "usd", success_url: expect.stringContaining(`${WEB_RETURN}?gift=success`) });
      await stripe.checkout.sessions.expire(session.id);
      await until("the expired gift", async () => (await me(bob)).gifts.sent.some((g: { id: string; status: string }) => g.id === started.giftId && g.status === "expired"));
      expect((await me(alice)).gifts.received).toEqual([]);
    }, SLOW);
  });
});
