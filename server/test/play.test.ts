import { createSign, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlayConfig } from "../src/modules/billing/config.js";
import {
  accountToken,
  type GooglePlayApi,
  type JwksSource,
  type PlayProductPurchase,
  type PlaySubscription,
  playStatus,
  tokenHash,
  verifyPushToken,
} from "../src/modules/billing/providers/googlePlay.js";
import { STRIPE_SIGNATURE_HEADER, StripeProvider, type StripeApi } from "../src/modules/billing/providers/stripe.js";
import { WebhookRejected } from "../src/modules/billing/providers/types.js";
import { MojoMe, PlayIntentStarted, PlayVerified } from "../src/shared/contracts/http/mojo.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Meldiq Mojo bought on Google Play (docs/MOJO_ANDROID.md). Google's Developer API is a fake that answers what a test
 * sets; Pub/Sub pushes carry OIDC tokens signed with a test key the way Google signs them. These prove Meldiq's handling:
 * nothing is granted without Google's own answer, purchases belong to the account that started them, acknowledgement
 * and consumption follow the grant. They don't prove a live Play Console setup (that needs an internal-testing build).
 */
const PACKAGE = "com.meldiq.android";
const SECRET = "play-account-token-secret-for-tests-only-0123456789";
const AUDIENCE = "https://msg.meldiq.test/v1/billing/webhooks/google_play";
const PUSHER = "rtdn-push@meldiq-test.iam.gserviceaccount.com";
const WHSEC = "whsec_playtestsecretfortestsonly0123456789";
const SK = "sk_test_meldiqplayfaketestkey0123456789";
const DAY_MS = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

class FakePlay implements GooglePlayApi {
  subs = new Map<string, PlaySubscription>();
  products = new Map<string, PlayProductPurchase>();
  acked: string[] = [];
  consumed: string[] = [];
  down = false;
  async getSubscription(token: string) {
    if (this.down) throw new Error("google is down");
    return structuredClone(this.subs.get(token) ?? null);
  }
  async acknowledgeSubscription(_productId: string, token: string) {
    if (this.down) throw new Error("google is down");
    this.acked.push(token);
    const s = this.subs.get(token);
    if (s) s.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
  }
  async getProduct(_productId: string, token: string) {
    if (this.down) throw new Error("google is down");
    return structuredClone(this.products.get(token) ?? null);
  }
  async consumeProduct(_productId: string, token: string) {
    this.consumed.push(token);
    const p = this.products.get(token);
    if (p) p.consumptionState = 1;
  }
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks: JwksSource = { keys: async () => [{ ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "test-key" }] };

function oidc(claims: Record<string, unknown> = {}, kid = "test-key"): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: "https://accounts.google.com", aud: AUDIENCE, email: PUSHER, email_verified: true, iat: now, exp: now + 3600, ...claims };
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
}

class QuietStripe implements StripeApi {
  private n = 0;
  async createCustomer() {
    return { id: `cus_play_${++this.n}` };
  }
  async createCheckoutSession() {
    const id = `cs_test_play_${++this.n}`;
    return { id, url: `https://checkout.stripe.test/${id}` };
  }
  async expireCheckoutSession() {}
  async createPortalSession() {
    return { url: "https://billing.stripe.test/p" };
  }
  async retrieveSubscription() {
    return null;
  }
}

describe("Meldiq Mojo on Google Play", () => {
  let h: Harness;
  const mailer = new MemoryMailer();
  const google = new FakePlay();
  let n = 0;
  let buyer: AccountClient, other: AccountClient, friend: AccountClient, webBuyer: AccountClient, gifter: AccountClient;

  const play: PlayConfig = { packageName: PACKAGE, accountTokenSecret: SECRET, api: google, rtdn: { audience: AUDIENCE, email: PUSHER }, jwks };

  /** The app's side: an intent, then Google's sheet (the fake records the purchase as Google would). */
  const buySubscription = async (c: AccountClient, productId: string, opts: { replacing?: string; linked?: string; state?: string } = {}) => {
    const kind = productId.startsWith("spark") ? "spark" : "plan";
    const intent = await c.req("POST", "/v2/mojo/play/intent", { kind, productId, replacing: opts.replacing ?? null });
    expect(PlayIntentStarted.safeParse(intent).success).toBe(true);
    expect(intent.accountToken).toBe(accountToken(SECRET, c.accountId));
    const token = `play-token-${++n}-${"x".repeat(40)}`;
    google.subs.set(token, {
      subscriptionState: opts.state ?? "SUBSCRIPTION_STATE_ACTIVE",
      startTime: iso(Date.now()),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      linkedPurchaseToken: opts.linked,
      externalAccountIdentifiers: { obfuscatedExternalAccountId: intent.accountToken, obfuscatedExternalProfileId: intent.reference },
      lineItems: [{ productId, expiryTime: iso(Date.now() + 30 * DAY_MS), autoRenewingPlan: { autoRenewEnabled: true } }],
    });
    return token;
  };

  const verify = async (c: AccountClient, productId: string, purchaseToken: string): Promise<string> => {
    const r = await c.req("POST", "/v2/mojo/play/verify", { productId, purchaseToken });
    expect(PlayVerified.safeParse(r).success).toBe(true);
    return r.status;
  };

  const planOf = async (c: AccountClient) => (await c.req("GET", "/v2/billing/entitlements")).personal;
  const me = async (c: AccountClient) => {
    const m = await c.req("GET", "/v2/mojo/me");
    expect(MojoMe.safeParse(m).success).toBe(true);
    return m;
  };

  const push = (notification: object, token = oidc()) =>
    h.app.inject({
      method: "POST",
      url: "/v1/billing/webhooks/google_play",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { message: { data: Buffer.from(JSON.stringify({ packageName: PACKAGE, eventTimeMillis: String(Date.now()), ...notification })).toString("base64"), messageId: `m${++n}` }, subscription: "projects/x/subscriptions/rtdn" },
    });

  beforeAll(async () => {
    const provider = new StripeProvider({ secretKey: SK, webhookSecret: WHSEC, allowPromotionCodes: false, api: new QuietStripe() });
    h = await startServer(
      { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WHSEC, BILLING_RETURN_URL: "https://meldiq.test/account/billing", WORKFLOW_TICK_MS: "0" },
      { mailer, billingProvider: provider, play },
    );
    // The plans are published once in the catalog (here for Stripe); Google Play sells them under its own product ids.
    for (const [key, price, amount] of [["go", "price_go", 99], ["plus", "price_plus", 399], ["spark", "price_spark", 99]] as const) {
      const terms = { interval: "month" as const, currency: "USD", amountMinor: amount, providerPriceRef: price, trialDays: 0, graceDays: 0, limits: {}, notes: "" };
      const p = await h.ctx.billing.catalog.create(key, { name: key, description: "", segment: "personal", public: true, audience: "personal" }, terms, "test", Date.now());
      await h.ctx.billing.catalog.publish(p.id, "stripe", "test", Date.now());
    }
    [buyer, other, friend, webBuyer, gifter] = await Promise.all(["playbuyer", "playother", "playfriend", "webbuyer", "playgifter"].map((x) => AccountClient.ready(h.baseUrl, mailer, x)));
  });
  afterAll(async () => h.close());

  describe("subscriptions", () => {
    let plusToken = "";

    it("grants Mojo Plus only once Google says it's paid, and then acknowledges it", async () => {
      plusToken = await buySubscription(buyer, "mojo_plus");
      expect((await planOf(buyer)).plan).toBeNull();
      expect(await verify(buyer, "mojo_plus", plusToken)).toBe("granted");
      const p = await planOf(buyer);
      expect(p).toMatchObject({ plan: { key: "plus" }, standing: "entitled", renews: true, subscription: { provider: "google_play", status: "active" } });
      expect(google.acked).toContain(plusToken);
      expect((await me(buyer)).plan).toBe("plus");
      // The raw token is never a reference: subscriptions and events carry its hash.
      const row = h.ctx.billing.rows.get<{ provider_subscription_ref: string }>("billing_subscriptions", { provider: "google_play" })!;
      expect(row.provider_subscription_ref).toBe(tokenHash(plusToken));
      expect(JSON.stringify(h.ctx.billing.rows.all("billing_provider_events", { where: { provider: "google_play" } }))).not.toContain(plusToken);
    });

    it("answers the same again when the app sends the token twice (restore, reconcile)", async () => {
      const acks = google.acked.length;
      expect(await verify(buyer, "mojo_plus", plusToken)).toBe("granted");
      expect(google.acked.length).toBe(acks);
    });

    it("never lets a second account claim the same Google purchase", async () => {
      expect(await verify(other, "mojo_plus", plusToken)).toBe("already_linked");
      expect((await planOf(other)).plan).toBeNull();
    });

    it("refuses a purchase that wasn't started through the account's own intent", async () => {
      const token = `forged-${"y".repeat(40)}`;
      google.subs.set(token, {
        subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
        externalAccountIdentifiers: { obfuscatedExternalAccountId: accountToken(SECRET, other.accountId), obfuscatedExternalProfileId: "chk_made_up" },
        lineItems: [{ productId: "mojo_go", expiryTime: iso(Date.now() + 30 * DAY_MS) }],
      });
      expect(await verify(other, "mojo_go", token)).toBe("invalid");
      expect(google.acked).not.toContain(token);
      expect(await verify(other, "mojo_go", "a-token-google-never-issued")).toBe("invalid");
    });

    it("refuses another account's purchase, even with a real intent", async () => {
      const token = await buySubscription(other, "mojo_go");
      expect(await verify(buyer, "mojo_go", token)).toBe("already_linked");
    });

    it("asks before a second Play subscription: a change must name the one it replaces", async () => {
      await expectStatus(buyer.req("POST", "/v2/mojo/play/intent", { kind: "plan", productId: "mojo_go" }), 409);
      await expectStatus(buyer.req("POST", "/v2/mojo/play/intent", { kind: "plan", productId: "mojo_go", replacing: "mojo_go" }), 409);
      await expectStatus(buyer.req("POST", "/v2/mojo/play/intent", { kind: "gift", productId: "mojo_go" }), 400);
      await expectStatus(buyer.req("POST", "/v2/mojo/play/intent", { kind: "plan", productId: "mojo_gold" }), 404);
    });

    it("moves to the new plan on a change, ending the replaced purchase even before Google reports it", async () => {
      const goToken = await buySubscription(buyer, "mojo_go", { replacing: "mojo_plus", linked: plusToken });
      expect(await verify(buyer, "mojo_go", goToken)).toBe("granted");
      expect((await planOf(buyer)).plan.key).toBe("go");
      const old = h.ctx.billing.rows.get<{ status: string }>("billing_subscriptions", { provider_subscription_ref: tokenHash(plusToken) })!;
      expect(old.status).toBe("canceled");
      plusToken = goToken;
    });

    it("keeps the plan in Google's grace period, removes it on hold, and restores it when paid", async () => {
      const sub = google.subs.get(plusToken)!;
      sub.subscriptionState = "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
      expect((await push({ subscriptionNotification: { notificationType: 6, purchaseToken: plusToken, subscriptionId: "mojo_go" } })).statusCode).toBe(200);
      expect((await planOf(buyer)).plan.key).toBe("go");
      sub.subscriptionState = "SUBSCRIPTION_STATE_ON_HOLD";
      await push({ subscriptionNotification: { notificationType: 5, purchaseToken: plusToken, subscriptionId: "mojo_go" } });
      expect((await planOf(buyer)).plan).toBeNull();
      sub.subscriptionState = "SUBSCRIPTION_STATE_ACTIVE";
      await push({ subscriptionNotification: { notificationType: 1, purchaseToken: plusToken, subscriptionId: "mojo_go" } });
      expect((await planOf(buyer)).plan.key).toBe("go");
    });

    it("keeps a cancelled plan until its paid time ends", async () => {
      const sub = google.subs.get(plusToken)!;
      sub.subscriptionState = "SUBSCRIPTION_STATE_CANCELED";
      sub.lineItems![0]!.autoRenewingPlan = { autoRenewEnabled: false };
      await push({ subscriptionNotification: { notificationType: 3, purchaseToken: plusToken, subscriptionId: "mojo_go" } });
      expect(await planOf(buyer)).toMatchObject({ plan: { key: "go" }, renews: false });
      sub.subscriptionState = "SUBSCRIPTION_STATE_EXPIRED";
      await push({ subscriptionNotification: { notificationType: 13, purchaseToken: plusToken, subscriptionId: "mojo_go" } });
      expect((await planOf(buyer)).plan).toBeNull();
    });

    it("grants nothing for a pending payment", async () => {
      const token = await buySubscription(buyer, "mojo_plus", { state: "SUBSCRIPTION_STATE_PENDING" });
      expect(await verify(buyer, "mojo_plus", token)).toBe("pending");
      expect((await planOf(buyer)).plan).toBeNull();
      expect(google.acked).not.toContain(token);
    });

    it("applies a purchase from Google's notification when the app never sent it", async () => {
      const token = await buySubscription(friend, "mojo_go");
      expect((await push({ subscriptionNotification: { notificationType: 4, purchaseToken: token, subscriptionId: "mojo_go" } })).statusCode).toBe(200);
      expect((await planOf(friend)).plan.key).toBe("go");
      expect(google.acked).toContain(token);
    });

    it("doesn't sell on Google Play what the website already bills", async () => {
      const intent = await webBuyer.req("POST", "/v2/billing/checkout", { planKey: "plus" });
      const payload = JSON.stringify({
        id: `evt_play_web_${++n}`, object: "event", type: "customer.subscription.created", created: Math.floor(Date.now() / 1000), livemode: false,
        data: { object: { id: "sub_web_1", object: "subscription", customer: "cus_web", status: "active", cancel_at_period_end: false, cancel_at: null, canceled_at: null, trial_end: null,
          metadata: { meldiq_checkout: intent.checkoutId },
          items: { object: "list", data: [{ id: "si_web", object: "subscription_item", price: { id: "price_plus" }, quantity: 1, current_period_start: Math.floor(Date.now() / 1000), current_period_end: Math.floor((Date.now() + 30 * DAY_MS) / 1000) }] } } },
      });
      const res = await h.app.inject({
        method: "POST", url: "/v1/billing/webhooks/stripe", payload,
        headers: { "content-type": "application/json", [STRIPE_SIGNATURE_HEADER]: Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) },
      });
      expect(res.statusCode).toBe(200);
      const refused = await expectStatus(webBuyer.req("POST", "/v2/mojo/play/intent", { kind: "plan", productId: "mojo_go" }), 409);
      expect(refused.error.code).toBe("billed_elsewhere");
    });
  });

  describe("Spark packs", () => {
    it("adds a pack's Sparks, and switching packs changes how many", async () => {
      const two = await buySubscription(other, "spark_2");
      expect(await verify(other, "spark_2", two)).toBe("granted");
      expect((await me(other)).sparks).toMatchObject({ purchased: 2, subscription: { quantity: 2, provider: "google_play" } });
      await expectStatus(other.req("POST", "/v2/mojo/play/intent", { kind: "spark", productId: "spark_3" }), 409);
      const three = await buySubscription(other, "spark_3", { replacing: "spark_2", linked: two });
      expect(await verify(other, "spark_3", three)).toBe("granted");
      expect((await me(other)).sparks).toMatchObject({ purchased: 3, subscription: { quantity: 3 } });
    });
  });

  describe("gifts", () => {
    const buyGift = async (giftTo: string, productId: string, purchaseState: number) => {
      const intent = await gifter.req("POST", "/v2/mojo/play/intent", { kind: "gift", productId, giftTo, note: "Enjoy" });
      const token = `gift-token-${++n}-${"z".repeat(40)}`;
      google.products.set(token, { purchaseState, consumptionState: 0, obfuscatedExternalAccountId: intent.accountToken, obfuscatedExternalProfileId: intent.reference });
      return { token, giftId: intent.reference as string };
    };

    it("refuses gifts to oneself and to nobody", async () => {
      await expectStatus(gifter.req("POST", "/v2/mojo/play/intent", { kind: "gift", productId: "gift_go_1m", giftTo: gifter.userId }), 409);
      await expectStatus(gifter.req("POST", "/v2/mojo/play/intent", { kind: "gift", productId: "gift_go_1m", giftTo: "u_nobody" }), 404);
    });

    it("delivers a paid gift, then consumes the purchase so another can be bought", async () => {
      const { token, giftId } = await buyGift(friend.userId, "gift_plus_3m", 0);
      expect(await verify(gifter, "gift_plus_3m", token)).toBe("granted");
      expect(google.consumed).toContain(token);
      const received = (await me(friend)).gifts.received.find((g: { id: string }) => g.id === giftId);
      expect(received).toMatchObject({ planKey: "plus", months: 3, status: "paid", note: "Enjoy" });
    });

    it("waits for a pending payment without delivering or consuming", async () => {
      const { token, giftId } = await buyGift(friend.userId, "gift_go_1m", 2);
      expect(await verify(gifter, "gift_go_1m", token)).toBe("pending");
      expect(google.consumed).not.toContain(token);
      expect((await me(friend)).gifts.received.some((g: { id: string }) => g.id === giftId)).toBe(false);
    });

    it("won't deliver a purchase for a different gift than the one recorded", async () => {
      const { token } = await buyGift(friend.userId, "gift_go_1m", 0);
      expect(await verify(gifter, "gift_plus_12m", token)).toBe("invalid");
    });

    it("can't be started once Google refunded it", async () => {
      const { token, giftId } = await buyGift(friend.userId, "gift_go_3m", 0);
      expect(await verify(gifter, "gift_go_3m", token)).toBe("granted");
      expect((await push({ voidedPurchaseNotification: { purchaseToken: token, orderId: "GPA.1", productType: 2, refundType: 1 } })).statusCode).toBe(200);
      const refused = await expectStatus(friend.req("POST", `/v2/mojo/gifts/${giftId}/redeem`), 403);
      expect(refused.error.message).toMatch(/refunded/);
    });
  });

  describe("Google's notifications", () => {
    it("refuses pushes not signed by Google for this endpoint", async () => {
      const note = { subscriptionNotification: { notificationType: 2, purchaseToken: "x", subscriptionId: "mojo_go" } };
      expect((await push(note, oidc({ aud: "https://elsewhere.test/hook" }))).statusCode).toBe(401);
      expect((await push(note, oidc({ email: "someone@else.iam.gserviceaccount.com" }))).statusCode).toBe(401);
      expect((await push(note, oidc({ exp: Math.floor(Date.now() / 1000) - 3600 }))).statusCode).toBe(401);
      expect((await push(note, oidc({}, "unknown-key"))).statusCode).toBe(401);
      const forged = oidc().replace(/\.[^.]+$/, `.${Buffer.from("not a signature").toString("base64url")}`);
      expect((await push(note, forged)).statusCode).toBe(401);
      const unsigned = await h.app.inject({ method: "POST", url: "/v1/billing/webhooks/google_play", payload: { message: { data: "", messageId: "1" } } });
      expect(unsigned.statusCode).toBe(401);
    });

    it("ignores another app's notifications and Google's test message", async () => {
      expect((await push({ packageName: "com.other.app", subscriptionNotification: { purchaseToken: "x" } })).statusCode).toBe(200);
      expect((await push({ testNotification: { version: "1.0" } })).statusCode).toBe(200);
    });

    it("asks Pub/Sub to send it again while Google can't be reached", async () => {
      google.down = true;
      try {
        const r = await push({ subscriptionNotification: { notificationType: 2, purchaseToken: "anything", subscriptionId: "mojo_go" } });
        expect(r.statusCode).toBe(503);
      } finally {
        google.down = false;
      }
    });
  });

  describe("reconciliation", () => {
    it("acknowledges later what couldn't be acknowledged at once", async () => {
      const lone = await AccountClient.ready(h.baseUrl, mailer, "playlone");
      const token = await buySubscription(lone, "mojo_plus");
      const ack = google.acknowledgeSubscription.bind(google);
      google.acknowledgeSubscription = async () => {
        throw new Error("google is down");
      };
      try {
        expect(await verify(lone, "mojo_plus", token)).toBe("granted");
      } finally {
        google.acknowledgeSubscription = ack;
      }
      expect(google.acked).not.toContain(token);
      // Minutes later, the cleanup job's reconciliation asks Google again.
      await h.ctx.billing.rows.write((w) => w.update("billing_play_purchases", { token_hash: tokenHash(token) }, { checked_at: 0 }));
      expect(await h.ctx.play!.reconcile()).toBeGreaterThan(0);
      expect(google.acked).toContain(token);
    });
  });

  describe("without Google Play configured", () => {
    it("is unavailable, and verification needs an account session", async () => {
      expect(h.ctx.play).not.toBeNull();
      const playLess = await startServer({}, { mailer: new MemoryMailer() });
      try {
        const res = await playLess.app.inject({ method: "POST", url: "/v1/billing/webhooks/google_play", payload: {} });
        expect(res.statusCode).toBe(404);
      } finally {
        await playLess.close();
      }
    });
  });
});

describe("Google Play rules", () => {
  it("maps Google's subscription states", () => {
    const t = Date.now();
    expect(playStatus("SUBSCRIPTION_STATE_ACTIVE", t + DAY_MS, t)).toEqual({ status: "active", cancelAtPeriodEnd: false });
    expect(playStatus("SUBSCRIPTION_STATE_IN_GRACE_PERIOD", t + DAY_MS, t).status).toBe("active");
    expect(playStatus("SUBSCRIPTION_STATE_CANCELED", t + DAY_MS, t)).toEqual({ status: "active", cancelAtPeriodEnd: true });
    expect(playStatus("SUBSCRIPTION_STATE_CANCELED", t - DAY_MS, t).status).toBe("canceled");
    expect(playStatus("SUBSCRIPTION_STATE_ON_HOLD", t, t).status).toBe("unpaid");
    expect(playStatus("SUBSCRIPTION_STATE_PAUSED", t, t).status).toBe("paused");
    expect(playStatus("SUBSCRIPTION_STATE_EXPIRED", t, t).status).toBe("canceled");
    expect(playStatus("SUBSCRIPTION_STATE_PENDING", t, t).status).toBe("incomplete");
    expect(playStatus("SUBSCRIPTION_STATE_SOMETHING_NEW", t, t).status).toBe("incomplete");
  });

  it("keeps account tokens opaque, stable and within Google's 64 characters", () => {
    const a = accountToken(SECRET, "acc_123");
    expect(a).toBe(accountToken(SECRET, "acc_123"));
    expect(a).not.toBe(accountToken(SECRET, "acc_124"));
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toContain("acc_123");
  });

  it("rejects a missing or malformed bearer token", async () => {
    await expect(verifyPushToken(undefined, { audience: AUDIENCE, email: PUSHER }, jwks, Date.now())).rejects.toBeInstanceOf(WebhookRejected);
    await expect(verifyPushToken("Bearer nope", { audience: AUDIENCE, email: PUSHER }, jwks, Date.now())).rejects.toBeInstanceOf(WebhookRejected);
    await expect(verifyPushToken(`Bearer ${oidc()}`, { audience: AUDIENCE, email: PUSHER }, jwks, Date.now())).resolves.toBeUndefined();
  });
});
