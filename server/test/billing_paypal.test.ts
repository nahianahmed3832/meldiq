import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingConfig } from "../src/modules/billing/config.js";
import { PayPalCheckout } from "../src/modules/billing/paypalCheckout.js";
import {
  cents,
  PayPalProvider,
} from "../src/modules/billing/providers/paypal.js";
import type { PayPalApi } from "../src/modules/billing/providers/paypalApi.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import {
  ADMIN_ORIGIN,
  consoleAdmin,
  type ConsoleAdmin,
} from "./support/adminConsole.js";
import { expectStatus, startServer, type Harness } from "./support/harness.js";

const PLAN = "P-SANDBOXPLUS";
const NOW = Date.now();
const env = {
  BILLING_PROVIDER: "paypal",
  PAYPAL_ENVIRONMENT: "sandbox",
  PAYPAL_CLIENT_ID: "test-public-client",
  PAYPAL_CLIENT_SECRET: "test-secret-not-real",
  PAYPAL_WEBHOOK_ID: "WH-TEST",
  PAYPAL_MERCHANT_ID: "TESTMERCHANT",
  PAYPAL_PLUS_PLAN_ID: PLAN,
  PAYPAL_SUBSCRIPTIONS_APPROVED: "true",
  BILLING_RETURN_URL: "https://meldiq.test/settings/checkout",
  BILLING_WEB_RETURN_URL: "https://meldiq.test/settings/checkout",
};

/** A REST boundary fake. Signature verification is tested as a request to PayPal's official verify endpoint.
 * These tests prove Meldiq behavior, not PayPal's cryptographic implementation or real Sandbox delivery. */
class FakePayPal implements PayPalApi {
  calls: { method: string; path: string; body: any; key?: string }[] = [];
  orders = new Map<string, any>();
  disputes = new Map<string, any>();
  subs = new Map<string, any>();
  keys = new Map<string, any>();
  denyCapture = false;
  planPrice = "3.99";
  async request(
    method: string,
    path: string,
    body?: any,
    key?: string,
  ): Promise<any> {
    this.calls.push({ method, path, body, key });
    if (key && this.keys.has(key)) return structuredClone(this.keys.get(key));
    let result: any;
    if (path === "/v1/notifications/verify-webhook-signature")
      return {
        verification_status:
          body.transmission_sig === "valid-test-signature"
            ? "SUCCESS"
            : "FAILURE",
      };
    if (path === `/v1/billing/plans/${PLAN}`)
      return {
        id: PLAN,
        status: "ACTIVE",
        quantity_supported: false,
        payment_preferences: {
          setup_fee: { currency_code: "USD", value: "0.0" },
        },
        billing_cycles: [
          {
            tenure_type: "REGULAR",
            total_cycles: 0,
            frequency: { interval_unit: "MONTH", interval_count: 1 },
            pricing_scheme: {
              fixed_price: { currency_code: "USD", value: this.planPrice },
            },
          },
        ],
      };
    if (path === "/v2/checkout/orders" && method === "POST") {
      const id = `ORDER${this.orders.size + 1}`;
      result = {
        id,
        status: "CREATED",
        purchase_units: [
          {
            ...body.purchase_units[0],
            payee: { merchant_id: env.PAYPAL_MERCHANT_ID },
          },
        ],
        links: [
          {
            rel: "payer-action",
            href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
          },
        ],
      };
      this.orders.set(id, result);
    } else if (path === "/v1/billing/subscriptions" && method === "POST") {
      const id = `I-SUB${this.subs.size + 1}`;
      result = {
        id,
        plan_id: body.plan_id,
        custom_id: body.custom_id,
        status: "APPROVAL_PENDING",
        start_time: body.start_time,
        links: [],
      };
      this.subs.set(id, result);
    } else if (/\/v2\/payments\/captures\/[^/]+$/.test(path)) {
      const id = path.split("/").at(-1);
      const o = [...this.orders.values()].find(
        (o) => o.purchase_units[0].payments?.captures?.[0]?.id === id,
      );
      result = {
        ...o.purchase_units[0].payments.captures[0],
        links: [
          {
            rel: "up",
            href: `https://api.sandbox.paypal.com/v2/checkout/orders/${o.id}`,
          },
        ],
      };
    } else if (/\/v1\/customer\/disputes\/[^/]+$/.test(path))
      result = this.disputes.get(path.split("/").at(-1)!);
    else if (/\/v2\/checkout\/orders\/[^/]+$/.test(path))
      result = this.orders.get(path.split("/").at(-1)!);
    else if (/\/v2\/checkout\/orders\/[^/]+\/capture$/.test(path)) {
      if (this.denyCapture) throw new Error("payment declined");
      const o = this.orders.get(path.split("/").at(-2)!);
      if (o.status !== "APPROVED") throw new Error("buyer approval required");
      o.status = "COMPLETED";
      o.purchase_units[0].payments = {
        captures: [
          {
            id: `CAPTURE${o.id}`,
            status: "COMPLETED",
            amount: o.purchase_units[0].amount,
          },
        ],
      };
      result = o;
    } else if (/\/v1\/billing\/subscriptions\/[^/]+\/cancel$/.test(path)) {
      const s = this.subs.get(path.split("/").at(-2)!);
      s.status = "CANCELLED";
      s.status_update_time = new Date().toISOString();
      result = {};
    } else if (/\/v1\/billing\/subscriptions\/[^/]+$/.test(path))
      result = this.subs.get(path.split("/").at(-1)!);
    else if (/\/v2\/payments\/captures\/[^/]+\/refund$/.test(path))
      result = { id: `REFUND${path.split("/").at(-2)}`, status: "COMPLETED" };
    else throw new Error(`Unexpected fake REST request: ${method} ${path}`);
    if (!result) throw new Error("resource not found");
    if (key) this.keys.set(key, structuredClone(result));
    return structuredClone(result);
  }
  activate(id: string) {
    const s = this.subs.get(id)!;
    s.status = "ACTIVE";
    s.billing_info = {
      last_payment: {
        amount: { currency_code: "USD", value: "3.99" },
        time: new Date(NOW).toISOString(),
      },
      next_billing_time: new Date(NOW + 31 * 86400000).toISOString(),
      failed_payments_count: 0,
      outstanding_balance: { currency_code: "USD", value: "0.00" },
    };
    return s;
  }
}
const headers = () => ({
  "paypal-transmission-id": "TXTEST",
  "paypal-transmission-time": new Date().toISOString(),
  "paypal-transmission-sig": "valid-test-signature",
  "paypal-cert-url":
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERTTEST",
  "paypal-auth-algo": "SHA256withRSA",
});

describe("PayPal Sandbox configuration", () => {
  it("separates Sandbox from explicitly enabled production live charges", () => {
    expect(billingConfig(env).provider).toMatchObject({
      id: "paypal",
      mode: "test",
    });
    expect(() =>
      billingConfig({
        ...env,
        PAYPAL_ENVIRONMENT: "live",
        BILLING_ALLOW_LIVE: "true",
      }),
    ).toThrow(/APP_ENV/);
    expect(() =>
      billingConfig({
        ...env,
        APP_ENV: "production",
        BILLING_ALLOW_LIVE: "true",
      }),
    ).toThrow(/production/);
    const live = billingConfig({ ...env, APP_ENV: "production", PAYPAL_ENVIRONMENT: "live", BILLING_ALLOW_LIVE: "true" }).provider as PayPalProvider;
    expect(live.mode).toBe("live");
    expect(live.publicConfig().environment).toBe("live");
    expect(live.supportsOneTimePurchases).toBe(false);
    expect(() => billingConfig({ ...env, APP_ENV: "production", PAYPAL_ENVIRONMENT: "live" })).toThrow(/BILLING_ALLOW_LIVE/);
    expect(() => billingConfig({ ...env, PAYPAL_CLIENT_SECRET: "" })).toThrow(
      /requires/,
    );
    expect(() => billingConfig({ ...env, PAYPAL_WEBHOOK_ID: "" })).toThrow(
      /requires/,
    );
  });
  it("uses exact minor-unit parsing", () => {
    expect(cents("3.99")).toBe(399);
    expect(cents("11.97")).toBe(1197);
    expect(cents("0.0")).toBe(0);
    expect(cents("3.9")).toBe(390);
    expect(() => cents("3.999")).toThrow();
    expect(() => cents("NaN")).toThrow();
  });
  it("gates subscriptions and verifies the real plan price, currency and billing interval", async () => {
    const api = new FakePayPal();
    const blocked = new PayPalProvider({
      clientId: "public",
      clientSecret: "secret",
      webhookId: "WH",
      merchantId: "TESTMERCHANT",
      plusPlanId: PLAN,
      subscriptionsApproved: false,
      api,
    });
    await expect(blocked.verifyPlusPlan()).rejects.toThrow(/not been approved/);
    const p = new PayPalProvider({
      ...blocked.options,
      subscriptionsApproved: true,
    });
    await p.verifyPlusPlan();
    api.planPrice = "4.99";
    await expect(p.verifyPlusPlan()).rejects.toThrow();
  });
});

it("keeps the provider's monthly anchor through short months when cancellation omits next billing", async () => {
  const api = new FakePayPal();
  api.subs.set("I-ANCHOR", {
    id: "I-ANCHOR",
    plan_id: PLAN,
    custom_id: "chk_anchor",
    status: "CANCELLED",
    start_time: "2026-01-31T12:00:00Z",
    billing_info: {
      last_payment: {
        amount: { currency_code: "USD", value: "3.99" },
        time: "2026-02-28T12:00:00Z",
      },
      cycle_executions: [{ tenure_type: "REGULAR", cycles_completed: 2 }],
    },
    links: [],
  });
  const provider = new PayPalProvider({
    clientId: "public",
    clientSecret: "secret",
    webhookId: "WH",
    merchantId: "TESTMERCHANT",
    plusPlanId: PLAN,
    subscriptionsApproved: true,
    api,
    clock: () => Date.parse("2026-03-01T00:00:00Z"),
  });
  expect(await provider.fetchSubscription("I-ANCHOR")).toMatchObject({
    status: "active",
    cancelAtPeriodEnd: true,
    currentPeriodEnd: Date.parse("2026-03-31T12:00:00Z"),
  });
});

describe("PayPal through authenticated billing APIs", () => {
  let h: Harness, admin: ConsoleAdmin, auditor: ConsoleAdmin;
  const mailer = new MemoryMailer();
  const api = new FakePayPal();
  const provider = new PayPalProvider({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    webhookId: env.PAYPAL_WEBHOOK_ID,
    merchantId: env.PAYPAL_MERCHANT_ID,
    plusPlanId: PLAN,
    subscriptionsApproved: true,
    api,
  });
  let alice: AccountClient, bob: AccountClient;
  const checkout = () => new PayPalCheckout(h.ctx.billing, h.ctx.gifts);
  const gift = (c = alice, extra = {}) =>
    c.req("POST", "/v2/billing/paypal/checkouts", {
      product: "gift",
      recipientUserId: bob.userId,
      months: 3,
      note: "Happy birthday",
      requestKey: randomUUID(),
      ...extra,
    });
  const event = (
    type: string,
    resource: object,
    id = randomUUID(),
    time = Date.now(),
  ) => ({
    id,
    event_type: type,
    create_time: new Date(time).toISOString(),
    resource,
    resource_type: "test-resource",
    summary: "retain the complete body for official verification",
  });
  const deliver = async (e: object, head = headers()) =>
    h.app.inject({
      method: "POST",
      url: "/v1/billing/webhooks/paypal",
      payload: JSON.stringify(e),
      headers: { "content-type": "application/json", ...head },
    });
  beforeAll(async () => {
    h = await startServer(
      {
        ...env,
        ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN,
        WORKFLOW_TICK_MS: "0",
        MOJO_ENFORCEMENT: "true",
      },
      { mailer, billingProvider: provider },
    );
    const p = await h.ctx.billing.catalog.create(
      "plus",
      {
        name: "Mojo Plus",
        description: "Existing Plus",
        segment: "personal",
        public: true,
        audience: "personal",
      },
      {
        interval: "month",
        currency: "USD",
        amountMinor: 399,
        providerPriceRef: PLAN,
        trialDays: 0,
        graceDays: 3,
        limits: {},
        notes: "",
      },
      "test",
      Date.now(),
    );
    await h.ctx.billing.catalog.publish(p.id, "paypal", "test", Date.now());
    alice = await AccountClient.ready(h.baseUrl, mailer, "paypalalice");
    bob = await AccountClient.ready(h.baseUrl, mailer, "paypalbob");
    admin = await consoleAdmin(h, mailer, "billing_admin", "paypaladmin");
    auditor = await consoleAdmin(h, mailer, "auditor", "paypalauditor");
  });
  afterAll(async () => {
    await h?.close();
  });

  it("exposes only public configuration and rejects unauthenticated purchases and forged amounts", async () => {
    const c = await alice.req("GET", "/v2/billing/paypal/config");
    expect(c).toEqual({
      provider: "paypal",
      environment: "sandbox",
      clientId: env.PAYPAL_CLIENT_ID,
      billingStartAt: null,
      subscriptions: true,
      cards: false,
    });
    expect(JSON.stringify(c)).not.toContain(env.PAYPAL_CLIENT_SECRET);
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/v2/billing/paypal/checkouts",
          payload: { product: "plus", requestKey: randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
    await expectStatus(gift(alice, { amountMinor: 1 }), 400);
    await expectStatus(
      alice.req("POST", "/v2/billing/paypal/checkouts", {
        product: "go",
        requestKey: randomUUID(),
      }),
      400,
    );
  });
  it("prices a gift from the existing catalog and deduplicates concurrent create requests", async () => {
    const requestKey = randomUUID();
    const [a, b] = await Promise.all([
      gift(alice, { requestKey }),
      gift(alice, { requestKey }),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.amountMinor).toBe(1197);
    expect(a.confirmed).toBe(false);
    expect(
      h.ctx.billing.rows.all("mojo_gifts", {
        where: { buyer_account_id: alice.accountId, request_key: requestKey },
      }),
    ).toHaveLength(1);
    await expectStatus(gift(alice, { requestKey, months: 1 }), 409);
  });
  it("does not grant a gift on approval, GET, cancellation or a declined capture", async () => {
    const g = await gift();
    api.orders.get(g.providerRef).status = "APPROVED";
    expect(
      (await alice.req("GET", `/v2/billing/paypal/checkouts/${g.id}`))
        .confirmed,
    ).toBe(false);
    expect(h.ctx.gifts.get(g.id)?.status).toBe("pending");
    api.denyCapture = true;
    expect(
      (
        await alice.req(
          "POST",
          `/v2/billing/paypal/checkouts/${g.id}/confirm`,
          {},
        )
      ).confirmed,
    ).toBe(false);
    api.denyCapture = false;
    expect(h.ctx.gifts.get(g.id)?.status).toBe("pending");
  });
  it("captures on the server, verifies amounts, records one payment and enforces ownership", async () => {
    const g = await gift();
    api.orders.get(g.providerRef).status = "APPROVED";
    await expectStatus(
      bob.req("POST", `/v2/billing/paypal/checkouts/${g.id}/confirm`, {}),
      404,
    );
    await expectStatus(
      alice.req("POST", "/v2/billing/paypal/checkouts/gft_invalid/confirm", {}),
      404,
    );
    const a = await alice.req(
      "POST",
      `/v2/billing/paypal/checkouts/${g.id}/confirm`,
      {},
    );
    const b = await alice.req(
      "POST",
      `/v2/billing/paypal/checkouts/${g.id}/confirm`,
      {},
    );
    expect(a.confirmed).toBe(true);
    expect(b.confirmed).toBe(true);
    expect(
      api.calls.filter(
        (c) => c.path === `/v2/checkout/orders/${g.providerRef}/capture`,
      ),
    ).toHaveLength(1);
    expect(h.ctx.gifts.get(g.id)?.provider_payment_ref).toBe(
      `CAPTURE${g.providerRef}`,
    );
    const history = await alice.req("GET", "/v2/billing/paypal/history");
    expect(history.transactions.find((t: any) => t.id === g.id).status).toBe(
      "paid",
    );
    expect(
      (await bob.req("GET", "/v2/billing/paypal/history")).transactions.find(
        (t: any) => t.id === g.id,
      ),
    ).toBeUndefined();
  });
  it("rejects a capture with the wrong merchant or payable amount", async () => {
    const g = await gift();
    const o = api.orders.get(g.providerRef);
    o.purchase_units[0].payee.merchant_id = "ATTACKER";
    await expect(
      checkout().confirm(alice.accountId, g.id, true),
    ).rejects.toThrow(/do not match/);
    o.purchase_units[0].payee.merchant_id = env.PAYPAL_MERCHANT_ID;
    o.purchase_units[0].amount.value = "0.01";
    await expect(
      checkout().confirm(alice.accountId, g.id, true),
    ).rejects.toThrow(/do not match/);
    expect(h.ctx.gifts.get(g.id)?.status).toBe("pending");
  });
  it("requires explicit refund confirmation, billing permission and an audit entry; retries refund only once", async () => {
    const g = await gift();
    api.orders.get(g.providerRef).status = "APPROVED";
    await checkout().confirm(alice.accountId, g.id, true);
    const path = `/admin/v1/billing/paypal/transactions/${g.id}/refund`;
    expect(
      (
        await auditor.browser.req("POST", path, {
          confirm: true,
          reason: "Testing authorized refunds",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.browser.req("POST", path, {
          confirm: false,
          reason: "Testing authorized refunds",
        })
      ).status,
    ).toBe(400);
    const a = await admin.browser.expect(200, "POST", path, {
      confirm: true,
      reason: "Testing authorized refunds",
    });
    const b = await admin.browser.expect(200, "POST", path, {
      confirm: true,
      reason: "Testing authorized refunds",
    });
    expect(a).toEqual(b);
    expect(a.status).toBe("completed");
    expect(h.ctx.gifts.get(g.id)?.status).toBe("refunded");
    expect(
      api.calls.filter(
        (c) =>
          c.path === `/v2/payments/captures/CAPTURE${g.providerRef}/refund`,
      ),
    ).toHaveLength(1);
    expect(
      h.ctx.platform.get("platform_audit", {
        action: "billing.paypal.refund_requested",
        target_id: g.id,
      }),
    ).toBeTruthy();
    await expectStatus(
      bob.req("POST", `/v2/mojo/gifts/${g.id}/redeem`, {}),
      403,
    );
  });
  it("verifies the complete webhook body with PayPal, rejects bad signatures and deduplicates durably", async () => {
    const e = event("CHECKOUT.ORDER.APPROVED", { id: "ORDER1" });
    const bad = await deliver(e, {
      ...headers(),
      "paypal-transmission-sig": "forged",
    });
    expect(bad.statusCode).toBe(400);
    const good = await deliver(e);
    expect(good.statusCode).toBe(200);
    expect(good.json().duplicate).toBe(false);
    const again = await deliver(e);
    expect(again.json().duplicate).toBe(true);
    const call = api.calls.findLast(
      (c) => c.path === "/v1/notifications/verify-webhook-signature",
    )!;
    expect(call.body.webhook_event).toEqual(e);
    expect(
      h.ctx.billing.rows.all("billing_provider_events", {
        where: { provider: "paypal", event_ref: e.id },
      }),
    ).toHaveLength(1);
    const malicious = await deliver(event("TEST", {}), {
      ...headers(),
      "paypal-cert-url": "https://attacker.test/cert",
    });
    expect(malicious.statusCode).toBe(400);
  });
  it("preserves existing free time while scheduling and cancelling an approved unpaid subscription", async () => {
    const user = await AccountClient.ready(h.baseUrl, mailer, "paypalfreeperiod");
    const end = Date.now() + 7 * 86400000;
    const id = "grt_paypal_free_period";
    await h.ctx.billing.rows.write((w) => w.insert("billing_grants", { id, account_id: user.accountId, user_id: user.userId, plan_key: "plus", source: "operator", starts_at: Date.now() - 1000, ends_at: end, created_at: Date.now() }));
    expect((await user.req("GET", "/v2/billing/paypal/config")).billingStartAt).toBe(end);
    const p = await user.req("POST", "/v2/billing/paypal/checkouts", { product: "plus", requestKey: randomUUID() });
    const remote = api.subs.get(p.providerRef);
    expect(remote.start_time).toBe(new Date(end).toISOString());
    remote.status = "ACTIVE";
    const result = await user.req("POST", `/v2/billing/paypal/checkouts/${p.id}/confirm`, {});
    expect(result).toMatchObject({ approved: true, confirmed: false, status: "incomplete" });
    expect(h.ctx.billing.grants.get(id)?.ends_at).toBe(end);
    const canceled = await user.req("POST", "/v2/billing/paypal/cancel", { confirm: true });
    expect(canceled.confirmed).toBe(true);
    expect(h.ctx.billing.grants.get(id)?.ends_at).toBe(end);
  });

  it("independently verifies Plus activation, failed renewal, recovery, cancellation and paid-period expiration", async () => {
    const user = await AccountClient.ready(h.baseUrl, mailer, "paypalplus");
    const started = await user.req("POST", "/v2/billing/paypal/checkouts", {
      product: "plus",
      requestKey: randomUUID(),
    });
    expect(
      (await checkout().confirm(user.accountId, started.id, false)).confirmed,
    ).toBe(false);
    const remote = api.activate(started.providerRef);
    expect(
      (
        await user.req(
          "POST",
          `/v2/billing/paypal/checkouts/${started.id}/confirm`,
          {},
        )
      ).confirmed,
    ).toBe(true);
    let sub = h.ctx.billing.subscriptions.liveForOwner({
      kind: "account",
      accountId: user.accountId,
    })!;
    expect(h.ctx.mojo.planOf(user.userId, Date.now())).toBe("plus");
    expect(
      (await user.req("GET", "/v2/mojo/me")).perks.uploadBytes,
    ).toBeLessThanOrEqual(1024000000);
    remote.billing_info.failed_payments_count = 1;
    const failure = await deliver(
      event("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: remote.id }),
    );
    expect(failure.json().status).toBe("processed");
    sub = h.ctx.billing.subscriptions.get(sub.id)!;
    expect(sub.status).toBe("past_due");
    expect(h.ctx.billing.subscriptions.grants(sub, Date.now())).toBe(true);
    expect(
      h.ctx.billing.subscriptions.grants(
        sub,
        (sub.past_due_since ?? 0) + 3 * 86400000,
      ),
    ).toBe(false);
    remote.billing_info.failed_payments_count = 0;
    await deliver(event("BILLING.SUBSCRIPTION.ACTIVATED", { id: remote.id }));
    expect(h.ctx.billing.subscriptions.get(sub.id)?.status).toBe("active");
    // Out-of-order signed event fetches current remote state instead of restoring stale event resource fields.
    await deliver(
      event(
        "BILLING.SUBSCRIPTION.CREATED",
        { id: remote.id, status: "APPROVAL_PENDING" },
        randomUUID(),
        NOW - 10000,
      ),
    );
    expect(h.ctx.billing.subscriptions.get(sub.id)?.status).toBe("active");
    const cancel = await user.req("POST", "/v2/billing/paypal/cancel", {
      confirm: true,
    });
    expect(cancel.confirmed).toBe(true);
    sub = h.ctx.billing.subscriptions.get(sub.id)!;
    expect(sub.cancel_at_period_end).toBe(1);
    expect(h.ctx.billing.subscriptions.grants(sub, Date.now())).toBe(true);
    expect(
      h.ctx.billing.subscriptions.grants(sub, sub.current_period_end! + 1),
    ).toBe(false);
    expect(
      (await user.req("GET", "/v2/billing/paypal/history")).history.length,
    ).toBeGreaterThan(0);
  });
  it("records renewals and safely synchronizes suspension, reactivation and provider expiration", async () => {
    const user = await AccountClient.ready(
      h.baseUrl,
      mailer,
      "paypallifecycle",
    );
    const start = await user.req("POST", "/v2/billing/paypal/checkouts", {
      product: "plus",
      requestKey: randomUUID(),
    });
    const remote = api.activate(start.providerRef);
    await checkout().confirm(user.accountId, start.id, false);
    const renewal = event("PAYMENT.SALE.COMPLETED", {
      id: "SALETEST",
      billing_agreement_id: remote.id,
      amount: { currency: "USD", total: "3.99" },
      create_time: new Date().toISOString(),
    });
    expect((await deliver(renewal)).json().status).toBe("processed");
    expect(
      (await user.req("GET", "/v2/billing/paypal/history")).transactions[0],
    ).toMatchObject({
      amountMinor: 399,
      providerRef: "SALETEST",
      status: "paid",
    });
    const partial = {
      kind: "refund" as const,
      ref: "PARTIAL1",
      paymentRef: "SALETEST",
      subscriptionRef: remote.id,
      customerRef: null,
      currency: "USD",
      amountMinor: 399,
      affectedMinor: 100,
      state: "partially_refunded",
    };
    for (const id of ["partial-event", "partial-event-other-delivery"])
      await h.ctx.billing.webhooks.ingest("paypal", {
        ref: id,
        type: "PAYMENT.SALE.REFUNDED",
        createdAt: Date.now(),
        kind: "payment",
        payment: partial,
      });
    expect(
      h.ctx.billing.rows.get<{ amount_refunded_minor: number }>(
        "billing_invoices",
        { provider_invoice_ref: "SALETEST" },
      )?.amount_refunded_minor,
    ).toBe(100);
    remote.status = "SUSPENDED";
    await h.ctx.billing.rows.write((w) =>
      w.update(
        "billing_invoices",
        { provider_invoice_ref: "SALETEST" },
        { provider_updated_at: Date.now() + 10000 },
      ),
    );
    const batch = await h.ctx.billing.webhooks.ingest("paypal", {
      ref: "mixed-fresh-stale-batch",
      type: "TEST.BATCH",
      createdAt: Date.now(),
      kind: "batch",
      events: [
        {
          ref: "batch-sub",
          type: "BILLING.SUBSCRIPTION.SUSPENDED",
          createdAt: Date.now(),
          kind: "subscription",
          subscription: await provider.fetchSubscription(remote.id),
        },
        {
          ref: "batch-invoice",
          type: "PAYMENT.SALE.COMPLETED",
          createdAt: Date.now(),
          kind: "invoice",
          invoice: {
            ref: "SALETEST",
            subscriptionRef: remote.id,
            status: "paid",
            currency: "USD",
            amountDueMinor: 399,
            amountPaidMinor: 399,
            amountRefundedMinor: 0,
            taxMinor: null,
            periodStart: NOW,
            periodEnd: NOW + 30 * 86400000,
            issuedAt: NOW,
            paidAt: NOW,
          },
        },
      ],
    });
    expect(batch.status).toBe("processed");
    expect(h.ctx.mojo.planOf(user.userId, Date.now())).toBe("free");
    remote.status = "ACTIVE";
    await deliver(event("BILLING.SUBSCRIPTION.ACTIVATED", { id: remote.id }));
    expect(h.ctx.mojo.planOf(user.userId, Date.now())).toBe("plus");
    remote.status = "EXPIRED";
    await deliver(event("BILLING.SUBSCRIPTION.EXPIRED", { id: remote.id }));
    expect(h.ctx.mojo.planOf(user.userId, Date.now())).toBe("free");
  });
  it("applies an early refund before completion and never resurrects the refunded gift", async () => {
    const g = await gift();
    const o = api.orders.get(g.providerRef);
    o.status = "APPROVED";
    const snap = await provider.captureOrder(g.providerRef, {
      reference: g.id,
      amountMinor: g.amountMinor,
    });
    o.purchase_units[0].payments.captures[0].status = "REFUNDED";
    const refunded = await deliver(
      event("PAYMENT.CAPTURE.REFUNDED", {
        id: "REFUNDEARLY",
        links: [
          {
            rel: "up",
            href: `https://api.sandbox.paypal.com/v2/payments/captures/${snap.paymentRef}`,
          },
        ],
      }),
    );
    expect(refunded.json().status).toBe("processed");
    await h.ctx.billing.webhooks.ingest("paypal", {
      ref: "late-capture-test",
      type: "PAYMENT.CAPTURE.COMPLETED",
      createdAt: NOW - 10000,
      kind: "checkout",
      checkout: snap,
    });
    expect(h.ctx.gifts.get(g.id)?.status).toBe("refunded");
    await expectStatus(
      bob.req("POST", `/v2/mojo/gifts/${g.id}/redeem`, {}),
      403,
    );
  });
  it("removes only the reversed gift grant, leaving other grants intact", async () => {
    const buyer = await AccountClient.ready(
      h.baseUrl,
      mailer,
      "paypalreversalbuyer",
    );
    const g = await gift(buyer);
    api.orders.get(g.providerRef).status = "APPROVED";
    await checkout().confirm(buyer.accountId, g.id, true);
    const otherEnd = Date.now() + 86400000;
    await h.ctx.billing.rows.write((w) =>
      w.insert("billing_grants", {
        id: "grt_other_reversal",
        account_id: bob.accountId,
        user_id: bob.userId,
        plan_key: "plus",
        source: "operator",
        starts_at: Date.now() - 1000,
        ends_at: otherEnd,
        created_at: Date.now(),
      }),
    );
    await bob.req("POST", `/v2/mojo/gifts/${g.id}/redeem`, {});
    const paid = h.ctx.gifts.get(g.id)!;
    await h.ctx.billing.webhooks.ingest("paypal", {
      ref: "reversal-test",
      type: "PAYMENT.CAPTURE.REVERSED",
      createdAt: Date.now(),
      kind: "payment",
      payment: {
        kind: "refund",
        ref: "REVERSALTEST",
        paymentRef: paid.provider_payment_ref!,
        customerRef: null,
        currency: paid.currency,
        amountMinor: paid.amount_minor,
        affectedMinor: paid.amount_minor,
        state: "reversed",
      },
    });
    expect(h.ctx.gifts.get(g.id)?.status).toBe("refunded");
    expect(
      h.ctx.billing.grants.get(paid.grant_id!)!.ends_at,
    ).toBeLessThanOrEqual(Date.now());
    expect(
      h.ctx.billing.rows.get("billing_grant_notes", {
        grant_id: paid.grant_id!,
      }),
    ).toBeTruthy();
    expect(h.ctx.billing.grants.get("grt_other_reversal")!.ends_at).toBe(
      otherEnd,
    );
  });
  it("recovers a durable received event after a process interruption", async () => {
    const e = {
      ref: "crash-test",
      type: "TEST",
      createdAt: NOW - 120000,
      kind: "other",
    };
    await h.ctx.billing.rows.write((w) =>
      w.insert("billing_provider_events", {
        id: "bev_crash",
        provider: "paypal",
        event_ref: e.ref,
        type: e.type,
        provider_created_at: e.createdAt,
        received_at: NOW - 120000,
        status: "received",
        summary: JSON.stringify(e),
      }),
    );
    await h.ctx.billing.webhooks.retryDue();
    expect(
      h.ctx.billing.rows.get<{ status: string }>("billing_provider_events", {
        id: "bev_crash",
      })?.status,
    ).toBe("ignored");
  });
  it("never grants on ACTIVE without a verified payment and prevents binding another account's subscription", async () => {
    const user = await AccountClient.ready(h.baseUrl, mailer, "paypalunpaid");
    const start = await user.req("POST", "/v2/billing/paypal/checkouts", {
      product: "plus",
      requestKey: randomUUID(),
    });
    const remote = api.subs.get(start.providerRef);
    remote.status = "ACTIVE";
    expect(
      (await checkout().confirm(user.accountId, start.id, false)).confirmed,
    ).toBe(false);
    await expectStatus(
      alice.req("POST", `/v2/billing/paypal/checkouts/${start.id}/confirm`, {}),
      404,
    );
    remote.plan_id = "P-ATTACKER";
    await expect(
      checkout().confirm(user.accountId, start.id, false),
    ).rejects.toThrow(/terms/);
  });
});
