import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminControls } from "../src/shared/contracts/http/platformAdminInsights.js";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Platform controls (docs/PLATFORM_CONTROLS.md): switches an operator flips from the console that change what the
 * server does at once — maintenance mode, who may sign up, blocked email domains, and kill switches for calls,
 * uploads and new organizations. Every change needs controls.edit and a fresh passkey, and is audited.
 */
let h: Harness;
const mailer = new MemoryMailer();
const admins: Record<string, ConsoleAdmin> = {};
let alice: AccountClient;
const REASON = { reason: "Launch-day load test of the controls" };

beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: "https://admin.example.test", TELEMETRY_TICK_MS: "0" }, { mailer });
  for (const role of ["super_admin", "operations_admin", "support_admin", "auditor"]) admins[role] = await consoleAdmin(h, mailer, role, `ctl${role}`);
  alice = await AccountClient.ready(h.baseUrl, mailer, "alice");
});
afterAll(async () => h.close());

const as = (role: string) => admins[role]!.browser;
const DEFAULTS = {
  maintenance: { enabled: false, message: "" },
  signups: { mode: "environment" },
  email_domains: { blocked: [] },
  features: { calls: true, uploads: true, orgCreation: true },
};
afterEach(async () => {
  for (const [key, value] of Object.entries(DEFAULTS)) await as("super_admin").expect(200, "PUT", `/admin/v1/controls/${key}`, { value, ...REASON });
});

const lastAudit = (action: string) => h.ctx.platform.get<any>("platform_audit", { action }, [["id", "desc"]]);

/** A request as an app makes it (no console header), answered with its status and body. */
async function app(method: string, path: string, body?: unknown, token = alice.token): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

const register = (address: string) => app("POST", "/v2/auth/register", { name: "New Person", email: address, password: PASSWORD }, "");

describe("the controls view", () => {
  it("lists every control with its default, the environment's sign-up mode and the effective one", async () => {
    const v = await as("auditor").expect(200, "GET", "/admin/v1/controls");
    expect(AdminControls.safeParse(v).success).toBe(true);
    expect(v.controls.maintenance.value).toEqual(DEFAULTS.maintenance);
    expect(v.controls.features.value).toEqual(DEFAULTS.features);
    expect(v.signups).toEqual({ environment: "open", effective: "open" });
  });

  it("lets super and operations admins change controls, with a reason and an audit entry; nobody else", async () => {
    await as("operations_admin").expect(200, "PUT", "/admin/v1/controls/features", { value: { calls: false, uploads: true, orgCreation: true }, ...REASON });
    expect(lastAudit("controls.update")).toMatchObject({ target_id: "features", reason: REASON.reason });
    const v = await as("auditor").expect(200, "GET", "/admin/v1/controls");
    expect(v.controls.features.value.calls).toBe(false);
    expect(v.controls.features.updatedBy).toMatchObject({ name: expect.any(String) });
    await as("support_admin").expect(403, "PUT", "/admin/v1/controls/features", { value: DEFAULTS.features, ...REASON });
    await as("auditor").expect(403, "PUT", "/admin/v1/controls/maintenance", { value: { enabled: true, message: "" }, ...REASON });
  });

  it("refuses unknown controls, malformed values and a missing reason", async () => {
    await as("super_admin").expect(404, "PUT", "/admin/v1/controls/everything", { value: true, ...REASON });
    await as("super_admin").expect(400, "PUT", "/admin/v1/controls/signups", { value: { mode: "sometimes" }, ...REASON });
    await as("super_admin").expect(400, "PUT", "/admin/v1/controls/email_domains", { value: { blocked: ["not a domain"] }, ...REASON });
    await as("super_admin").expect(400, "PUT", "/admin/v1/controls/maintenance", { value: { enabled: true, message: "" } });
  });
});

describe("maintenance mode", () => {
  it("answers app requests with 503 and the operator's message, while health, server info and the console keep working", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/maintenance", { value: { enabled: true, message: "Upgrading the database, back by 14:00 UTC." }, ...REASON });
    const blocked = await app("GET", "/v1/conversations");
    expect(blocked.status).toBe(503);
    expect(blocked.body.error).toMatchObject({ code: "maintenance", message: "Upgrading the database, back by 14:00 UTC." });
    expect(blocked.headers.get("retry-after")).toBe("300");
    expect((await register(email("during"))).status).toBe(503);
    expect((await app("GET", "/healthz", undefined, "")).status).toBe(200);
    const info = await app("GET", "/v1/server-info", undefined, "");
    expect(info.status).toBe(200);
    expect(info.body.maintenance).toEqual({ enabled: true, message: "Upgrading the database, back by 14:00 UTC." });
    await as("auditor").expect(200, "GET", "/admin/v1/controls");

    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/maintenance", { value: { enabled: false, message: "" }, ...REASON });
    expect((await app("GET", "/v1/conversations")).status).toBe(200);
  });

  it("uses a plain message when the operator leaves it empty", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/maintenance", { value: { enabled: true, message: "" }, ...REASON });
    const blocked = await app("GET", "/v1/conversations");
    expect(blocked.body.error.message).toMatch(/maintenance/i);
  });
});

describe("sign-ups", () => {
  it("closed: refuses every new sign-up, and server info says so", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/signups", { value: { mode: "closed" }, ...REASON });
    const r = await register(email("closed"));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("registration_closed");
    const info = await app("GET", "/v1/server-info", undefined, "");
    expect(info.body.signups).toBe("closed");
    // Older apps only know invite and open: closed shows as invite there, so they ask for a code.
    expect(info.body.registration).toBe("invite");
    expect((await as("auditor").expect(200, "GET", "/admin/v1/controls")).signups).toEqual({ environment: "open", effective: "closed" });
  });

  it("invite: needs an invitation code even though the environment says open", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/signups", { value: { mode: "invite" }, ...REASON });
    const r = await register(email("invite"));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("invite_required");
  });

  it("environment: the server's REGISTRATION_MODE applies again", async () => {
    expect((await register(email("open"))).status).toBe(202);
  });

  it("refuses addresses at blocked domains (and their subdomains), whatever the case", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/email_domains", { value: { blocked: ["Mailinator.com", "tempmail.dev"] }, ...REASON });
    const v = await as("auditor").expect(200, "GET", "/admin/v1/controls");
    expect(v.controls.email_domains.value.blocked).toEqual(["mailinator.com", "tempmail.dev"]);
    for (const address of ["someone@mailinator.com", "x@EU.Mailinator.com"]) {
      const r = await register(address);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("email_domain_blocked");
    }
    expect((await register(email("fine"))).status).toBe(202);
  });
});

describe("kill switches", () => {
  it("switch off starting and joining calls", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/features", { value: { calls: false, uploads: true, orgCreation: true }, ...REASON });
    const start = await app("POST", "/v1/calls", { kind: "audio" });
    expect(start.status).toBe(503);
    expect(start.body.error.code).toBe("feature_disabled");
    expect((await app("POST", "/v1/calls/c_x/join", {})).status).toBe(503);
  });

  it("switch off new uploads", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/features", { value: { calls: true, uploads: false, orgCreation: true }, ...REASON });
    const r = await app("POST", "/v1/attachments/uploads", { size: 10 });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("feature_disabled");
  });

  it("switch off creating organizations, and turning it back on works at once", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/features", { value: { calls: true, uploads: true, orgCreation: false }, ...REASON });
    const r = await app("POST", "/v1/orgs", { name: "Blocked Org", visibility: "public", joinPolicy: "open" });
    expect(r.status).toBe(503);
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/features", { value: DEFAULTS.features, ...REASON });
    expect((await app("POST", "/v1/orgs", { name: "Allowed Org", visibility: "public", joinPolicy: "open" })).status).toBe(200);
  });
});
