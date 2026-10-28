import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWarning } from "../src/modules/accounts/standing.js";
import { fromBase32, stepAt, totpCode } from "../src/modules/accounts/totp.js";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * API 0.46.0 (docs/ACCOUNT_SAFETY.md): two-step sign-in with an authenticator app, changing the account's email,
 * account standing with what it limits, bug reports with the Bug Hunter badge, and About me and links.
 */
let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer({ PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex") }, { mailer });
});
afterAll(async () => h.close());

const codeAt = (secret: string, ms: number) => totpCode(fromBase32(secret), stepAt(ms));

describe("two-step sign-in", () => {
  it("is advertised and off at first", async () => {
    const c = await new AccountClient(h.baseUrl, email("tf0")).signUp(mailer);
    await c.signIn();
    expect(await c.req("GET", "/v2/account/totp")).toEqual({ available: true, enabled: false, enabledAt: null, backupCodesLeft: 0 });
  });

  it("turns on with the password and the app's first code, then every password sign-in needs a code", async () => {
    const c = await new AccountClient(h.baseUrl, email("tf1")).signUp(mailer);
    await c.signIn();
    await expectStatus(c.req("POST", "/v2/account/totp/setup", { password: "not the password at all" }), 401);
    const { secret, uri } = await c.req("POST", "/v2/account/totp/setup", { password: PASSWORD });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Meldiq:/);
    expect(uri).toContain(`secret=${secret}`);
    // Not on until a code comes back; a wrong one is refused.
    await c.signIn();
    expect((await expectStatus(c.req("POST", "/v2/account/totp/enable", { code: "000000" }), 400)).error.code).toBe("totp_invalid");
    const { backupCodes } = await c.req("POST", "/v2/account/totp/enable", { code: codeAt(secret, Date.now()) });
    expect(backupCodes).toHaveLength(10);
    expect(mailer.lastSubject(c.email)).toMatch(/Two-step sign-in is on/);
    expect(await c.req("GET", "/v2/account/totp")).toMatchObject({ enabled: true, backupCodesLeft: 10 });

    const login = (extra: object) => c.req("POST", "/v2/auth/login", { email: c.email, password: PASSWORD, ...extra });
    expect((await expectStatus(login({}), 401)).error.code).toBe("totp_required");
    expect((await expectStatus(login({ totpCode: "123456" }), 401)).error.code).toBe("totp_invalid");
    // The next step's code (the one the app shows after this one): accepted, and only once.
    const next = codeAt(secret, Date.now() + 30_000);
    expect((await login({ totpCode: next })).accessToken).toBeTruthy();
    expect((await expectStatus(login({ totpCode: next }), 401)).error.code).toBe("totp_invalid");
    // A backup code works once.
    expect((await login({ totpCode: backupCodes[0] })).accessToken).toBeTruthy();
    await expectStatus(login({ totpCode: backupCodes[0] }), 401);
  });

  it("pauses after too many wrong codes, and turns off with the password and a code", async () => {
    const c = await new AccountClient(h.baseUrl, email("tf2")).signUp(mailer);
    await c.signIn();
    const { secret } = await c.req("POST", "/v2/account/totp/setup", { password: PASSWORD });
    const { backupCodes } = await c.req("POST", "/v2/account/totp/enable", { code: codeAt(secret, Date.now()) });
    await expectStatus(c.req("POST", "/v2/account/totp/disable", { password: PASSWORD, code: "111111" }), 401);
    await c.req("POST", "/v2/account/totp/disable", { password: PASSWORD, code: backupCodes[1] });
    expect((await c.req("GET", "/v2/account/totp")).enabled).toBe(false);
    expect(mailer.lastSubject(c.email)).toMatch(/turned off/);
    expect((await c.req("POST", "/v2/auth/login", { email: c.email, password: PASSWORD })).accessToken).toBeTruthy();

    const d = await new AccountClient(h.baseUrl, email("tf3")).signUp(mailer);
    await d.signIn();
    const s2 = await d.req("POST", "/v2/account/totp/setup", { password: PASSWORD });
    await d.req("POST", "/v2/account/totp/enable", { code: codeAt(s2.secret, Date.now()) });
    for (let i = 0; i < 5; i++) await expectStatus(d.req("POST", "/v2/auth/login", { email: d.email, password: PASSWORD, totpCode: "999999" }), 401);
    const locked = await expectStatus(d.req("POST", "/v2/auth/login", { email: d.email, password: PASSWORD, totpCode: codeAt(s2.secret, Date.now() + 30_000) }), 429);
    expect(locked.error.code).toBe("totp_locked");
  });

  it("keeps the secret sealed in the database", async () => {
    const rows = h.ctx.safety.all<{ secret: string }>("account_totp");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.secret).toMatch(/^v1\./);
  });
});

describe("changing the email", () => {
  it("sends a code to the new address, changes on the code, and tells the old one", async () => {
    const c = await new AccountClient(h.baseUrl, email("ec1")).signUp(mailer);
    await c.signIn();
    const next = email("ec1new");
    await expectStatus(c.req("POST", "/v2/account/email", { password: "wrong password here", newEmail: next }), 401);
    const started = await c.req("POST", "/v2/account/email", { password: PASSWORD, newEmail: next });
    expect(started.email).not.toBe(next); // masked
    const code = mailer.sent.filter((m) => m.to === next).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
    expect(code).toBeTruthy();
    await expectStatus(c.req("POST", "/v2/account/email/confirm", { code: code === "000000" ? "111111" : "000000" }), 400);
    expect(await c.req("POST", "/v2/account/email/confirm", { code })).toEqual({ email: next });
    expect(mailer.lastSubject(c.email)).toMatch(/email was changed/);
    // The new address signs in; the old one doesn't.
    expect((await c.req("POST", "/v2/auth/login", { email: next, password: PASSWORD })).accessToken).toBeTruthy();
    await expectStatus(c.req("POST", "/v2/auth/login", { email: c.email, password: PASSWORD }), 401);
  });

  it("answers the same for an address that already has an account, and tells that address instead of sending a code", async () => {
    const a = await new AccountClient(h.baseUrl, email("ec2")).signUp(mailer);
    const b = await new AccountClient(h.baseUrl, email("ec3")).signUp(mailer);
    await a.signIn();
    const started = await a.req("POST", "/v2/account/email", { password: PASSWORD, newEmail: b.email });
    expect(started).toMatchObject({ expiresAt: expect.any(Number) });
    expect(mailer.lastSubject(b.email)).toMatch(/already has a Meldiq account/);
    await expectStatus(a.req("POST", "/v2/account/email/confirm", { code: "123456" }), 400);
  });
});

describe("account standing", () => {
  let warned: GriipClient, friend: GriipClient;
  beforeAll(async () => {
    [warned, friend] = await Promise.all([h.client("warned"), h.client("friend")]);
  });

  it("limits more with each active warning, and an expired or lifted one stops counting", async () => {
    const org = (await friend.req("POST", "/v1/orgs", { name: "Standing Lab" })).org;
    const code = (await friend.req("POST", `/v1/orgs/${org.id}/invites`, { role: "MEMBER", maxUses: 5 })).invite.code;
    // One warning: no new communities or invitations, but joining and messaging still work.
    await addWarning(h.ctx.safety, warned.userId, "Spam in #general", 14, "test");
    expect((await expectStatus(warned.req("POST", "/v1/orgs", { name: "Nope" }), 403)).error.code).toBe("account_limited");
    await warned.req("POST", "/v1/invites/accept", { code });
    await expectStatus(warned.req("POST", `/v1/orgs/${org.id}/invites`, { role: "MEMBER", maxUses: 1 }), 403);
    const dm = (await warned.req("POST", "/v1/conversations/dm", { userId: friend.userId })).conversation.id;
    // Two: no new conversations (an existing one still opens).
    await addWarning(h.ctx.safety, warned.userId, "Spam again", 14, "test");
    const other = await h.client("other");
    await expectStatus(warned.req("POST", "/v1/conversations/dm", { userId: other.userId }), 403);
    expect((await warned.req("POST", "/v1/conversations/dm", { userId: friend.userId })).conversation.id).toBe(dm);
    // Three: suspended, so no messages either.
    const third = await addWarning(h.ctx.safety, warned.userId, "Third time", 14, "test");
    await expectStatus(warned.send(dm, { type: "text", text: "hello" }), 403);
    // Lifting one brings sending back.
    await h.ctx.safety.write((w) => w.update("account_warnings", { id: third.id }, { revoked_at: Date.now() }));
    await warned.send(dm, { type: "text", text: "hello again" });
    // Expired warnings don't count.
    await h.ctx.safety.write((w) => w.update("account_warnings", { user_id: warned.userId }, { expires_at: Date.now() - 1 }));
    await warned.req("POST", "/v1/orgs", { name: "Back in good standing" });
  });

  it("shows the account its standing and the reasons", async () => {
    const c = await new AccountClient(h.baseUrl, email("st1")).signUp(mailer);
    await c.signIn();
    await c.setUpIdentity();
    expect(await c.req("GET", "/v2/account/standing")).toEqual({ level: "good", warnings: [] });
    await addWarning(h.ctx.safety, c.userId!, "Harassment report upheld", 7, "test");
    const st = await c.req("GET", "/v2/account/standing");
    expect(st.level).toBe("limited");
    expect(st.warnings[0]).toMatchObject({ reason: "Harassment report upheld", expiresAt: expect.any(Number) });
  });
});

describe("bug reports and profile additions", () => {
  it("takes a report, lists it to its reporter, and a confirmed one earns the Bug Hunter badge", async () => {
    const [ada, eve] = await Promise.all([h.client("bugada"), h.client("bugeve")]);
    await expectStatus(ada.req("POST", "/v1/bug-reports", { summary: "x", details: "short" }), 400);
    const { report } = await ada.req("POST", "/v1/bug-reports", { summary: "Menu doesn't close", details: "Right-click, then Escape: the menu stays open.", page: "/home" });
    expect(report).toMatchObject({ status: "open", page: "/home", staffNote: null });
    expect((await ada.req("GET", "/v1/bug-reports")).reports).toHaveLength(1);
    expect((await eve.req("GET", "/v1/bug-reports")).reports).toHaveLength(0);
    expect((await eve.req("GET", `/v1/users/${ada.userId}`)).user.badges).toBeUndefined();
    await h.ctx.safety.write((w) => w.update("bug_reports", { id: report.id }, { status: "confirmed" }));
    expect((await ada.req("GET", "/v1/bug-reports")).bugHunter).toBe(true);
    expect((await eve.req("GET", `/v1/users/${ada.userId}`)).user.badges).toEqual(["bug-hunter"]);
  });

  it("keeps About me and https links, shown under the bio's setting", async () => {
    const [ada, eve] = await Promise.all([h.client("abada"), h.client("abeve")]);
    await expectStatus(ada.req("PATCH", "/v1/users/me", { links: [{ label: "Site", url: "javascript:alert(1)" }] }), 400);
    await expectStatus(ada.req("PATCH", "/v1/users/me", { aboutMe: "x".repeat(301) }), 400);
    await ada.req("PATCH", "/v1/users/me", { aboutMe: "I build things.", links: [{ label: "YouTube", url: "https://youtube.com/@ada" }] });
    expect((await eve.req("GET", `/v1/users/${ada.userId}`)).user).toMatchObject({ aboutMe: "I build things.", links: [{ label: "YouTube", url: "https://youtube.com/@ada" }] });
    // Another change leaves them alone; null clears them.
    await ada.req("PATCH", "/v1/users/me", { displayName: "Ada L" });
    expect((await eve.req("GET", `/v1/users/${ada.userId}`)).user.aboutMe).toBe("I build things.");
    await ada.req("PATCH", "/v1/users/me", { aboutMe: null, links: null });
    expect((await eve.req("GET", `/v1/users/${ada.userId}`)).user.aboutMe).toBeUndefined();
    await ada.req("PUT", "/v1/users/me/privacy", { bio: "nobody" });
    await ada.req("PATCH", "/v1/users/me", { aboutMe: "Hidden" });
    expect((await eve.req("GET", `/v1/users/${ada.userId}`)).user.aboutMe).toBeUndefined();
  });
});
