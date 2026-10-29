import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertOperatorAccount, type OperatorVerification, staticCodeHash } from "../src/modules/accounts/operatorAccounts.js";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { newEd25519, newX25519 } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer({}, { mailer });
});
afterAll(async () => h.close());

const ITERATIONS = 600_000;
const NEW_PASSWORD = "a brand new passphrase";

/**
 * The clients' format (docs/KEY_BACKUP.md): PBKDF2-HMAC-SHA256 of the password, AES-256-GCM over the 32-byte seed with
 * associated data naming the account and identity. The server never opens it; this only makes a realistic one.
 */
function seal(password: string, accountId: string, identityKey: string, seed: Buffer = crypto.randomBytes(32)) {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt, ITERATIONS, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(`meldiq-key-backup-v1\n${accountId}\n${identityKey}`, "utf8"));
  const ciphertext = Buffer.concat([c.update(seed), c.final(), c.getAuthTag()]);
  return { version: 1, iterations: ITERATIONS, salt: salt.toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), identityKey };
}

/** The 6-digit code last emailed to [to] for setting up a new device. */
function unlockCode(to: string): string {
  const m = [...mailer.sent].reverse().find((x) => x.to === to && /code to set up Meldiq on a new device/.test(x.subject));
  const code = m?.subject.match(/^(\d{6})/)?.[1];
  if (!code) throw new Error(`no unlock code sent to ${to}`);
  return code;
}

/** An account whose first phone has backed up its keys. */
async function backedUp(name: string) {
  const c = await AccountClient.ready(h.baseUrl, mailer, name);
  const backup = seal(PASSWORD, c.accountId, c.identityKeyB64);
  await c.req("PUT", "/v2/account/key-backup", { password: PASSWORD, backup });
  return { c, backup };
}

/** The same account signed in on a phone with no keys yet. */
async function newPhone(c: AccountClient, password = PASSWORD): Promise<AccountClient> {
  const p = new AccountClient(h.baseUrl, c.email, password, c.name);
  await p.signIn();
  return p;
}

describe("keys backed up under the password", () => {
  it("advertises the feature", async () => {
    const info = await new AccountClient(h.baseUrl, email("info")).req("GET", "/v1/server-info");
    expect(info.features).toContain("key-backup");
  });

  it("is saved from a device of the account with the password, and only for its current identity", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "save");
    expect(await c.req("GET", "/v2/account/key-backup")).toEqual({ exists: false, updatedAt: null });
    const backup = seal(PASSWORD, c.accountId, c.identityKeyB64);
    await expectStatus(c.req("PUT", "/v2/account/key-backup", { password: "not my password!", backup }), 401);
    const wrongIdentity = { ...backup, identityKey: new AccountClient(h.baseUrl, email("other")).identityKeyB64 };
    expect((await expectStatus(c.req("PUT", "/v2/account/key-backup", { password: PASSWORD, backup: wrongIdentity }), 409)).error.code).toBe("identity_mismatch");
    await expectStatus(c.req("PUT", "/v2/account/key-backup", { password: PASSWORD, backup: { ...backup, iterations: 1000 } }), 400);
    const r = await c.req("PUT", "/v2/account/key-backup", { password: PASSWORD, backup });
    expect(typeof r.updatedAt).toBe("number");
    expect(await c.req("GET", "/v2/account/key-backup")).toEqual({ exists: true, updatedAt: r.updatedAt });
  });

  it("can't be written by a session without a device (a password and an access token aren't enough)", async () => {
    const { c, backup } = await backedUp("nodevice");
    const p = await newPhone(c);
    expect((await expectStatus(p.req("PUT", "/v2/account/key-backup", { password: PASSWORD, backup }), 403)).error.code).toBe("device_required");
    await expectStatus(p.req("DELETE", "/v2/account/key-backup"), 403);
  });

  it("gives a new phone the sealed keys after the emailed code, once", async () => {
    const { c, backup } = await backedUp("unlock");
    const p = await newPhone(c);
    expect(await p.req("GET", "/v2/account/key-backup")).toMatchObject({ exists: true });
    const start = await p.req("POST", "/v2/account/key-backup/unlock/start");
    expect(start.email).not.toBe(c.email);
    expect(start.email).toMatch(/\*/);
    const code = unlockCode(c.email);
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", { code: wrong }), 400)).error.code).toBe("invalid_code");
    // Another session of the same account can't use this session's code.
    const q = await newPhone(c);
    await expectStatus(q.req("POST", "/v2/account/key-backup/unlock", { code }), 400);
    const got = await p.req("POST", "/v2/account/key-backup/unlock", { code });
    expect(got).toEqual(backup);
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", { code }), 400);
    const audit = h.ctx.ws
      .all<{ action: string; detail: string | null }>("audit_log", { where: { target: c.accountId }, orderBy: [["id", "asc"]] })
      .filter((a) => a.action.startsWith("account.key_"))
      .map(({ action, detail }) => ({ action, detail }));
    expect(audit.map((a) => a.action)).toEqual(["account.key_backup_saved", "account.key_unlock_started", "account.key_unlocked"]);
    for (const a of audit) expect(a.detail ?? "").not.toContain(code);
  });

  it("stops a code after too many wrong tries", async () => {
    const { c } = await backedUp("tries");
    const p = await newPhone(c);
    await p.req("POST", "/v2/account/key-backup/unlock/start");
    const code = unlockCode(c.email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < h.ctx.config.accounts.codeMaxAttempts; i++) await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", { code: wrong }), 400);
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", { code }), 400);
  });

  it("sends nothing when there is no backup, so the app offers the recovery key instead", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "none");
    const p = await newPhone(c);
    const before = mailer.sent.length;
    expect((await expectStatus(p.req("POST", "/v2/account/key-backup/unlock/start"), 404)).error.code).toBe("no_key_backup");
    expect(mailer.sent.length).toBe(before);
  });

  it("goes stale when the password is reset", async () => {
    const { c } = await backedUp("reset");
    await c.req("POST", "/v2/auth/password/forgot", { email: c.email });
    await c.req("POST", "/v2/auth/password/reset", { email: c.email, code: mailer.resetCode(c.email), newPassword: NEW_PASSWORD });
    const p = await newPhone(c, NEW_PASSWORD);
    expect(await p.req("GET", "/v2/account/key-backup")).toEqual({ exists: false, updatedAt: null });
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock/start"), 404);
  });

  it("survives a password change when the keys are sealed again under the new password, and not otherwise", async () => {
    const { c } = await backedUp("change");
    const resealed = seal(NEW_PASSWORD, c.accountId, c.identityKeyB64);
    expect(await c.req("POST", "/v2/account/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, keyBackup: resealed })).toEqual({ ok: true, keyBackup: true });
    const p = await newPhone(c, NEW_PASSWORD);
    await p.req("POST", "/v2/account/key-backup/unlock/start");
    expect(await p.req("POST", "/v2/account/key-backup/unlock", { code: unlockCode(c.email) })).toEqual(resealed);

    const { c: d } = await backedUp("change2");
    expect(await d.req("POST", "/v2/account/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).toEqual({ ok: true, keyBackup: false });
    expect(await d.req("GET", "/v2/account/key-backup")).toMatchObject({ exists: false });
  });

  it("refuses a password change whose new backup is of other keys, before changing anything", async () => {
    const { c } = await backedUp("change3");
    const other = new AccountClient(h.baseUrl, email("x"));
    const bad = seal(NEW_PASSWORD, c.accountId, other.identityKeyB64);
    await expectStatus(c.req("POST", "/v2/account/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, keyBackup: bad }), 409);
    await newPhone(c, PASSWORD);
    expect(await c.req("GET", "/v2/account/key-backup")).toMatchObject({ exists: true });
  });

  it("goes stale when the account starts fresh with a new identity", async () => {
    const { c } = await backedUp("fresh");
    const lost = await newPhone(c);
    lost.device = newEd25519();
    lost.enc = newX25519();
    await lost.req("POST", "/v2/account/identity/reset", await lost.deviceBody("register", { password: PASSWORD, identityKey: lost.identityKeyB64 }));
    expect(await lost.req("GET", "/v2/account/key-backup")).toMatchObject({ exists: false });
  });

  it("is turned off from a device, and removed with the account", async () => {
    const { c } = await backedUp("off");
    await c.req("DELETE", "/v2/account/key-backup");
    expect(await c.req("GET", "/v2/account/key-backup")).toMatchObject({ exists: false });

    const { c: d } = await backedUp("gone");
    const p = await newPhone(d);
    await p.req("POST", "/v2/account/key-backup/unlock/start");
    await d.req("DELETE", "/v2/account", { password: PASSWORD, confirmEmail: d.email });
    expect(await h.ctx.accounts.keyBackups.store.backup(d.accountId)).toBeUndefined();
    expect(await h.ctx.accounts.keyBackups.store.unlock(d.accountId)).toBeUndefined();
  });
});

/** Marks [accountId] as made in the console (docs/ADMIN_ACCOUNTS.md) with [verification]. */
async function madeInConsole(accountId: string, verification: OperatorVerification, staticCode?: string, codeExpiresAt: number | null = null) {
  const t = Date.now();
  await h.ctx.platform.write((w) =>
    insertOperatorAccount(w, {
      account_id: accountId,
      verification,
      code_hash: staticCode ? staticCodeHash(accountId, staticCode) : null,
      code_expires_at: staticCode ? codeExpiresAt : null,
      tester: 1,
      note: null,
      created_by: "acc_operator",
      created_at: t,
      updated_by: "acc_operator",
      updated_at: t,
    }),
  );
}

const unlockMails = (to: string) => mailer.sent.filter((m) => m.to === to && /code to set up Meldiq on a new device/.test(m.subject)).length;

describe("a new device of an account made in the console", () => {
  it("emails the code as usual for an ordinary account", async () => {
    const { c } = await backedUp("ordinary");
    const p = await newPhone(c);
    expect(await p.req("POST", "/v2/account/key-backup/unlock/start")).toMatchObject({ delivery: "email" });
    expect(unlockMails(c.email)).toBe(1);
  });

  it("fixed tester code: nothing is emailed and the fixed code unlocks the keys, once, in the session that started", async () => {
    const { c, backup } = await backedUp("fixedcode");
    await madeInConsole(c.accountId, "static_code", "135790");
    const p = await newPhone(c);
    expect(await p.req("POST", "/v2/account/key-backup/unlock/start")).toMatchObject({ delivery: "fixed_code" });
    expect(unlockMails(c.email)).toBe(0);
    const q = await newPhone(c);
    await expectStatus(q.req("POST", "/v2/account/key-backup/unlock", { code: "135790" }), 400);
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", { code: "111111" }), 400);
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", {}), 400);
    expect(await p.req("POST", "/v2/account/key-backup/unlock", { code: "135-790" })).toEqual(backup);
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", { code: "135790" }), 400);
  });

  it("fixed tester code: starting again for fresh tries is limited like emailing codes", async () => {
    const { c } = await backedUp("fixedguess");
    await madeInConsole(c.accountId, "static_code", "135790");
    const p = await newPhone(c);
    const wrong = async () => {
      await p.req("POST", "/v2/account/key-backup/unlock/start");
      for (let i = 0; i < h.ctx.config.accounts.codeMaxAttempts; i++) await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", { code: "000000" }), 400);
    };
    for (let i = 0; i < 5; i++) await wrong();
    // The hourly starts are used up: a new start opens no fresh tries, so even the right code is refused now.
    await p.req("POST", "/v2/account/key-backup/unlock/start");
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", { code: "135790" }), 400);
  });

  it("fixed tester code that has ended: back to the emailed code", async () => {
    const { c, backup } = await backedUp("fixedended");
    await madeInConsole(c.accountId, "static_code", "135790", Date.now() - 1000);
    const p = await newPhone(c);
    expect(await p.req("POST", "/v2/account/key-backup/unlock/start")).toMatchObject({ delivery: "email" });
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", { code: "135790" }), 400);
    expect(await p.req("POST", "/v2/account/key-backup/unlock", { code: unlockCode(c.email) })).toEqual(backup);
  });

  it("no code: nothing is emailed and the keys come back without a code, still only after the step was started", async () => {
    const { c, backup } = await backedUp("nocode");
    await madeInConsole(c.accountId, "verified");
    const p = await newPhone(c);
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", {}), 400);
    expect(await p.req("POST", "/v2/account/key-backup/unlock/start")).toMatchObject({ delivery: "none" });
    expect(unlockMails(c.email)).toBe(0);
    expect(await p.req("POST", "/v2/account/key-backup/unlock", {})).toEqual(backup);
    await expectStatus(p.req("POST", "/v2/account/key-backup/unlock", {}), 400);
    const audit = h.ctx.ws.all<{ action: string; detail: string | null }>("audit_log", { where: { target: c.accountId, action: "account.key_unlock_started" } });
    expect(audit.map((a) => a.detail)).toEqual(["none"]);
  });
});
