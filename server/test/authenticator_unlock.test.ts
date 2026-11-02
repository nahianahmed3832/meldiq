import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fromBase32, stepAt, totpCode } from "../src/modules/accounts/totp.js";
import { AccountClient, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

for (const backend of process.env.MELDIQ_TEST_PG_URL ? ["postgres"] : ["sqlite", "mongodb"] as const) {
  describe(`one second factor for sign-in and key recovery (${backend})`, () => {
    let h: Harness;
    const mailer = new MemoryMailer();
    beforeAll(async () => {
      h = await startServer({ PLATFORM_SECRETS_KEY: crypto.randomBytes(32).toString("hex"), MONGODB_DOMAINS: backend === "mongodb" ? "accounts" : "" }, { mailer });
    });
    afterAll(async () => h.close());

    async function account() {
      const c = await AccountClient.ready(h.baseUrl, mailer, `linear${crypto.randomBytes(3).toString("hex")}`);
      const backup = { version: 1, iterations: 600_000, salt: crypto.randomBytes(16).toString("base64"), nonce: crypto.randomBytes(12).toString("base64"), ciphertext: crypto.randomBytes(48).toString("base64"), identityKey: c.identityKeyB64 };
      await c.req("PUT", "/v2/account/key-backup", { password: PASSWORD, backup });
      const prior = new AccountClient(h.baseUrl, c.email, PASSWORD, c.name);
      await prior.signIn();
      const { secret } = await c.req("POST", "/v2/account/totp/setup", { password: PASSWORD });
      const { backupCodes } = await c.req("POST", "/v2/account/totp/enable", { code: totpCode(fromBase32(secret), stepAt(Date.now())) });
      return { c, prior, secret, backupCodes, backup };
    }
    const unlockMailCount = () => mailer.sent.filter((mail) => /code to set up Meldiq on a new device/.test(mail.subject)).length;

    for (const method of ["authenticator", "backup code"] as const) {
      it(`uses the verified ${method} session without also asking for email`, async () => {
        const { c, secret, backupCodes, backup } = await account();
        const factor = method === "authenticator" ? totpCode(fromBase32(secret), stepAt(Date.now() + 30_000)) : backupCodes[0];
        const grant = await c.req("POST", "/v2/auth/login", { email: c.email, password: PASSWORD, totpCode: factor });
        const fresh = new AccountClient(h.baseUrl, c.email, PASSWORD, c.name);
        fresh.useSession(grant);
        const sent = unlockMailCount();
        expect(await fresh.req("POST", "/v2/account/key-backup/unlock/start")).toMatchObject({ delivery: "none" });
        expect(unlockMailCount()).toBe(sent);
        expect(await fresh.req("POST", "/v2/account/key-backup/unlock", {})).toEqual(backup);
        await expectStatus(fresh.req("POST", "/v2/account/key-backup/unlock", {}), 400);
      });
    }
    it("does not grant assurance to a password session merely because the account now has an authenticator", async () => {
      const { prior } = await account();
      const sent = unlockMailCount();
      expect(await prior.req("POST", "/v2/account/key-backup/unlock/start")).toMatchObject({ delivery: "email" });
      expect(unlockMailCount()).toBe(sent + 1);
      await expectStatus(prior.req("POST", "/v2/account/key-backup/unlock", {}), 400);
    });
    it("refresh cannot extend the ten-minute second-factor recovery window", async () => {
      const { c, secret } = await account();
      const signedAt = Date.now();
      const grant = await c.req("POST", "/v2/auth/login", { email: c.email, password: PASSWORD, totpCode: totpCode(fromBase32(secret), stepAt(signedAt + 30_000)) });
      const fresh = new AccountClient(h.baseUrl, c.email, PASSWORD, c.name);
      fresh.useSession(grant);
      const clock = vi.spyOn(Date, "now").mockReturnValue(signedAt + 11 * 60_000);
      try {
        await fresh.refresh();
        expect(await fresh.req("POST", "/v2/account/key-backup/unlock/start")).toMatchObject({ delivery: "email" });
      } finally { clock.mockRestore(); }
    });
    it("refreshing an old password session cannot manufacture a verified second factor", async () => {
      const { prior } = await account();
      await prior.refresh();
      expect(await prior.req("POST", "/v2/account/key-backup/unlock/start")).toMatchObject({ delivery: "email" });
    });
  });
}
