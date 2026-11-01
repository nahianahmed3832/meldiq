import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/shared/errors.js";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";
import type { PayPalApi } from "../src/modules/billing/providers/paypalApi.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

class PaymentApi implements PayPalApi {
  orders = new Map<string, any>();
  subscriptions = new Map<string, any>();
  successfulCaptures = 0;
  requests: { method: string; path: string; body: any }[] = [];
  async request(method: string, path: string, raw?: unknown): Promise<unknown> {
    const body = raw as any;
    this.requests.push({ method, path, body });
    if (method === "GET" && path.startsWith("/v1/billing/plans/")) return { id: path.split("/").at(-1), status: "ACTIVE", quantity_supported: false,
      billing_cycles: [{ tenure_type: "REGULAR", total_cycles: 0, frequency: { interval_unit: "MONTH", interval_count: 1 }, pricing_scheme: { fixed_price: { currency_code: "USD", value: "3.99" } } }] };
    if (method === "POST" && path === "/v2/checkout/orders") {
      const id = `O-${crypto.randomBytes(5).toString("hex")}`;
      const order = { id, status: "CREATED", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
        purchase_units: body.purchase_units.map((unit: any) => ({ ...unit, payee: { merchant_id: "merchant-test" } })) };
      this.orders.set(id, order); return order;
    }
    const capture = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (method === "POST" && capture) {
      const order = this.orders.get(capture[1]!)!;
      if (order.status !== "APPROVED" && order.status !== "COMPLETED") throw new ApiError(409, "not_approved", "The buyer has not approved this payment.");
      if (order.status !== "COMPLETED") {
        this.successfulCaptures++;
        order.status = "COMPLETED";
        order.purchase_units[0].payments = { captures: [{ id: `CAP-${order.id}`, status: "COMPLETED", amount: order.purchase_units[0].amount, create_time: new Date().toISOString() }] };
      }
      return order;
    }
    if (method === "GET" && path.startsWith("/v2/checkout/orders/")) return this.orders.get(path.split("/").at(-1)!);
    if (method === "POST" && path === "/v1/billing/subscriptions") {
      const id = `I-${crypto.randomBytes(5).toString("hex")}`;
      const subscription = { id, plan_id: body.plan_id, custom_id: body.custom_id, status: "APPROVAL_PENDING", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=${id}` }] };
      this.subscriptions.set(id, subscription); return subscription;
    }
    const canceled = path.match(/^\/v1\/billing\/subscriptions\/([^/]+)\/cancel$/);
    if (method === "POST" && canceled) { this.subscriptions.get(canceled[1]!)!.status = "CANCELLED"; return {}; }
    if (method === "GET" && path.startsWith("/v1/billing/subscriptions/")) return this.subscriptions.get(path.split("/").at(-1)!);
    if (path === "/v1/notifications/verify-webhook-signature") return { verification_status: "SUCCESS" };
    throw new Error(`Unexpected PayPal API request: ${method} ${path}`);
  }
}

for (const storage of ["sqlite", "mongodb"] as const) {
  describe(`separate PayPal products (${storage})`, () => {
    let h: Harness;
    const mailer = new MemoryMailer();
    const api = new PaymentApi();
    const provider = new PayPalProvider({ environment: "sandbox", clientId: "public-test", clientSecret: "secret-test", webhookId: "hook-test", merchantId: "merchant-test", plusPlanId: "P-PLUS", botsPlanId: "P-BOTS", subscriptionsApproved: true, giftsEnabled: false, sparksEnabled: true, api });
    beforeAll(async () => {
      h = await startServer({ MONGODB_DOMAINS: storage === "mongodb" ? "billing" : "" }, { mailer, billingProvider: provider });
      const plan = await h.ctx.billing.catalog.create("bots_plus", { name: "Meldiq Bots+", description: "Premium community bots", segment: "community-bots", public: true, audience: "organization" },
        { interval: "month", currency: "USD", amountMinor: 399, providerPriceRef: "P-BOTS", trialDays: 0, graceDays: 3, limits: {}, notes: "Separate from personal Mojo Plus" }, "test", Date.now());
      await h.ctx.billing.catalog.publish(plan.id, "paypal", "test", Date.now());
    });
    afterAll(async () => h.close());
    async function account() { return AccountClient.ready(h.baseUrl, mailer, `commerce${crypto.randomBytes(3).toString("hex")}`); }

    it("offers one-time Sparks with no Plus offer or gift checkout enabled", async () => {
      const c = await account();
      const catalog = await c.req("GET", "/v2/mojo/catalog");
      expect(catalog.onSale).toMatchObject({ plus: null, gifts: false, spark: { amountMinor: 99, currency: "USD" }, botsPlus: { amountMinor: 399, currency: "USD" } });
      const order = await c.req("POST", "/v2/billing/paypal/checkouts", { product: "spark", quantity: 2, requestKey: crypto.randomUUID() });
      expect(order).toMatchObject({ product: "spark", amountMinor: 198, interval: "one_time", quantity: 2, confirmed: false });
      const before = api.successfulCaptures;
      expect((await c.req("POST", `/v2/billing/paypal/checkouts/${order.id}/confirm`, {})).confirmed).toBe(false);
      expect(api.successfulCaptures).toBe(before);
      expect(h.ctx.mojo.sparkSlots(c.userId).purchased).toBe(0);
      api.orders.get(order.providerRef)!.status = "APPROVED";
      expect((await c.req("GET", `/v2/billing/paypal/checkouts/${order.id}`)).confirmed).toBe(false);
      expect(h.ctx.mojo.sparkSlots(c.userId).purchased).toBe(0);
      expect((await c.req("POST", `/v2/billing/paypal/checkouts/${order.id}/confirm`, {})).confirmed).toBe(true);
      expect(h.ctx.mojo.sparkSlots(c.userId).purchased).toBe(2);
      expect(h.ctx.mojo.planOf(c.userId)).toBe("free");
      expect((await c.req("GET", "/v2/billing/paypal/history")).transactions).toEqual(expect.arrayContaining([expect.objectContaining({ id: order.id, product: "2 Meldiq Sparks · one-time", amountMinor: 198, status: "paid" })]));
    });
    it("protects one-time purchases from another account and rejects client-supplied prices", async () => {
      const [buyer, other] = await Promise.all([account(), account()]);
      const order = await buyer.req("POST", "/v2/billing/paypal/checkouts", { product: "spark", quantity: 1, requestKey: crypto.randomUUID() });
      await expectStatus(other.req("GET", `/v2/billing/paypal/checkouts/${order.id}`), 404);
      await expectStatus(other.req("POST", `/v2/billing/paypal/checkouts/${order.id}/confirm`, {}), 404);
      await expectStatus(buyer.req("POST", "/v2/billing/paypal/checkouts", { product: "spark", quantity: 1, amountMinor: 1, requestKey: crypto.randomUUID() }), 400);
    });
    it("allows only community owners to start Bots+ and keeps its benefits separate from personal Plus", async () => {
      const owner = await account(); const member = await account();
      const { org } = await owner.req("POST", "/v1/orgs", { name: "Bots purchase" });
      const { invite } = await owner.req("POST", `/v1/orgs/${org.id}/invites`, { role: "MEMBER" });
      await member.req("POST", "/v1/invites/accept", { code: invite.code });
      await expectStatus(member.req("POST", "/v2/billing/paypal/checkouts", { product: "bots_plus", orgId: org.id, requestKey: crypto.randomUUID() }), 403);
      const order = await owner.req("POST", "/v2/billing/paypal/checkouts", { product: "bots_plus", orgId: org.id, requestKey: crypto.randomUUID() });
      expect(order).toMatchObject({ product: "bots_plus", orgId: org.id, amountMinor: 399, interval: "month", confirmed: false });
      expect(h.ctx.officialBots.hasPlus(org.id)).toBe(false);
      const subscription = api.subscriptions.get(order.providerRef)!;
      subscription.status = "ACTIVE";
      subscription.status_update_time = new Date().toISOString();
      subscription.billing_info = { next_billing_time: new Date(Date.now() + 30 * 86400_000).toISOString(), last_payment: { amount: { currency_code: "USD", value: "3.99" }, time: new Date().toISOString() } };
      expect((await owner.req("POST", `/v2/billing/paypal/checkouts/${order.id}/confirm`, {})).confirmed).toBe(true);
      expect(h.ctx.officialBots.hasPlus(org.id)).toBe(true);
      expect(h.ctx.billing.renewsPersonal(owner.accountId)).toBe(true);
      expect(h.ctx.mojo.planOf(owner.userId)).toBe("free");
      const history = await owner.req("GET", "/v2/billing/paypal/history");
      const bought = history.subscriptions.find((row: { product: string }) => row.product === "bots_plus");
      expect(bought).toMatchObject({ orgId: org.id, status: "active" });
      await expectStatus(member.req("POST", "/v2/billing/paypal/cancel", { confirm: true, subscriptionId: bought.id }), 404);
      expect((await owner.req("POST", "/v2/billing/paypal/cancel", { confirm: true, subscriptionId: bought.id })).confirmed).toBe(true);
    });
  });
}
