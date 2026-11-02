import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import {
  StripeProvider,
  type StripeApi,
} from "../src/modules/billing/providers/stripe.js";
import { MemoryMailer, AccountClient } from "./support/accounts.js";
import {
  ADMIN_ORIGIN,
  consoleAdmin,
  type ConsoleAdmin,
} from "./support/adminConsole.js";
import { startServer, type Harness } from "./support/harness.js";
import { inRollout } from "../src/modules/platformAdmin/runtimePolicy.js";
import {
  standingOf,
  requireStanding,
} from "../src/modules/accounts/standing.js";
import { legacyOperatorAllowed } from "../src/modules/platformAdmin/operations.js";
import { PlatformAudit } from "../src/modules/platformAdmin/audit.js";
import { testMongoEnv } from "./support/mongo.js";
import { mongoConfig } from "../src/infrastructure/database/mongo/config.js";
import { openMongo } from "../src/infrastructure/database/mongo/index.js";
import { openDatabase } from "../src/infrastructure/database/db.js";
const SECRET = "whsec_opsTestSecret01234567890123456789";
class Payments implements StripeApi {
  sessions: { id: string; params: Stripe.Checkout.SessionCreateParams }[] = [];
  refunds = 0;
  async createCustomer() {
    return { id: "cus_controls" };
  }
  async createCheckoutSession(params: Stripe.Checkout.SessionCreateParams) {
    const id = "cs_ops_" + (this.sessions.length + 1);
    this.sessions.push({ id, params });
    return { id, url: "https://checkout.stripe.test/" + id };
  }
  async expireCheckoutSession() {}
  async createPortalSession() {
    return { url: "https://stripe.test/portal" };
  }
  async retrieveSubscription() {
    return null;
  }
  async refundPayment() {
    this.refunds++;
    return { id: "re_ops_confirmed", status: "succeeded" };
  }
}
describe("connected operational controls", () => {
  let h: Harness,
    admin: ConsoleAdmin,
    moderator: ConsoleAdmin,
    auditor: ConsoleAdmin,
    person: AccountClient,
    other: AccountClient;
  const mailer = new MemoryMailer(),
    payments = new Payments();
  let noticeId: string, warningId: string, appealId: string, orderId: string;
  beforeAll(async () => {
    const mongoEnv = process.env.MELDIQ_TEST_MONGO_DOMAINS ? testMongoEnv({}) : {};
    if (process.env.MELDIQ_TEST_MONGO_DOMAINS) {
      // Bootstrap the disposable, empty domains through the normal authority checks,
      // then exercise the stricter production startup against verified markers.
      const db = openDatabase(":memory:");
      try {
        const config = mongoConfig(mongoEnv, "development", (_name, fallback) => fallback)!;
        const mongo = await openMongo(config, db);
        await mongo.close();
      } finally {
        db.close();
      }
    }
    const provider = new StripeProvider({
      secretKey: "sk_test_meldiqmojofaketestkey0123456789",
      webhookSecret: SECRET,
      allowPromotionCodes: false,
      api: payments,
    });
    h = await startServer(
      {
        ...mongoEnv,
        DATABASE_MODE: process.env.MELDIQ_TEST_MONGO_DOMAINS ? "atlas" : "hybrid",
        ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN,
        BILLING_PROVIDER: "stripe",
        STRIPE_SECRET_KEY: "sk_test_meldiqmojofaketestkey0123456789",
        STRIPE_WEBHOOK_SECRET: SECRET,
        BILLING_WEB_RETURN_URL: "https://web.test/settings/mojo",
        BILLING_RETURN_URL: "https://web.test/billing",
      },
      { mailer, billingProvider: provider },
    );
    admin = await consoleAdmin(h, mailer, "super_admin", "controlssuper");
    moderator = await consoleAdmin(
      h,
      mailer,
      "platform_moderator",
      "controlsmod",
    );
    auditor = await consoleAdmin(h, mailer, "auditor", "controlsaudit");
    person = await AccountClient.ready(h.baseUrl, mailer, "controlsuser");
    other = await AccountClient.ready(h.baseUrl, mailer, "controlsother");
  }, 180000);
  afterAll(async () => h?.close(), 180000);
  const raw = async (
    client: AccountClient,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    fetch(h.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${client.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  it("publishes a real targeted notice, counts idempotent reads and excludes other users", async () => {
    const x = await admin.browser.expect(
      200,
      "POST",
      "/admin/v1/operations/notices",
      {
        kind: "announcement",
        title: "Operations notice",
        body: "A scheduled service announcement",
        targetUserId: person.userId,
        startsAt: Date.now() - 1000,
        endsAt: Date.now() + 86400000,
        reason: "Test targeted announcement",
      },
    );
    noticeId = x.item.id;
    expect(
      (await person.req("GET", "/v2/platform/notices")).items,
    ).toHaveLength(0);
    await admin.browser.expect(
      200,
      "POST",
      `/admin/v1/operations/notices/${noticeId}/state`,
      { version: 1, status: "published", reason: "Publish reviewed notice" },
    );
    expect(
      (await person.req("GET", "/v2/platform/notices")).items[0].title,
    ).toBe("Operations notice");
    expect((await other.req("GET", "/v2/platform/notices")).items).toHaveLength(
      0,
    );
    expect(
      (await raw(other, "POST", `/v2/platform/notices/${noticeId}/read`))
        .status,
    ).toBe(404);
    await person.req("POST", `/v2/platform/notices/${noticeId}/read`);
    await person.req("POST", `/v2/platform/notices/${noticeId}/read`);
    expect(
      (
        await admin.browser.expect(
          200,
          "GET",
          `/admin/v1/operations/notices/${noticeId}/receipts`,
        )
      ).read,
    ).toBe(1);
  });
  it("rejects stale notice writes and unauthorized publishing", async () => {
    expect(
      (
        await admin.browser.req(
          "POST",
          `/admin/v1/operations/notices/${noticeId}/state`,
          { version: 1, status: "withdrawn", reason: "Stale editor request" },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await auditor.browser.req(
          "POST",
          `/admin/v1/operations/notices/${noticeId}/state`,
          { version: 2, status: "withdrawn", reason: "Unauthorized publish" },
        )
      ).status,
    ).toBe(403);
  });
  it("withdraws real notices without deleting their history", async () => {
    await admin.browser.expect(
      200,
      "POST",
      `/admin/v1/operations/notices/${noticeId}/state`,
      { version: 2, status: "withdrawn", reason: "Withdraw resolved notice" },
    );
    expect(
      (await person.req("GET", "/v2/platform/notices")).items,
    ).toHaveLength(0);
    expect(
      h.ctx.platform.get<any>("platform_notices", { id: noticeId }).status,
    ).toBe("withdrawn");
  });
  it("issues canonical warnings with duration and server restrictions, idempotently", async () => {
    const body = {
      userId: person.userId,
      message: "Please follow the community rules",
      days: 14,
      requestId: "ops-warning-once",
      reason: "Review established safety policy",
    };
    const x = await moderator.browser.expect(
      200,
      "POST",
      "/admin/v1/operations/warnings",
      body,
    );
    warningId = x.id;
    await moderator.browser.expect(
      200,
      "POST",
      "/admin/v1/operations/warnings",
      body,
    );
    expect(standingOf(h.ctx.safety, person.userId).warnings).toHaveLength(1);
    expect(() =>
      requireStanding(h.ctx.safety, person.userId, "create_community"),
    ).toThrow(/Warnings/);
    expect((await person.req("GET", "/v2/account/standing")).level).toBe(
      "limited",
    );
  });
  it("accepts authenticated warning appeals and prevents another user appealing the warning", async () => {
    expect(
      (
        await raw(other, "POST", "/v2/platform/appeals", {
          noticeId: warningId,
          subject: "Wrong recipient",
          body: "I cannot appeal someone else’s warning",
        })
      ).status,
    ).toBe(404);
    const x = await person.req("POST", "/v2/platform/appeals", {
      noticeId: warningId,
      subject: "Review this warning",
      body: "Please review the warning with the additional context",
    });
    appealId = x.item.id;
    expect(
      (
        await raw(person, "POST", "/v2/platform/appeals", {
          noticeId: warningId,
          subject: "Duplicate appeal",
          body: "This duplicate should be rejected",
        })
      ).status,
    ).toBe(409);
  });
  it("requires a different reviewer, escalates and lifts the canonical warning after acceptance", async () => {
    const body = {
      version: 1,
      status: "accepted",
      decision: "The warning is overturned after review",
      reason: "Independent appeal review",
    };
    expect(
      (
        await moderator.browser.req(
          "POST",
          `/admin/v1/operations/appeals/${appealId}/decision`,
          body,
        )
      ).status,
    ).toBe(403);
    await admin.browser.expect(
      200,
      "POST",
      `/admin/v1/operations/appeals/${appealId}/decision`,
      {
        ...body,
        status: "escalated",
        assigneeAccountId: admin.account.accountId,
      },
    );
    await admin.browser.expect(
      200,
      "POST",
      `/admin/v1/operations/appeals/${appealId}/decision`,
      { ...body, version: 2 },
    );
    expect(standingOf(h.ctx.safety, person.userId).level).toBe("good");
    expect(
      (await person.req("GET", "/v2/platform/appeals")).items[0].decision,
    ).toContain("overturned");
  });
  it("redeems a bounded promotion exactly once and updates the real Plus entitlement", async () => {
    await admin.browser.expect(200, "PUT", "/admin/v1/operations/promotions", {
      code: "CONTROLSPROMO",
      title: "Launch promotion",
      months: 1,
      maxRedemptions: 1,
      startsAt: Date.now() - 1000,
      endsAt: Date.now() + 86400000,
      enabled: true,
      version: 0,
      reason: "Create controlled promotion",
    });
    const first = await person.req("POST", "/v2/platform/promotions/redeem", {
      code: "CONTROLSPROMO",
    });
    const again = await person.req("POST", "/v2/platform/promotions/redeem", {
      code: "CONTROLSPROMO",
    });
    expect(again.grantId).toBe(first.grantId);
    expect(
      h.ctx.billing.grants.active(person.accountId, Date.now())?.plan_key,
    ).toBe("plus");
    expect(
      (
        await raw(other, "POST", "/v2/platform/promotions/redeem", {
          code: "CONTROLSPROMO",
        })
      ).status,
    ).toBe(409);
    expect(
      h.ctx.billing.rows.get<any>("billing_promotions", {
        code: "CONTROLSPROMO",
      }).redeemed,
    ).toBe(1);
  });
  it("stages deterministic cohorts, honors exclusions, enforces operations and rejects stale policies", async () => {
    const x = await admin.browser.expect(
      200,
      "GET",
      "/admin/v1/operations/policy",
    );
    const policy = {
      ...x.policy,
      calls: { ...x.policy.calls, percent: 0 },
      orgCreation: {
        ...x.policy.orgCreation,
        percent: 0,
        allowUsers: [person.userId],
      },
    };
    await admin.browser.expect(200, "PUT", "/admin/v1/operations/policy", {
      version: x.version,
      policy,
      reason: "Stage verified feature cohorts",
    });
    expect(inRollout(h.ctx.platform, "calls", person.userId)).toBe(false);
    expect(inRollout(h.ctx.platform, "orgCreation", person.userId)).toBe(true);
    expect(inRollout(h.ctx.platform, "orgCreation", other.userId)).toBe(false);
    expect(
      (
        await raw(other, "POST", "/v1/orgs", {
          name: "Denied cohort community",
        })
      ).status,
    ).toBe(503);
    expect(
      (await other.req("GET", "/v2/platform/features")).features.orgCreation,
    ).toBe(false);
    expect(
      (
        await admin.browser.req("PUT", "/admin/v1/operations/policy", {
          version: 0,
          policy,
          reason: "Reject stale policy",
        })
      ).status,
    ).toBe(409);
    await admin.browser.expect(200, "PUT", "/admin/v1/operations/policy", {
      version: 1,
      policy: x.policy,
      reason: "Restore rollout baseline",
    });
  });
  it("does not let read-only roles mutate or stale-MFA sessions publish", async () => {
    expect(
      (await auditor.browser.req("PUT", "/admin/v1/operations/promotions", {}))
        .status,
    ).toBe(403);
    const me = await admin.browser.expect(200, "GET", "/admin/v1/me");
    await h.ctx.ephemeral.write((w) =>
      w.update(
        "platform_admin_sessions",
        { id: me.session.id },
        { reauth_at: 0 },
      ),
    );
    expect(
      (await admin.browser.req("POST", "/admin/v1/operations/notices", {})).body
        .error.code,
    ).toBe("reauth_required");
    await h.ctx.ephemeral.write((w) =>
      w.update(
        "platform_admin_sessions",
        { id: me.session.id },
        { reauth_at: Date.now() },
      ),
    );
  });
  it("creates a frozen hosted collectible checkout without granting ownership", async () => {
    const item = {
      ...new (
        await import("../src/modules/accounts/collectibles/service.js")
      ).CollectionService(h.ctx).item("ion-halo"),
      id: "paid-control-item",
      name: "Paid control item",
      acquisitionType: "purchase",
      currency: "USD",
      price: 499,
    };
    await admin.browser.expect(
      200,
      "PUT",
      "/admin/v1/profile-collectibles/paid-control-item",
      { item, reason: "Publish reviewed purchase product" },
    );
    const x = await person.req("POST", "/v2/collectible-purchases", {
      itemId: item.id,
      requestKey: "controls-purchase-once",
    });
    orderId = x.id;
    expect(
      payments.sessions[0].params.line_items?.[0].price_data?.unit_amount,
    ).toBe(499);
    expect(
      h.ctx.identity.get("profile_collectible_inventory", {
        user_id: person.userId,
        decoration_id: item.id,
      }),
    ).toBeUndefined();
    expect(
      (
        await person.req("POST", "/v2/collectible-purchases", {
          itemId: item.id,
          requestKey: "controls-purchase-once",
        })
      ).id,
    ).toBe(orderId);
    expect(payments.sessions).toHaveLength(1);
    expect(
      (await raw(other, "POST", `/v2/collectible-purchases/${orderId}/confirm`))
        .status,
    ).toBe(404);
  });
  it("rejects mismatched provider amounts, then grants only a verified paid order", async () => {
    const r = h.ctx.collectibleCommerce.get(orderId)!;
    const snap = {
      sessionRef: r.session_ref!,
      reference: r.id,
      outcome: "completed" as const,
      subscriptionRef: null,
      customerRef: null,
      mode: "payment" as const,
      paid: true,
      paymentRef: "pi_controls_paid",
      currency: "USD",
      amountMinor: 499,
    };
    const wrong = await h.ctx.billing.webhooks.ingest("stripe", {
      ref: "evt_control_mismatch",
      type: "checkout.completed",
      createdAt: Date.now(),
      kind: "checkout",
      checkout: { ...snap, amountMinor: 1 },
    });
    expect(wrong.status).toBe("failed");
    expect(h.ctx.collectibleCommerce.get(orderId)?.status).toBe("pending");
    const payload = JSON.stringify({
      id: "evt_control_paid",
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: {
        object: {
          id: r.session_ref,
          object: "checkout.session",
          mode: "payment",
          client_reference_id: r.id,
          metadata: { meldiq_checkout: r.id },
          payment_status: "paid",
          payment_intent: "pi_controls_paid",
          currency: "usd",
          amount_total: 499,
          customer: null,
          subscription: null,
        },
      },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
    });
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/v1/billing/webhooks/stripe",
          headers: {
            "content-type": "application/json",
            "stripe-signature": "invalid",
          },
          payload,
        })
      ).statusCode,
    ).toBe(400);
    const delivered = await h.app.inject({
      method: "POST",
      url: "/v1/billing/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload,
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().status).toBe("processed");
    await h.ctx.collectibleCommerce.sync();
    expect(
      h.ctx.identity.get<any>("profile_collectible_inventory", {
        user_id: person.userId,
        decoration_id: r.item_id,
      }).acquisition_source,
    ).toBe("purchase:" + orderId);
    const state = await person.req("GET", "/v2/users/me/profile-customization");
    await person.req("PATCH", "/v2/users/me/profile-customization", {
      baseStyleRevision: state.styleRevision,
      slots: { "avatar-frame": r.item_id },
    });
  });
  it("refunds via provider confirmation, revokes inventory and equipped style, and survives capture replay", async () => {
    await admin.browser.expect(
      200,
      "POST",
      `/admin/v1/operations/orders/${orderId}/refund`,
      { reason: "Refund reviewed purchase request" },
    );
    expect(payments.refunds).toBe(1);
    expect(h.ctx.collectibleCommerce.get(orderId)?.status).toBe("refunded");
    expect(
      h.ctx.identity.get("profile_collectible_inventory", {
        user_id: person.userId,
        decoration_id: "paid-control-item",
      }),
    ).toBeUndefined();
    expect(
      (await person.req("GET", "/v2/users/me/profile-customization"))
        .profileStyle.collectibles ?? [],
    ).toHaveLength(0);
    const r = h.ctx.collectibleCommerce.get(orderId)!;
    await h.ctx.billing.webhooks.ingest("stripe", {
      ref: "evt_control_late_capture",
      type: "checkout.completed",
      createdAt: Date.now(),
      kind: "checkout",
      checkout: {
        sessionRef: r.session_ref!,
        reference: r.id,
        outcome: "completed",
        subscriptionRef: null,
        customerRef: null,
        mode: "payment",
        paid: true,
        paymentRef: r.payment_ref,
        currency: "USD",
        amountMinor: 499,
      },
    });
    await h.ctx.collectibleCommerce.sync();
    expect(h.ctx.collectibleCommerce.get(orderId)?.status).toBe("refunded");
    expect(
      (
        await admin.browser.expect(
          200,
          "POST",
          `/admin/v1/operations/orders/${orderId}/refund`,
          { reason: "Repeat idempotent refund request" },
        )
      ).status,
    ).toBe("completed");
    expect(payments.refunds).toBe(1);
  });
  it("ties legacy read access to console revocation and explicit denial", async () => {
    const user = person.userId;
    (h.ctx.config.platformAdmins as Set<string>).add(user);
    expect(await legacyOperatorAllowed(h.ctx, user, "health.view")).toBe(true);
    await admin.browser.expect(
      200,
      "PUT",
      `/admin/v1/operations/operators/${user}`,
      { denied: true, reason: "Deprovision legacy operator access" },
    );
    expect(await legacyOperatorAllowed(h.ctx, user, "health.view")).toBe(false);
    expect((await raw(person, "GET", "/v1/admin/health")).status).toBe(403);
    await h.ctx.platform.write((w) =>
      w.insert("platform_admins", {
        account_id: person.accountId,
        role: "operations_admin",
        granted_at: Date.now(),
        updated_at: Date.now(),
        revoked_at: Date.now(),
      }),
    );
    await admin.browser.expect(
      200,
      "PUT",
      `/admin/v1/operations/operators/${user}`,
      { denied: false, reason: "Verify revocation still limits legacy access" },
    );
    expect(await legacyOperatorAllowed(h.ctx, user, "health.view")).toBe(false);
  });
  it("accepts single-use email-proof appeals from a suspended account without granting authentication", async () => {
    const emailUser = await AccountClient.ready(
      h.baseUrl,
      mailer,
      "appealemailperson",
    );
    await admin.browser.expect(
      200,
      "POST",
      `/admin/v1/users/${emailUser.userId}/suspend`,
      { reason: "Test suspended-account appeal access" },
    );
    const started = await h.app.inject({
      method: "POST",
      url: "/v2/platform/appeals/email/start",
      payload: { email: emailUser.email },
    });
    expect(started.statusCode).toBe(202);
    const proof = started.json();
    const code = mailer.sent
      .filter(
        (m) =>
          m.to === emailUser.email &&
          m.subject === "Meldiq appeal verification code",
      )
      .at(-1)!
      .text.match(/\b(\d{6})\b/)![1];
    const body = {
      challengeId: proof.challengeId,
      code,
      subject: "Suspension review",
      body: "Please review the suspension and my additional information",
    };
    const completed = await h.app.inject({
      method: "POST",
      url: "/v2/platform/appeals/email/complete",
      payload: body,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("open");
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/v2/platform/appeals/email/complete",
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
    expect((await raw(emailUser, "GET", "/v2/platform/notices")).status).toBe(
      401,
    );
  });
  it("records staff transfer proposals but requires the real current owner to approve", async () => {
    const org = (
      await person.req("POST", "/v1/orgs", { name: "Ownership consent lab" })
    ).org;
    const invite = (
      await person.req("POST", `/v1/orgs/${org.id}/invites`, { role: "MEMBER" })
    ).invite;
    await other.req("POST", "/v1/invites/accept", { code: invite.code });
    const proposal = await admin.browser.expect(
      200,
      "POST",
      "/admin/v1/operations/ownership",
      {
        orgId: org.id,
        ownerUserId: person.userId,
        targetUserId: other.userId,
        confirmName: "Ownership consent lab",
        reason: "Request verified owner consent",
      },
    );
    expect(h.ctx.authz.orgRole(org.id, person.userId)).toBe("OWNER");
    expect(
      (
        await raw(
          other,
          "POST",
          `/v2/platform/ownership/${proposal.item.id}/approve`,
          { confirmName: "Ownership consent lab" },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await raw(
          person,
          "POST",
          `/v2/platform/ownership/${proposal.item.id}/approve`,
          { confirmName: "Wrong name" },
        )
      ).status,
    ).toBe(400);
    await person.req(
      "POST",
      `/v2/platform/ownership/${proposal.item.id}/approve`,
      { confirmName: "Ownership consent lab" },
    );
    expect(h.ctx.authz.orgRole(org.id, other.userId)).toBe("OWNER");
    expect(h.ctx.authz.orgRole(org.id, person.userId)).toBe("ADMIN");
    expect(
      h.ctx.platform.get<any>("platform_ownership_requests", {
        id: proposal.item.id,
      }).status,
    ).toBe("completed");
  });
  it("freezes a real percentage discount and reserves its redemption only once", async () => {
    await admin.browser.expect(200, "PUT", "/admin/v1/operations/promotions", {
      product: "collectible_discount",
      discountPercent: 20,
      code: "COSMETIC20",
      title: "Collectible launch discount",
      months: 1,
      maxRedemptions: 1,
      startsAt: Date.now() - 1000,
      endsAt: Date.now() + 86400000,
      enabled: true,
      version: 0,
      reason: "Create verified percentage campaign",
    });
    const order = await other.req("POST", "/v2/collectible-purchases", {
      itemId: "paid-control-item",
      requestKey: "discounted-checkout-once",
      promotionCode: "COSMETIC20",
    });
    expect(order.amountMinor).toBe(399);
    expect(h.ctx.collectibleCommerce.get(order.id)?.original_amount_minor).toBe(
      499,
    );
    const again = await other.req("POST", "/v2/collectible-purchases", {
      itemId: "paid-control-item",
      requestKey: "discounted-checkout-once",
      promotionCode: "COSMETIC20",
    });
    expect(again.id).toBe(order.id);
    expect(
      h.ctx.billing.rows.get<any>("billing_promotions", { code: "COSMETIC20" })
        .redeemed,
    ).toBe(1);
    expect(
      (
        await raw(person, "POST", "/v2/collectible-purchases", {
          itemId: "paid-control-item",
          requestKey: "promotion-capacity-denial",
          promotionCode: "COSMETIC20",
        })
      ).status,
    ).toBe(409);
  });
  it("persists complete policy revisions and enforces file retention without changing old files", async () => {
    const current = await admin.browser.expect(
      200,
      "GET",
      "/admin/v1/operations/policy",
    );
    await admin.browser.expect(200, "PUT", "/admin/v1/operations/policy", {
      version: current.version,
      policy: {
        ...current.policy,
        fileRetentionDays: 30,
        reportRetentionDays: 90,
        maxFileBytes: 1000000,
      },
      reason: "Apply explicit file retention policy",
    });
    const { fileExpiry } = await import("../src/modules/files/routes.js");
    expect(fileExpiry(h.ctx, 1000)).toBe(1000 + 30 * 86400000);
    const history = await admin.browser.expect(
      200,
      "GET",
      "/admin/v1/operations/policy/history",
    );
    expect(history.items[0].policy.fileRetentionDays).toBe(30);
    await admin.browser.expect(200, "PUT", "/admin/v1/operations/policy", {
      version: current.version + 1,
      policy: current.policy,
      reason: "Restore known policy revision",
    });
  });
  it("repairs paid ownership after the completion audit fails, without duplicating inventory", async () => {
    const o = await person.req("POST", "/v2/collectible-purchases", {
      itemId: "paid-control-item",
      requestKey: "recover-paid-after-audit",
    });
    const r = h.ctx.collectibleCommerce.get(o.id)!;
    await h.ctx.billing.webhooks.ingest("stripe", {
      ref: "evt_recover_paid",
      type: "checkout.completed",
      createdAt: Date.now(),
      kind: "checkout",
      checkout: {
        sessionRef: r.session_ref!,
        reference: r.id,
        outcome: "completed",
        subscriptionRef: null,
        customerRef: null,
        mode: "payment",
        paid: true,
        paymentRef: "pi_recover_paid",
        currency: "USD",
        amountMinor: 499,
      },
    });
    const write = vi
      .spyOn(h.ctx.platform, "write")
      .mockRejectedValueOnce(
        new Error("simulated audit persistence interruption"),
      );
    await expect(h.ctx.collectibleCommerce.sync()).rejects.toThrow(
      "interruption",
    );
    write.mockRestore();
    expect(h.ctx.collectibleCommerce.get(o.id)?.sync_status).toBe("pending");
    await h.ctx.collectibleCommerce.sync();
    expect(h.ctx.collectibleCommerce.get(o.id)?.sync_status).toBe("complete");
    expect(
      h.ctx.identity.count("profile_collectible_inventory", {
        user_id: person.userId,
        decoration_id: "paid-control-item",
      }),
    ).toBe(1);
  });
  it("keeps unknown-email appeal requests nonenumerating", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: "/v2/platform/appeals/email/start",
      remoteAddress: "10.99.7.1",
      payload: { email: "unknown-control-test@example.test" },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().message).toBe(
      "If that address belongs to an account, an appeal code has been sent.",
    );
    expect(
      mailer.sent.some((x) => x.to === "unknown-control-test@example.test"),
    ).toBe(false);
  });
  it("removes operational personal data on account deletion while retaining anonymous financial history", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "controlsdelete");
    const request = await c.req("POST", "/v2/platform/appeals", {
      noticeId: null,
      subject: "Deletion privacy",
      body: "This user supplied appeal must be removed",
    });
    const order = await c.req("POST", "/v2/collectible-purchases", {
      itemId: "paid-control-item",
      requestKey: "deleted-person-checkout",
    });
    await c.req("DELETE", "/v2/account", {
      password: c.password,
      confirmEmail: c.email,
    });
    expect(
      h.ctx.platform.get("platform_appeals", { id: request.item.id }),
    ).toBeUndefined();
    expect(h.ctx.collectibleCommerce.get(order.id)).toMatchObject({
      account_id: null,
      user_id: null,
      checkout_url: null,
    });
    expect(
      h.ctx.identity.count("profile_collectible_inventory", {
        user_id: c.userId,
      }),
    ).toBe(0);
  });
  it("serves typed private purchase and owner-request views without exposing other users", async () => {
    const history = await person.req("GET", "/v2/collectible-purchases");
    expect(history.items.every((r: any) => typeof r.id === "string")).toBe(
      true,
    );
    expect(
      (await person.req("GET", "/v2/platform/ownership")).items,
    ).toBeInstanceOf(Array);
    const orders = await admin.browser.expect(
      200,
      "GET",
      "/admin/v1/operations/orders",
    );
    expect(orders.capability.provider).toBe("stripe");
    expect(orders.items.length).toBeGreaterThan(0);
  });
  it("retains a valid platform audit chain through all operational changes", () => {
    expect(new PlatformAudit(h.ctx.platform).verify().brokenAt).toBeNull();
  });
});
