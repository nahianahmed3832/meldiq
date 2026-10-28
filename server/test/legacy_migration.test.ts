import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { type GriipClient, newEd25519, newX25519, sign } from "./support/griipClient.js";
import { accountRows } from "./support/accountRows.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer({}, { mailer });
});
afterAll(async () => h.close());

/** The proof the app makes: the identity key (derived from the recovery key) signs a fresh challenge. */
async function legacyProof(c: GriipClient, username = c.username, identity = c.identity) {
  const { nonce } = await c.req("POST", "/v1/auth/challenge");
  return { username, nonce, signature: sign(identity, `griip-legacy-migration-v1\n${username}\n${nonce}`) };
}

/** A legacy (v1) account turned into an AccountClient that keeps its keys and device. */
function asAccount(legacy: GriipClient, address: string): AccountClient {
  const c = new AccountClient(h.baseUrl, address, PASSWORD, legacy.displayName);
  c.identity = legacy.identity;
  c.device = legacy.device;
  c.enc = legacy.enc;
  c.deviceId = legacy.deviceId;
  c.userId = legacy.userId;
  return c;
}

async function migrate(legacy: GriipClient, address = email("moved")): Promise<{ ticket: string; address: string }> {
  const v = await legacy.req("POST", "/v2/migration/legacy/verify", await legacyProof(legacy));
  await legacy.req("POST", "/v2/migration/legacy/complete", { ticket: v.ticket, name: "Moved Person", email: address, password: PASSWORD });
  return { ticket: v.ticket, address };
}

describe("legacy account migration", () => {
  it("refuses a wrong recovery key and an unknown username alike, and links nothing", async () => {
    const legacy = await h.client("legacywrong");
    const wrongKey = await expectStatus(legacy.req("POST", "/v2/migration/legacy/verify", await legacyProof(legacy, legacy.username, newEd25519())), 401);
    const unknown = await expectStatus(legacy.req("POST", "/v2/migration/legacy/verify", await legacyProof(legacy, "nosuchuser9")), 401);
    expect(wrongKey.error).toEqual(unknown.error);
    expect(wrongKey.error.code).toBe("legacy_verification_failed");
    expect(await accountRows(h).emailsOfUser(legacy.userId)).toHaveLength(0);
    expect(await accountRows(h).ticketCount(legacy.userId)).toBe(0);
    // A username in local storage isn't proof: a challenge signed by the device key (not the identity key) fails too.
    await expectStatus(legacy.req("POST", "/v2/migration/legacy/verify", await legacyProof(legacy, legacy.username, legacy.device)), 401);
  });

  it("links a recognised installation, keeps its data, and signs the same device in", async () => {
    const legacy = await h.client("legacyok", "Old Name");
    const friend = await h.client("friend");
    const org = (await legacy.req("POST", "/v1/orgs", { name: `Legacy Org ${Date.now()}` })).org;
    const dm = (await legacy.req("POST", "/v1/conversations/dm", { userId: friend.userId })).conversation.id;
    const v = await legacy.req("POST", "/v2/migration/legacy/verify", await legacyProof(legacy));
    expect(v.legacyUser).toEqual({ username: legacy.username, displayName: "Old Name" });
    const address = email("legacyok");
    const done = await legacy.req("POST", "/v2/migration/legacy/complete", { ticket: v.ticket, name: "New Name", email: address, password: PASSWORD });
    expect(done).toEqual({ status: "verification_sent", email: address });
    // Retrying the same request is safe: same answer, no second account.
    expect(await legacy.req("POST", "/v2/migration/legacy/complete", { ticket: v.ticket, name: "New Name", email: address, password: PASSWORD })).toEqual(done);
    expect(await accountRows(h).emailsOfUser(legacy.userId)).toHaveLength(1);
    // The same ticket can't be reused for another address.
    expect((await expectStatus(legacy.req("POST", "/v2/migration/legacy/complete", { ticket: v.ticket, name: "X", email: email("other"), password: PASSWORD }), 401)).error.code).toBe("invalid_ticket");

    const c = asAccount(legacy, address);
    await expectStatus(c.signIn(true), 403);
    await c.req("POST", "/v2/auth/email/verify", { email: address, code: mailer.verifyCode(address) , password: PASSWORD });
    const s = await c.signIn(true);
    expect(s.session.deviceId).toBe(legacy.deviceId);
    expect(s.account.identity.userId).toBe(legacy.userId);
    expect(s.account.legacyLinkedAt).toBeGreaterThan(0);
    const me = await c.req("GET", "/v1/users/me");
    expect(me.user.id).toBe(legacy.userId);
    expect((await c.req("GET", "/v2/workspaces")).workspaces.map((w: any) => w.id)).toContain(org.id);
    expect((await c.req("GET", "/v1/conversations")).conversations.map((x: any) => x.id)).toContain(dm);
  });

  it("restores on a fresh installation: sign in, then add a device from the recovery key", async () => {
    const legacy = await h.client("legacyfresh");
    const { address } = await migrate(legacy);
    await legacy.req("POST", "/v2/auth/email/verify", { email: address, code: mailer.verifyCode(address) , password: PASSWORD });
    const phone = new AccountClient(h.baseUrl, address);
    phone.identity = legacy.identity;
    phone.device = newEd25519();
    phone.enc = newX25519();
    const s = await phone.signIn();
    expect(s.session.deviceId).toBeNull();
    const r = await phone.addThisDevice();
    expect(r).toMatchObject({ result: "device", userId: legacy.userId, username: legacy.username });
    expect((await phone.req("GET", "/v1/users/me")).user.id).toBe(legacy.userId);
  });

  it("says where to sign in once the move is verified", async () => {
    const legacy = await h.client("legacydone");
    const { address } = await migrate(legacy);
    await legacy.req("POST", "/v2/auth/email/verify", { email: address, code: mailer.verifyCode(address) , password: PASSWORD });
    const again = await expectStatus(legacy.req("POST", "/v2/migration/legacy/verify", await legacyProof(legacy)), 409);
    expect(again.error.code).toBe("already_migrated");
    expect(again.error.details.emailHint).toMatch(/^m\*+\d@example\.test$/);
    expect(again.error.details.emailHint).not.toBe(address);
  });

  it("lets an unverified move be redone with another address (a typo can't lock anyone out)", async () => {
    const legacy = await h.client("legacytypo");
    const { address: typo } = await migrate(legacy, email("tpyo"));
    const { address: right } = await migrate(legacy, email("typo"));
    expect(await accountRows(h).emailsOfUser(legacy.userId)).toEqual([right]);
    await expectStatus(legacy.req("POST", "/v2/auth/email/verify", { email: typo, code: mailer.verifyCode(typo) , password: PASSWORD }), 400);
    await legacy.req("POST", "/v2/auth/email/verify", { email: right, code: mailer.verifyCode(right) , password: PASSWORD });
  });

  it("refuses an address another verified account owns", async () => {
    const taken = await new AccountClient(h.baseUrl, email("owned")).signUp(mailer);
    const legacy = await h.client("legacytaken");
    const v = await legacy.req("POST", "/v2/migration/legacy/verify", await legacyProof(legacy));
    const r = await expectStatus(legacy.req("POST", "/v2/migration/legacy/complete", { ticket: v.ticket, name: "X", email: taken.email, password: PASSWORD }), 409);
    expect(r.error.code).toBe("email_taken");
    expect(await accountRows(h).emailsOfUser(legacy.userId)).toHaveLength(0);
  });

  it("expires tickets and rejects forged ones", async () => {
    const legacy = await h.client("legacyexpire");
    const v = await legacy.req("POST", "/v2/migration/legacy/verify", await legacyProof(legacy));
    await accountRows(h).expireTickets(legacy.userId, Date.now() - 1);
    await expectStatus(legacy.req("POST", "/v2/migration/legacy/complete", { ticket: v.ticket, name: "X", email: email("late"), password: PASSWORD }), 401);
    await expectStatus(legacy.req("POST", "/v2/migration/legacy/complete", { ticket: "x".repeat(43), name: "X", email: email("forged"), password: PASSWORD }), 401);
  });

  it("refuses a disabled legacy account", async () => {
    const legacy = await h.client("legacydisabled");
    await h.ctx.identity.write((w) => w.update("users", { id: legacy.userId }, { disabled_at: Date.now() }));
    expect((await expectStatus(legacy.req("POST", "/v2/migration/legacy/verify", await legacyProof(legacy)), 403)).error.code).toBe("account_disabled");
  });
});

describe("retiring the legacy system", () => {
  it("offers the move as optional by default", async () => {
    const info = await new AccountClient(h.baseUrl, email("defprobe")).req("GET", "/v1/server-info");
    expect(info.accounts).toMatchObject({ legacyLogin: true, legacyMigration: true, legacyMigrationRequired: false });
  });

  it("can require the move from updated apps while old apps still sign in", async () => {
    const required = await startServer({ LEGACY_MIGRATION_REQUIRED: "on" }, { mailer: new MemoryMailer() });
    try {
      const info = await new AccountClient(required.baseUrl, email("reqprobe")).req("GET", "/v1/server-info");
      expect(info.features).toContain("legacy-migration");
      expect(info.accounts).toMatchObject({ legacyLogin: true, legacyMigration: true, legacyMigrationRequired: true });
      // An app from before the move still registers and signs in with its device key.
      const old = await required.client("oldapp");
      await old.req("GET", "/v1/users/me");
    } finally {
      await required.close();
    }
  });

  it("never requires the move while account email is off", async () => {
    const noMail = await startServer({ LEGACY_MIGRATION_REQUIRED: "on" });
    try {
      const info = await new AccountClient(noMail.baseUrl, email("nomail")).req("GET", "/v1/server-info");
      expect(info.accounts).toMatchObject({ registration: false, legacyMigrationRequired: false });
    } finally {
      await noMail.close();
    }
  });

  it("refuses to require a move that is switched off", async () => {
    await expect(startServer({ LEGACY_MIGRATION_REQUIRED: "on", LEGACY_MIGRATION: "off" })).rejects.toThrow(/LEGACY_MIGRATION_REQUIRED/);
  });

  it("closes migration, v1 sign-in and v1 sign-up when the settings say so", async () => {
    const closed = await startServer({ LEGACY_MIGRATION: "off", LEGACY_LOGIN: "off", LEGACY_REGISTRATION: "off" }, { mailer: new MemoryMailer() });
    try {
      const probe = new AccountClient(closed.baseUrl, email("probe"));
      const info = await probe.req("GET", "/v1/server-info");
      expect(info.features).not.toContain("legacy-migration");
      expect(info.accounts).toMatchObject({ legacyLogin: false, legacyRegistration: false, legacyMigration: false });
      expect((await expectStatus(probe.req("POST", "/v2/migration/legacy/verify", { username: "someone", nonce: "n".repeat(20), signature: "A".repeat(86) + "==" }), 410)).error.code).toBe("migration_closed");
      expect((await expectStatus(closed.client("v1after"), 410)).error.code).toBe("legacy_registration_closed");
      expect((await expectStatus(probe.req("POST", "/v1/auth/login", { deviceId: "d_x", nonce: "n".repeat(20), signature: "A".repeat(86) + "==" }), 410)).error.code).toBe("legacy_login_closed");
      // Orbit 2.0 accounts keep working.
      const fresh = await new AccountClient(closed.baseUrl, email("after")).signUp(closed.ctx.accounts.mailer as MemoryMailer);
      await fresh.signIn();
      await fresh.setUpIdentity();
      await fresh.req("GET", "/v1/users/me");
    } finally {
      await closed.close();
    }
  });
});
