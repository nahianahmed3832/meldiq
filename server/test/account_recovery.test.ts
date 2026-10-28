import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer({}, { mailer });
});
afterAll(async () => h.close());

const NEW_PASSWORD = "a brand new passphrase";

/** The 6-digit code sent to [to] to confirm it as the account's new address. */
function recoveryEmailCode(to: string): string {
  const m = [...mailer.sent].reverse().find((x) => x.to === to && /confirms your new Meldiq email/.test(x.subject));
  const code = m?.subject.match(/^(\d{6})/)?.[1];
  if (!code) throw new Error(`no recovery code sent to ${to}`);
  return code;
}

async function withCodes(name: string): Promise<{ c: AccountClient; codes: string[] }> {
  const c = await new AccountClient(h.baseUrl, email(name)).signUp(mailer);
  await c.signIn();
  const r = await c.req("POST", "/v2/account/recovery-codes", { password: PASSWORD });
  return { c, codes: r.codes };
}

const anon = (addr: string) => new AccountClient(h.baseUrl, addr);

describe("account recovery codes", () => {
  it("advertises the feature", async () => {
    const info = await anon(email("info")).req("GET", "/v1/server-info");
    expect(info.features).toContain("recovery-codes");
  });

  it("creates ten single-use codes shown once, stored hashed, and reports how many are left", async () => {
    const { c, codes } = await withCodes("make");
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Set(codes).size).toBe(10);
    const status = await c.req("GET", "/v2/account/recovery-codes");
    expect(status).toMatchObject({ remaining: 10, total: 10 });
    expect(status.codes).toBeUndefined();
    // Through the store, so this holds for SQLite and MongoDB alike.
    const rows = await h.ctx.accounts.recovery.store.codes(c.accountId);
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);
      for (const code of codes) expect(r.code_hash).not.toContain(code.replace(/-/g, ""));
    }
    expect(mailer.lastSubject(c.email)).toMatch(/New recovery codes/);
  });

  it("needs the password to make or revoke codes", async () => {
    const c = await new AccountClient(h.baseUrl, email("pw")).signUp(mailer);
    await c.signIn();
    await expectStatus(c.req("POST", "/v2/account/recovery-codes", { password: "not my password" }), 401);
    await c.req("POST", "/v2/account/recovery-codes", { password: PASSWORD });
    await expectStatus(c.req("POST", "/v2/account/recovery-codes/revoke", { password: "nope nope nope" }), 401);
    await c.req("POST", "/v2/account/recovery-codes/revoke", { password: PASSWORD });
    expect(await c.req("GET", "/v2/account/recovery-codes")).toMatchObject({ remaining: 0, total: 0, createdAt: null });
  });

  it("recovers an account with a code and a new address, then signs every session out", async () => {
    const { c, codes } = await withCodes("lost");
    const oldEmail = c.email;
    const newEmail = email("found");
    // Codes are accepted without dashes and in lower case.
    const start = await anon(oldEmail).req("POST", "/v2/auth/recover/start", { email: oldEmail, code: codes[3].replace(/-/g, "").toLowerCase(), newEmail });
    expect(start.email).toBe(newEmail);
    expect(typeof start.ticket).toBe("string");
    const done = await anon(newEmail).req("POST", "/v2/auth/recover/complete", { ticket: start.ticket, code: recoveryEmailCode(newEmail), newPassword: NEW_PASSWORD });
    expect(done).toEqual({ email: newEmail, remainingCodes: 9 });
    // The old session is gone; the old address and password no longer sign in; the new ones do.
    await expectStatus(c.req("GET", "/v2/account"), 401);
    await expectStatus(new AccountClient(h.baseUrl, oldEmail, PASSWORD).signIn(), 401);
    const back = new AccountClient(h.baseUrl, newEmail, NEW_PASSWORD);
    const s = await back.signIn();
    expect(s.account.id).toBe(c.accountId);
    expect(s.account.email).toBe(newEmail);
    // The old address is told; the audit trail records it without the code.
    expect(mailer.lastSubject(oldEmail)).toMatch(/email was changed/);
    const audit = h.ctx.ws
      .all<{ action: string; detail: string }>("audit_log", { where: { target: c.accountId }, orderBy: [["id", "asc"]] })
      .filter((a) => a.action.startsWith("account.recover"))
      .map(({ action, detail }) => ({ action, detail }));
    expect(audit.map((a) => a.action)).toEqual(["account.recovery_codes_created", "account.recovery_started", "account.recovered"]);
    for (const a of audit) for (const code of codes) expect(a.detail ?? "").not.toContain(code);
  });

  it("refuses a code that was already used, even for a second recovery", async () => {
    const { c, codes } = await withCodes("reuse");
    const first = await anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: codes[0], newEmail: email("reuse-a") });
    expect(first.ticket).toBeTruthy();
    const again = await expectStatus(anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: codes[0], newEmail: email("reuse-b") }), 400);
    expect(again.error.code).toBe("invalid_recovery");
  });

  it("gives one answer for an unknown address, a wrong code and a revoked set", async () => {
    const { c, codes } = await withCodes("same");
    const unknown = await expectStatus(anon("nobody@example.test").req("POST", "/v2/auth/recover/start", { email: email("nobody"), code: "AAAA-BBBB-CCCC", newEmail: email("x") }), 400);
    const wrong = await expectStatus(anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: "AAAA-BBBB-CCCC", newEmail: email("y") }), 400);
    expect(unknown.error).toEqual(wrong.error);
    // A new set revokes the old one.
    await c.req("POST", "/v2/account/recovery-codes", { password: PASSWORD });
    const revoked = await expectStatus(anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: codes[1], newEmail: email("z") }), 400);
    expect(revoked.error).toEqual(wrong.error);
  });

  it("throttles wrong codes per address", async () => {
    const { c } = await withCodes("throttle");
    for (let i = 0; i < 5; i++) await expectStatus(anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: `WRNG-CODE-${i}AAA`, newEmail: email("t") }), 400);
    const limited = await expectStatus(anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: "WRNG-CODE-ZZZZ", newEmail: email("t") }), 429);
    expect(limited.error.code).toBe("recovery_throttled");
  });

  it("rejects a wrong email code (five tries), a reused ticket and an address another account uses", async () => {
    const { c, codes } = await withCodes("ticket");
    const taken = await new AccountClient(h.baseUrl, email("taken")).signUp(mailer);
    const inUse = await expectStatus(anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: codes[0], newEmail: taken.email }), 409);
    expect(inUse.error.code).toBe("email_in_use");
    // A refused address doesn't use the code up.
    const newEmail = email("ticket-new");
    const start = await anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: codes[0], newEmail });
    const right = recoveryEmailCode(newEmail);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expectStatus(anon(newEmail).req("POST", "/v2/auth/recover/complete", { ticket: start.ticket, code: wrong, newPassword: NEW_PASSWORD }), 400);
    // Used up: even the right code is refused now.
    await expectStatus(anon(newEmail).req("POST", "/v2/auth/recover/complete", { ticket: start.ticket, code: right, newPassword: NEW_PASSWORD }), 400);
    // A fresh recovery with another code works once, and its ticket can't be replayed.
    const newEmail2 = email("ticket-new2");
    const start2 = await anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: codes[1], newEmail: newEmail2 });
    const code2 = recoveryEmailCode(newEmail2);
    await anon(newEmail2).req("POST", "/v2/auth/recover/complete", { ticket: start2.ticket, code: code2, newPassword: NEW_PASSWORD });
    await expectStatus(anon(newEmail2).req("POST", "/v2/auth/recover/complete", { ticket: start2.ticket, code: code2, newPassword: NEW_PASSWORD }), 400);
  });

  it("checks the new password like any other", async () => {
    const { c, codes } = await withCodes("weak");
    const newEmail = email("weak-new");
    const start = await anon(c.email).req("POST", "/v2/auth/recover/start", { email: c.email, code: codes[0], newEmail });
    const weak = await expectStatus(anon(newEmail).req("POST", "/v2/auth/recover/complete", { ticket: start.ticket, code: recoveryEmailCode(newEmail), newPassword: "short" }), 400);
    expect(weak.error.code).toBe("weak_password");
  });
});
