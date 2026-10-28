import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runPlatformAdminCommand } from "../src/modules/platformAdmin/index.js";
import { AdminMe } from "../src/shared/contracts/http/platformAdmin.js";
import { MemoryMailer } from "./support/accounts.js";
import { accountRows } from "./support/accountRows.js";
import {
  ADMIN_HOST,
  ADMIN_ORIGIN,
  AdminBrowser,
  consoleAdmin,
  consoleAudit,
  consoleStore,
  plainAccount,
  signIn,
} from "./support/adminConsole.js";
import { FakePasskey } from "./support/fakePasskey.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Platform Admin Console sign-in (meldiq_central_admin/docs/ARCHITECTURE_PROPOSAL.md §3): the request gate, enrolment
 * with a one-time code, password + console passkey, sessions and what ends them, step-up, throttling, and the audit
 * rows each of these leaves.
 */
let h: Harness;
let off: Harness;
const mailer = new MemoryMailer();

beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, WEB_ORIGINS: "https://web.example.test" }, { mailer });
  off = await startServer({}, { mailer });
});
afterAll(async () => {
  await h.close();
  await off.close();
});

const lastAudit = (action: string) => h.ctx.platform.get<any>("platform_audit", { action }, [["id", "desc"]]);

/** Runs a CLI command and returns its exit code and what it printed. */
async function cli(cmd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation((...a) => void lines.push(a.join(" ")));
  const table = vi.spyOn(console, "table").mockImplementation((t) => void lines.push(JSON.stringify(t)));
  try {
    // As admin.js does: a refusal is printed and exits 1.
    const code = await runPlatformAdminCommand(cmd, args, h.ctx.config, h.ctx.db).catch((e: Error) => {
      lines.push(e.message);
      return 1;
    });
    return { code, out: lines.join("\n") };
  } finally {
    log.mockRestore();
    err.mockRestore();
    table.mockRestore();
  }
}

describe("the console's routes", () => {
  it("don't exist unless ADMIN_CONSOLE_ORIGIN is set", async () => {
    const r = await new AdminBrowser(off).req("GET", "/admin/v1/me");
    expect(r.status).toBe(404);
  });

  it("answer only the console's host, with its header, and its origin for changes", async () => {
    const b = new AdminBrowser(h);
    expect((await b.req("GET", "/admin/v1/me", undefined, { host: "msg.example.test" })).status).toBe(404);
    expect((await b.req("GET", "/admin/v1/me", undefined, { "x-meldiq-admin": undefined })).status).toBe(403);
    expect((await b.req("POST", "/admin/v1/auth/password", { email: "a@b.cd", password: "x" }, { origin: undefined })).status).toBe(403);
    expect((await b.req("POST", "/admin/v1/auth/password", { email: "a@b.cd", password: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await b.req("GET", "/admin/v1/me")).status).toBe(401);
  });

  it("refuse app bearer tokens, even a platform admin's", async () => {
    const admin = await consoleAdmin(h, mailer, "super_admin", "bearer");
    const r = await admin.browser.req("GET", "/admin/v1/me", undefined, { authorization: `Bearer ${admin.account.accessToken}` });
    expect(r.status).toBe(401);
  });

  it("never carry the apps' CORS answer and are never cached", async () => {
    const r = await new AdminBrowser(h).req("GET", "/admin/v1/me", undefined, { origin: "https://web.example.test" });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("answer only listed networks when ADMIN_ALLOWED_NETWORKS is set", async () => {
    const fenced = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, ADMIN_ALLOWED_NETWORKS: "203.0.113.0/24" }, { mailer });
    try {
      const b = new AdminBrowser(fenced);
      expect((await b.req("GET", "/admin/v1/me")).status).toBe(403);
      b.ip = "203.0.113.9";
      expect((await b.req("GET", "/admin/v1/me")).status).toBe(401);
    } finally {
      await fenced.close();
    }
  });
});

describe("enrolment", () => {
  it("issues a one-time code from the CLI and turns it into a passkey and a session", async () => {
    const account = await plainAccount(h, mailer, "enrol");
    const { code, out } = await cli("platform-admin-grant", account.email, "support_admin", "on-call support");
    expect(code).toBe(0);
    const enrolCode = /([A-Z2-9]{5}-[A-Z2-9]{5})/.exec(out)![1];
    const b = new AdminBrowser(h);
    const wrong = await b.req("POST", "/admin/v1/auth/enrol/options", { email: account.email, password: account.password, code: "AAAAA-BBBBB" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("invalid_code");
    const { options } = await b.expect(200, "POST", "/admin/v1/auth/enrol/options", { email: account.email, password: account.password, code: enrolCode });
    expect(options.rp).toMatchObject({ id: ADMIN_HOST });
    expect(options.authenticatorSelection).toMatchObject({ userVerification: "required" });
    const key = new FakePasskey(ADMIN_HOST, ADMIN_ORIGIN);
    const r = await b.req("POST", "/admin/v1/auth/enrol", { response: key.create(options), name: "Laptop" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ account: { email: account.email }, role: "support_admin", passkeys: 1 });
    expect(r.body.permissions).toContain("users.suspend");
    expect(r.body.permissions).not.toContain("admins.manage");
    expect(lastAudit("admin.enrol")).toMatchObject({ outcome: "success", actor_account_id: account.accountId, actor_role: "support_admin" });
    const session = r.setCookies.find((c) => c.startsWith("__Host-mdq_admin="))!;
    expect(session).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Strict/);
    expect(session).not.toMatch(/Domain=/i);
    // Used up: the same code doesn't work twice.
    const again = await new AdminBrowser(h).req("POST", "/admin/v1/auth/enrol/options", { email: account.email, password: account.password, code: enrolCode });
    expect(again.status).toBe(400);
    expect(lastAudit("admin.enrol")).toMatchObject({ outcome: "failed", actor_account_id: account.accountId });
  });

  it("voids a code after five wrong tries", async () => {
    const account = await plainAccount(h, mailer, "fivewrong");
    const { out } = await cli("platform-admin-grant", account.email, "auditor");
    const enrolCode = /([A-Z2-9]{5}-[A-Z2-9]{5})/.exec(out)![1];
    const b = new AdminBrowser(h);
    b.ip = "198.51.100.20";
    for (let i = 0; i < 5; i++) await b.expect(400, "POST", "/admin/v1/auth/enrol/options", { email: account.email, password: account.password, code: "ZZZZZ-ZZZZZ" });
    await b.expect(400, "POST", "/admin/v1/auth/enrol/options", { email: account.email, password: account.password, code: enrolCode });
  });

  it("refuses accounts without a grant, with the same answer as a wrong password", async () => {
    const account = await plainAccount(h, mailer, "nogrant");
    const b = new AdminBrowser(h);
    b.ip = "198.51.100.21";
    const r = await b.req("POST", "/admin/v1/auth/enrol/options", { email: account.email, password: account.password, code: "AAAAA-BBBBB" });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("invalid_credentials");
  });
});

describe("signing in", () => {
  it("takes the password, then a console passkey", async () => {
    const admin = await consoleAdmin(h, mailer, "operations_admin", "ops");
    const b = await signIn(h, admin);
    const me = await b.expect(200, "GET", "/admin/v1/me");
    expect(AdminMe.safeParse(me).success).toBe(true);
    expect(me).toMatchObject({ role: "operations_admin", account: { email: admin.account.email } });
    expect(me.session.expiresAt - me.session.createdAt).toBe(8 * 3_600_000);
    expect(lastAudit("admin.login")).toMatchObject({ outcome: "success", actor_account_id: admin.account.accountId, target_type: "admin_session" });
  });

  it("gives one answer for an unknown address, a wrong password and an account that isn't an admin", async () => {
    const admin = await consoleAdmin(h, mailer, "auditor", "sameanswer");
    const plain = await plainAccount(h, mailer, "plainperson");
    const b = new AdminBrowser(h);
    b.ip = "198.51.100.30";
    const answers = [
      await b.req("POST", "/admin/v1/auth/password", { email: "nobody@example.test", password: "whatever-it-is" }),
      await b.req("POST", "/admin/v1/auth/password", { email: admin.account.email, password: "not the password" }),
      await b.req("POST", "/admin/v1/auth/password", { email: plain.email, password: plain.password }),
    ];
    for (const a of answers) expect([a.status, a.body.error.code, a.body.error.message]).toEqual([401, "invalid_credentials", answers[0].body.error.message]);
  });

  it("sends an admin without a console passkey to enrolment", async () => {
    const account = await plainAccount(h, mailer, "unenrolled");
    await cli("platform-admin-grant", account.email, "auditor");
    const r = await new AdminBrowser(h).req("POST", "/admin/v1/auth/password", { email: account.email, password: account.password });
    expect([r.status, r.body.error.code]).toEqual([403, "enrolment_required"]);
  });

  it("refuses another admin's passkey, a passkey from another site, a replayed or missing ceremony", async () => {
    const a = await consoleAdmin(h, mailer, "auditor", "keya");
    const other = await consoleAdmin(h, mailer, "auditor", "keyb");
    const b = new AdminBrowser(h);
    const step1 = () => b.expect(200, "POST", "/admin/v1/auth/password", { email: a.account.email, password: a.account.password });
    let { options } = await step1();
    expect((await b.req("POST", "/admin/v1/auth/passkey", { response: other.passkey.get(options) })).status).toBe(401);
    // A look-alike site relaying the challenge: the browser reports that site's origin (and its relying party).
    ({ options } = await step1());
    a.passkey.origin = "https://admin.example.test.evil.example";
    expect((await b.req("POST", "/admin/v1/auth/passkey", { response: a.passkey.get(options) })).status).toBe(401);
    a.passkey.origin = ADMIN_ORIGIN;
    ({ options } = await step1());
    expect((await b.req("POST", "/admin/v1/auth/passkey", { response: a.passkey.get(options, undefined, "evil.example") })).status).toBe(401);
    ({ options } = await step1());
    const answer = a.passkey.get(options);
    const pendingCookie = b.cookies.get("__Host-mdq_admin_pending")!;
    await b.expect(200, "POST", "/admin/v1/auth/passkey", { response: answer });
    b.cookies.set("__Host-mdq_admin_pending", pendingCookie);
    expect((await b.req("POST", "/admin/v1/auth/passkey", { response: answer })).body.error.code).toBe("challenge_expired");
    expect((await new AdminBrowser(h).req("POST", "/admin/v1/auth/passkey", { response: answer })).body.error.code).toBe("challenge_expired");
  });

  it("throttles repeated attempts from one network", async () => {
    const b = new AdminBrowser(h);
    b.ip = "198.51.100.40";
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await b.req("POST", "/admin/v1/auth/password", { email: `x${i}@example.test`, password: "wrong-password" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(lastAudit("admin.login")).toMatchObject({ outcome: "denied" });
  });
});

describe("sessions", () => {
  const expire = async (column: string, browser: AdminBrowser, h2 = h) => {
    const id = h2.ctx.ephemeral.get<{ id: string }>("platform_admin_sessions", {}, [["created_at", "desc"]])!.id;
    await h2.ctx.ephemeral.write((w) => w.update("platform_admin_sessions", { id }, { [column]: Date.now() - 1 }));
    return browser;
  };

  it("end on sign-out", async () => {
    const admin = await consoleAdmin(h, mailer, "auditor", "logout");
    await admin.browser.expect(200, "POST", "/admin/v1/auth/logout", {});
    expect(admin.browser.cookies.has("__Host-mdq_admin")).toBe(false);
    expect(lastAudit("admin.logout")).toMatchObject({ outcome: "success", actor_account_id: admin.account.accountId });
  });

  it("end when idle too long or past their lifetime", async () => {
    for (const column of ["idle_expires_at", "expires_at"]) {
      const admin = await consoleAdmin(h, mailer, "auditor", `expiry${column}`);
      await (await expire(column, admin.browser)).expect(401, "GET", "/admin/v1/me");
    }
  });

  it("end when the grant is revoked, the role changes, the account is disabled or its password changes", async () => {
    const revoked = await consoleAdmin(h, mailer, "auditor", "revoked");
    expect((await cli("platform-admin-revoke", revoked.account.email, "left the team")).code).toBe(0);
    await revoked.browser.expect(401, "GET", "/admin/v1/me");
    await expect(signIn(h, revoked)).rejects.toThrow(/401/);

    const promoted = await consoleAdmin(h, mailer, "auditor", "promoted");
    await cli("platform-admin-grant", promoted.account.email, "support_admin");
    await promoted.browser.expect(401, "GET", "/admin/v1/me");
    expect((await (await signIn(h, promoted)).expect(200, "GET", "/admin/v1/me")).role).toBe("support_admin");

    const disabled = await consoleAdmin(h, mailer, "auditor", "disabled");
    await accountRows(h).setAccount(disabled.account.accountId, { disabled_at: Date.now() });
    await disabled.browser.expect(401, "GET", "/admin/v1/me");

    const changed = await consoleAdmin(h, mailer, "auditor", "pwchange");
    await accountRows(h).setAccount(changed.account.accountId, { password_changed_at: Date.now() + 1000 });
    await changed.browser.expect(401, "GET", "/admin/v1/me");
    expect(lastAudit("admin.session_end")).toMatchObject({ actor_account_id: changed.account.accountId });
  });

  it("re-authenticate with the passkey for sensitive actions", async () => {
    const admin = await consoleAdmin(h, mailer, "super_admin", "stepup");
    const before = await admin.browser.expect(200, "GET", "/admin/v1/me");
    await h.ctx.ephemeral.write((w) => w.update("platform_admin_sessions", { id: before.session.id }, { reauth_at: 0 }));
    const { options } = await admin.browser.expect(200, "POST", "/admin/v1/auth/reauth/options", {});
    // A ceremony belongs to one session: another browser of the same admin can't use it.
    const elsewhere = await signIn(h, admin);
    elsewhere.cookies.set("__Host-mdq_admin_pending", admin.browser.cookies.get("__Host-mdq_admin_pending")!);
    expect((await elsewhere.req("POST", "/admin/v1/auth/reauth", { response: admin.passkey.get(options) })).status).toBe(401);
    const { options: again } = await admin.browser.expect(200, "POST", "/admin/v1/auth/reauth/options", {});
    const after = await admin.browser.expect(200, "POST", "/admin/v1/auth/reauth", { response: admin.passkey.get(again) });
    expect(after.session.reauthUntil).toBeGreaterThan(Date.now());
    expect(lastAudit("admin.reauth")).toMatchObject({ outcome: "success", actor_account_id: admin.account.accountId });
  });
});

describe("the CLI", () => {
  it("refuses unknown roles and accounts, lists grants and resets passkeys", async () => {
    const account = await plainAccount(h, mailer, "clirole");
    expect((await cli("platform-admin-grant", account.email, "owner")).code).toBe(1);
    expect((await cli("platform-admin-grant", "nobody@example.test", "auditor")).code).toBe(1);
    expect((await cli("platform-admin-grant", account.email)).code).toBe(2);
    const admin = await consoleAdmin(h, mailer, "auditor", "lostdevice");
    expect((await cli("platform-admin-list")).out).toContain(admin.account.accountId);
    const reset = await cli("platform-admin-reset-passkeys", admin.account.email, "phone lost");
    expect(reset.out).toMatch(/[A-Z2-9]{5}-[A-Z2-9]{5}/);
    expect(consoleStore(h).passkeys(admin.account.accountId)).toEqual([]);
    await admin.browser.expect(401, "GET", "/admin/v1/me");
  });
});

describe("the platform audit", () => {
  it("is append-only and never holds secrets", async () => {
    await consoleAdmin(h, mailer, "auditor", "auditrows");
    // In SQLite, triggers refuse changes; in MongoDB nothing in the server updates or deletes it, and the chain shows it.
    if (h.ctx.platform.backend === "sqlite") {
      expect(() => h.ctx.db.prepare("UPDATE platform_audit SET outcome = 'success'").run()).toThrow(/append-only/);
      expect(() => h.ctx.db.prepare("DELETE FROM platform_audit").run()).toThrow(/append-only/);
    }
    const all = JSON.stringify(h.ctx.platform.all("platform_audit"));
    expect(all).not.toMatch(/correct horse battery|__Host-|[A-Z2-9]{5}-[A-Z2-9]{5}|nobody@example\.test/);
  });

  it("detects an edited row by its hash chain", async () => {
    expect(consoleAudit(h).verify().brokenAt).toBeNull();
    expect((await cli("platform-audit-verify")).code).toBe(0);
    const target = h.ctx.platform.all<{ id: number }>("platform_audit", { orderBy: [["id", "asc"]], limit: 3 })[2]!.id;
    if (h.ctx.platform.backend === "mongodb") {
      // Edited in MongoDB behind the server's back: the CLI reads the collection and finds the break.
      const audit = h.ctx.mongo!.db.collection<{ _id: number; outcome: string; reason: string | null }>("platform_audit");
      const before = (await audit.findOne({ _id: target }))!;
      await audit.updateOne({ _id: target }, { $set: { outcome: "success", reason: "nothing to see" } });
      try {
        expect((await cli("platform-audit-verify")).code).toBe(1);
      } finally {
        await audit.updateOne({ _id: target }, { $set: { outcome: before.outcome, reason: before.reason } });
      }
      return;
    }
    const db = h.ctx.db;
    db.exec("DROP TRIGGER platform_audit_no_update");
    try {
      db.prepare("UPDATE platform_audit SET outcome = 'success', reason = 'nothing to see' WHERE id = ?").run(target);
      expect(consoleAudit(h).verify().brokenAt).toBe(target);
      expect((await cli("platform-audit-verify")).code).toBe(1);
    } finally {
      db.exec("CREATE TRIGGER platform_audit_no_update BEFORE UPDATE ON platform_audit BEGIN SELECT RAISE(ABORT, 'platform_audit is append-only'); END");
    }
  });
});
