import { RefundOperation, RefundInspection, RefundOperations, PaymentPage } from "../src/shared/contracts/http/adminRefunds.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PayPalProvider } from "../src/modules/billing/providers/paypal.js";
import { PayPalRefundRejected, type PayPalApi } from "../src/modules/billing/providers/paypalApi.js";
import { parseMinor, decimalMinor } from "../src/modules/billing/money.js";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, consoleAdmin, type ConsoleAdmin, AdminBrowser } from "./support/adminConsole.js";
import { startServer, type Harness } from "./support/harness.js";

/** Recording REST fake. This verifies Meldiq's durable behavior, not a connected PayPal Sandbox. */
class RefundApi implements PayPalApi {
  orders = new Map<string, any>();
  refunds = new Map<string, any>();
  posts = 0;
  nextStatus = "COMPLETED";
  timeoutAfterAccept = false;
  readsFail = false;
  rejectNext = false;
  beforeRead: (() => Promise<void>) | null = null;
  async request(method: string, path: string, body?: any, key?: string): Promise<any> {
    if (method === "GET" && this.beforeRead) { const pause = this.beforeRead; this.beforeRead = null; await pause(); }
    if (method === "GET" && this.readsFail) throw new Error("simulated network failure");
    if (path.includes("/checkout/orders/")) return structuredClone(this.orders.get(path.split("/").at(-1)!));
    if (path.includes("/payments/refunds/")) return structuredClone(this.refunds.get(path.split("/").at(-1)!));
    const captureId = path.split("/")[4]!;
    const o = [...this.orders.values()].find(v => v.purchase_units[0].payments.captures[0].id === captureId);
    if (!o) throw new Error("Missing fixture capture");
    if (method === "GET") return structuredClone(o.purchase_units[0].payments.captures[0]);
    this.posts++;
    if (this.rejectNext) { this.rejectNext = false; throw new PayPalRefundRejected("TRANSACTION_DISPUTED"); }
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.amount.currency_code).toBe("USD");
    const id = `RF${this.refunds.size + 1}`;
    const r = { id, status: this.nextStatus, custom_id: body.custom_id, amount: body.amount, links: [{ rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}` }] };
    this.refunds.set(id, r);
    o.purchase_units[0].payments.refunds.push(r);
    this.updateCapture(o);
    if (this.timeoutAfterAccept) { this.timeoutAfterAccept = false; throw new Error("timeout after provider acceptance"); }
    return { id, status: r.status };
  }
  updateCapture(o: any) {
    const amount = o.purchase_units[0].payments.refunds.filter((r: any) => r.status === "COMPLETED").reduce((n: number, r: any) => n + parseMinor(r.amount.value, 2), 0);
    o.purchase_units[0].payments.captures[0].status = amount === 499 ? "REFUNDED" : amount > 0 ? "PARTIALLY_REFUNDED" : "COMPLETED";
  }
}

describe("durable admin refunds", () => {
  let h: Harness, admin: ConsoleAdmin, auditor: ConsoleAdmin;
  const fake = new RefundApi();
  const mailer = new MemoryMailer();
  const provider = new PayPalProvider({ api: fake, environment: "sandbox", clientId: "fixture", clientSecret: "fixture", merchantId: "TESTMERCHANT", webhookId: "WH-FIXTURE", plusPlanId: null, subscriptionsApproved: false });
  beforeAll(async () => {
    h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, WORKFLOW_TICK_MS: "0" }, { mailer, billingProvider: provider });
    admin = await consoleAdmin(h, mailer, "billing_admin", "refundoperator");
    auditor = await consoleAdmin(h, mailer, "auditor", "refundreader");
  });
  afterAll(async () => h?.close());

  async function purchase(kind: "gift" | "spark" | "collectible" = "gift") {
    const suffix = randomUUID().slice(0, 8), id = `${kind === "gift" ? "gft" : kind === "spark" ? "spk" : "colpay"}_${suffix}`, orderId = `ORDER${suffix}`, captureId = `CAP${suffix}`, now = Date.now();
    const o = { id: orderId, status: "COMPLETED", purchase_units: [{ custom_id: id, amount: { currency_code: "USD", value: "4.99" }, payee: { merchant_id: "TESTMERCHANT" }, payments: { captures: [{ id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value: "4.99" } }], refunds: [] } }] };
    fake.orders.set(orderId, o);
    await h.ctx.billing.rows.write(w => {
      const base = { id, provider: "paypal", currency: "USD", amount_minor: 499, status: "paid", created_at: now, updated_at: now, expires_at: now + 86_400_000 };
      if (kind === "gift") w.insert("mojo_gifts", { ...base, buyer_account_id: admin.account.accountId, buyer_user_id: null, recipient_user_id: "fixture-recipient", plan_key: "plus", months: 1, provider_session_ref: orderId, provider_payment_ref: captureId, paid_at: now });
      if (kind === "spark") w.insert("spark_purchases", { ...base, buyer_account_id: admin.account.accountId, quantity: 1, provider_session_ref: orderId, provider_payment_ref: captureId, paid_at: now });
      if (kind === "collectible") w.insert("collectible_orders", { ...base, account_id: admin.account.accountId, item_id: "fixture-item", item_version: 1, original_amount_minor: 499, session_ref: orderId, payment_ref: captureId, request_key: randomUUID() });
    });
    return { id, orderId, captureId };
  }
  const body = (amountMinor = 499) => ({ confirm: true, requestKey: randomUUID(), accountId: admin.account.accountId, currency: "USD", amountMinor, reason: "Disposable refund investigation" });
  const request = (id: string, input: ReturnType<typeof body>) => admin.browser.expect(200, "POST", `/admin/v1/billing/paypal/payments/${id}/refunds`, input);

  it("serves strict shared list response contracts", async () => {
    RefundOperations.parse(await auditor.browser.expect(200, "GET", "/admin/v1/billing/refunds"));
    PaymentPage.parse(await auditor.browser.expect(200, "GET", "/admin/v1/billing/paypal/payments"));
  });
  it("persists a partial then remaining full refund, preserves partial gift access, and records one action for retries", async () => {
    const p = await purchase(), first = body(199), before = fake.posts;
    const a = await request(p.id, first), duplicate = await request(p.id, first);
    RefundOperation.parse(a); RefundInspection.parse(await admin.browser.expect(200, "GET", `/admin/v1/billing/paypal/payments/${p.id}/refunds`));
    expect(a).toMatchObject({ status: "completed", amountMinor: 199, mode: "test" }); expect(duplicate.id).toBe(a.id); expect(fake.posts - before).toBe(1);
    expect(h.ctx.gifts.get(p.id)?.status).toBe("paid");
    const inspected = await admin.browser.expect(200, "GET", `/admin/v1/billing/paypal/payments/${p.id}/refunds`);
    expect(inspected).toMatchObject({ remainingMinor: 300, completedMinor: 199, reservedMinor: 0 });
    expect((await admin.browser.req("POST", `/admin/v1/billing/paypal/payments/${p.id}/refunds`, body(301))).status).toBe(409);
    // Use service for the second operation to avoid coupling the case to HTTP rate-limit timing.
    const b = await h.ctx.billing.adminRefunds.request(p.id, body(300), admin.account.accountId, async () => {});
    expect(b.status).toBe("completed"); expect(h.ctx.gifts.get(p.id)?.status).toBe("refunded");
    const audit = await auditor.browser.expect(200, "GET", `/admin/v1/audit?targetId=${a.id}`);
    expect(JSON.stringify(audit)).toContain("billing.refund.requested");
  });

  it("resolves timeout after acceptance by provider reads, without a second financial POST", async () => {
    const p = await purchase(), input = body(250), before = fake.posts;
    fake.timeoutAfterAccept = true;
    const first = await h.ctx.billing.adminRefunds.request(p.id, input, admin.account.accountId, async () => {});
    expect(first.status).toBe("uncertain"); expect(first.providerRef).toBeNull();
    expect((await h.ctx.billing.adminRefunds.request(p.id, input, admin.account.accountId, async () => {})).id).toBe(first.id);
    await expect(h.ctx.billing.adminRefunds.request(p.id, body(200), admin.account.accountId, async () => {})).rejects.toThrow(/pending|uncertain/);
    const resolved = await h.ctx.billing.adminRefunds.reconcile(first.id);
    expect(resolved.status).toBe("completed"); expect(fake.posts - before).toBe(1);
    expect((await h.ctx.billing.adminRefunds.inspect(p.id)).remainingMinor).toBe(249);
  });

  it("serializes concurrent distinct refunds and rejects duplicate identity with a changed amount", async () => {
    const p = await purchase(), input = body(300), before = fake.posts;
    const results = await Promise.allSettled([h.ctx.billing.adminRefunds.request(p.id, input, admin.account.accountId, async () => {}), h.ctx.billing.adminRefunds.request(p.id, body(300), admin.account.accountId, async () => {})]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(fake.posts - before).toBe(1);
    await expect(h.ctx.billing.adminRefunds.request(p.id, { ...input, amountMinor: 301 }, admin.account.accountId, async () => {})).rejects.toThrow(/identity/);
  });

  it("keeps pending reservations and releases only provider-confirmed failure", async () => {
    const p = await purchase(); fake.nextStatus = "PENDING";
    const a = await h.ctx.billing.adminRefunds.request(p.id, body(499), admin.account.accountId, async () => {});
    expect(a.status).toBe("pending"); expect((await h.ctx.billing.adminRefunds.inspect(p.id)).reservedMinor).toBe(499);
    fake.refunds.get(a.providerRef!)!.status = "FAILED";
    expect((await h.ctx.billing.adminRefunds.reconcile(a.id)).status).toBe("failed");
    expect((await h.ctx.billing.adminRefunds.inspect(p.id)).remainingMinor).toBe(499); fake.nextStatus = "COMPLETED";
  });

  it("records a documented provider refusal as failed instead of pretending it completed", async () => {
    const p = await purchase(); fake.rejectNext = true;
    const result = await h.ctx.billing.adminRefunds.request(p.id, body(100), admin.account.accountId, async () => {});
    expect(result.status).toBe("failed"); expect(result.lastError).toContain("disputed");
    expect((await h.ctx.billing.adminRefunds.inspect(p.id)).remainingMinor).toBe(499);
  });

  it("safely releases a reservation before dispatch while the original request is still awaiting audit", async () => {
    const p = await purchase(), before = fake.posts;
    let audited!: () => void, resume!: () => void;
    const ready = new Promise<void>(resolve => { audited = resolve; });
    const hold = new Promise<void>(resolve => { resume = resolve; });
    const request = h.ctx.billing.adminRefunds.request(p.id, body(199), admin.account.accountId, async () => { audited(); await hold; });
    await ready;
    const reserved = h.ctx.billing.rows.get<{ id: string }>("billing_admin_refunds", { purchase_id: p.id })!;
    expect((await h.ctx.billing.adminRefunds.reconcile(reserved.id)).status).toBe("failed");
    resume(); expect((await request).status).toBe("failed"); expect(fake.posts).toBe(before);
    expect((await h.ctx.billing.adminRefunds.inspect(p.id)).remainingMinor).toBe(499);
  });

  it("rejects wrong owner, currency, merchant and refund references without changing money", async () => {
    const p = await purchase(), before = fake.posts;
    await expect(h.ctx.billing.adminRefunds.request(p.id, { ...body(), accountId: "another-account" }, admin.account.accountId, async () => {})).rejects.toThrow(/account/);
    await expect(h.ctx.billing.adminRefunds.request(p.id, { ...body(), currency: "JPY" }, admin.account.accountId, async () => {})).rejects.toThrow(/currency/);
    fake.orders.get(p.orderId).purchase_units[0].payee.merchant_id = "ANOTHER";
    await expect(h.ctx.billing.adminRefunds.request(p.id, body(), admin.account.accountId, async () => {})).rejects.toThrow(/match/);
    expect(fake.posts).toBe(before);
  });

  it("refuses reconciliation under a changed source environment or merchant without another POST", async () => {
    const p = await purchase(), input = body(199); fake.timeoutAfterAccept = true;
    const r = await h.ctx.billing.adminRefunds.request(p.id, input, admin.account.accountId, async () => {}), posts = fake.posts;
    await h.ctx.billing.rows.write(w => w.update("billing_admin_refunds", { id: r.id }, { provider_mode: "live" }));
    await expect(h.ctx.billing.adminRefunds.reconcile(r.id)).rejects.toThrow(/environment/);
    await expect(h.ctx.billing.adminRefunds.request(p.id, input, admin.account.accountId, async () => {})).rejects.toThrow(/environment/);
    await h.ctx.billing.rows.write(w => w.update("billing_admin_refunds", { id: r.id }, { provider_mode: "test", merchant_id: "OTHER" }));
    await expect(h.ctx.billing.adminRefunds.reconcile(r.id)).rejects.toThrow(/merchant/); expect(fake.posts).toBe(posts);
  });
  it.each(["permission", "session", "reauth"] as const)("revalidates %s after a delayed provider read and fails before money dispatch", async changed => {
    const operator = await consoleAdmin(h, mailer, "billing_admin", `refundfresh${changed}`);
    const p = await purchase(), input = body(199), posts = fake.posts;
    let arrived!: () => void, resume!: () => void;
    const waiting = new Promise<void>(resolve => { arrived = resolve; });
    const hold = new Promise<void>(resolve => { resume = resolve; });
    fake.beforeRead = async () => { arrived(); await hold; };
    const response = operator.browser.req("POST", `/admin/v1/billing/paypal/payments/${p.id}/refunds`, input);
    await waiting;
    if (changed === "permission") await h.ctx.platform.write(w => w.update("platform_admins", { account_id: operator.account.accountId }, { permissions: JSON.stringify(["billing.view"]) }));
    else await h.ctx.ephemeral.write(w => w.update("platform_admin_sessions", { account_id: operator.account.accountId }, changed === "session" ? { revoked_at: Date.now() } : { reauth_at: 0 }));
    resume();
    expect((await response).status).toBe(403); expect(fake.posts).toBe(posts);
    expect(h.ctx.billing.rows.get("billing_admin_refunds", { request_key: input.requestKey })).toMatchObject({ status: "failed", last_error: "Authorization or audit persistence failed before dispatch. No financial request was sent." });
    expect((await h.ctx.billing.adminRefunds.inspect(p.id)).reservedMinor).toBe(0);
  });

  it("blocks readonly and unauthenticated direct requests and leaves a no-store response", async () => {
    const p = await purchase();
    const answer = await auditor.browser.req("POST", `/admin/v1/billing/paypal/payments/${p.id}/refunds`, body());
    expect(answer.status).toBe(403);
    expect((await new AdminBrowser(h).req("GET", "/admin/v1/billing/refunds")).status).toBe(401);
    const list = await auditor.browser.req("GET", `/admin/v1/billing/paypal/payments?account=${admin.account.accountId}&kind=gift&limit=2`);
    expect(list.status).toBe(200); expect(list.body.payments).toHaveLength(2); expect(list.body.nextCursor).toBeTruthy(); expect(String(list.headers["cache-control"])).toContain("no-store");
    expect((await auditor.browser.expect(200, "GET", `/admin/v1/billing/paypal/payments?account=not-the-owner`)).payments).toHaveLength(0);
  });

  it("does not dispatch when requested audit persistence fails; supports Spark and collectible capture ownership", async () => {
    const p = await purchase("spark"), before = fake.posts;
    await expect(h.ctx.billing.adminRefunds.request(p.id, body(100), admin.account.accountId, async () => { throw new Error("audit storage down"); })).rejects.toThrow("audit storage down");
    expect(fake.posts).toBe(before);
    const op = await h.ctx.billing.adminRefunds.request(p.id, body(200), admin.account.accountId, async () => {});
    expect(op.status).toBe("completed"); expect(h.ctx.billing.sparkPurchases.get(p.id)?.status).toBe("paid");
    const col = await purchase("collectible");
    expect((await h.ctx.billing.adminRefunds.request(col.id, body(499), admin.account.accountId, async () => {})).status).toBe("completed");
    expect(h.ctx.billing.rows.get<{ status: string }>("collectible_orders", { id: col.id })?.status).toBe("refunded");
  });
});

it("uses exact decimal arithmetic for zero, two and three precision currencies", () => {
  expect(parseMinor("500", 0)).toBe(500); expect(decimalMinor(500, 0)).toBe("500");
  expect(parseMinor("12.345", 3)).toBe(12345); expect(decimalMinor(12345, 3)).toBe("12.345");
  expect(parseMinor("4.99", 2)).toBe(499); expect(() => parseMinor("1.001", 2)).toThrow();
  expect(() => parseMinor("9007199254740992", 0)).toThrow(); expect(() => parseMinor("1.0", 0)).toThrow();
});
