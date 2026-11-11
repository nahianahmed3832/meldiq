import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { consoleAdmin, consoleAudit, signIn, type ConsoleAdmin } from "./support/adminConsole.js";
import { startServer, type Harness } from "./support/harness.js";
import { csvCell } from "../src/modules/platformAdmin/searchExport.js";
import { grantAdmin, CLI_ACTOR } from "../src/modules/platformAdmin/bootstrap.js";
import { PlatformAdminStore } from "../src/modules/platformAdmin/store.js";

let h: Harness;
let superAdmin: ConsoleAdmin, auditor: ConsoleAdmin, otherAuditor: ConsoleAdmin, ops: ConsoleAdmin, reader: ConsoleAdmin;
const mailer = new MemoryMailer();
let alice: AccountClient;
const reason = "Synthetic administration acceptance test";
beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: "https://admin.example.test", TELEMETRY_TICK_MS: "0" }, { mailer });
  superAdmin = await consoleAdmin(h, mailer, "super_admin", "foundation-super");
  auditor = await consoleAdmin(h, mailer, "auditor", "foundation-auditor");
  otherAuditor = await consoleAdmin(h, mailer, "auditor", "foundation-other");
  ops = await consoleAdmin(h, mailer, "operations_admin", "foundation-ops");
  reader = await consoleAdmin(h, mailer, "support_admin", "foundation-reader");
  alice = await AccountClient.ready(h.baseUrl, mailer, "foundation-alice");
});
afterAll(async () => h.close());

async function ready(id: string, admin: ConsoleAdmin = auditor) {
  for (let i = 0; i < 60; i++) {
    const job = await admin.browser.expect(200, "GET", `/admin/v1/export-jobs/${id}`);
    if (job.state === "ready" || job.state === "failed") return job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Local export did not complete");
}

describe("admin completion shared foundations", { timeout: 120_000 }, () => {
  it("protects spreadsheet cells including whitespace/control-prefixed formulas", () => {
    for (const value of ["=CMD()", " +1", "\t@SUM(1)", "\r-2", "\n=1", "\u0000=1"]) expect(csvCell(value).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvCell("ordinary text")).toBe("ordinary text");
  });
  it("uses the table filters for exports and never exports masked account fields", async () => {
    const filters = JSON.stringify({ q: alice.username, status: "active" });
    const table = await auditor.browser.expect(200, "GET", `/admin/v1/users?q=${alice.username}&status=active`);
    const file = await auditor.browser.expect(200, "GET", `/admin/v1/exports/users?filters=${encodeURIComponent(filters)}&reason=${encodeURIComponent(reason)}`);
    const csv = file.toString();
    expect(csv.trim().split("\r\n")).toHaveLength(table.users.length + 1);
    expect(csv).toContain(alice.userId);
    expect(csv).not.toContain(alice.email);
    await reader.browser.expect(403, "GET", `/admin/v1/exports/users?reason=${encodeURIComponent(reason)}`);
    await ops.browser.expect(403, "GET", `/admin/v1/exports/audit?reason=${encodeURIComponent(reason)}`);
    await auditor.browser.expect(400, "GET", `/admin/v1/exports/users?filters=${encodeURIComponent(JSON.stringify({ arbitrarySql: "select *" }))}&reason=${encodeURIComponent(reason)}`);
  });
  it("rejects stale configuration edits and records the winning value once", async () => {
    const path = "/admin/v1/settings/analytics.exclude_admins";
    await superAdmin.browser.expect(400, "PUT", path, { value: false, reason });
    const body = { value: false, expectedUpdatedAt: null, reason };
    const answers = await Promise.all([superAdmin.browser.req("PUT", path, body), superAdmin.browser.req("PUT", path, { ...body, value: true })]);
    expect(answers.map(r => r.status).sort()).toEqual([200, 409]);
    const latest = await superAdmin.browser.expect(200, "GET", "/admin/v1/settings");
    const setting = latest.settings.find((s: any) => s.key === "analytics.exclude_admins");
    expect(setting.updatedAt).toBeGreaterThan(0);
    await superAdmin.browser.expect(409, "PUT", path, body);
    const controls = await superAdmin.browser.expect(200, "GET", "/admin/v1/controls");
    const update = { value: { mode: "open" }, expectedUpdatedAt: controls.controls.signups.updatedAt, reason };
    await superAdmin.browser.expect(200, "PUT", "/admin/v1/controls/signups", update);
    await superAdmin.browser.expect(409, "PUT", "/admin/v1/controls/signups", update);
  });
  it("filters and exports canonical dotted, numeric and system audit references", async () => {
    const audit = consoleAudit(h);
    for (const targetId of ["host.cpu", "1", "provider:subscription/fixture"]) {
      await audit.record({ action: "fixture.reference", actorAccountId: "system:restrictions", targetType: "test", targetId, outcome: "success", reason });
      const filters = { actor: "system:restrictions", targetType: "test", targetId };
      const page = await auditor.browser.expect(200, "GET", `/admin/v1/audit?${new URLSearchParams(filters)}`);
      expect(page.events).toHaveLength(1);
      expect(page.events[0].targetId).toBe(targetId);
      const csv = (await auditor.browser.expect(200, "GET", `/admin/v1/exports/audit?filters=${encodeURIComponent(JSON.stringify(filters))}&reason=${encodeURIComponent(reason)}`)).toString();
      expect(csv.trim().split("\r\n")).toHaveLength(2);
      expect(csv).toContain(targetId);
    }
    await auditor.browser.expect(400, "GET", "/admin/v1/audit?targetId=unsafe%0Aidentifier");
  });
  it("pages sparse audit filters within bounded scans and completes an owned durable export beyond 5,000 rows", async () => {
    const audit = consoleAudit(h), at = Date.now();
    await h.ctx.platform.write(w => {
      for (let i = 0; i < 5005; i++) audit.append(w, { action: "fixture.export", actorAccountId: auditor.account.accountId, actorRole: "auditor", targetType: "test", targetId: `fixture-${i}`, outcome: "success", reason }, at);
    });
    const filters = JSON.stringify({ action: "fixture.", actor: auditor.account.accountId });
    const tooBig = await auditor.browser.req("GET", `/admin/v1/exports/audit?filters=${encodeURIComponent(filters)}&reason=${encodeURIComponent(reason)}`);
    expect(tooBig.status).toBe(422);
    const request = { kind: "audit", requestKey: crypto.randomUUID(), query: { filters, reason } };
    const created = await auditor.browser.expect(200, "POST", "/admin/v1/export-jobs", request);
    const duplicate = await auditor.browser.expect(200, "POST", "/admin/v1/export-jobs", request);
    expect(duplicate.id).toBe(created.id);
    await auditor.browser.expect(409, "POST", "/admin/v1/export-jobs", { ...request, kind: "users" });
    await otherAuditor.browser.expect(404, "GET", `/admin/v1/export-jobs/${created.id}`);
    await otherAuditor.browser.expect(404, "GET", `/admin/v1/export-jobs/${created.id}/download`);
    const finished = await ready(created.id);
    expect(finished).toMatchObject({ state: "ready", rows: 5005 });
    const csv = (await auditor.browser.expect(200, "GET", `/admin/v1/export-jobs/${created.id}/download`)).toString();
    expect(csv.trim().split("\r\n")).toHaveLength(5006);
    const sparse = await auditor.browser.expect(200, "GET", "/admin/v1/audit?action=admin.enrol&limit=1");
    expect(sparse.nextCursor).not.toBeNull();
    const store = new PlatformAdminStore(h.ctx.platform, h.ctx.ephemeral);
    await grantAdmin(store, audit, await h.ctx.accounts.store.accountById(auditor.account.accountId), "support_admin", CLI_ACTOR, reason);
    // Role changes revoke the session; stale credentials cannot download the previously authorized artifact.
    expect((await auditor.browser.req("GET", `/admin/v1/export-jobs/${created.id}/download`)).status).toBe(401);
  });
  it("invalidates old artifacts after a supplemental permission is removed even when dataset and export permissions remain", async () => {
    const target = otherAuditor.account.accountId;
    const job = await otherAuditor.browser.expect(200, "POST", "/admin/v1/export-jobs", { kind: "users", requestKey: crypto.randomUUID(), query: { filters: JSON.stringify({ q: alice.username }), reason } });
    expect((await ready(job.id, otherAuditor)).state).toBe("ready");
    const view = await superAdmin.browser.expect(200, "GET", `/admin/v1/admins/${target}/permissions`);
    await superAdmin.browser.expect(400, "PUT", `/admin/v1/admins/${target}/permissions`, { permissions: view.effective, reason });
    await superAdmin.browser.expect(200, "PUT", `/admin/v1/admins/${target}/permissions`, { permissions: view.effective.filter((p: string) => p !== "billing.view"), expectedUpdatedAt: view.updatedAt, reason });
    await superAdmin.browser.expect(409, "PUT", `/admin/v1/admins/${target}/permissions`, { permissions: view.effective, expectedUpdatedAt: view.updatedAt, reason });
    otherAuditor.browser = await signIn(h, otherAuditor);
    await otherAuditor.browser.expect(200, "GET", "/admin/v1/users");
    await otherAuditor.browser.expect(403, "GET", `/admin/v1/export-jobs/${job.id}/download`);
    expect((await otherAuditor.browser.expect(200, "GET", "/admin/v1/export-jobs")).jobs).toHaveLength(0);
    const fresh = await otherAuditor.browser.expect(200, "POST", "/admin/v1/export-jobs", { kind: "users", requestKey: crypto.randomUUID(), query: { reason } });
    expect((await ready(fresh.id, otherAuditor)).state).toBe("ready");
    await h.ctx.platform.write(w => { w.update("platform_export_jobs", { id: fresh.id }, { expires_at: Date.now() - 1 }); });
    await otherAuditor.browser.expect(410, "GET", `/admin/v1/export-jobs/${fresh.id}/download`);
    await new PlatformAdminStore(h.ctx.platform, h.ctx.ephemeral).purgeExpired(Date.now());
    expect(h.ctx.platform.get("platform_export_jobs", { id: fresh.id })).toBeUndefined();
    expect(h.ctx.platform.count("platform_audit", { target_type: "export_job", target_id: fresh.id })).toBeGreaterThan(0);
  });
  it("prevents two administrators from concurrently removing the final platform authority", async () => {
    const peer = await consoleAdmin(h, mailer, "super_admin", "foundation-peer-super");
    const grantVersion = (id: string) => h.ctx.platform.get<{ updated_at: number }>("platform_admins", { account_id: id })!.updated_at;
    await superAdmin.browser.expect(400, "PATCH", `/admin/v1/admins/${peer.account.accountId}`, { role: "auditor", reason });
    const outcomes = await Promise.all([
      superAdmin.browser.req("PATCH", `/admin/v1/admins/${peer.account.accountId}`, { role: "auditor", expectedUpdatedAt: grantVersion(peer.account.accountId), reason }),
      peer.browser.req("PATCH", `/admin/v1/admins/${superAdmin.account.accountId}`, { role: "auditor", expectedUpdatedAt: grantVersion(superAdmin.account.accountId), reason }),
    ]);
    expect(outcomes.filter(r => r.status === 200)).toHaveLength(1);
    expect(outcomes.filter(r => [401, 403].includes(r.status))).toHaveLength(1);
    expect(h.ctx.platform.count("platform_admins", { role: "super_admin", revoked_at: null })).toBe(1);
  });

});
