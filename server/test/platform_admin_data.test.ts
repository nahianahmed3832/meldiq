import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminOrgDetail, AdminOrgsPage, AdminOverview, AdminUserChanged, AdminUserDetail, AdminUsersPage } from "../src/shared/contracts/http/platformAdmin.js";
import { AccountClient, email, MemoryMailer } from "./support/accounts.js";
import { type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * The console's data routes (phase 3): overview, people and organisations, with the permission each role has, the
 * passkey step-up and written reason for changes, suspension and restoration end to end, and what never appears.
 */
let h: Harness;
const mailer = new MemoryMailer();
const admins: Record<string, ConsoleAdmin> = {};
let person: AccountClient;
let orgId: string;
const REASON = { reason: "Spam reports from three communities" };

beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: "https://admin.example.test" }, { mailer });
  for (const role of ["super_admin", "operations_admin", "support_admin", "billing_admin", "auditor"]) admins[role] = await consoleAdmin(h, mailer, role, `data${role}`);
  person = await new AccountClient(h.baseUrl, email("person")).signUp(mailer);
  await person.signIn();
  await person.setUpIdentity(`person${Date.now().toString(36)}`);
  orgId = (await person.req("POST", "/v1/orgs", { name: "Console Lab", visibility: "public", joinPolicy: "open" })).org.id;
  // Two more people (device-key accounts), so there is more than one page.
  await h.client("pager");
  await h.client("pager");
});
afterAll(async () => h.close());

const lastAudit = (action: string) => h.ctx.platform.get<any>("platform_audit", { action }, [["id", "desc"]]);
const as = (role: string) => admins[role].browser;

describe("overview", () => {
  it("counts from named sources, and shows health and admin actions only to roles that may see them", async () => {
    const full = await as("super_admin").expect(200, "GET", "/admin/v1/overview");
    expect(AdminOverview.safeParse(full).success).toBe(true);
    expect(full.people.total).toBeGreaterThanOrEqual(1);
    expect(full.organizations.total).toBeGreaterThanOrEqual(1);
    expect(full.health).not.toBeNull();
    expect(full.recentActions?.length).toBeGreaterThan(0);
    expect(full.billing).toMatchObject({ available: false });
    const billing = await as("billing_admin").expect(200, "GET", "/admin/v1/overview");
    expect([billing.health, billing.requests, billing.recentActions]).toEqual([null, null, null]);
  });
});

describe("people", () => {
  it("are searched by username or display name, a page at a time, without email addresses", async () => {
    const page = await as("support_admin").expect(200, "GET", `/admin/v1/users?q=${person.username.slice(0, 8)}&limit=1`);
    expect(AdminUsersPage.safeParse(page).success).toBe(true);
    expect(page.users[0]).toMatchObject({ id: person.userId, status: "active", activeDevices: 1 });
    expect(JSON.stringify(page)).not.toContain(person.email);
    const all = await as("auditor").expect(200, "GET", "/admin/v1/users?limit=2");
    expect(all.users).toHaveLength(2);
    const next = await as("auditor").expect(200, "GET", `/admin/v1/users?limit=2&cursor=${all.nextCursor}`);
    expect(next.users.map((u: any) => u.id)).not.toContain(all.users[0].id);
    await as("auditor").expect(400, "GET", "/admin/v1/users?cursor=bad.cursor!");
    await as("auditor").expect(400, "GET", "/admin/v1/users?limit=500");
  });

  it("are found by exact email only by roles that may see addresses", async () => {
    expect((await as("support_admin").expect(200, "GET", `/admin/v1/users?q=${encodeURIComponent(person.email)}`)).users.map((u: any) => u.id)).toEqual([person.userId]);
    expect((await as("auditor").expect(200, "GET", `/admin/v1/users?q=${encodeURIComponent(person.email)}`)).users).toEqual([]);
  });

  it("show metadata, memberships and security events; the address only with users.view_email; every view audited", async () => {
    const detail = await as("support_admin").expect(200, "GET", `/admin/v1/users/${person.userId}`);
    expect(AdminUserDetail.safeParse(detail).success).toBe(true);
    expect(detail.account).toMatchObject({ email: person.email, emailVerified: true });
    expect(detail.memberships).toEqual([expect.objectContaining({ orgId, role: "OWNER", kind: "community" })]);
    expect(detail.securityEvents.map((e: any) => e.action)).toContain("account.register");
    expect(lastAudit("user.view")).toMatchObject({ target_id: person.userId, actor_role: "support_admin" });
    expect((await as("auditor").expect(200, "GET", `/admin/v1/users/${person.userId}`)).account.email).toBeNull();
    await as("billing_admin").expect(403, "GET", `/admin/v1/users/${person.userId}`);
    await as("auditor").expect(404, "GET", "/admin/v1/users/u_nobody_here");
  });

  it("are suspended with a reason after a recent passkey check, ending every session, and restored", async () => {
    const support = admins.support_admin;
    await support.browser.expect(400, "POST", `/admin/v1/users/${person.userId}/suspend`, { reason: "spam" });
    // Step-up: an old passkey check is refused until the admin confirms again.
    await h.ctx.ephemeral.write((w) => w.update("platform_admin_sessions", { account_id: support.account.accountId }, { reauth_at: 0 }));
    expect((await support.browser.req("POST", `/admin/v1/users/${person.userId}/suspend`, REASON)).body.error.code).toBe("reauth_required");
    const { options } = await support.browser.expect(200, "POST", "/admin/v1/auth/reauth/options", {});
    await support.browser.expect(200, "POST", "/admin/v1/auth/reauth", { response: support.passkey.get(options) });

    const done = await support.browser.expect(200, "POST", `/admin/v1/users/${person.userId}/suspend`, REASON);
    expect(AdminUserChanged.safeParse(done).success).toBe(true);
    expect(done).toMatchObject({ changed: true, user: { status: "suspended" } });
    await expectStatus(person.req("GET", "/v1/conversations"), 401);
    await expectStatus(person.signIn(), 401);
    expect(lastAudit("user.suspend")).toMatchObject({ outcome: "success", reason: REASON.reason, target_id: person.userId });
    // Idempotent.
    expect((await support.browser.expect(200, "POST", `/admin/v1/users/${person.userId}/suspend`, REASON)).changed).toBe(false);

    const back = await support.browser.expect(200, "POST", `/admin/v1/users/${person.userId}/restore`, { reason: "Reviewed: the reports were mistaken" });
    expect(back).toMatchObject({ changed: true, user: { status: "active", suspendedAt: null } });
    await person.signIn(true);
  });

  it("can't be suspended by roles without the permission, by the person themselves, or if they're an admin (unless super)", async () => {
    await as("auditor").expect(403, "POST", `/admin/v1/users/${person.userId}/suspend`, REASON);
    await as("billing_admin").expect(403, "POST", `/admin/v1/users/${person.userId}/suspend`, REASON);
    expect(lastAudit("admin.permission")).toMatchObject({ outcome: "denied" });

    const support = admins.support_admin;
    await support.account.setUpIdentity(`support${Date.now().toString(36)}`);
    const self = await support.browser.req("POST", `/admin/v1/users/${support.account.userId}/suspend`, REASON);
    expect(self.status).toBe(403);
    const auditor = admins.auditor;
    await auditor.account.setUpIdentity(`auditor${Date.now().toString(36)}`);
    expect((await support.browser.req("POST", `/admin/v1/users/${auditor.account.userId}/suspend`, REASON)).status).toBe(403);
    expect(lastAudit("user.suspend")).toMatchObject({ outcome: "denied", target_id: auditor.account.userId });
    // A super admin may, and that also ends the suspended admin's console session.
    await as("super_admin").expect(200, "POST", `/admin/v1/users/${auditor.account.userId}/suspend`, REASON);
    await auditor.browser.expect(401, "GET", "/admin/v1/me");
  });

  it("have their sessions ended on request without being suspended", async () => {
    const before = await person.req("GET", "/v1/conversations");
    expect(before).toBeTruthy();
    const ended = await as("operations_admin").expect(200, "POST", `/admin/v1/users/${person.userId}/sessions/revoke`, REASON);
    expect(ended.accountSessions).toBeGreaterThanOrEqual(1);
    await expectStatus(person.req("GET", "/v1/conversations"), 401);
    expect((await as("operations_admin").expect(200, "GET", `/admin/v1/users/${person.userId}`)).user.status).toBe("active");
  });
});

describe("organizations", () => {
  it("are searched and shown as counts, settings, usage and limits; never members or channels by name", async () => {
    const page = await as("billing_admin").expect(200, "GET", "/admin/v1/orgs?q=Console&kind=community");
    expect(AdminOrgsPage.safeParse(page).success).toBe(true);
    expect(page.organizations[0]).toMatchObject({ id: orgId, name: "Console Lab", members: 1 });
    const detail = await as("billing_admin").expect(200, "GET", `/admin/v1/orgs/${orgId}`);
    expect(AdminOrgDetail.safeParse(detail).success).toBe(true);
    expect(detail.owners).toEqual([{ id: person.userId, username: person.username }]);
    expect(detail.composition.byRole).toEqual({ OWNER: 1 });
    expect(detail.suspension).toEqual({ supported: false });
    expect(detail.limits.map((l: any) => l.key)).toContain("members");
    expect(JSON.stringify(detail)).not.toMatch(/general|announcements/i);
    await as("support_admin").expect(404, "GET", "/admin/v1/orgs/o_missing_org");
  });

  it("refuse percent signs as wildcards", async () => {
    // (The auditor was suspended above, which ended its console session.)
    expect((await as("super_admin").expect(200, "GET", "/admin/v1/orgs?q=%25")).organizations).toEqual([]);
  });
});
