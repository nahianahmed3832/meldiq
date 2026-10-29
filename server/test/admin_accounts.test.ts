import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { staticCodeMatches, staticCodeHash } from "../src/modules/accounts/operatorAccounts.js";
import { AdminAccountCreated, AdminCreatedAccountsPage } from "../src/shared/contracts/http/platformAdminInsights.js";
import { email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Accounts made in the Platform Admin Console (docs/ADMIN_ACCOUNTS.md): an operator creates an account and chooses how
 * it proves its email — at once, with a fixed tester code, or with the normal emailed code. Public sign-up can never take
 * such an account over, and every creation needs accounts.create, a fresh passkey check and a reason, and is audited.
 */
let h: Harness;
const mailer = new MemoryMailer();
const admins: Record<string, ConsoleAdmin> = {};
const REASON = { reason: "Closed testing before the store release" };

beforeAll(async () => {
  h = await startServer({ ADMIN_CONSOLE_ORIGIN: "https://admin.example.test", TELEMETRY_TICK_MS: "0" }, { mailer });
  for (const role of ["super_admin", "operations_admin", "support_admin", "auditor"]) admins[role] = await consoleAdmin(h, mailer, role, `acc${role}`);
});
afterAll(async () => h.close());

const as = (role: string) => admins[role]!.browser;
const lastAudit = (action: string) => h.ctx.platform.get<any>("platform_audit", { action }, [["id", "desc"]]);

async function app(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${h.baseUrl}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = (address: string, password: string) => app("POST", "/v2/auth/login", { email: address, password, deviceName: "test phone" });
const verify = (address: string, code: string, password: string) => app("POST", "/v2/auth/email/verify", { email: address, code, password });
const create = (body: Record<string, unknown>, role = "super_admin", status = 200) => as(role).expect(status, "POST", "/admin/v1/accounts", { name: "Test Person", ...body, ...REASON });
const sentTo = (address: string) => mailer.sent.filter((m) => m.to === address).length;

describe("creating accounts", () => {
  it("verified: signs in at once with the generated password, shown only once, and no email is sent", async () => {
    const address = email("ready");
    const r = await create({ email: address, verification: "verified", tester: true });
    expect(AdminAccountCreated.safeParse(r).success).toBe(true);
    expect(r.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(r.account).toMatchObject({ email: address, verification: "verified", verified: true, tester: true, exists: true, userId: null });
    expect(sentTo(address)).toBe(0);
    const signedIn = await login(address, r.password);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.accessToken).toEqual(expect.any(String));
    expect(lastAudit("account.create")).toMatchObject({ target_id: r.account.accountId, reason: REASON.reason });
    // The password isn't stored in the clear, nor in the audit trail.
    expect(JSON.stringify(lastAudit("account.create"))).not.toContain(r.password);
  });

  it("static code: the app asks for the code, the fixed code verifies it (with the password), and no email is ever sent", async () => {
    const address = email("tester");
    const r = await create({ email: address, password: PASSWORD, verification: "static_code", staticCode: "246810" });
    expect(r.password).toBeNull();
    const first = await login(address, PASSWORD);
    expect(first.status).toBe(403);
    expect(first.body.error.code).toBe("email_unverified");
    // Asking the app to send the code again sends nothing: a tester's address may not receive mail.
    await app("POST", "/v2/auth/email/resend", { email: address });
    expect(sentTo(address)).toBe(0);
    expect((await verify(address, "111111", PASSWORD)).status).toBe(400);
    expect((await verify(address, "246810", "not the password at all")).status).toBe(400);
    expect((await verify(address, "246-810", PASSWORD)).status).toBe(200);
    expect((await login(address, PASSWORD)).status).toBe(200);
  });

  it("email: the normal emailed code is sent, and only that code verifies", async () => {
    const address = email("normal");
    const r = await create({ email: address, password: PASSWORD, verification: "email" });
    expect(r.codeSent).toBe(true);
    expect((await login(address, PASSWORD)).body.error.code).toBe("email_unverified");
    expect((await verify(address, mailer.verifyCode(address), PASSWORD)).status).toBe(200);
    expect((await login(address, PASSWORD)).status).toBe(200);
  });

  it("works while public sign-ups are closed, and refuses duplicates, weak passwords and mismatched codes", async () => {
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/signups", { value: { mode: "closed" }, ...REASON });
    const address = email("closed");
    await create({ email: address, verification: "verified" });
    await as("super_admin").expect(200, "PUT", "/admin/v1/controls/signups", { value: { mode: "environment" }, ...REASON });
    await create({ email: address, verification: "verified" }, "super_admin", 409);
    await create({ email: email("weak"), password: "password", verification: "verified" }, "super_admin", 400);
    await create({ email: email("nocode"), verification: "static_code" }, "super_admin", 400);
    await create({ email: email("extra"), verification: "verified", staticCode: "123456" }, "super_admin", 400);
    await create({ email: email("short"), verification: "static_code", staticCode: "123" }, "super_admin", 400);
    await as("super_admin").expect(400, "POST", "/admin/v1/accounts", { name: "No Reason", email: email("noreason"), verification: "verified" });
  });

  it("is for super and operations admins only; everyone who sees people sees the list, emails only with users.view_email", async () => {
    await create({ email: email("ops"), verification: "verified" }, "operations_admin");
    await create({ email: email("support"), verification: "verified" }, "support_admin", 403);
    await create({ email: email("auditor"), verification: "verified" }, "auditor", 403);
    const page = await as("auditor").expect(200, "GET", "/admin/v1/accounts?limit=2");
    expect(AdminCreatedAccountsPage.safeParse(page).success).toBe(true);
    expect(page.accounts).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = await as("super_admin").expect(200, "GET", `/admin/v1/accounts?limit=2&cursor=${page.nextCursor}`);
    expect(next.accounts[0].accountId).not.toBe(page.accounts[0].accountId);
    expect(next.accounts[0].email).toContain("@");
  });
});

describe("protection and changes", () => {
  it("a public sign-up can't take over an operator's account, even knowing the tester code", async () => {
    const address = email("held");
    await create({ email: address, password: PASSWORD, verification: "static_code", staticCode: "135790" });
    const attacker = "an entirely different password 9!";
    expect((await app("POST", "/v2/auth/register", { name: "Someone Else", email: address, password: attacker })).status).toBe(202);
    expect((await verify(address, "135790", attacker)).status).toBe(400);
    expect((await verify(address, "135790", PASSWORD)).status).toBe(200);
  });

  it("changing the verification: from a fixed code to verified signs in at once; a code's end must be in the future", async () => {
    const address = email("switch");
    const r = await create({ email: address, password: PASSWORD, verification: "static_code", staticCode: "975310" });
    const id = r.account.accountId;
    await as("super_admin").expect(400, "PUT", `/admin/v1/accounts/${id}/verification`, { verification: "static_code", staticCode: "111222", codeExpiresAt: Date.now() - 1000, ...REASON });
    const changed = await as("operations_admin").expect(200, "PUT", `/admin/v1/accounts/${id}/verification`, { verification: "verified", ...REASON });
    expect(changed.account).toMatchObject({ verification: "verified", verified: true });
    expect(lastAudit("account.verification")).toMatchObject({ target_id: id, reason: REASON.reason });
    expect((await login(address, PASSWORD)).status).toBe(200);
    await as("support_admin").expect(403, "PUT", `/admin/v1/accounts/${id}/verification`, { verification: "email", ...REASON });
    await as("super_admin").expect(404, "PUT", `/admin/v1/accounts/acc_nope/verification`, { verification: "email", ...REASON });
  });

  it("a fixed code stops working when it ends", () => {
    const t = Date.now();
    const row = { account_id: "acc_x", verification: "static_code" as const, code_hash: staticCodeHash("acc_x", "123456"), code_expires_at: t + 1000, tester: 1, note: null, created_by: "a", created_at: t, updated_by: "a", updated_at: t };
    expect(staticCodeMatches(row, "acc_x", "123456", t)).toBe(true);
    expect(staticCodeMatches(row, "acc_x", "123456", t + 1000)).toBe(false);
    expect(staticCodeMatches(row, "acc_y", "123456", t)).toBe(false);
    expect(staticCodeMatches({ ...row, verification: "email", code_hash: null }, "acc_x", "123456", t)).toBe(false);
  });
});
