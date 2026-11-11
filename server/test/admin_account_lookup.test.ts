import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminUserDetail } from "../src/shared/contracts/http/platformAdmin.js";
import { AdminAccountLookup, AdminAccountStatusChanged, AdminOrgInsights, AdminUserInsights } from "../src/shared/contracts/http/platformAdminInsights.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { consoleAdmin, plainAccount, type ConsoleAdmin } from "./support/adminConsole.js";
import { expectStatus, startServer, type Harness } from "./support/harness.js";

let h: Harness, superAdmin: ConsoleAdmin, support: ConsoleAdmin, auditor: ConsoleAdmin, reader: ConsoleAdmin;
const mailer = new MemoryMailer();
const reason = "Synthetic account lifecycle verification";
const lookup = (admin: ConsoleAdmin, body: object, status = 200) => admin.browser.expect(status, "POST", "/admin/v1/accounts/lookup", body);
beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: "https://admin.example.test", TELEMETRY_TICK_MS: "0" }, { mailer });
  superAdmin = await consoleAdmin(h, mailer, "super_admin", "lookup-super");
  support = await consoleAdmin(h, mailer, "support_admin", "lookup-support");
  auditor = await consoleAdmin(h, mailer, "auditor", "lookup-auditor");
  reader = await consoleAdmin(h, mailer, "support_admin", "lookup-reader");
  await h.ctx.platform.write(w => w.update("platform_admins", { account_id: reader.account.accountId }, { permissions: JSON.stringify(["users.view", "orgs.view"]) }));
});
afterAll(async () => h.close());

describe("registered accounts before messaging setup", () => {
  it("finds canonical public accounts without an operator row or encryption identity; redacts by permission", async () => {
    const person = await plainAccount(h, mailer, "not-yet-messaging");
    expect(h.ctx.platform.get("operator_accounts", { account_id: person.accountId })).toBeUndefined();
    const found = await lookup(support, { email: person.email });
    expect(AdminAccountLookup.safeParse(found).success).toBe(true);
    expect(found.account).toMatchObject({ id: person.accountId, email: person.email, userId: null, identityStatus: null, canSignIn: true });
    expect(found.sessions.some((s: any) => s.id === person.sessionId)).toBe(true);
    for (const secret of [person.accessToken, person.refreshToken, person.password]) expect(JSON.stringify(found)).not.toContain(secret);
    expect((await lookup(auditor, { accountId: person.accountId })).account.email).toBeNull();
    const restricted = await lookup(reader, { accountId: person.accountId });
    expect(restricted).toMatchObject({ account: { email: null }, sessions: null, history: null });
    await lookup(auditor, { email: person.email }, 403);
    await lookup(reader, { email: "absent@example.test" }, 403);
    await lookup(support, { accountId: "acc_absent" }, 404);
    await lookup(support, { email: person.email, accountId: person.accountId }, 400);
    await lookup(support, {}, 400);
  });

  it("revokes only the specified account-bound session, persists it and rejects native token reuse", async () => {
    const person = await plainAccount(h, mailer, "lookup-session");
    const other = await plainAccount(h, mailer, "lookup-other-session");
    const path = `/admin/v1/accounts/${person.accountId}/sessions/${person.sessionId}/revoke`;
    await auditor.browser.expect(403, "POST", path, { reason });
    await support.browser.expect(404, "POST", `/admin/v1/accounts/${person.accountId}/sessions/${other.sessionId}/revoke`, { reason });
    await support.browser.expect(400, "POST", path, {});
    expect(await support.browser.expect(200, "POST", path, { reason })).toMatchObject({ ok: true, changed: true });
    expect(await support.browser.expect(200, "POST", path, { reason })).toMatchObject({ ok: true, changed: false });
    await expectStatus(person.req("GET", "/v2/account"), 401);
    await expectStatus(person.refresh(), 401);
    expect((await lookup(support, { accountId: person.accountId })).sessions.find((s: any) => s.id === person.sessionId)).toMatchObject({ state: "revoked" });
    const record = h.ctx.platform.get<any>("platform_audit", { action: "account.session_revoke", target_id: person.accountId }, [["id", "desc"]]);
    expect(record).toMatchObject({ reason, outcome: "success" });
    expect(record.detail).not.toContain(person.sessionId);
    await other.req("GET", "/v2/account");
  });

  it("suspends and restores native account sign-in without restoring ended sessions", async () => {
    const person = await plainAccount(h, mailer, "lookup-status");
    const base = `/admin/v1/accounts/${person.accountId}`;
    await auditor.browser.expect(403, "POST", `${base}/suspend`, { reason });
    const suspended = await support.browser.expect(200, "POST", `${base}/suspend`, { reason });
    expect(AdminAccountStatusChanged.safeParse(suspended).success).toBe(true);
    expect(suspended.changed).toBe(true);
    expect((await support.browser.expect(200, "POST", `${base}/suspend`, { reason })).changed).toBe(false);
    expect((await h.ctx.accounts.store.accountById(person.accountId))!.disabled_at).not.toBeNull();
    expect((await lookup(support, { accountId: person.accountId })).account.canSignIn).toBe(false);
    await expectStatus(person.req("GET", "/v2/account"), 401);
    await expectStatus(person.signIn(), 401);
    await expectStatus(person.refresh(), 401);
    expect((await support.browser.expect(200, "POST", `${base}/restore`, { reason })).changed).toBe(true);
    expect((await h.ctx.accounts.store.accountById(person.accountId))!.disabled_at).toBeNull();
    expect(h.ctx.platform.get("platform_restrictions", { user_id: `account:${person.accountId}` })).toBeUndefined();
    await expectStatus(person.refresh(), 401);
    await person.signIn();
    await person.req("GET", "/v2/account");
    const events = h.ctx.platform.all<any>("platform_audit", { where: { target_id: person.accountId } });
    expect(events.filter(e => e.action === "account.suspend" && e.outcome === "success")).toHaveLength(2);
    expect(events.some(e => e.action === "account.restore" && e.reason === reason)).toBe(true);
  });

  it("requires fresh MFA, rejects self/admin changes, and routes linked identities through the existing lifecycle", async () => {
    await support.browser.expect(403, "POST", `/admin/v1/accounts/${support.account.accountId}/suspend`, { reason });
    await support.browser.expect(403, "POST", `/admin/v1/accounts/${superAdmin.account.accountId}/suspend`, { reason });
    const linked = await AccountClient.ready(h.baseUrl, mailer, "lookup-linked");
    await support.browser.expect(409, "POST", `/admin/v1/accounts/${linked.accountId}/suspend`, { reason });
    const principalSession = h.ctx.ephemeral.get<any>("platform_admin_sessions", { account_id: support.account.accountId });
    await h.ctx.ephemeral.write(w => w.update("platform_admin_sessions", { id: principalSession.id }, { reauth_at: 0 }));
    try {
      const person = await plainAccount(h, mailer, "lookup-stale-mfa");
      const response = await support.browser.req("POST", `/admin/v1/accounts/${person.accountId}/suspend`, { reason });
      expect(response.status).toBe(403);
      expect((await h.ctx.accounts.store.accountById(person.accountId))!.disabled_at).toBeNull();
    } finally {
      await h.ctx.ephemeral.write(w => w.update("platform_admin_sessions", { id: principalSession.id }, { reauth_at: Date.now() }));
    }
  });

  it("redacts related insights at the server and does not leak incident-derived health", async () => {
    const person = await AccountClient.ready(h.baseUrl, mailer, "lookup-insights");
    const orgId = (await person.req("POST", "/v1/orgs", { name: "Permission fixture", visibility: "public", joinPolicy: "open" })).org.id;
    const title = "Confidential incident title";
    await support.browser.expect(200, "POST", "/admin/v1/incidents", { requestKey: "lookup-insights-fixture", title, description: "Permission-bound case fixture", kind: "support", severity: "sev3", userRef: person.userId, orgRef: orgId });
    await support.browser.expect(200, "POST", `/admin/v1/users/${person.userId}/suspend`, { reason: "Private restriction reason" });
    const full = await superAdmin.browser.expect(200, "GET", `/admin/v1/users/${person.userId}/insights`);
    expect(full.incidents.some((i: any) => i.title === title)).toBe(true);
    expect(full.restriction.reason).toBe("Private restriction reason");
    const user = await reader.browser.expect(200, "GET", `/admin/v1/users/${person.userId}/insights`);
    expect(AdminUserInsights.safeParse(user).success).toBe(true);
    expect(user).toMatchObject({ activity: null, traffic30d: null, quotas: null, incidents: null, restriction: null, deletion: null });
    const org = await reader.browser.expect(200, "GET", `/admin/v1/orgs/${orgId}/insights`);
    expect(AdminOrgInsights.safeParse(org).success).toBe(true);
    expect(org).toMatchObject({ activeMembers30d: null, activeMembers7d: null, storageBytes: null, usage30d: null, quotas: null, incidents: null, health: [] });
    expect(JSON.stringify({ user, org })).not.toContain(title);
    expect(JSON.stringify(user)).not.toContain("Private restriction reason");
    const detail = await reader.browser.expect(200, "GET", `/admin/v1/users/${person.userId}`);
    expect(AdminUserDetail.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({ devices: null, securityEvents: null, interventions: null, platformRole: null, account: { email: null, activeSessions: null, passkeys: null } });
    expect(detail.memberships.some((m: any) => m.orgId === orgId)).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("Private restriction reason");
    expect(JSON.stringify(detail)).not.toContain(person.deviceId);
    const permitted = await support.browser.expect(200, "GET", `/admin/v1/users/${person.userId}`);
    expect(permitted.interventions.some((e: any) => e.reason === "Private restriction reason")).toBe(true);
    expect(permitted.devices.some((d: any) => d.id === person.deviceId)).toBe(true);
    await h.ctx.platform.write(w => w.update("platform_admins", { account_id: reader.account.accountId }, { permissions: JSON.stringify(["users.view"]) }));
    try {
      expect((await reader.browser.expect(200, "GET", `/admin/v1/users/${person.userId}`)).memberships).toBeNull();
      await reader.browser.expect(403, "GET", `/admin/v1/orgs/${orgId}`);
    } finally {
      await h.ctx.platform.write(w => w.update("platform_admins", { account_id: reader.account.accountId }, { permissions: JSON.stringify(["users.view", "orgs.view"]) }));
    }

  });

  it("serializes concurrent suspension reservations so a platform super administrator remains enabled", async () => {
    const peer = await consoleAdmin(h, mailer, "super_admin", "lookup-peer-super");
    const responses = await Promise.all([
      superAdmin.browser.req("POST", `/admin/v1/accounts/${peer.account.accountId}/suspend`, { reason }),
      peer.browser.req("POST", `/admin/v1/accounts/${superAdmin.account.accountId}/suspend`, { reason }),
    ]);
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(responses.filter(r => [401, 403].includes(r.status))).toHaveLength(1);
    const accounts = await Promise.all([superAdmin.account, peer.account].map(a => h.ctx.accounts.store.accountById(a.accountId)));
    expect(accounts.filter(a => a!.disabled_at === null)).toHaveLength(1);
  });
});
