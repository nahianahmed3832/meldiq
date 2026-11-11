import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountClient, email, MemoryMailer } from "./support/accounts.js";
import { AdminBrowser, consoleAdmin, signIn, type ConsoleAdmin } from "./support/adminConsole.js";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import { AdminReportDetail, AdminReportsPage, AdminPermissionView } from "../src/shared/contracts/http/platformAdmin.js";

let h: Harness;
const mailer = new MemoryMailer();
let owner: ConsoleAdmin, moderator: ConsoleAdmin, support: ConsoleAdmin, auditor: ConsoleAdmin;
let person: AccountClient;
let reportId: string, orgId: string, channelId: string;
const reason = "Reviewed the linked policy violation evidence";

beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: "https://admin.example.test" }, { mailer });
  owner = await consoleAdmin(h, mailer, "super_admin", "completeowner");
  moderator = await consoleAdmin(h, mailer, "platform_moderator", "completemoderator");
  support = await consoleAdmin(h, mailer, "support_admin", "completesupport");
  auditor = await consoleAdmin(h, mailer, "auditor", "completeauditor");
  person = await new AccountClient(h.baseUrl, email("completeperson")).signUp(mailer);
  await person.signIn();
  await person.setUpIdentity(`cp${Date.now().toString(36)}`);
  orgId = (await person.req("POST", "/v1/orgs", { name: "Restricted community", visibility: "public", joinPolicy: "open" })).org.id;
  channelId = h.ctx.ws.get<{ id: string }>("conversations", { org_id: orgId })!.id;
  const reporter = await h.client("completereporter");
  reportId = (await reporter.req("POST", "/v1/reports", { targetUserId: person.userId, reason: "harassment", note: "PRIVATE-REPORTER-NOTE" })).report.id;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await h?.close();
});

const detail = () => moderator.browser.expect(200, "GET", `/admin/v1/reports/${reportId}`);

describe("central moderation", () => {
  it("uses real submitted reports without exposing reporter notes, identity or content", async () => {
    const queue = await moderator.browser.expect(200, "GET", "/admin/v1/reports?status=open");
    expect(AdminReportsPage.safeParse(queue).success).toBe(true);
    expect(queue.reports[0]).toMatchObject({ id: reportId, targetUserId: person.userId, status: "open", version: 0 });
    const d = await detail();
    expect(AdminReportDetail.safeParse(d).success).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/PRIVATE-REPORTER-NOTE|reporterId|reporter_id|content|password|token/);
    await support.browser.expect(403, "PATCH", `/admin/v1/reports/${reportId}`, { version: 0, priority: "high", reason });
    await auditor.browser.expect(403, "GET", "/admin/v1/reports/assignees");
    await new AdminBrowser(h).expect(401, "GET", "/admin/v1/reports");
  });
  it("assigns only qualified moderators, records notes and rejects stale or invalid changes", async () => {
    await moderator.browser.expect(400, "PATCH", `/admin/v1/reports/${reportId}`, { version: 0, assigneeAccountId: support.account.accountId, reason });
    const d = await moderator.browser.expect(200, "PATCH", `/admin/v1/reports/${reportId}`, {
      version: 0,
      assigneeAccountId: moderator.account.accountId,
      priority: "urgent",
      note: "Evidence reference CASE-42",
      reason,
    });
    expect(d.report).toMatchObject({ version: 1, priority: "urgent", assigneeAccountId: moderator.account.accountId });
    expect(d.events[0].body).toBe("Evidence reference CASE-42");
    await moderator.browser.expect(409, "PATCH", `/admin/v1/reports/${reportId}`, { version: 0, priority: "low", reason });
    await moderator.browser.expect(400, "PATCH", `/admin/v1/reports/${reportId}`, { version: 1, priority: "invalid", reason });
    await moderator.browser.expect(404, "GET", "/admin/v1/reports/rep_nonexistent");
  });
  it("resolves through the canonical report store and records appeal decisions", async () => {
    const d = await moderator.browser.expect(200, "PATCH", `/admin/v1/reports/${reportId}`, { version: 1, status: "actioned", appealStatus: "open", reason });
    expect(d.report).toMatchObject({ status: "actioned", appealStatus: "open", syncStatus: "synced", version: 2 });
    expect((await h.ctx.reports.get(reportId))?.status).toBe("actioned");
    const reopened = await moderator.browser.expect(200, "PATCH", `/admin/v1/reports/${reportId}`, { version: 2, status: "open", appealStatus: "overturned", reason });
    expect(reopened.report).toMatchObject({ status: "open", appealStatus: "overturned", version: 3 });
    expect(h.ctx.platform.count("platform_audit", { action: "report.resolve", target_id: reportId })).toBe(2);
  });
  it("exposes a failed cross-store resolution and permits an explicit retry", async () => {
    const fail = vi.spyOn(h.ctx.reports, "setStatus").mockRejectedValueOnce(new Error("test store failure"));
    await moderator.browser.expect(500, "PATCH", `/admin/v1/reports/${reportId}`, { version: 3, status: "dismissed", reason });
    fail.mockRestore();
    const failed = await detail();
    expect(failed.report).toMatchObject({ status: "open", intendedStatus: "dismissed", syncStatus: "failed", version: 4 });
    const retried = await moderator.browser.expect(200, "PATCH", `/admin/v1/reports/${reportId}`, { version: 4, status: "dismissed", reason });
    expect(retried.report).toMatchObject({ status: "dismissed", syncStatus: "synced", version: 5 });
  });
  it("uses stable keyset pagination even when reports have the same timestamp", async () => {
    const original = (await h.ctx.reports.get(reportId))!;
    for (const id of ["rep_same_a", "rep_same_b", "rep_same_c"]) await h.ctx.reports.create({ ...original, id, status: "open", created_at: 1234 });
    const first = await moderator.browser.expect(200, "GET", "/admin/v1/reports?status=open&limit=2");
    const second = await moderator.browser.expect(200, "GET", `/admin/v1/reports?status=open&limit=2&cursor=${first.nextCursor}`);
    expect(first.reports.map((r: any) => r.id)).toEqual(["rep_same_c", "rep_same_b"]);
    expect(second.reports.map((r: any) => r.id)).toEqual(["rep_same_a"]);
  });
});

describe("explicit administrative permissions", () => {
  it("prevents privilege escalation and self/owner restriction", async () => {
    const target = support.account.accountId;
    await support.browser.expect(403, "PUT", `/admin/v1/admins/${target}/permissions`, { permissions: ["admins.manage"], reason, expectedUpdatedAt: h.ctx.platform.get<{ updated_at: number }>("platform_admins", { account_id: target })!.updated_at });
    await owner.browser.expect(400, "PUT", `/admin/v1/admins/${target}/permissions`, { permissions: ["admins.manage"], reason, expectedUpdatedAt: h.ctx.platform.get<{ updated_at: number }>("platform_admins", { account_id: target })!.updated_at });
    await owner.browser.expect(403, "PUT", `/admin/v1/admins/${owner.account.accountId}/permissions`, { permissions: [], reason, expectedUpdatedAt: h.ctx.platform.get<{ updated_at: number }>("platform_admins", { account_id: owner.account.accountId })!.updated_at });
    await owner.browser.expect(400, "PUT", `/admin/v1/admins/${target}/permissions`, { permissions: ["unknown"], reason, expectedUpdatedAt: h.ctx.platform.get<{ updated_at: number }>("platform_admins", { account_id: target })!.updated_at });
  });
  it("ends sessions and enforces reduced grants in routes, nested data, search and exports", async () => {
    const target = support.account.accountId;
    const changed = await owner.browser.expect(200, "PUT", `/admin/v1/admins/${target}/permissions`, { permissions: ["overview.view", "users.view"], reason, expectedUpdatedAt: h.ctx.platform.get<{ updated_at: number }>("platform_admins", { account_id: target })!.updated_at });
    expect(AdminPermissionView.safeParse(changed).success).toBe(true);
    await support.browser.expect(401, "GET", "/admin/v1/me");
    const restricted = await signIn(h, support);
    const d = await restricted.expect(200, "GET", `/admin/v1/users/${person.userId}`);
    expect(d.account.email).toBeNull();
    await restricted.expect(403, "GET", "/admin/v1/reports");
    await restricted.expect(403, "POST", `/admin/v1/users/${person.userId}/suspend`, { reason });
    const ov = await restricted.expect(200, "GET", "/admin/v1/overview");
    expect(ov.health).toBeNull();
    expect((await restricted.expect(200, "GET", "/admin/v1/search?q=community")).organizations).toBeNull();
    await owner.browser.expect(200, "PUT", `/admin/v1/admins/${target}/permissions`, { permissions: null, reason, expectedUpdatedAt: h.ctx.platform.get<{ updated_at: number }>("platform_admins", { account_id: target })!.updated_at });
  });
});

describe("community restrictions and billing availability", () => {
  it("blocks owners and channel access server-side, then restores access without deleting membership", async () => {
    await person.req("GET", `/v1/orgs/${orgId}`);
    await auditor.browser.expect(403, "POST", `/admin/v1/orgs/${orgId}/restriction`, { suspended: true, reason });
    await moderator.browser.expect(400, "POST", `/admin/v1/orgs/${orgId}/restriction`, { suspended: true, until: 1, reason });
    const result = await moderator.browser.expect(200, "POST", `/admin/v1/orgs/${orgId}/restriction`, { suspended: true, reason });
    expect(result.suspension.active).toBe(true);
    expect(h.ctx.authz.orgRole(orgId, person.userId)).toBeNull();
    expect(h.ctx.authz.isMember(channelId, person.userId)).toBe(false);
    await expectStatus(person.req("GET", `/v1/orgs/${orgId}`), 404);
    await moderator.browser.expect(200, "POST", `/admin/v1/orgs/${orgId}/restriction`, { suspended: false, reason });
    expect(h.ctx.authz.orgRole(orgId, person.userId)).toBe("OWNER");
    await person.req("GET", `/v1/orgs/${orgId}`);
  });
  it("expires temporary restrictions through the shared authorization path", async () => {
    await moderator.browser.expect(200, "POST", `/admin/v1/orgs/${orgId}/restriction`, { suspended: true, until: Date.now() + 60000, reason });
    await h.ctx.ws.write((w) => w.update("orgs", { id: orgId }, { platform_suspended_until: Date.now() - 1 }));
    expect(h.ctx.authz.platformSuspended(orgId)).toBe(false);
    await person.req("GET", `/v1/orgs/${orgId}`);
  });
  it("filters people by canonical entitlements and community membership, and measures Free accurately", async () => {
    const before = await owner.browser.expect(200, "GET", `/admin/v1/users?q=${person.userId}&plan=free&orgId=${orgId}`);
    expect(before.users.map((u: any) => u.id)).toEqual([person.userId]);
    await owner.browser.expect(200, "POST", "/admin/v1/billing/grants", { accountId: person.accountId, planKey: "plus", days: 7, reason });
    const plus = await owner.browser.expect(200, "GET", `/admin/v1/users?q=${person.userId}&plan=plus`);
    expect(plus.users.map((u: any) => u.id)).toEqual([person.userId]);
    expect((await owner.browser.expect(200, "GET", `/admin/v1/users?q=${person.userId}&plan=free`)).users).toEqual([]);
    const figures = await owner.browser.expect(200, "GET", "/admin/v1/billing/mojo");
    expect(figures.figures.accountsByPlan.plus).toBe(1);
    expect(figures.figures.accountsByPlan.free).toBeGreaterThan(0);
  });
  it("deletes only suspended communities after exact confirmation, and safely replays the operation", async () => {
    const name = "Disposable deletion fixture";
    const id = (await person.req("POST", "/v1/orgs", { name, visibility: "public", joinPolicy: "open" })).org.id;
    const requestId = crypto.randomUUID();
    await moderator.browser.expect(403, "DELETE", `/admin/v1/orgs/${id}`, { confirmName: name, requestId, reason });
    await owner.browser.expect(409, "DELETE", `/admin/v1/orgs/${id}`, { confirmName: name, requestId, reason });
    await owner.browser.expect(200, "POST", `/admin/v1/orgs/${id}/restriction`, { suspended: true, reason });
    await owner.browser.expect(400, "DELETE", `/admin/v1/orgs/${id}`, { confirmName: "wrong", requestId, reason });
    const result = await owner.browser.expect(200, "DELETE", `/admin/v1/orgs/${id}`, { confirmName: name, requestId, reason });
    expect(result).toMatchObject({ deleted: true, orgId: id, members: 1 });
    expect(h.ctx.ws.get("orgs", { id })).toBeUndefined();
    expect(await owner.browser.expect(200, "DELETE", `/admin/v1/orgs/${id}`, { confirmName: name, requestId, reason })).toEqual(result);
    await owner.browser.expect(404, "DELETE", `/admin/v1/orgs/${id}`, { confirmName: name, requestId: crypto.randomUUID(), reason });
    expect(h.ctx.identity.get("users", { id: person.userId })).toBeDefined();
    expect(h.ctx.ws.get("orgs", { id: orgId })).toBeDefined();
  });
  it("reports PayPal as unavailable without fake transaction data", async () => {
    const r = await owner.browser.expect(200, "GET", "/admin/v1/billing/paypal/transactions");
    expect(r).toMatchObject({ integration: { available: false, mode: null }, transactions: [] });
    const verify = await owner.browser.expect(200, "GET", "/admin/v1/audit/verify");
    expect(verify.brokenAt).toBeNull();
  });
});
