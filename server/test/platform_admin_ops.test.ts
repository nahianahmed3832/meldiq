import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AdminAdminsList,
  AdminAuditPage,
  AdminAuditVerify,
  AdminEntitlements,
  AdminGrantResult,
  AdminIncidentDetail,
  AdminIncidentsPage,
  AdminInfrastructure,
  AdminLimits,
  AdminSessionsList,
} from "../src/shared/contracts/http/platformAdmin.js";
import { AccountClient, email, MemoryMailer } from "./support/accounts.js";
import { ADMIN_HOST, ADMIN_ORIGIN, AdminBrowser, type ConsoleAdmin, consoleAdmin, plainAccount, signIn } from "./support/adminConsole.js";
import { FakePasskey } from "./support/fakePasskey.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Phase 4 of the console: billing status and limits, infrastructure, incidents, the audit viewer and admin
 * management, each with its permission and the escalation rules admin management keeps.
 */
let h: Harness;
const mailer = new MemoryMailer();
const admins: Record<string, ConsoleAdmin> = {};
let orgId: string;
const REASON = "Phase four test: checking the change";

beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, ENTITLEMENT_LIMITS: "roles.custom=20" }, { mailer });
  for (const role of ["super_admin", "operations_admin", "support_admin", "billing_admin", "auditor"]) admins[role] = await consoleAdmin(h, mailer, role, `ops${role}`);
  const owner = await new AccountClient(h.baseUrl, email("owner")).signUp(mailer);
  await owner.signIn();
  await owner.setUpIdentity(`owner${Date.now().toString(36)}`);
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Limits Lab", visibility: "private", joinPolicy: "invite" })).org.id;
});
afterAll(async () => h.close());

const as = (role: string) => admins[role].browser;
const lastAudit = (action: string) => h.ctx.db.prepare("SELECT * FROM platform_audit WHERE action = ? ORDER BY id DESC LIMIT 1").get(action) as any;

describe("billing status and limits", () => {
  it("say there is no billing, and list server-wide limits", async () => {
    const e = await as("billing_admin").expect(200, "GET", "/admin/v1/entitlements");
    expect(AdminEntitlements.safeParse(e).success).toBe(true);
    expect(e.billing.available).toBe(false);
    expect(e.serverLimits).toEqual([{ key: "roles.custom", limit: 20 }]);
  });

  it("are set and cleared per organization by billing admins, with a reason, and enforced", async () => {
    const until = Date.now() + 30 * 86_400_000;
    const set = await as("billing_admin").expect(200, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: 1 }, expiresAt: until, reason: REASON });
    expect(AdminLimits.safeParse(set).success).toBe(true);
    expect(set.limits).toContainEqual({ key: "members", limit: 1, source: "workspace" });
    expect(lastAudit("org.limits")).toMatchObject({ target_id: orgId, reason: REASON, actor_role: "billing_admin" });
    expect(JSON.parse(lastAudit("org.limits").detail)).toEqual({ members: "default -> 1", until: new Date(until).toISOString() });
    expect((await as("billing_admin").expect(200, "GET", "/admin/v1/entitlements")).overrides).toContainEqual(expect.objectContaining({ orgId, orgName: "Limits Lab", key: "members", limit: 1 }));
    const cleared = await as("billing_admin").expect(200, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: null }, reason: REASON });
    expect(cleared.limits).toContainEqual({ key: "members", limit: null, source: "none" });
  });

  it("refuse unknown keys, empty changes, and roles without the permission", async () => {
    await as("billing_admin").expect(400, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { "ai.requests": 5 }, reason: REASON });
    await as("billing_admin").expect(400, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: {}, reason: REASON });
    await as("billing_admin").expect(404, "PUT", "/admin/v1/orgs/o_none_here/limits", { limits: { members: 3 }, expiresAt: Date.now() + 86_400_000, reason: REASON });
    await as("support_admin").expect(403, "PUT", `/admin/v1/orgs/${orgId}/limits`, { limits: { members: 3 }, reason: REASON });
    await as("auditor").expect(200, "GET", "/admin/v1/entitlements");
  });
});

describe("infrastructure", () => {
  it("reports measured health and connectors, without secrets", async () => {
    const r = await as("operations_admin").expect(200, "GET", "/admin/v1/infrastructure");
    expect(AdminInfrastructure.safeParse(r).success).toBe(true);
    expect(r.checks.map((c: any) => c.id)).toEqual(["database", "mongodb", "livekit", "storage"]);
    expect(r.checks.find((c: any) => c.id === "database").status).toBe("ok");
    expect(JSON.stringify(r)).not.toMatch(/test-secret-that-is-at-least-32-characters-long|devkey/);
    await as("billing_admin").expect(403, "GET", "/admin/v1/infrastructure");
  });

  it("checks a connector when allowed, and records it", async () => {
    const r = await as("operations_admin").expect(200, "POST", "/admin/v1/connectors/storage/check", {});
    expect(r).toEqual({ ok: true, errorKind: null });
    expect(lastAudit("connector.check")).toMatchObject({ target_id: "storage", outcome: "success" });
    await as("support_admin").expect(403, "POST", "/admin/v1/connectors/storage/check", {});
    await as("operations_admin").expect(400, "POST", "/admin/v1/connectors/smtp-password/check", {});
  });
});

describe("incidents", () => {
  it("go through the lifecycle (acknowledged, investigating, monitoring, resolved with a summary, closed), each change kept as an event", async () => {
    const ops = admins.operations_admin;
    const created = await ops.browser.expect(200, "POST", "/admin/v1/incidents", {
      title: "Uploads failing in ap-southeast-1",
      severity: "sev2",
      kind: "incident",
      orgRef: orgId,
      description: "S3 errors since 10:02 UTC.",
      service: "File storage",
    });
    expect(AdminIncidentDetail.safeParse(created).success).toBe(true);
    const id = created.incident.id;
    expect(created.incident).toMatchObject({ status: "open", source: "manual", service: "File storage", createdBy: { accountId: ops.account.accountId } });
    const acked = await ops.browser.expect(200, "PATCH", `/admin/v1/incidents/${id}`, { status: "acknowledged" });
    expect(acked.incident.acknowledgedAt).toBeGreaterThan(0);
    await ops.browser.expect(200, "PATCH", `/admin/v1/incidents/${id}`, { status: "investigating", assigneeAccountId: admins.support_admin.account.accountId });
    await as("support_admin").expect(200, "POST", `/admin/v1/incidents/${id}/notes`, { body: "Bucket policy rolled back." });
    await ops.browser.expect(200, "PATCH", `/admin/v1/incidents/${id}`, { status: "monitoring" });
    // Resolving needs a summary of what happened and what fixed it.
    await ops.browser.expect(400, "PATCH", `/admin/v1/incidents/${id}`, { status: "resolved" });
    const done = await ops.browser.expect(200, "PATCH", `/admin/v1/incidents/${id}`, {
      status: "resolved",
      resolution: "A bucket policy change blocked writes; rolled back.",
      notice: "File uploads were delayed for 20 minutes.",
    });
    expect(done.incident).toMatchObject({ status: "resolved", resolution: "A bucket policy change blocked writes; rolled back.", assignee: { accountId: admins.support_admin.account.accountId } });
    expect(done.incident.resolvedAt).toBeGreaterThan(0);
    const closed = await ops.browser.expect(200, "PATCH", `/admin/v1/incidents/${id}`, { status: "closed" });
    expect(closed.incident.closedAt).toBeGreaterThan(0);
    expect(closed.events.map((e: any) => e.kind)).toEqual(["created", "status", "status", "assign", "note", "status", "status", "note", "note", "status"]);
    expect((await ops.browser.expect(200, "GET", "/admin/v1/incidents?status=closed")).incidents.map((i: any) => i.id)).toContain(id);
    // Reopening clears the resolution and closing times, and keeps when it was first acknowledged.
    const reopened = await ops.browser.expect(200, "PATCH", `/admin/v1/incidents/${id}`, { status: "investigating" });
    expect(reopened.incident).toMatchObject({ status: "investigating", resolvedAt: null, closedAt: null, acknowledgedAt: acked.incident.acknowledgedAt });
    expect(lastAudit("incident.update")).toMatchObject({ target_id: id });
  });

  it("are listed and filtered; assignees must be admins; references must exist; auditors only read", async () => {
    const ops = as("operations_admin");
    await ops.expect(200, "POST", "/admin/v1/incidents", { title: "Planned database maintenance", severity: "sev4", kind: "maintenance", description: "Saturday 02:00 UTC." });
    const active = await as("auditor").expect(200, "GET", "/admin/v1/incidents?status=active");
    expect(AdminIncidentsPage.safeParse(active).success).toBe(true);
    expect(active.incidents.every((i: any) => i.status !== "resolved")).toBe(true);
    const id = active.incidents[0].id;
    const plain = await plainAccount(h, mailer, "notadmin");
    await ops.expect(400, "PATCH", `/admin/v1/incidents/${id}`, { assigneeAccountId: plain.accountId });
    await ops.expect(400, "POST", "/admin/v1/incidents", { title: "Bad ref", severity: "sev3", kind: "support", userRef: "u_nobody_at_all", description: "x" });
    await ops.expect(400, "PATCH", `/admin/v1/incidents/${id}`, {});
    await as("auditor").expect(403, "POST", `/admin/v1/incidents/${id}/notes`, { body: "Can't write" });
    // Assignees: admins whose role manages incidents (an auditor or billing admin isn't one).
    const { assignees } = await as("support_admin").expect(200, "GET", "/admin/v1/incidents/assignees");
    expect(assignees.map((a: any) => a.accountId)).toContain(admins.operations_admin.account.accountId);
    expect(assignees.map((a: any) => a.accountId)).not.toContain(admins.auditor.account.accountId);
    await ops.expect(400, "PATCH", `/admin/v1/incidents/${id}`, { assigneeAccountId: admins.auditor.account.accountId });
    await as("billing_admin").expect(403, "GET", "/admin/v1/incidents");
  });
});

describe("the audit viewer", () => {
  it("filters, pages, and verifies the chain; only auditors and super admins see it", async () => {
    const page1 = await as("auditor").expect(200, "GET", "/admin/v1/audit?limit=3");
    expect(AdminAuditPage.safeParse(page1).success).toBe(true);
    expect(page1.events).toHaveLength(3);
    const page2 = await as("auditor").expect(200, "GET", `/admin/v1/audit?limit=3&cursor=${page1.nextCursor}`);
    expect(page2.events[0].id).toBeLessThan(page1.events[2].id);
    const limits = await as("auditor").expect(200, "GET", `/admin/v1/audit?action=org.&targetId=${orgId}`);
    expect(limits.events.length).toBeGreaterThan(0);
    expect(limits.events.every((e: any) => e.action.startsWith("org.") && e.targetId === orgId)).toBe(true);
    const denied = await as("super_admin").expect(200, "GET", "/admin/v1/audit?outcome=denied");
    expect(denied.events.every((e: any) => e.outcome === "denied")).toBe(true);
    await as("auditor").expect(400, "GET", "/admin/v1/audit?action=x%25");
    const v = await as("auditor").expect(200, "GET", "/admin/v1/audit/verify");
    expect(AdminAuditVerify.safeParse(v).success).toBe(true);
    expect(v.brokenAt).toBeNull();
    for (const role of ["operations_admin", "support_admin", "billing_admin"]) await as(role).expect(403, "GET", "/admin/v1/audit");
  });
});

describe("admin management", () => {
  it("lists admins to super admins and auditors only", async () => {
    const list = await as("auditor").expect(200, "GET", "/admin/v1/admins");
    expect(AdminAdminsList.safeParse(list).success).toBe(true);
    expect(list.activeSuperAdmins).toBe(1);
    const support = list.admins.find((a: any) => a.accountId === admins.support_admin.account.accountId);
    expect(support).toMatchObject({ role: "support_admin", status: "active", passkeys: 1 });
    // Enrolment ends in a session, so it counts as signing in.
    expect(support.lastSignInAt).toBeGreaterThan(0);
    await as("support_admin").expect(403, "GET", "/admin/v1/admins");
    await as("auditor").expect(403, "POST", "/admin/v1/admins", { email: "x@example.test", role: "auditor", reason: REASON });
  });

  it("grants a role with a one-time enrolment code, which the new admin uses", async () => {
    const newcomer = await plainAccount(h, mailer, "newcomer");
    const r = await as("super_admin").expect(200, "POST", "/admin/v1/admins", { email: newcomer.email, role: "auditor", reason: REASON });
    expect(AdminGrantResult.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ admin: { role: "auditor", enrolmentPending: true, grantedBy: { accountId: admins.super_admin.account.accountId } } });
    expect(r.enrolmentCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const b = new AdminBrowser(h);
    const { options } = await b.expect(200, "POST", "/admin/v1/auth/enrol/options", { email: newcomer.email, password: newcomer.password, code: r.enrolmentCode });
    await b.expect(200, "POST", "/admin/v1/auth/enrol", { response: new FakePasskey(ADMIN_HOST, ADMIN_ORIGIN).create(options) });
    expect(lastAudit("admin.grant")).toMatchObject({ actor_account_id: admins.super_admin.account.accountId, reason: REASON });
    await as("super_admin").expect(409, "POST", "/admin/v1/admins", { email: newcomer.email, role: "auditor", reason: REASON });
  });

  it("changes roles, resets passkeys, ends sessions and revokes, and the target feels each at once", async () => {
    const target = await consoleAdmin(h, mailer, "auditor", "target");
    const id = target.account.accountId;
    const changed = await as("super_admin").expect(200, "PATCH", `/admin/v1/admins/${id}`, { role: "support_admin", reason: REASON });
    expect(changed.admin.role).toBe("support_admin");
    await target.browser.expect(401, "GET", "/admin/v1/me");

    const again = await signIn(h, target);
    const sessions = await as("super_admin").expect(200, "GET", `/admin/v1/admins/${id}/sessions`);
    expect(AdminSessionsList.safeParse(sessions).success).toBe(true);
    await as("super_admin").expect(200, "POST", `/admin/v1/admin-sessions/${sessions.sessions[0].id}/revoke`, { reason: REASON });
    await again.expect(401, "GET", "/admin/v1/me");

    const reset = await as("super_admin").expect(200, "POST", `/admin/v1/admins/${id}/reset-passkeys`, { reason: REASON });
    expect(reset.admin.passkeys).toBe(0);
    expect(reset.enrolmentCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const revoked = await as("super_admin").expect(200, "POST", `/admin/v1/admins/${id}/revoke`, { reason: REASON });
    expect(revoked.admin).toMatchObject({ status: "revoked", enrolmentPending: false });
  });

  it("refuses changing oneself, demoting or revoking the last super admin, and needs a recent passkey check", async () => {
    const sup = admins.super_admin;
    const self = sup.account.accountId;
    expect((await sup.browser.req("PATCH", `/admin/v1/admins/${self}`, { role: "auditor", reason: REASON })).status).toBe(403);
    expect(lastAudit("admin.role_change")).toMatchObject({ outcome: "denied", target_id: self });
    expect((await sup.browser.req("POST", `/admin/v1/admins/${self}/revoke`, { reason: REASON })).status).toBe(403);
    // With two super admins, one may demote the other; the one left is then the last, and can't remove itself.
    const second = await consoleAdmin(h, mailer, "super_admin", "secondsuper");
    expect((await second.browser.req("PATCH", `/admin/v1/admins/${self}`, { role: "auditor", reason: REASON })).status).toBe(200);
    expect((await as("auditor").req("GET", "/admin/v1/admins")).body).toMatchObject({ activeSuperAdmins: 1 });
    expect((await second.browser.req("POST", `/admin/v1/admins/${second.account.accountId}/revoke`, { reason: REASON })).status).toBe(403);
    // Nobody else can manage admins at all, so the last super admin can't be removed through the API. (The
    // last-super-admin check in admins.ts is defence in depth for that case.)
    // Step-up applies to admin management too.
    h.ctx.db.prepare("UPDATE platform_admin_sessions SET reauth_at = 0 WHERE account_id = ?").run(second.account.accountId);
    expect((await second.browser.req("POST", "/admin/v1/admins", { email: "nobody@example.test", role: "auditor", reason: REASON })).body.error.code).toBe("reauth_required");
  });
});
