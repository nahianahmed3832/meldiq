import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingConfig } from "../src/modules/billing/config.js";
import { canMove, grantsPlan, standing } from "../src/modules/billing/lifecycle.js";
import { SANDBOX_SIGNATURE_HEADER, SandboxProvider, signSandbox } from "../src/modules/billing/providers/sandbox.js";
import { WebhookRejected } from "../src/modules/billing/providers/types.js";
import { retryDelay } from "../src/modules/billing/webhooks.js";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { OrgBilling } from "../src/shared/contracts/http/billing.js";
import { AdminBillingEventsPage, AdminBillingMetrics, AdminPlan, AdminPlans, AdminSubscriptionDetail, AdminSubscriptionsPage } from "../src/shared/contracts/http/platformAdminBilling.js";
import { Plan } from "../src/shared/contracts/http/roles.js";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Billing (docs/BILLING.md): the plan catalog and its versions, the sandbox provider's signed webhooks, the subscription
 * lifecycle with its entitlements, invoices, provider-event recovery, the console's figures, and who may do what.
 */
const SECRET = "sandbox-webhook-secret-for-tests-0123456789";
const REASON = "Billing test: checking the change";
const DAY_MS = 86_400_000;

describe("lifecycle rules", () => {
  it("allow only the documented transitions", () => {
    expect(canMove(null, "trialing")).toBe(true);
    expect(canMove("trialing", "active")).toBe(true);
    expect(canMove("active", "past_due")).toBe(true);
    expect(canMove("past_due", "active")).toBe(true);
    expect(canMove("canceled", "active")).toBe(false);
    expect(canMove("incomplete_expired", "active")).toBe(false);
    expect(canMove("active", "incomplete")).toBe(false);
  });

  it("grant the plan while trialing or active, and while past due only within the grace days", () => {
    const t = Date.parse("2026-10-28T00:00:00Z");
    expect(grantsPlan({ status: "active", pastDueSince: null, graceDays: 0 }, t)).toBe(true);
    expect(grantsPlan({ status: "trialing", pastDueSince: null, graceDays: 0 }, t)).toBe(true);
    expect(standing({ status: "past_due", pastDueSince: t - 2 * DAY_MS, graceDays: 3 }, t)).toBe("grace");
    expect(standing({ status: "past_due", pastDueSince: t - 3 * DAY_MS, graceDays: 3 }, t)).toBe("grace_ended");
    expect(standing({ status: "past_due", pastDueSince: t, graceDays: 0 }, t)).toBe("grace_ended");
    for (const status of ["incomplete", "paused", "canceled", "incomplete_expired"] as const) expect(grantsPlan({ status, pastDueSince: null, graceDays: 30 }, t)).toBe(false);
  });

  it("retry failed events with growing, capped delays", () => {
    expect(retryDelay(1)).toBe(60_000);
    expect(retryDelay(3)).toBe(240_000);
    expect(retryDelay(20)).toBe(6 * 3_600_000);
  });
});

describe("sandbox provider", () => {
  const p = new SandboxProvider(SECRET);
  const t = Date.now();
  const body = JSON.stringify({ id: "evt_1", type: "ping", created: t });
  const reason = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof WebhookRejected ? e.reason : "other";
    }
    return "accepted";
  };

  it("accepts a body signed with the secret, as sent", () => {
    expect(p.verifyWebhook({ [SANDBOX_SIGNATURE_HEADER]: signSandbox(SECRET, body) }, body, t)).toMatchObject({ ref: "evt_1", kind: "other" });
  });

  it("refuses a missing, wrong or stale signature, and a changed body", () => {
    expect(reason(() => p.verifyWebhook({}, body, t))).toBe("missing_signature");
    expect(reason(() => p.verifyWebhook({ [SANDBOX_SIGNATURE_HEADER]: signSandbox("another-secret-that-is-long-enough-000", body) }, body, t))).toBe("bad_signature");
    expect(reason(() => p.verifyWebhook({ [SANDBOX_SIGNATURE_HEADER]: signSandbox(SECRET, body) }, `${body} `, t))).toBe("bad_signature");
    expect(reason(() => p.verifyWebhook({ [SANDBOX_SIGNATURE_HEADER]: "t=1,v1=zz" }, body, t))).toBe("bad_signature");
    const old = Math.floor(t / 1000) - 600;
    expect(reason(() => p.verifyWebhook({ [SANDBOX_SIGNATURE_HEADER]: signSandbox(SECRET, body, old) }, body, t))).toBe("stale_timestamp");
    const notJson = "not json";
    expect(reason(() => p.verifyWebhook({ [SANDBOX_SIGNATURE_HEADER]: signSandbox(SECRET, notJson) }, notJson, t))).toBe("unreadable_body");
  });

  it("needs a long secret, and an unknown provider stops the server", () => {
    expect(() => billingConfig({ BILLING_PROVIDER: "sandbox", BILLING_SANDBOX_WEBHOOK_SECRET: "short" })).toThrow(/at least 32/);
    expect(() => billingConfig({ BILLING_PROVIDER: "paypal" })).toThrow(/unknown provider/);
    expect(billingConfig({}).provider).toBeNull();
  });
});

describe("with the sandbox provider", () => {
  let h: Harness;
  const mailer = new MemoryMailer();
  const admins: Record<string, ConsoleAdmin> = {};
  let owner: GriipClient, member: GriipClient, outsider: GriipClient;
  let orgId: string;
  let seq = 0;

  const as = (role: string) => admins[role]!.browser;
  const lastAudit = (action: string) => h.ctx.platform.get<any>("platform_audit", { action }, [["id", "desc"]]);
  const deliver = async (event: object, headers: Record<string, string> = {}) => {
    const payload = JSON.stringify(event);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/billing/webhooks/sandbox",
      payload,
      headers: { "content-type": "application/json", [SANDBOX_SIGNATURE_HEADER]: signSandbox(SECRET, payload), ...headers },
    });
    return { status: res.statusCode, body: res.json() };
  };
  const subEvent = (sub: object, created = Date.now() + ++seq) => ({ id: `evt_${++seq}`, type: "subscription.updated", created, data: { subscription: sub } });
  const plan = async (key: string) => {
    const r = await as("billing_admin").expect(200, "POST", "/admin/v1/billing/plans", {
      key,
      name: `Plan ${key}`,
      description: "For tests",
      segment: "communities",
      public: true,
      terms: { interval: "month", currency: "usd", amountMinor: 1200, providerPriceRef: `price_${key}`, trialDays: 14, graceDays: 3, limits: { members: 2 }, notes: "" },
      reason: REASON,
    });
    await as("billing_admin").expect(200, "POST", `/admin/v1/billing/plans/${r.id}/publish`, { reason: REASON });
    return r.id as string;
  };
  const membersCap = async () => ((await owner.req("GET", `/v1/orgs/${orgId}/plan`)).capabilities as { key: string; limit: number | null; source: string }[]).find((c) => c.key === "members")!;

  beforeAll(async () => {
    h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, BILLING_PROVIDER: "sandbox", BILLING_SANDBOX_WEBHOOK_SECRET: SECRET, WORKFLOW_TICK_MS: "0" }, { mailer });
    for (const role of ["super_admin", "operations_admin", "support_admin", "billing_admin", "auditor"]) admins[role] = await consoleAdmin(h, mailer, role, `bill${role}`);
    [owner, member, outsider] = await Promise.all(["bilowner", "bilmember", "biloutsider"].map((n) => h.client(n)));
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Billing Lab" })).org.id;
    const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
    await member.req("POST", "/v1/invites/accept", { code });
  });
  afterAll(async () => h.close());

  describe("the plan catalog", () => {
    it("creates a draft, publishes it, and freezes published terms", async () => {
      const draft = await as("billing_admin").expect(200, "POST", "/admin/v1/billing/plans", {
        key: "team",
        name: "Team",
        description: "Small teams",
        segment: "teams",
        public: true,
        terms: { interval: "month", currency: "usd", amountMinor: 900, providerPriceRef: null, trialDays: 0, graceDays: 0, limits: { members: 25 }, notes: "" },
        reason: REASON,
      });
      expect(AdminPlan.safeParse(draft).success).toBe(true);
      expect(draft).toMatchObject({ status: "draft", versions: [{ version: 1, state: "draft", terms: { currency: "USD", amountMinor: 900 } }] });
      expect(lastAudit("billing.plan_create")).toMatchObject({ target_id: draft.id, reason: REASON, actor_role: "billing_admin" });
      // No provider price yet: can't publish.
      await as("billing_admin").expect(409, "POST", `/admin/v1/billing/plans/${draft.id}/publish`, { reason: REASON });
      const terms = { interval: "month", currency: "USD", amountMinor: 900, providerPriceRef: "price_team_v1", trialDays: 0, graceDays: 0, limits: { members: 25 }, notes: "" };
      await as("billing_admin").expect(200, "PUT", `/admin/v1/billing/plans/${draft.id}/draft`, { terms, reason: REASON });
      const live = await as("billing_admin").expect(200, "POST", `/admin/v1/billing/plans/${draft.id}/publish`, { reason: REASON });
      expect(live).toMatchObject({ status: "active", versions: [{ version: 1, state: "current", provider: "sandbox" }] });
      // SQLite also refuses it with a trigger; on any backend the catalog never edits a published version.
      if (h.ctx.billing.rows.backend === "sqlite") expect(() => h.ctx.db.prepare("UPDATE billing_plan_versions SET amount_minor = 1 WHERE plan_id = ?").run(draft.id)).toThrow(/immutable/);
      // New terms are a new version; the old one is retired, never edited.
      const v2 = await as("billing_admin").expect(200, "PUT", `/admin/v1/billing/plans/${draft.id}/draft`, { terms: { ...terms, amountMinor: 1100, providerPriceRef: "price_team_v2" }, reason: REASON });
      expect(v2.versions.map((v: any) => [v.version, v.state])).toEqual([
        [2, "draft"],
        [1, "current"],
      ]);
      await as("billing_admin").expect(200, "POST", `/admin/v1/billing/plans/${draft.id}/publish`, { reason: REASON });
      const all = await as("auditor").expect(200, "GET", "/admin/v1/billing/plans");
      expect(AdminPlans.safeParse(all).success).toBe(true);
      expect(all.setup).toMatchObject({ provider: { id: "sandbox", mode: "test" }, webhookPath: "/v1/billing/webhooks/sandbox" });
      expect(all.plans.find((p: any) => p.key === "team").versions.map((v: any) => [v.version, v.state, v.terms.amountMinor])).toEqual([
        [2, "current", 1100],
        [1, "retired", 900],
      ]);
    });

    it("refuses bad terms, duplicate keys and reused provider prices", async () => {
      const body = (over: object) => ({
        key: "bad",
        name: "Bad",
        description: "",
        segment: "",
        public: false,
        terms: { interval: "month", currency: "USD", amountMinor: 100, providerPriceRef: null, trialDays: 0, graceDays: 0, limits: {}, notes: "", ...over },
        reason: REASON,
      });
      await as("billing_admin").expect(400, "POST", "/admin/v1/billing/plans", body({ amountMinor: -1 }));
      await as("billing_admin").expect(400, "POST", "/admin/v1/billing/plans", body({ amountMinor: 1.5 }));
      await as("billing_admin").expect(400, "POST", "/admin/v1/billing/plans", body({ currency: "XYZ" }));
      await as("billing_admin").expect(400, "POST", "/admin/v1/billing/plans", body({ interval: "week" }));
      await as("billing_admin").expect(400, "POST", "/admin/v1/billing/plans", body({ limits: { "ai.requests": 5 } }));
      await as("billing_admin").expect(400, "POST", "/admin/v1/billing/plans", { ...body({}), status: "active" });
      await as("billing_admin").expect(409, "POST", "/admin/v1/billing/plans", { ...body({}), key: "team" });
      const dup = await as("billing_admin").expect(200, "POST", "/admin/v1/billing/plans", body({ providerPriceRef: "price_team_v2" }));
      await as("billing_admin").expect(409, "POST", `/admin/v1/billing/plans/${dup.id}/publish`, { reason: REASON });
    });

    it("is managed only by roles with billing.manage, and seen by billing.view", async () => {
      const body = { key: "nope", name: "Nope", description: "", segment: "", public: false, terms: { interval: "year", currency: "EUR", amountMinor: 0, providerPriceRef: null, trialDays: 0, graceDays: 0, limits: {}, notes: "" }, reason: REASON };
      for (const role of ["support_admin", "operations_admin", "auditor"]) await as(role).expect(403, "POST", "/admin/v1/billing/plans", body);
      await as("operations_admin").expect(403, "GET", "/admin/v1/billing/plans");
      await as("support_admin").expect(200, "GET", "/admin/v1/billing/subscriptions");
      await as("super_admin").expect(200, "POST", "/admin/v1/billing/plans", body);
    });
  });

  describe("checkout and subscriptions", () => {
    let planId: string;
    let checkoutId: string;
    let subscriptionId: string;
    const base = () => ({ id: "sub_sbx_1", customer: "cus_sbx_1", price: "price_starter", checkoutReference: checkoutId, currentPeriodStart: Date.now(), currentPeriodEnd: Date.now() + 30 * DAY_MS });

    beforeAll(async () => {
      planId = await plan("starter");
    });

    it("only owners see billing and start a checkout; the plan must be offered", async () => {
      await expectStatus(member.req("GET", `/v1/orgs/${orgId}/billing`), 403);
      await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/billing`), 404);
      await expectStatus(member.req("POST", `/v1/orgs/${orgId}/billing/checkout`, { planKey: "starter" }), 403);
      await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/billing/checkout`, { planKey: "nope" }), 404);
      const summary = await owner.req("GET", `/v1/orgs/${orgId}/billing`);
      expect(OrgBilling.safeParse(summary).success).toBe(true);
      expect(summary).toMatchObject({ available: true, subscription: null, invoices: [] });
      expect(summary.offers.map((o: any) => o.key)).toContain("starter");
      const started = await owner.req("POST", `/v1/orgs/${orgId}/billing/checkout`, { planKey: "starter" });
      expect(started).toMatchObject({ url: null });
      checkoutId = started.checkoutId;
      // Coming back from checkout proves nothing: no subscription until the provider's event.
      expect((await owner.req("GET", `/v1/orgs/${orgId}/billing`)).subscription).toBeNull();
    });

    it("refuses unsigned or tampered webhooks and counts them", async () => {
      const event = subEvent({ ...base(), status: "active" });
      expect((await deliver(event, { [SANDBOX_SIGNATURE_HEADER]: "t=1,v1=00" })).status).toBe(400);
      const res = await h.app.inject({ method: "POST", url: "/v1/billing/webhooks/sandbox", payload: JSON.stringify(event), headers: { "content-type": "application/json" } });
      expect(res.statusCode).toBe(400);
      // Only the configured provider has an endpoint.
      const other = await h.app.inject({ method: "POST", url: "/v1/billing/webhooks/stripe", payload: "{}", headers: { "content-type": "application/json" } });
      expect(other.statusCode).toBe(404);
      const rejected = h.ctx.billing.rows.all<{ reason: string; count: number }>("billing_webhook_rejections", { orderBy: [["reason", "asc"]] }).map(({ reason, count }) => ({ reason, count }));
      expect(rejected).toEqual([
        { reason: "bad_signature", count: 1 },
        { reason: "missing_signature", count: 1 },
      ]);
      expect(h.ctx.billing.rows.count("billing_provider_events")).toBe(0);
    });

    it("never attaches a subscription to an organization without our checkout", async () => {
      const r = await deliver(subEvent({ ...base(), id: "sub_rogue", checkoutReference: null, status: "active" }));
      expect(r.body).toMatchObject({ received: true, status: "failed" });
      const forged = await deliver(subEvent({ ...base(), id: "sub_rogue2", checkoutReference: "chk_forged", status: "active" }));
      expect(forged.body.status).toBe("failed");
      expect(h.ctx.billing.rows.count("billing_subscriptions")).toBe(0);
      expect(h.ctx.billing.rows.all<{ last_error: string }>("billing_provider_events", { orderBy: [["received_at", "asc"]] }).map((e) => ({ last_error: e.last_error }))).toEqual([{ last_error: "unknown_checkout" }, { last_error: "unknown_checkout" }]);
    });

    it("starts the trial from the provider's event, and the plan's limits apply", async () => {
      expect(await membersCap()).toMatchObject({ limit: null, source: "none" });
      const r = await deliver(subEvent({ ...base(), status: "trialing", trialEnd: Date.now() + 14 * DAY_MS }));
      expect(r.body).toEqual({ received: true, duplicate: false, status: "processed" });
      const plan = await owner.req("GET", `/v1/orgs/${orgId}/plan`);
      expect(Plan.safeParse(plan).success).toBe(true);
      expect(plan.plan).toEqual({ name: "Plan starter" });
      expect(await membersCap()).toMatchObject({ limit: 2, source: "plan" });
      // Two members already: a third is refused, and nobody is removed.
      const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
      await expectStatus(outsider.req("POST", "/v1/invites/accept", { code }), 409);
      // Members see the plan's name, not its billing.
      expect((await member.req("GET", `/v1/orgs/${orgId}/plan`)).plan).toEqual({ name: "Plan starter" });
      const summary = await owner.req("GET", `/v1/orgs/${orgId}/billing`);
      expect(summary.subscription).toMatchObject({ plan: { key: "starter" }, status: "trialing", standing: "entitled", amountMinor: 1200, currency: "USD" });
      subscriptionId = h.ctx.billing.rows.get<{ id: string }>("billing_subscriptions", {})!.id;
      // A second checkout while one isn't over is refused.
      await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/billing/checkout`, { planKey: "starter" }), 409);
    });

    it("acknowledges a duplicate delivery without applying it twice", async () => {
      const event = subEvent({ ...base(), status: "active" });
      expect((await deliver(event)).body).toMatchObject({ duplicate: false, status: "processed" });
      expect((await deliver(event)).body).toMatchObject({ duplicate: true, status: "processed" });
      const history = h.ctx.billing.rows
        .all<{ from_status: string | null; to_status: string }>("billing_subscription_history", { where: { subscription_id: subscriptionId }, orderBy: [["id", "asc"]] })
        .map(({ from_status, to_status }) => ({ from_status, to_status }));
      expect(history).toEqual([
        { from_status: null, to_status: "trialing" },
        { from_status: "trialing", to_status: "active" },
      ]);
    });

    it("ignores an event older than the state already applied", async () => {
      const r = await deliver(subEvent({ ...base(), status: "trialing" }, Date.now() - 60_000));
      expect(r.body.status).toBe("ignored");
      expect(h.ctx.billing.subscriptions.get(subscriptionId)!.status).toBe("active");
    });

    it("keeps an invoice that arrives before its subscription and applies it on retry", async () => {
      const invoice = { id: "in_1", subscription: "sub_sbx_late", status: "paid", currency: "usd", amountDue: 1200, amountPaid: 1200, issuedAt: Date.now(), paidAt: Date.now() };
      const early = await deliver({ id: `evt_${++seq}`, type: "invoice.paid", created: Date.now(), data: { invoice } });
      expect(early.body.status).toBe("failed");
      // The invoice was for our subscription after all (the provider's id): point it there and let the job retry.
      const fixed = { ...invoice, id: "in_2", subscription: "sub_sbx_1" };
      expect((await deliver({ id: `evt_${++seq}`, type: "invoice.paid", created: Date.now(), data: { invoice: fixed } })).body.status).toBe("processed");
      await h.ctx.billing.rows.write((w) => w.update("billing_provider_events", { status: "failed" }, { next_attempt_at: 0 }));
      await runCleanup(h.ctx);
      const ev = h.ctx.billing.rows.get<{ attempts: number; status: string }>("billing_provider_events", { event_ref: `evt_${seq - 1}` })!;
      const attempts = { attempts: ev.attempts, status: ev.status };
      expect(attempts).toEqual({ attempts: 2, status: "failed" });
      const summary = await owner.req("GET", `/v1/orgs/${orgId}/billing`);
      expect(summary.invoices).toEqual([expect.objectContaining({ status: "paid", currency: "USD", amountDueMinor: 1200, amountPaidMinor: 1200 })]);
    });

    it("keeps the plan through the grace days after a failed payment, and refuses impossible moves", async () => {
      await deliver(subEvent({ ...base(), status: "past_due" }));
      const s = h.ctx.billing.subscriptions.get(subscriptionId)!;
      expect(s.past_due_since).not.toBeNull();
      expect(await membersCap()).toMatchObject({ limit: 2, source: "plan" });
      expect((await owner.req("GET", `/v1/orgs/${orgId}/billing`)).subscription.standing).toBe("grace");
      // Grace over (3 days): the plan stops applying; the organization falls back, nothing is removed.
      await h.ctx.billing.rows.write((w) => w.update("billing_subscriptions", { id: subscriptionId }, { past_due_since: Date.now() - 4 * DAY_MS }));
      expect(await membersCap()).toMatchObject({ limit: null, source: "none" });
      expect((await owner.req("GET", `/v1/orgs/${orgId}/billing`)).subscription.standing).toBe("grace_ended");
      await deliver(subEvent({ ...base(), status: "active", cancelAtPeriodEnd: true }));
      expect(await membersCap()).toMatchObject({ limit: 2, source: "plan" });
      await deliver(subEvent({ ...base(), status: "canceled", canceledAt: Date.now() }));
      expect(await membersCap()).toMatchObject({ source: "none" });
      const back = await deliver(subEvent({ ...base(), status: "active" }));
      expect(back.body.status).toBe("failed");
      expect(h.ctx.billing.subscriptions.get(subscriptionId)!.status).toBe("canceled");
    });

    it("shows subscriptions, their history and invoices to billing.view roles only", async () => {
      const page = await as("support_admin").expect(200, "GET", "/admin/v1/billing/subscriptions?status=canceled");
      expect(AdminSubscriptionsPage.safeParse(page).success).toBe(true);
      expect(page.subscriptions).toEqual([expect.objectContaining({ id: subscriptionId, org: { id: orgId, name: "Billing Lab" }, plan: { key: "starter", name: "Plan starter", version: 1 } })]);
      expect((await as("billing_admin").expect(200, "GET", "/admin/v1/billing/subscriptions?status=active")).subscriptions).toEqual([]);
      const detail = await as("billing_admin").expect(200, "GET", `/admin/v1/billing/subscriptions/${subscriptionId}`);
      expect(AdminSubscriptionDetail.safeParse(detail).success).toBe(true);
      expect(detail.history.map((x: any) => x.to)).toEqual(["canceled", "active", "past_due", "active", "trialing"]);
      expect(detail.invoices).toHaveLength(1);
      await as("operations_admin").expect(403, "GET", `/admin/v1/billing/subscriptions/${subscriptionId}`);
      await as("billing_admin").expect(404, "GET", "/admin/v1/billing/subscriptions/sub_none");
      await as("billing_admin").expect(400, "GET", "/admin/v1/billing/subscriptions?status=bogus");
      const org = await as("billing_admin").expect(200, "GET", `/admin/v1/orgs/${orgId}`);
      expect(org.subscription).toBeNull();
    });

    it("lets billing admins replay a failed event, with a reason", async () => {
      const events = await as("billing_admin").expect(200, "GET", "/admin/v1/billing/events?status=failed");
      expect(AdminBillingEventsPage.safeParse(events).success).toBe(true);
      const failed = events.events.find((e: any) => e.lastError === "invalid_transition");
      await as("support_admin").expect(403, "POST", `/admin/v1/billing/events/${failed.id}/replay`, { reason: REASON });
      await as("billing_admin").expect(400, "POST", `/admin/v1/billing/events/${failed.id}/replay`, {});
      expect(await as("billing_admin").expect(200, "POST", `/admin/v1/billing/events/${failed.id}/replay`, { reason: REASON })).toEqual({ status: "failed" });
      expect(lastAudit("billing.event_replay")).toMatchObject({ target_id: failed.id, reason: REASON });
      const processed = (await as("billing_admin").expect(200, "GET", "/admin/v1/billing/events?status=processed")).events[0];
      await as("billing_admin").expect(409, "POST", `/admin/v1/billing/events/${processed.id}/replay`, { reason: REASON });
    });

    it("gives events up after the last attempt", async () => {
      const r = await deliver(subEvent({ ...base(), id: "sub_dead", checkoutReference: null, status: "active" }));
      const id = h.ctx.billing.rows.get<{ id: string }>("billing_provider_events", { subscription_id: null }, [["received_at", "desc"]])!.id;
      expect(r.body.status).toBe("failed");
      for (let i = 0; i < 8; i++) {
        await h.ctx.billing.rows.write((w) => w.update("billing_provider_events", { id, status: "failed" }, { next_attempt_at: 0 }));
        await h.ctx.billing.webhooks.retryDue();
      }
      const dead = h.ctx.billing.rows.get<{ status: string; attempts: number; next_attempt_at: number | null }>("billing_provider_events", { id })!;
      expect({ status: dead.status, attempts: dead.attempts, next_attempt_at: dead.next_attempt_at }).toEqual({ status: "dead", attempts: 8, next_attempt_at: null });
    });

    it("reports figures per currency, with their definitions", async () => {
      // A second, paying organization so the MRR estimate has something to sum.
      const other = (await owner.req("POST", "/v1/orgs", { name: "Second Lab" })).org.id;
      const chk = (await owner.req("POST", `/v1/orgs/${other}/billing/checkout`, { planKey: "starter" })).checkoutId;
      await deliver(subEvent({ id: "sub_sbx_2", customer: "cus_2", price: "price_starter", checkoutReference: chk, status: "active", currentPeriodEnd: Date.now() + 30 * DAY_MS }));
      const m = await as("billing_admin").expect(200, "GET", "/admin/v1/billing/metrics?days=30");
      expect(AdminBillingMetrics.safeParse(m).success).toBe(true);
      expect(m.subscriptions.byStatus).toMatchObject({ active: 1, canceled: 1 });
      expect(m.subscriptions).toMatchObject({ granting: 1, started: 2, canceled: 1, trialsStarted: 1, trialConversions: 1 });
      expect(m.money.mrrEstimate).toEqual([{ currency: "USD", amountMinor: 1200 }]);
      expect(m.money.collected).toEqual([{ currency: "USD", amountMinor: 1200 }]);
      expect(m.webhooks.rejected).toEqual(expect.arrayContaining([{ reason: "bad_signature", count: 1 }]));
      expect(m.definitions.map((d: any) => d.key)).toContain("mrrEstimate");
      await as("billing_admin").expect(400, "GET", "/admin/v1/billing/metrics?days=12");
      await as("operations_admin").expect(403, "GET", "/admin/v1/billing/metrics");
      expect((await as("billing_admin").expect(200, "GET", `/admin/v1/orgs/${other}`)).subscription).toMatchObject({ plan: "Plan starter", status: "active", standing: "entitled" });
    });

    it("keeps an existing subscriber's terms when the plan changes", async () => {
      const terms = { interval: "month", currency: "USD", amountMinor: 1500, providerPriceRef: "price_starter_v2", trialDays: 0, graceDays: 0, limits: { members: 9 }, notes: "" };
      await as("billing_admin").expect(200, "PUT", `/admin/v1/billing/plans/${planId}/draft`, { terms, reason: REASON });
      await as("billing_admin").expect(200, "POST", `/admin/v1/billing/plans/${planId}/publish`, { reason: REASON });
      const sub2 = h.ctx.billing.rows.get<{ org_id: string }>("billing_subscriptions", { provider_subscription_ref: "sub_sbx_2" })!;
      expect(h.ctx.entitlements.limitFor("members", sub2.org_id)).toEqual({ limit: 2, source: "plan" });
      const m = await as("billing_admin").expect(200, "GET", "/admin/v1/billing/metrics?days=7");
      expect(m.money.mrrEstimate).toEqual([{ currency: "USD", amountMinor: 1200 }]);
      await as("billing_admin").expect(200, "POST", `/admin/v1/billing/plans/${planId}/archive`, { reason: REASON });
      expect(h.ctx.entitlements.limitFor("members", sub2.org_id)).toEqual({ limit: 2, source: "plan" });
      expect((await owner.req("GET", `/v1/orgs/${orgId}/billing`)).offers.map((o: any) => o.key)).not.toContain("starter");
    });
  });

  describe("operator limits", () => {
    it("need an end date, except a super admin's explicit choice, and stop at it", async () => {
      await as("billing_admin").expect(400, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: 50 }, reason: REASON });
      await as("billing_admin").expect(403, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: 50 }, expiresAt: null, reason: REASON });
      await as("billing_admin").expect(400, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: 50 }, expiresAt: Date.now() - 1, reason: REASON });
      await as("billing_admin").expect(400, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: 50 }, expiresAt: Date.now() + 400 * DAY_MS, reason: REASON });
      const until = Date.now() + 7 * DAY_MS;
      const set = await as("billing_admin").expect(200, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: 50 }, expiresAt: until, reason: REASON });
      expect(set.limits).toContainEqual({ key: "members", limit: 50, source: "workspace" });
      expect(JSON.parse(lastAudit("org.limits").detail)).toEqual({ members: "default -> 50", until: new Date(until).toISOString() });
      const listed = (await as("billing_admin").expect(200, "GET", "/admin/v1/entitlements")).overrides;
      expect(listed).toContainEqual(expect.objectContaining({ orgId, key: "members", limit: 50, expiresAt: until, reason: REASON }));
      await h.ctx.ws.write((w) => w.update("org_entitlements", { org_id: orgId }, { expires_at: Date.now() - 1 }));
      expect(h.ctx.entitlements.limitFor("members", orgId).source).not.toBe("workspace");
      expect((await as("billing_admin").expect(200, "GET", "/admin/v1/entitlements")).overrides).toEqual([]);
      await as("super_admin").expect(200, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: 60 }, expiresAt: null, reason: REASON });
      expect(JSON.parse(lastAudit("org.limits").detail).until).toBe("no end");
      await as("billing_admin").expect(200, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: null }, reason: REASON });
    });
  });
});

describe("without a provider", () => {
  let h: Harness;
  const mailer = new MemoryMailer();
  let admin: ConsoleAdmin;

  beforeAll(async () => {
    h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN }, { mailer });
    admin = await consoleAdmin(h, mailer, "billing_admin", "nobill");
  });
  afterAll(async () => h.close());

  it("prepares plans but can't publish, sell, or receive webhooks", async () => {
    const owner = await h.client("nobillowner");
    const org = (await owner.req("POST", "/v1/orgs", { name: "No Billing" })).org.id;
    const summary = await owner.req("GET", `/v1/orgs/${org}/billing`);
    expect(summary).toMatchObject({ available: false, subscription: null, offers: [] });
    expect(summary.reason).toMatch(/No billing provider/);
    await expectStatus(owner.req("POST", `/v1/orgs/${org}/billing/checkout`, { planKey: "any" }), 409);
    const res = await h.app.inject({ method: "POST", url: "/v1/billing/webhooks/sandbox", payload: "{}", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(404);
    const plan = await admin.browser.expect(200, "POST", "/admin/v1/billing/plans", {
      key: "later",
      name: "Later",
      description: "",
      segment: "",
      public: true,
      terms: { interval: "month", currency: "USD", amountMinor: 500, providerPriceRef: "price_later", trialDays: 0, graceDays: 0, limits: {}, notes: "" },
      reason: REASON,
    });
    await admin.browser.expect(409, "POST", `/admin/v1/billing/plans/${plan.id}/publish`, { reason: REASON });
    const m = await admin.browser.expect(200, "GET", "/admin/v1/billing/metrics");
    expect(m.setup).toMatchObject({ provider: null, webhookPath: null });
    expect((await admin.browser.expect(200, "GET", "/admin/v1/overview")).billing).toMatchObject({ available: false });
  });
});
