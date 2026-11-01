import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_FILE_MAX_BYTES } from "../src/app/config.js";
import { checkOverrides, levelsWith, LIMIT_BOUNDS, plansWith } from "../src/modules/billing/controls.js";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, consoleAdmin, type ConsoleAdmin } from "./support/adminConsole.js";
import { startServer, type Harness } from "./support/harness.js";

describe("the shared upload ceiling", () => {
  it("rejects oversized new plan and community entitlements and caps legacy values on read", () => {
    expect(LIMIT_BOUNDS.uploadBytes.max).toBe(DEFAULT_FILE_MAX_BYTES);
    expect(() => checkOverrides({ plus: { uploadBytes: 2_000_000_000 } }, {})).toThrow(/uploadBytes/);
    expect(() => checkOverrides({}, { "3": { uploadBytes: 2_000_000_000 } })).toThrow(/uploadBytes/);
    expect(plansWith({ plus: { uploadBytes: 2_000_000_000 } }).plus.uploadBytes).toBe(DEFAULT_FILE_MAX_BYTES);
    expect(levelsWith({ "3": { uploadBytes: 2_000_000_000 } }).at(-1)?.uploadBytes).toBe(DEFAULT_FILE_MAX_BYTES);
  });
});

describe("administration parity security and actual outcomes", () => {
  let h: Harness, admin: ConsoleAdmin, reviewer: ConsoleAdmin;
  const mailer = new MemoryMailer();
  let userId: string;
  beforeAll(async () => {
    h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN }, { mailer });
    admin = await consoleAdmin(h, mailer, "super_admin", "paritysuper");
    reviewer = await consoleAdmin(h, mailer, "support_admin", "parityreviewer");
    userId = (await h.client("parityperson")).userId;
  }, 120000);
  afterAll(async () => { await h?.close(); }, 120000);

  it("searches and pages the administrator catalog without repeating items", async () => {
    const first = await admin.browser.expect(200, "GET", "/admin/v1/profile-collectibles?limit=2");
    expect(first.items).toHaveLength(2);
    expect(typeof first.next).toBe("string");
    const second = await admin.browser.expect(200, "GET", `/admin/v1/profile-collectibles?limit=2&after=${encodeURIComponent(first.next)}`);
    expect(second.items).toHaveLength(2);
    expect(second.items.some((item: any) => first.items.some((previous: any) => previous.id === item.id))).toBe(false);
    const search = await admin.browser.expect(200, "GET", "/admin/v1/profile-collectibles?q=Ion%20Halo");
    expect(search.items.map((item: any) => item.id)).toEqual(["ion-halo"]);
  });

  it("saves catalog reasons and before/after metadata, rejects stale writes and enforces deactivation", async () => {
    const { items } = await admin.browser.expect(200, "GET", "/admin/v1/profile-collectibles");
    const item = items.find((x: any) => x.acquisitionType === "free" && x.isActive);
    const path = `/admin/v1/profile-collectibles/${item.id}`;
    await admin.browser.expect(200, "PUT", path, { item: { ...item, isActive: false }, reason: "Retire a seasonal asset" });
    const stale = await admin.browser.req("PUT", path, { item, reason: "Another operator changed this" });
    expect(stale.status).toBe(409);
    const row = h.ctx.platform.get<any>("platform_audit", { action: "collectible.save" }, [["id", "desc"]]);
    expect(row.reason).toBe("Retire a seasonal asset");
    expect(JSON.parse(row.detail)).toMatchObject({ activeBefore: true, activeAfter: false, versionBefore: item.version, versionAfter: item.version + 1 });
    const person = await h.client("paritybuyer");
    const catalog = await person.req("GET", "/v2/profile-collectibles");
    expect(catalog.items.some((x: any) => x.id === item.id)).toBe(false);
    const claim = await fetch(h.baseUrl + `/v2/users/me/profile-collectibles/${item.id}/claim`, { method: "POST", headers: { authorization: `Bearer ${person.token}` } });
    expect(claim.status).toBeGreaterThanOrEqual(400);
    expect((await reviewer.browser.req("PUT", path, { item, reason: "Unauthorized catalog change" })).status).toBe(403);
  });

  it("filters and pages actual gift rows with tied timestamps without exposing personal notes", async () => {
    const at = Date.now();
    await h.ctx.billing.rows.write((w) => {
      for (const suffix of ["a", "b", "c"]) w.insert("mojo_gifts", {
        id: `gft_parity_${suffix}`, buyer_account_id: admin.account.accountId, buyer_user_id: null,
        recipient_user_id: userId, plan_key: "plus", months: 1, currency: "USD", amount_minor: 399,
        note: "Personal gift note must stay private", status: "refunded", provider: "sandbox",
        provider_session_ref: null, provider_payment_ref: null, grant_id: null,
        created_at: at, expires_at: at + 86400000, paid_at: at, redeemed_at: null, updated_at: at,
      });
    });
    const first = await admin.browser.expect(200, "GET", "/admin/v1/billing/gifts?status=refunded&limit=2");
    expect(first.gifts.map((g: any) => g.id)).toEqual(["gft_parity_c", "gft_parity_b"]);
    const next = await admin.browser.expect(200, "GET", `/admin/v1/billing/gifts?status=refunded&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(next.gifts.map((g: any) => g.id)).toEqual(["gft_parity_a"]);
    expect(next.nextCursor).toBeNull();
    expect(JSON.stringify(first)).not.toContain("Personal gift note");
  });

  it("updates shared subscription limits through the admin API and rejects an oversized file ceiling", async () => {
    const reason = "Update Plus shared subscription limits";
    const saved = await admin.browser.expect(200, "PUT", "/admin/v1/billing/mojo", { enforce: "on", plans: { plus: { messageChars: 9000, uploadBytes: DEFAULT_FILE_MAX_BYTES } }, levels: {}, reason });
    expect(saved.bounds.uploadBytes.max).toBe(DEFAULT_FILE_MAX_BYTES);
    const person = await h.client("paritycatalogreader");
    const catalog = await person.req("GET", "/v2/mojo/catalog");
    expect(catalog.plans.find((p: any) => p.key === "plus").messageChars).toBe(9000);
    expect(catalog.plans.some((p: any) => p.key === "go")).toBe(false);
    const denied = await admin.browser.req("PUT", "/admin/v1/billing/mojo", { enforce: "on", plans: { plus: { uploadBytes: 2_000_000_000 } }, levels: {}, reason });
    expect(denied.status).toBe(400);
    expect((await person.req("GET", "/v2/mojo/catalog")).version).toBe(catalog.version);
    expect(h.ctx.platform.get<any>("platform_audit", { action: "mojo.controls_update" }, [["id", "desc"]]).reason).toBe(reason);
  });

  it("keeps creator and collectible reads usable after step-up expiry, while refusing mutations", async () => {
    const me = await admin.browser.expect(200, "GET", "/admin/v1/me");
    await h.ctx.ephemeral.write((w) => w.update("platform_admin_sessions", { id: me.session.id }, { reauth_at: 0 }));
    await admin.browser.expect(200, "GET", "/admin/v1/profile-collectibles");
    const sensitiveRead = await admin.browser.req("GET", "/admin/v1/reports/assignees");
    expect(sensitiveRead.body.error.code).toBe("reauth_required");
    const denied = await admin.browser.req("POST", "/admin/v1/profile-collectibles/blue-horizon/grant", { userId, reason: "Needs a fresh passkey" });
    expect(denied.body.error.code).toBe("reauth_required");
    const reviewerMe = await reviewer.browser.expect(200, "GET", "/admin/v1/me");
    await h.ctx.ephemeral.write((w) => w.update("platform_admin_sessions", { id: reviewerMe.session.id }, { reauth_at: 0 }));
    await reviewer.browser.expect(200, "GET", "/admin/v1/creators/verification");
    const decision = await reviewer.browser.req("POST", "/admin/v1/creators/verification/cr_123456789/approve", { reason: "Review requires fresh verification" });
    expect(decision.body.error.code).toBe("reauth_required");
  });
});
