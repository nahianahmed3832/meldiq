import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AdminActiveUsers,
  AdminAlerts,
  AdminAnalyticsOverview,
  AdminClients,
  AdminDevicesPage,
  AdminPresence,
  AdminQuotaEffective,
  AdminQuotas,
  AdminResources,
  AdminRetention,
  AdminSearch,
  AdminSettings,
  AdminTraffic,
  AdminUserDevices,
  AdminUserInsights,
} from "../src/shared/contracts/http/platformAdminInsights.js";
import { AdminUserDetail } from "../src/shared/contracts/http/platformAdmin.js";
import { PlatformAudit, platformSetting } from "../src/modules/platformAdmin/index.js";
import { liftExpiredSuspensions } from "../src/modules/platformAdmin/insights.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Platform Admin 2.0 end to end (meldiq_central_admin/docs/ADMIN_2_ASSESSMENT.md): every new answer matches its
 * contract, figures come from what really happened, revocations take effect on the server, changes are audited with a
 * reason, and secrets never come back out.
 */
let h: Harness;
const mailer = new MemoryMailer();
const admins: Record<string, ConsoleAdmin> = {};
let alice: AccountClient;
let bob: AccountClient;
let orgId: string;
const REASON = { reason: "Investigating a support ticket" };
const SECRETS_KEY = crypto.randomBytes(32).toString("hex");

beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: "https://admin.example.test", TELEMETRY_TICK_MS: "0", PLATFORM_SECRETS_KEY: SECRETS_KEY }, { mailer });
  for (const role of ["super_admin", "operations_admin", "support_admin", "billing_admin", "auditor"]) admins[role] = await consoleAdmin(h, mailer, role, `ins${role}`);
  alice = await AccountClient.ready(h.baseUrl, mailer, "alice");
  bob = await AccountClient.ready(h.baseUrl, mailer, "bob");
  alice.extraHeaders = { "user-agent": "okhttp/4.12.0" };
  orgId = (await alice.req("POST", "/v1/orgs", { name: "Insights Lab", visibility: "public", joinPolicy: "open" })).org.id;
  await bob.req("POST", `/v1/communities/${orgId}/join`).catch(() => undefined);
  await alice.req("GET", "/v1/conversations");
  await h.ctx.telemetry.minute();
});
afterAll(async () => h.close());

const as = (role: string) => admins[role]!.browser;
const lastAudit = (action: string) => h.ctx.platform.get<any>("platform_audit", { action }, [["id", "desc"]]);
const ok = (schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, v: unknown) => {
  const r = schema.safeParse(v);
  if (!r.success) throw new Error(JSON.stringify(r.error, null, 1).slice(0, 2000));
};

describe("analytics", () => {
  it("answer from measured activity, with collection's start and nothing invented", async () => {
    const o = await as("operations_admin").expect(200, "GET", "/admin/v1/analytics/overview?range=24h");
    ok(AdminAnalyticsOverview, o);
    expect(o.collectingSince).toBeGreaterThan(0);
    // Admins are left out by default; alice and bob are real.
    expect(o.activity.activeInRange.current).toBeGreaterThanOrEqual(1);
    // Console admins here have no messaging identity, so none is left out for that; nothing synthetic or listed yet.
    expect(o.excluded).toMatchObject({ synthetic: 0, listed: 0, admins: 0 });
    // Yesterday wasn't collected: no DAU comparison is made up.
    expect(o.activity.dau.previous).toBeNull();
    expect(o.billing.available).toBe(false);
    const billing = await as("billing_admin").expect(200, "GET", "/admin/v1/analytics/overview?range=7d");
    expect(billing.requests).toBeNull();

    const days = await as("auditor").expect(200, "GET", "/admin/v1/analytics/active-users");
    ok(AdminActiveUsers, days);
    const today = days.days[days.days.length - 1];
    expect(today).toMatchObject({ collected: true });
    expect(today.dau).toBeGreaterThanOrEqual(1);
    expect(days.days[0].collected).toBe(false);
    ok(AdminRetention, await as("auditor").expect(200, "GET", "/admin/v1/analytics/retention"));
    const clients = await as("auditor").expect(200, "GET", "/admin/v1/analytics/clients");
    ok(AdminClients, clients);
    expect(clients.platforms.map((p: any) => p.platform)).toContain("android");
    await as("auditor").expect(400, "GET", "/admin/v1/analytics/active-users?from=2026-01-01&to=2026-12-31");
    await as("support_admin").expect(403, "GET", "/admin/v1/analytics/traffic");
    ok(AdminTraffic, await as("billing_admin").expect(200, "GET", "/admin/v1/analytics/traffic"));
  });

  it("leave out the people the operator lists, changing past figures too", async () => {
    const before = (await as("super_admin").expect(200, "GET", "/admin/v1/analytics/active-users")).days.at(-1).dau;
    await as("super_admin").expect(200, "PUT", "/admin/v1/settings/analytics.excluded_users", { value: [alice.userId], ...REASON });
    const after = (await as("super_admin").expect(200, "GET", "/admin/v1/analytics/active-users")).days.at(-1).dau;
    expect(after).toBe(before - 1);
    expect(lastAudit("settings.update")).toMatchObject({ target_id: "analytics.excluded_users", reason: REASON.reason });
    await as("super_admin").expect(200, "PUT", "/admin/v1/settings/analytics.excluded_users", { value: [], ...REASON });
    await as("operations_admin").expect(403, "PUT", "/admin/v1/settings/analytics.exclude_admins", { value: true, ...REASON });
    await as("super_admin").expect(400, "PUT", "/admin/v1/settings/analytics.exclude_admins", { value: "yes", ...REASON });
  });
});

describe("live connections, devices and sessions", () => {
  it("count people, devices and sockets apart, and list connections without credentials", async () => {
    await alice.connect();
    const p = await as("auditor").expect(200, "GET", "/admin/v1/presence?range=1h");
    ok(AdminPresence, p);
    expect(p.now.users).toBeGreaterThanOrEqual(1);
    expect(p.screenSharing.available).toBe(false);
    const conns = await as("support_admin").expect(200, "GET", "/admin/v1/presence/connections");
    const mine = conns.connections.find((c: any) => c.userId === alice.userId);
    // The test client's socket sends no User-Agent: an unknown client, never a guessed one.
    expect(mine).toMatchObject({ platform: "unknown", deviceId: alice.deviceId });
    expect(JSON.stringify(conns)).not.toContain(alice.accessToken);
    await as("billing_admin").expect(403, "GET", "/admin/v1/presence/connections");
  });

  it("show a person's devices and sessions, and revoking one session ends it on the server at once", async () => {
    await alice.signIn(true);
    const view = await as("support_admin").expect(200, "GET", `/admin/v1/users/${alice.userId}/devices`);
    ok(AdminUserDevices, view);
    expect(view.devices[0]).toMatchObject({ id: alice.deviceId, push: { fcm: "none", unifiedPush: "none" } });
    expect(view.authHistory.map((e: any) => e.event)).toContain("Signed in");
    const current = view.sessions.find((s: any) => s.id === alice.sessionId);
    expect(current).toMatchObject({ state: "active" });
    expect(current.masked).not.toBe(alice.sessionId);
    expect(JSON.stringify(view)).not.toContain(alice.refreshToken);
    await alice.req("GET", "/v1/conversations");
    await as("support_admin").expect(200, "POST", `/admin/v1/users/${alice.userId}/sessions/${alice.sessionId}/revoke`, REASON);
    await expectStatus(alice.req("GET", "/v1/conversations"), 401);
    await expectStatus(alice.refresh(), 401);
    expect(lastAudit("user.session_revoke")).toMatchObject({ target_id: alice.userId, reason: REASON.reason });
    // Someone else's session id isn't found under this person.
    await bob.signIn();
    await as("support_admin").expect(404, "POST", `/admin/v1/users/${alice.userId}/sessions/${bob.sessionId}/revoke`, REASON);
  });

  it("revokes a device the way the app does, and lists the inventory", async () => {
    const inv = await as("auditor").expect(200, "GET", "/admin/v1/devices?status=active");
    ok(AdminDevicesPage, inv);
    expect(inv.counts.active).toBeGreaterThanOrEqual(2);
    await as("operations_admin").expect(403, "POST", `/admin/v1/users/${bob.userId}/devices/${bob.deviceId}/revoke`, REASON);
    await as("support_admin").expect(200, "POST", `/admin/v1/users/${bob.userId}/devices/${bob.deviceId}/revoke`, REASON);
    expect(h.ctx.identity.get<any>("devices", { id: bob.deviceId }).revoked_at).toBeGreaterThan(0);
    // An admin can't act on their own account.
    const own = admins.support_admin!.account;
    await own.setUpIdentity().catch(() => undefined);
    if (own.userId) await as("support_admin").expect(403, "POST", `/admin/v1/presence/disconnect`, { userId: own.userId, ...REASON });
  });
});

describe("people and organizations", () => {
  it("suspend for a while and lift it by themselves, audited as the system", async () => {
    const carol = await AccountClient.ready(h.baseUrl, mailer, "carol");
    const until = Date.now() + 120_000;
    const r = await as("support_admin").expect(200, "POST", `/admin/v1/users/${carol.userId}/suspend`, { ...REASON, until });
    expect(r.user).toMatchObject({ status: "suspended", suspendedUntil: until });
    await expectStatus(carol.req("GET", "/v1/conversations"), 401);
    // The console's minute job lifts it once its time has come (driven directly: the timer is off in tests).
    expect(await liftExpiredSuspensions(h.ctx, new PlatformAudit(h.ctx.platform), until - 1)).toBe(0);
    expect(await liftExpiredSuspensions(h.ctx, new PlatformAudit(h.ctx.platform), until + 1)).toBe(1);
    const detail = await as("support_admin").expect(200, "GET", `/admin/v1/users/${carol.userId}`);
    ok(AdminUserDetail, detail);
    expect(detail.user).toMatchObject({ status: "active", suspendedUntil: null });
    expect(lastAudit("user.restore")).toMatchObject({ actor_account_id: "system:restrictions", target_id: carol.userId });
    await carol.signIn(true);
    await carol.req("GET", "/v1/conversations");
  });

  it("send recovery emails to the person's own address, and delete only through the established workflow", async () => {
    const dave = await AccountClient.ready(h.baseUrl, mailer, "dave");
    const sentBefore = mailer.sent.length;
    const r = await as("support_admin").expect(200, "POST", `/admin/v1/users/${dave.userId}/password-reset-email`, REASON);
    expect(r.sent).toBe(true);
    expect(mailer.sent.slice(sentBefore).map((m) => m.to)).toEqual([dave.email]);
    await as("support_admin").expect(409, "POST", `/admin/v1/users/${dave.userId}/verification-email`, REASON);
    const insights = await as("super_admin").expect(200, "GET", `/admin/v1/users/${dave.userId}/insights`);
    ok(AdminUserInsights, insights);
    expect(insights.deletion).toMatchObject({ possible: false, blockers: ["Suspend the account first."] });
    await as("support_admin").expect(403, "POST", `/admin/v1/users/${dave.userId}/delete`, { ...REASON, confirm: dave.username });
    await as("super_admin").expect(409, "POST", `/admin/v1/users/${dave.userId}/delete`, { ...REASON, confirm: dave.username });
    await as("super_admin").expect(200, "POST", `/admin/v1/users/${dave.userId}/suspend`, REASON);
    await as("super_admin").expect(400, "POST", `/admin/v1/users/${dave.userId}/delete`, { ...REASON, confirm: "someone-else" });
    const done = await as("super_admin").expect(200, "POST", `/admin/v1/users/${dave.userId}/delete`, { ...REASON, confirm: dave.username });
    expect(done.deleted).toBe(true);
    expect(await h.ctx.accounts.store.accountById(dave.accountId)).toBeUndefined();
    expect(lastAudit("user.delete")).toMatchObject({ target_id: dave.userId, actor_role: "super_admin" });
  });

  it("show an organization's activity and remove a member, but never an owner", async () => {
    const o = await as("auditor").expect(200, "GET", `/admin/v1/orgs/${orgId}/insights`);
    expect(o.activeMembers30d).toBeGreaterThanOrEqual(1);
    await as("super_admin").expect(409, "POST", `/admin/v1/orgs/${orgId}/members/${alice.userId}/remove`, REASON);
    await as("support_admin").expect(403, "POST", `/admin/v1/orgs/${orgId}/members/${bob.userId}/remove`, REASON);
  });
});

describe("quotas", () => {
  it("are set with their impact shown, resolve per scope, and are audited with before and after", async () => {
    const ops = as("operations_admin");
    const saved = await ops.expect(200, "POST", "/admin/v1/quotas/policies", { scopeType: "user", scopeId: alice.userId, key: "files.upload_bytes", limit: 1000, mode: "block", ...REASON });
    expect(saved.impact.scopesOverNow).toBe(0);
    await ops.expect(400, "POST", "/admin/v1/quotas/policies", { scopeType: "user", scopeId: alice.userId, key: "sessions.active", limit: 1, mode: "block", ...REASON });
    await ops.expect(404, "POST", "/admin/v1/quotas/policies", { scopeType: "user", scopeId: "u_nobody_here", key: "files.upload_bytes", limit: 1, mode: "block", ...REASON });
    const eff = await as("support_admin").expect(200, "GET", `/admin/v1/quotas/effective?scopeType=user&scopeId=${alice.userId}`);
    ok(AdminQuotaEffective, eff);
    expect(eff.quotas.find((q: any) => q.key === "files.upload_bytes")).toMatchObject({ source: "own", limit: 1000, mode: "block" });
    expect(eff.quotas.find((q: any) => q.key === "files.max_upload_bytes").alsoLimitedBy[0]).toMatch(/^FILE_MAX_BYTES/);
    await ops.expect(200, "POST", "/admin/v1/quotas/adjust", { key: "files.upload_bytes", scopeType: "user", scopeId: alice.userId, delta: 400, ...REASON });
    const overview = await as("auditor").expect(200, "GET", "/admin/v1/quotas");
    ok(AdminQuotas, overview);
    expect(overview.usage.find((u: any) => u.scopeId === alice.userId)).toMatchObject({ used: 400, limit: 1000, pct: 40 });
    const events = await as("auditor").expect(200, "GET", "/admin/v1/quotas/events");
    expect(events.events[0]).toMatchObject({ outcome: "adjusted", amount: 400, actor: { accountId: admins.operations_admin!.account.accountId } });
    await ops.expect(200, "POST", `/admin/v1/quotas/policies/${saved.policy.id}/remove`, REASON);
    expect(lastAudit("quota.policy_remove")).toMatchObject({ target_id: saved.policy.id });
    await as("support_admin").expect(403, "POST", "/admin/v1/quotas/plans", { name: "Team", ...REASON });
    await as("billing_admin").expect(200, "POST", "/admin/v1/quotas/plans", { name: "Team", description: "Internal teams", ...REASON });
  });
});

describe("alerts, resources, search and exports", () => {
  it("open one incident per breached rule, deduplicated, and record that no notification was configured", async () => {
    await as("operations_admin").expect(200, "PUT", "/admin/v1/alerts/signups.spike", { enabled: true, threshold: 0, windowMinutes: 60, severity: "sev3", ...REASON });
    const first = await as("operations_admin").expect(200, "POST", "/admin/v1/alerts/evaluate");
    ok(AdminAlerts, first);
    const rule = first.rules.find((r: any) => r.key === "signups.spike");
    expect(rule.state).toMatchObject({ breaching: true });
    await as("operations_admin").expect(200, "POST", "/admin/v1/alerts/evaluate");
    const incidents = h.ctx.platform.all<{ id: string; source: string }>("platform_incidents", { where: { dedupe_key: "rule:signups.spike" } }).map((i) => ({ id: i.id, source: i.source }));
    expect(incidents).toEqual([{ id: rule.state.incidentId, source: "rule" }]);
    expect(first.deliveries[0]).toMatchObject({ incidentId: rule.state.incidentId, outcome: "not_configured" });
    await as("auditor").expect(403, "PUT", "/admin/v1/alerts/signups.spike", { enabled: false, threshold: 1, windowMinutes: 60, severity: "sev3", ...REASON });
  });

  it("report resources honestly, with what isn't measured listed", async () => {
    await h.ctx.telemetry.minute();
    const r = await as("operations_admin").expect(200, "GET", "/admin/v1/resources");
    ok(AdminResources, r);
    expect(r.server.coverage.collector).toBe("not_configured");
    expect(r.unavailable.map((u: any) => u.what)).toContain("Screen sharing");
    expect(r.server.versions[0].version).toMatch(/^\d+\.\d+\.\d+$/);
    await as("operations_admin").expect(400, "GET", "/admin/v1/resources/series?series=../../etc");
    const s = await as("operations_admin").expect(200, "GET", "/admin/v1/resources/series?series=api.mem.rss_bytes&range=1h");
    expect(s.series[0].points.length).toBeGreaterThanOrEqual(1);
  });

  it("search only where the role may look, and export audited CSV that can't run as a formula", async () => {
    const all = await as("auditor").expect(200, "GET", `/admin/v1/search?q=${alice.username}`);
    ok(AdminSearch, all);
    expect(all.users.map((u: any) => u.id)).toContain(alice.userId);
    const billing = await as("billing_admin").expect(200, "GET", `/admin/v1/search?q=${alice.username}`);
    expect(billing.users).toBeNull();
    expect(billing.organizations).not.toBeNull();
    const b = as("auditor");
    const res = await h.app.inject({
      method: "GET",
      url: `/admin/v1/exports/users?reason=${encodeURIComponent("Quarterly access review")}`,
      headers: { host: "admin.example.test", "x-meldiq-admin": "1", cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
      remoteAddress: b.ip,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/text\/csv/);
    expect(res.body.split("\r\n")[0]).toBe("id,username,display_name,status,created_at,last_active_at,active_devices,last_seen_at");
    expect(res.body).toContain(alice.userId);
    expect(res.body).not.toContain(alice.email);
    expect(lastAudit("export.create")).toMatchObject({ target_id: "users", reason: "Quarterly access review" });
    await as("auditor").expect(400, "GET", "/admin/v1/exports/users");
    await as("support_admin").expect(403, "GET", `/admin/v1/exports/users?reason=${encodeURIComponent("Quarterly access review")}`);
    const { csvCell } = await import("../src/modules/platformAdmin/searchExport.js");
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    ok(AdminSettings, await as("auditor").expect(200, "GET", "/admin/v1/settings"));
  });
});
