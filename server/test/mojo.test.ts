import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMonths } from "../src/modules/billing/gifts.js";
import { ciphertextCeilingB64, MB, PLAN_PERKS, screenAllows, sparkLevel, unionPresets } from "../src/modules/billing/perks.js";
import { STRIPE_SIGNATURE_HEADER, StripeProvider, type StripeApi } from "../src/modules/billing/providers/stripe.js";
import { MAX_CIPHERTEXT_B64 } from "../src/shared/contracts/http/messaging.js";
import { MojoCatalog, MojoMe, OrgSparks } from "../src/shared/contracts/http/mojo.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Meldiq Mojo (docs/MOJO.md): the plan catalog and its limits, Meldiq Spark's server levels, buying Sparks, gifts and
 * badges. Stripe's API is a recording fake (no network, no keys) and its webhooks are signed as Stripe signs them and
 * verified by the official SDK: these prove Meldiq's handling, not a live Stripe account.
 */
const WHSEC = "whsec_mojotestsecretfortestsonly0123456789";
const SK = "sk_test_meldiqmojofaketestkey0123456789";
const RETURN = "https://meldiq.test/account/billing";
const WEB_RETURN = "https://web.meldiq.test/settings/mojo";
const DAY_MS = 86_400_000;
const secs = (ms: number) => Math.floor(ms / 1000);

class FakeStripe implements StripeApi {
  sessions: { id: string; params: Stripe.Checkout.SessionCreateParams }[] = [];
  private n = 0;
  async createCustomer() {
    return { id: `cus_mojo_${++this.n}` };
  }
  async createCheckoutSession(params: Stripe.Checkout.SessionCreateParams) {
    const id = `cs_test_mojo_${++this.n}`;
    this.sessions.push({ id, params });
    return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
  }
  async expireCheckoutSession() {}
  async createPortalSession() {
    return { url: "https://billing.stripe.test/p/session/1" };
  }
  async retrieveSubscription() {
    return null;
  }
}

let seq = 0;
let lastCreated = secs(Date.now()) - 3600;
const event = (type: string, object: object) => ({ id: `evt_mojo_${++seq}`, object: "event", type, created: ++lastCreated, livemode: false, data: { object } });

function subscription(o: { id: string; price: string; checkout: string; customer: string; status?: string; quantity?: number }) {
  return {
    id: o.id,
    object: "subscription",
    customer: o.customer,
    status: o.status ?? "active",
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: o.status === "canceled" ? secs(Date.now()) : null,
    trial_end: null,
    metadata: { meldiq_checkout: o.checkout },
    items: {
      object: "list",
      data: [{ id: `si_${o.id}`, object: "subscription_item", price: { id: o.price }, quantity: o.quantity ?? 1, current_period_start: secs(Date.now()), current_period_end: secs(Date.now() + 30 * DAY_MS) }],
    },
  };
}

describe("Meldiq Mojo", () => {
  let h: Harness;
  const mailer = new MemoryMailer();
  const stripe = new FakeStripe();
  let free: AccountClient, go: AccountClient, plus: AccountClient, friend: AccountClient;
  let orgId: string;

  const deliver = async (e: object) => {
    const payload = JSON.stringify(e);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/billing/webhooks/stripe",
      payload,
      headers: { "content-type": "application/json; charset=utf-8", [STRIPE_SIGNATURE_HEADER]: Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  /** Subscribes [c] to [planKey] the way Stripe would: a checkout, then the subscription's signed event. */
  const subscribe = async (c: AccountClient, planKey: string, price: string, quantity?: number) => {
    const started =
      planKey === "spark"
        ? await c.req("POST", "/v2/mojo/sparks/checkout", { quantity: quantity ?? 1 })
        : await c.req("POST", "/v2/billing/checkout", { planKey });
    const subId = `sub_${planKey}_${++seq}`;
    await deliver(event("customer.subscription.created", subscription({ id: subId, price, checkout: started.checkoutId, customer: `cus_${c.accountId}`, quantity })));
    return subId;
  };

  const publish = async (key: string, price: string, amountMinor: number) => {
    const terms = { interval: "month" as const, currency: "USD", amountMinor, providerPriceRef: price, trialDays: 0, graceDays: 0, limits: {}, notes: "" };
    const p = await h.ctx.billing.catalog.create(key, { name: key, description: "", segment: "personal", public: true, audience: "personal" }, terms, "test", Date.now());
    await h.ctx.billing.catalog.publish(p.id, "stripe", "test", Date.now());
  };

  const me = async (c: AccountClient) => {
    const m = await c.req("GET", "/v2/mojo/me");
    expect(MojoMe.safeParse(m).success).toBe(true);
    return m;
  };
  const sparksOf = async (c: AccountClient) => {
    const s = await c.req("GET", `/v1/orgs/${orgId}/sparks`);
    expect(OrgSparks.safeParse(s).success).toBe(true);
    return s;
  };

  beforeAll(async () => {
    const provider = new StripeProvider({ secretKey: SK, webhookSecret: WHSEC, allowPromotionCodes: false, api: stripe });
    h = await startServer(
      { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WHSEC, BILLING_RETURN_URL: RETURN, BILLING_WEB_RETURN_URL: WEB_RETURN, WORKFLOW_TICK_MS: "0" },
      { mailer, billingProvider: provider },
    );
    await publish("go", "price_go", 99);
    await publish("plus", "price_plus", 399);
    await publish("spark", "price_spark", 99);
    [free, go, plus, friend] = await Promise.all(["free", "goer", "pluser", "friend"].map((n) => AccountClient.ready(h.baseUrl, mailer, n)));
    orgId = (await free.req("POST", "/v1/orgs", { name: "Spark Lab" })).org.id;
    for (const c of [go, plus, friend]) {
      const code = (await free.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
      await c.req("POST", "/v1/invites/accept", { code });
    }
    await subscribe(go, "go", "price_go");
    await subscribe(plus, "plus", "price_plus");
  });
  afterAll(async () => h.close());

  describe("the catalog", () => {
    it("lists Free, Go and Plus with every agreed limit, and what's on sale at the published prices", async () => {
      const res = await h.app.inject({ method: "GET", url: "/v2/mojo/catalog" });
      const c = res.json();
      expect(MojoCatalog.safeParse(c).success).toBe(true);
      expect(c.plans.map((p: any) => [p.key, p.messageChars, p.uploadBytes, p.sparks, p.customItems, p.bots, p.badge, p.check])).toEqual([
        ["free", 1000, 50 * MB, 0, 20, 2, null, false],
        ["go", 2000, 200 * MB, 1, 50, 4, "go", false],
        ["plus", 5000, 2_000_000_000, 2, 250, 10, "plus", true],
      ]);
      expect(c.spark.levels.map((l: any) => [l.level, l.sparks, l.emojiSlots, l.uploadBytes, l.voiceKbps, l.screen])).toEqual([
        [0, 0, 50, null, 48, []],
        [1, 1, 100, 50 * MB, 128, ["720p30"]],
        [2, 2, 200, 200 * MB, 256, ["1080p60"]],
        [3, 3, 500, 2_000_000_000, 384, ["1080p60", "1440p30"]],
      ]);
      expect(c.onSale).toEqual({ mode: "test", go: { currency: "USD", amountMinor: 99 }, plus: { currency: "USD", amountMinor: 399 }, spark: { currency: "USD", amountMinor: 99 }, gifts: true });
    });

    it("works out limits the same way everywhere", () => {
      expect(screenAllows(["720p30"], 1280, 720, 30)).toBe(true);
      expect(screenAllows(["720p30"], 1920, 1080, 30)).toBe(false);
      expect(screenAllows(["720p30"], 1280, 720, 60)).toBe(false);
      // A portrait phone screen counts its long side as the width.
      expect(screenAllows(["1080p30"], 1080, 1920, 30)).toBe(true);
      expect(unionPresets(["720p60", "1080p30"], ["1080p60"])).toEqual(["720p60", "1080p30", "1080p60"]);
      expect(sparkLevel(7).level).toBe(3);
      expect(ciphertextCeilingB64(PLAN_PERKS.plus.messageChars, MAX_CIPHERTEXT_B64)).toBeLessThanOrEqual(MAX_CIPHERTEXT_B64);
      expect(ciphertextCeilingB64(1000, MAX_CIPHERTEXT_B64)).toBeLessThan(ciphertextCeilingB64(5000, MAX_CIPHERTEXT_B64));
      expect(new Date(addMonths(Date.UTC(2026, 0, 31), 1)).toISOString().slice(0, 10)).toBe("2026-02-28");
      expect(new Date(addMonths(Date.UTC(2026, 9, 28), 12)).toISOString().slice(0, 10)).toBe("2027-10-28");
    });
  });

  describe("plans come from verified billing only", () => {
    it("gives each person their plan's perks; signing in gives nothing", async () => {
      expect((await me(free)).plan).toBe("free");
      expect((await me(go)).plan).toBe("go");
      const p = await me(plus);
      expect(p).toMatchObject({ plan: "plus", perks: { messageChars: 5000 }, badge: { kind: "plus", check: true, hidden: false } });
    });

    it("answers a device session too (linked before email sign-in), and asks it to sign in with email to buy", async () => {
      const legacy = await new GriipClient(h.baseUrl, `legacy${Date.now() % 100000}`, "Legacy Person").register();
      const m = await legacy.req("GET", "/v2/mojo/me");
      expect(MojoMe.safeParse(m).success).toBe(true);
      expect(m.plan).toBe("free");
      await expectStatus(legacy.req("POST", "/v2/mojo/sparks/checkout", { quantity: 1 }), 403);
    });

    it("refuses the Spark add-on through the plan checkout (it has its own, by quantity)", async () => {
      await expectStatus(free.req("POST", "/v2/billing/checkout", { planKey: "spark" }), 404);
    });
  });

  describe("Meldiq Spark", () => {
    it("lets a Go member give their one Spark: the server reaches level 1 for everyone in it", async () => {
      const a = await go.req("POST", "/v2/mojo/sparks", { orgId });
      expect(a.orgId).toBe(orgId);
      const s = await sparksOf(free);
      expect(s).toMatchObject({ level: 1, active: 1, next: { level: 2, needs: 1 }, perks: { emojiSlots: 100, uploadBytes: 50 * MB, voiceKbps: 128 } });
      await expectStatus(go.req("POST", "/v2/mojo/sparks", { orgId }), 409);
      await expectStatus(free.req("POST", "/v2/mojo/sparks", { orgId }), 409);
    });

    it("adds up members' Sparks and stops at level 3", async () => {
      await plus.req("POST", "/v2/mojo/sparks", { orgId });
      await plus.req("POST", "/v2/mojo/sparks", { orgId });
      expect(await sparksOf(free)).toMatchObject({ level: 3, active: 3, next: null, perks: { emojiSlots: 500, voiceKbps: 384 } });
    });

    it("can't give the same Spark twice, even at once", async () => {
      const results = await Promise.allSettled([go.req("POST", "/v2/mojo/sparks", { orgId }), go.req("POST", "/v2/mojo/sparks", { orgId })]);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect((await me(go)).sparks).toMatchObject({ total: 1, free: 0 });
    });

    it("lets anyone buy more Sparks, counted once Stripe confirms, by quantity", async () => {
      const before = stripe.sessions.length;
      await subscribe(free, "spark", "price_spark", 3);
      const session = stripe.sessions[before]!;
      expect(session.params).toMatchObject({ mode: "subscription", line_items: [{ price: "price_spark", quantity: 3 }] });
      expect((await me(free)).sparks).toMatchObject({ included: 0, purchased: 3, total: 3, free: 3, subscription: { quantity: 3 } });
      // Buying Sparks doesn't make anyone a Mojo subscriber.
      expect((await me(free)).plan).toBe("free");
    });

    it("pauses Sparks beyond a lapsed plan instead of deleting them, and lowers the level at once", async () => {
      const goSub = h.ctx.billing.rows.get<{ provider_subscription_ref: string; checkout_id: string }>("billing_subscriptions", { owner_user_id: go.userId })!;
      await deliver(event("customer.subscription.deleted", subscription({ id: goSub.provider_subscription_ref, price: "price_go", checkout: goSub.checkout_id, customer: `cus_${go.accountId}`, status: "canceled" })));
      const m = await me(go);
      expect(m.plan).toBe("free");
      expect(m.sparks.assignments).toEqual([expect.objectContaining({ orgId, paused: true })]);
      expect((await sparksOf(free)).level).toBe(2);
    });

    it("moves a Spark and takes it back, keeping the history", async () => {
      const other = (await free.req("POST", "/v1/orgs", { name: "Second Lab" })).org.id;
      const mine = (await me(free)).sparks;
      const given = await free.req("POST", "/v2/mojo/sparks", { orgId });
      const moved = await free.req("POST", `/v2/mojo/sparks/${given.id}/move`, { orgId: other });
      expect(moved.orgId).toBe(other);
      await free.req("DELETE", `/v2/mojo/sparks/${moved.id}`);
      expect((await me(free)).sparks.free).toBe(mine.free);
      expect(h.ctx.billing.rows.count("spark_assignments", { user_id: free.userId, removed_at: { ne: null } })).toBe(2);
      // Only one's own, only to a community one is in.
      const p = (await me(plus)).sparks.assignments[0];
      await expectStatus(free.req("DELETE", `/v2/mojo/sparks/${p.id}`), 403);
      await expectStatus(plus.req("POST", "/v2/mojo/sparks/" + p.id + "/move", { orgId: other }), 404);
    });
  });

  describe("limits", () => {
    it("bounds the encrypted size of messages by plan, whatever the client says", async () => {
      const dm = (await free.req("POST", "/v1/conversations/dm", { userId: plus.userId })).conversation.id;
      await free.send(dm, { type: "text", text: "hello" });
      await expectStatus(free.send(dm, { type: "text", text: "x".repeat(40_000) }), 413);
      await plus.send(dm, { type: "text", text: "x".repeat(40_000) });
    });

    it("refuses a file larger than the plan before reading it, and a community's Sparks raise it", async () => {
      const dm = (await free.req("POST", "/v1/conversations/dm", { userId: friend.userId })).conversation.id;
      const tooBig = await h.app.inject({
        method: "POST",
        url: `/v1/attachments?conversationId=${dm}`,
        payload: Buffer.alloc(10),
        headers: { authorization: `Bearer ${free.token}`, "content-type": "application/octet-stream", "content-length": String(60 * MB) },
      });
      expect(tooBig.statusCode).toBe(413);
      expect(tooBig.json().error).toMatchObject({ code: "upload_limit", details: { maxBytes: 50 * MB } });
      expect(h.ctx.mojo.uploadBytes(free.userId, orgId)).toBe(200 * MB);
      expect(h.ctx.mojo.uploadBytes(plus.userId, null)).toBe(2_000_000_000);
    });

    it("gives everyone in a boosted server its screen shares and voice, never less than their own plan", () => {
      expect(h.ctx.mojo.screenPresets(free.userId, null)).toEqual(["720p30"]);
      expect(h.ctx.mojo.screenPresets(free.userId, orgId)).toEqual(["720p30", "1080p60"]);
      expect(h.ctx.mojo.screenPresets(plus.userId, null)).toEqual(["1080p60", "1440p30"]);
      expect(h.ctx.mojo.voiceKbps(null)).toBe(48);
    });
  });

  describe("custom emoji and stickers", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
    const add = (c: AccountClient, org: string, name: string) => c.req("POST", `/v1/orgs/${org}/expressions?kind=emoji&name=${name}`, undefined, png);

    it("keeps one pool per person across communities, and locks (never deletes) what a lapsed plan no longer covers", async () => {
      const lab = (await free.req("POST", "/v1/orgs", { name: "Emoji Lab" })).org.id;
      // A free period of Mojo Go (50 items) that ends later: the person adds 22.
      const t = Date.now();
      await h.ctx.billing.rows.write((w) =>
        w.insert("billing_grants", { id: "grt_emoji", account_id: free.accountId, user_id: free.userId, plan_key: "go", source: "gift", reference: "gft_emoji", starts_at: t - 1000, ends_at: t + DAY_MS, created_at: t }),
      );
      for (let i = 0; i < 22; i++) await add(free, lab, `e${String(i).padStart(2, "0")}`);
      // Back to Free (20): the newest two are locked, all 22 are kept, and no more can be added.
      await h.ctx.billing.rows.write((w) => w.update("billing_grants", { id: "grt_emoji" }, { ends_at: t }));
      const list = (await free.req("GET", `/v1/orgs/${lab}/expressions`)).expressions as { name: string; locked?: string }[];
      expect(list).toHaveLength(22);
      expect(list.filter((e) => e.locked === "plan").map((e) => e.name)).toEqual(["e20", "e21"]);
      const refused = await free.req("POST", `/v1/orgs/${lab}/expressions?kind=emoji&name=more`, undefined, png).catch((e) => e);
      expect(String(refused.message ?? refused)).toMatch(/custom emoji|409/);
    });
  });

  describe("enforcement", () => {
    it("applies plan limits once Mojo is on sale (MOJO_ENFORCE=auto), and keeps everyone's old limits until then", async () => {
      // This server has Stripe and published plans: enforced.
      expect(h.ctx.mojo.enforced()).toBe(true);
      const plain = await startServer({ WORKFLOW_TICK_MS: "0" }, { mailer });
      try {
        expect(plain.ctx.mojo.enforced()).toBe(false);
        expect(plain.ctx.mojo.uploadBytes("u_any", null)).toBe(Number.MAX_SAFE_INTEGER);
        expect(plain.ctx.mojo.limitsOf("u_any")).toBeNull();
      } finally {
        await plain.close();
      }
      const forced = await startServer({ WORKFLOW_TICK_MS: "0", MOJO_ENFORCE: "on" }, { mailer });
      try {
        expect(forced.ctx.mojo.enforced()).toBe(true);
        expect(forced.ctx.mojo.uploadBytes("u_any", null)).toBe(50 * MB);
      } finally {
        await forced.close();
      }
      // Two more servers start here (slower with every domain in MongoDB).
    }, 90_000);
  });

  describe("badges", () => {
    it("shows Plus and Meldiq Check in member lists, and hides them on request without changing the plan", async () => {
      const badgeOf = async () => {
        const members = (await free.req("GET", `/v1/orgs/${orgId}/members`)).members as any[];
        return members.find((m) => m.id === plus.userId)?.mojo;
      };
      expect(await badgeOf()).toEqual({ badge: "plus", check: true });
      await plus.req("PUT", "/v2/mojo/badge", { hidden: true });
      expect(await badgeOf()).toBeUndefined();
      expect((await me(plus)).plan).toBe("plus");
      await plus.req("PUT", "/v2/mojo/badge", { hidden: false });
    });
  });

  describe("gifts", () => {
    it("prices a gift on the server and makes it the friend's only once Stripe says it's paid", async () => {
      await expectStatus(free.req("POST", "/v2/mojo/gifts", { recipientUserId: free.userId, planKey: "plus", months: 3 }), 409);
      await expectStatus(free.req("POST", "/v2/mojo/gifts", { recipientUserId: "u_nobody", planKey: "plus", months: 3 }), 404);
      const before = stripe.sessions.length;
      const started = await free.req("POST", "/v2/mojo/gifts", { recipientUserId: friend.userId, planKey: "plus", months: 3, note: "Happy birthday", returnTo: "web" });
      const session = stripe.sessions[before]!;
      expect(session.params).toMatchObject({
        mode: "payment",
        client_reference_id: started.giftId,
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 399 * 3 } }],
        success_url: `${WEB_RETURN}?gift=success`,
      });
      expect((await me(friend)).gifts.received).toEqual([]);
      const paid = { id: session.id, object: "checkout.session", mode: "payment", client_reference_id: started.giftId, payment_status: "paid", payment_intent: "pi_gift_1", customer: "cus_gift", subscription: null, metadata: {} };
      await deliver(event("checkout.session.completed", paid));
      // Delivered twice by Stripe: still one gift.
      await deliver(event("checkout.session.completed", paid));
      const received = (await me(friend)).gifts.received;
      expect(received).toEqual([expect.objectContaining({ id: started.giftId, planKey: "plus", months: 3, status: "paid", note: "Happy birthday" })]);
      expect((await me(friend)).plan).toBe("free");

      const r = await friend.req("POST", `/v2/mojo/gifts/${started.giftId}/redeem`);
      expect(r.endsAt).toBe(addMonths(r.startsAt, 3));
      expect((await me(friend)).plan).toBe("plus");
      await expectStatus(friend.req("POST", `/v2/mojo/gifts/${started.giftId}/redeem`), 409);
      await expectStatus(plus.req("POST", `/v2/mojo/gifts/${started.giftId}/redeem`), 404);
    });

    it("can't be started once refunded", async () => {
      const before = stripe.sessions.length;
      const started = await free.req("POST", "/v2/mojo/gifts", { recipientUserId: friend.userId, planKey: "go", months: 1 });
      const s = stripe.sessions[before]!;
      await deliver(event("checkout.session.completed", { id: s.id, object: "checkout.session", mode: "payment", client_reference_id: started.giftId, payment_status: "paid", payment_intent: "pi_gift_2", customer: "cus_gift", subscription: null, metadata: {} }));
      await deliver(event("charge.refunded", { id: "ch_gift_2", object: "charge", customer: "cus_gift", currency: "usd", amount: 99, amount_refunded: 99, refunded: true, payment_intent: "pi_gift_2" }));
      expect(h.ctx.gifts.get(started.giftId)?.status).toBe("refunded");
      await expectStatus(friend.req("POST", `/v2/mojo/gifts/${started.giftId}/redeem`), 403);
    });
  });
});
