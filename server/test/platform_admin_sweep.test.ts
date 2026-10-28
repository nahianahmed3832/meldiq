import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, PLATFORM_ROLES, type Permission, type PlatformRole } from "../src/modules/platformAdmin/permissions.js";
import { MemoryMailer } from "./support/accounts.js";
import { AdminBrowser, type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Phase 5 hardening: every /admin/v1 route the server registers, checked as a whole. A route must be listed below as
 * public, session-only or guarded by one named permission, so a route added later without a decision fails here.
 * Then: no session → 401, an app token → 401, another host → 404, and every role against every permission (refused
 * exactly when the role lacks it, and the refusal audited).
 */
const PUBLIC = ["POST /admin/v1/auth/password", "POST /admin/v1/auth/passkey", "POST /admin/v1/auth/enrol/options", "POST /admin/v1/auth/enrol"];
const SESSION_ONLY = ["GET /admin/v1/me", "POST /admin/v1/auth/logout", "POST /admin/v1/auth/reauth/options", "POST /admin/v1/auth/reauth"];
const GUARDED: Record<string, Permission> = {
  "GET /admin/v1/overview": "overview.view",
  "GET /admin/v1/users": "users.view",
  "GET /admin/v1/users/:userId": "users.view",
  "POST /admin/v1/users/:userId/suspend": "users.suspend",
  "POST /admin/v1/users/:userId/restore": "users.restore",
  "POST /admin/v1/users/:userId/sessions/revoke": "users.sessions.revoke",
  "GET /admin/v1/orgs": "orgs.view",
  "GET /admin/v1/orgs/:orgId": "orgs.view",
  "GET /admin/v1/entitlements": "entitlements.view",
  "PUT /admin/v1/orgs/:orgId/limits": "entitlements.edit",
  // Billing (docs/BILLING.md).
  "GET /admin/v1/billing/metrics": "billing.view",
  "GET /admin/v1/billing/plans": "billing.view",
  "POST /admin/v1/billing/plans": "billing.manage",
  "PATCH /admin/v1/billing/plans/:planId": "billing.manage",
  "PUT /admin/v1/billing/plans/:planId/draft": "billing.manage",
  "POST /admin/v1/billing/plans/:planId/publish": "billing.manage",
  "POST /admin/v1/billing/plans/:planId/archive": "billing.manage",
  "GET /admin/v1/billing/subscriptions": "billing.view",
  "GET /admin/v1/billing/subscriptions/:subscriptionId": "billing.view",
  "GET /admin/v1/billing/events": "billing.view",
  "POST /admin/v1/billing/events/:eventId/replay": "billing.events.replay",
  "GET /admin/v1/billing/program": "billing.view",
  "PUT /admin/v1/billing/program": "billing.manage",
  "GET /admin/v1/billing/grants": "billing.view",
  "POST /admin/v1/billing/grants": "billing.manage",
  "POST /admin/v1/billing/grants/:grantId/end": "billing.manage",
  "GET /admin/v1/billing/accounts/:accountId": "billing.view",
  "GET /admin/v1/billing/mojo": "billing.view",
  "PUT /admin/v1/billing/mojo": "billing.manage",
  "GET /admin/v1/billing/gifts": "billing.view",
  "GET /admin/v1/billing/sparks": "billing.view",
  "GET /admin/v1/infrastructure": "health.view",
  "POST /admin/v1/connectors/:id/check": "connectors.check",
  "GET /admin/v1/incidents": "incidents.view",
  "POST /admin/v1/incidents": "incidents.manage",
  "GET /admin/v1/incidents/assignees": "incidents.manage",
  "GET /admin/v1/incidents/:incidentId": "incidents.view",
  "PATCH /admin/v1/incidents/:incidentId": "incidents.manage",
  "POST /admin/v1/incidents/:incidentId/notes": "incidents.manage",
  "GET /admin/v1/audit": "audit.view",
  "GET /admin/v1/audit/verify": "audit.view",
  "GET /admin/v1/admins": "admins.view",
  "POST /admin/v1/admins": "admins.manage",
  "PATCH /admin/v1/admins/:accountId": "admins.manage",
  "POST /admin/v1/admins/:accountId/revoke": "admins.manage",
  "POST /admin/v1/admins/:accountId/reset-passkeys": "admins.manage",
  "GET /admin/v1/admins/:accountId/sessions": "admins.view",
  "POST /admin/v1/admin-sessions/:sessionId/revoke": "admins.manage",
  // Platform Admin 2.0.
  "GET /admin/v1/analytics/overview": "analytics.view",
  "GET /admin/v1/analytics/active-users": "analytics.view",
  "GET /admin/v1/analytics/retention": "analytics.view",
  "GET /admin/v1/analytics/clients": "analytics.view",
  "GET /admin/v1/analytics/organizations": "analytics.view",
  "GET /admin/v1/analytics/traffic": "resources.view",
  "GET /admin/v1/presence": "analytics.view",
  "GET /admin/v1/presence/connections": "presence.view",
  "POST /admin/v1/presence/disconnect": "users.sessions.revoke",
  "GET /admin/v1/devices": "devices.view",
  "GET /admin/v1/users/:userId/devices": "devices.view",
  "POST /admin/v1/users/:userId/sessions/:sessionId/revoke": "users.sessions.revoke",
  "POST /admin/v1/users/:userId/devices/:deviceId/revoke": "devices.revoke",
  "GET /admin/v1/users/:userId/insights": "users.view",
  "POST /admin/v1/users/:userId/verification-email": "users.recovery",
  "POST /admin/v1/users/:userId/password-reset-email": "users.recovery",
  "POST /admin/v1/users/:userId/delete": "users.delete",
  "GET /admin/v1/orgs/:orgId/insights": "orgs.view",
  "POST /admin/v1/orgs/:orgId/members/:userId/remove": "orgs.members.manage",
  "GET /admin/v1/resources": "resources.view",
  "GET /admin/v1/resources/series": "resources.view",
  "GET /admin/v1/quotas": "quotas.view",
  "GET /admin/v1/quotas/effective": "quotas.view",
  "GET /admin/v1/quotas/events": "quotas.view",
  "POST /admin/v1/quotas/policies": "quotas.edit",
  "POST /admin/v1/quotas/policies/:policyId/remove": "quotas.edit",
  "POST /admin/v1/quotas/plans": "quotas.edit",
  "POST /admin/v1/quotas/plans/:planId/members": "quotas.edit",
  "POST /admin/v1/quotas/plan-members/remove": "quotas.edit",
  "POST /admin/v1/quotas/adjust": "quotas.edit",
  // AI Workforce: the AI Control Center (docs/AI_WORKFORCE.md).
  "GET /admin/v1/settings": "settings.view",
  "PUT /admin/v1/settings/:key": "settings.edit",
  "GET /admin/v1/alerts": "incidents.view",
  "PUT /admin/v1/alerts/:key": "alerts.manage",
  "POST /admin/v1/alerts/evaluate": "alerts.manage",
  "GET /admin/v1/search": "overview.view",
  "GET /admin/v1/exports/:kind": "exports.create",
};

let h: Harness;
const mailer = new MemoryMailer();
const admins = {} as Record<PlatformRole, ConsoleAdmin>;

beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: "https://admin.example.test" }, { mailer });
  for (const role of PLATFORM_ROLES) admins[role] = await consoleAdmin(h, mailer, role, `sweep${role}`);
});
afterAll(async () => h.close());

const adminRoutes = () =>
  [...h.contracts.routes].filter((r) => / \/admin\/v1\//.test(r) && !r.startsWith("HEAD ") && !r.startsWith("OPTIONS ")).sort();

/** A concrete request for route template [r]: made-up ids, an empty body (so nothing real changes). */
function request(r: string): [string, string, unknown] {
  const [method, template] = r.split(" ");
  const url = template.replace(/:[A-Za-z]+/g, "zz_not_a_real_id");
  return [method, url, method === "GET" ? undefined : {}];
}

describe("every console route", () => {
  it("is classified as public, session-only or guarded by one permission", () => {
    const known = new Set([...PUBLIC, ...SESSION_ONLY, ...Object.keys(GUARDED)]);
    expect(adminRoutes().filter((r) => !known.has(r))).toEqual([]);
    expect([...known].filter((r) => !adminRoutes().includes(r))).toEqual([]);
  });

  it("refuses a request without a session (and never answers 2xx)", async () => {
    const b = new AdminBrowser(h);
    for (const r of adminRoutes()) {
      const res = await b.req(...request(r));
      expect(res.status, r).toBeGreaterThanOrEqual(400);
      if (!PUBLIC.includes(r)) expect([res.status, res.body.error.code], r).toEqual([401, "session_expired"]);
    }
  });

  it("refuses an app bearer token even next to a valid console cookie", async () => {
    const b = admins.super_admin.browser;
    for (const r of adminRoutes()) {
      const res = await b.req(...request(r), { authorization: "Bearer app-token-that-is-long-enough-to-look-real" });
      expect(res.status, r).toBe(401);
    }
  });

  it("is invisible on another host, and refuses changes from another origin", async () => {
    const b = admins.super_admin.browser;
    for (const r of adminRoutes()) {
      expect((await b.req(...request(r), { host: "msg.example.test" })).status, r).toBe(404);
      if (!r.startsWith("GET ")) expect((await b.req(...request(r), { origin: "https://evil.example" })).status, r).toBe(403);
    }
  });

  it("lets each role through exactly where its permissions say, and audits every refusal", async () => {
    for (const [r, permission] of Object.entries(GUARDED)) {
      for (const role of PLATFORM_ROLES) {
        const before = h.ctx.platform.count("platform_audit", { action: "admin.permission" });
        const res = await admins[role].browser.req(...request(r));
        const refused = res.status === 403 && res.body?.error?.code === "forbidden";
        expect(refused, `${role} ${r}`).toBe(!can(role, permission));
        const after = h.ctx.platform.count("platform_audit", { action: "admin.permission" });
        expect(after - before, `${role} ${r} audit`).toBe(refused ? 1 : 0);
        expect(res.status, `${role} ${r}`).not.toBe(500);
      }
    }
  });
});

describe("logging", () => {
  it("never logs a console request's query string (it can hold an email search)", async () => {
    const { logUrl } = await import("../src/app/server.js");
    expect(logUrl("/admin/v1/users?q=ada%40example.com&limit=25")).toBe("/admin/v1/users");
    expect(logUrl("/v1/conversations?limit=5")).toBe("/v1/conversations?limit=5");
  });
});
