import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRegistrationInvite } from "../src/modules/organizations/invites.js";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { accountRows } from "./support/accountRows.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * The account store under concurrency and partial failure, on both stores (docs/MONGODB.md › Accounts): racing
 * refreshes, double taps, a code used twice, sign-up races over one invite, undoing half-done steps, and repairing an
 * interrupted identity link. MongoDB runs each multi-store step as a saga; SQLite in one transaction.
 */
describe.each([
  ["SQLite", ""],
  ["MongoDB", "accounts"],
])("accounts on %s", (_name, domains) => {
  let h: Harness;
  const mailer = new MemoryMailer();
  beforeAll(async () => {
    h = await startServer({ MONGODB_DOMAINS: domains, REGISTRATION_MODE: "invite" }, { mailer });
  });
  afterAll(async () => h.close());

  const signUp = async (name: string, inviteCode?: string) => {
    const c = new AccountClient(h.baseUrl, email(name), PASSWORD, name);
    await c.req("POST", "/v2/auth/register", { name, email: c.email, password: PASSWORD, inviteCode: inviteCode ?? (await createRegistrationInvite(h.ctx.identity, { maxUses: 1, days: 1 })).code });
    await c.req("POST", "/v2/auth/email/verify", { email: c.email, code: mailer.verifyCode(c.email), password: PASSWORD });
    return c;
  };

  it("uses the store it was configured with", () => {
    expect(h.ctx.accounts.store.backend).toBe(domains ? "mongodb" : "sqlite");
  });

  /**
   * Two refreshes with one token where both read the session before either rotates it: the store's first two rotations
   * are held until both requests are waiting, then [rotatesFirst] (0: the request sent first) goes ahead and the other
   * loses the conditional rotation. Answers in the order the requests were sent.
   */
  const raceRefreshes = async (c: AccountClient, refreshToken: string, rotatesFirst: 0 | 1) => {
    const store = h.ctx.accounts.store;
    const rotate = store.rotateSession.bind(store);
    const held: { release: () => void; done: Promise<boolean> }[] = [];
    const spy = vi.spyOn(store, "rotateSession").mockImplementation((...args) => {
      if (held.length === 2) return rotate(...args);
      let release = () => {};
      const done = new Promise<void>((go) => (release = go)).then(() => rotate(...args));
      held.push({ release, done });
      return done;
    });
    try {
      const send = () => c.req("POST", "/v2/auth/refresh", { refreshToken });
      const first = send();
      await vi.waitFor(() => expect(held).toHaveLength(1));
      const second = send();
      await vi.waitFor(() => expect(held).toHaveLength(2));
      held[rotatesFirst].release();
      expect(await held[rotatesFirst].done).toBe(true);
      held[1 - rotatesFirst].release();
      return await Promise.all([first, second]);
    } finally {
      spy.mockRestore();
    }
  };

  it.each([
    ["the request sent first", 0],
    ["the request sent second", 1],
  ] as const)("two refreshes racing with one token get the same answer when %s rotates first", async (_who, rotatesFirst) => {
    const c = await signUp(`racer${rotatesFirst}`);
    const s = await c.signIn();
    const [a, b] = await raceRefreshes(c, s.refreshToken, rotatesFirst);
    // The loser is given the pair the winner got, so whichever answer the app keeps is the session's current pair.
    expect(b.refreshToken).toBe(a.refreshToken);
    expect(b.accessToken).toBe(a.accessToken);
    c.token = a.accessToken;
    expect((await c.req("GET", "/v2/account")).account.email).toBe(c.email);
    // Its next refresh is an ordinary one, not refresh-token reuse: the session survives.
    c.refreshToken = a.refreshToken;
    await c.refresh();
    expect((await c.req("GET", "/v2/account")).account.email).toBe(c.email);
    expect((await accountRows(h).session(s.session.id)).revoked_at).toBeNull();
  });

  it("three refreshes with one token all get the same answer", async () => {
    const c = await signUp("racer3");
    const s = await c.signIn();
    const answers = await Promise.all([1, 2, 3].map(() => c.req("POST", "/v2/auth/refresh", { refreshToken: s.refreshToken })));
    expect(new Set(answers.map((r) => r.refreshToken)).size).toBe(1);
    c.refreshToken = answers[0].refreshToken;
    await c.refresh();
    expect((await c.req("GET", "/v2/account")).account.email).toBe(c.email);
  });

  it("a double tap on device setup makes one identity", async () => {
    const c = await signUp("doubletap");
    await c.signIn();
    const body = await c.deviceBody("register", { identityKey: c.identityKeyB64 });
    const body2 = await c.deviceBody("register", { identityKey: c.identityKeyB64 });
    const results = await Promise.all([body, body2].map((b) => c.req("POST", "/v2/account/devices", b).then((r) => r, (e) => e)));
    const made = results.filter((r) => r.result === "identity");
    expect(made).toHaveLength(1);
    // The other one found the identity already there (same device), or was refused (told to try again, or its proof was
    // for making an identity, not adding a device): never a second identity.
    for (const r of results.filter((x) => x.result !== "identity")) expect(r.result === "existing" || (r.status >= 400 && r.status < 500)).toBe(true);
    const users = { n: h.ctx.identity.count("users", { identity_key: c.identityKeyB64 }) };
    expect(users.n).toBe(1);
  });

  it("a code works once even when sent twice at the same moment", async () => {
    const c = new AccountClient(h.baseUrl, email("twice"), PASSWORD, "twice");
    await c.req("POST", "/v2/auth/register", { name: "twice", email: c.email, password: PASSWORD, inviteCode: (await createRegistrationInvite(h.ctx.identity, { maxUses: 1, days: 1 })).code });
    await c.signIn().catch(() => undefined);
    await c.req("POST", "/v2/auth/password/forgot", { email: c.email }).catch(() => undefined);
    const code = mailer.verifyCode(c.email);
    const results = await Promise.all(
      [1, 2].map(() => c.req("POST", "/v2/auth/email/verify", { email: c.email, code, password: PASSWORD }).then((r) => r, (e) => e)),
    );
    expect(results.filter((r) => r.verified === true)).toHaveLength(1);
  });

  it("two sign-ups for one address at once make one account and use one invite", async () => {
    const invite = await createRegistrationInvite(h.ctx.identity, { maxUses: 5, days: 1 });
    const address = email("samemail");
    await Promise.all(
      [1, 2].map(() => new AccountClient(h.baseUrl, address).req("POST", "/v2/auth/register", { name: "Same", email: address, password: PASSWORD, inviteCode: invite.code })),
    );
    expect(await accountRows(h).passwordHash(address)).toBeDefined();
    const uses = h.ctx.identity.get<{ uses: number }>("registration_invites", { id: invite.id })!.uses;
    expect(uses).toBe(1);
  });

  it("gives the identity link back when the identity's rows can't be written (a taken username)", async () => {
    const first = await signUp("taken1");
    await first.signIn();
    await first.setUpIdentity("sameusername");
    const second = await signUp("taken2");
    await second.signIn();
    const e = await expectStatus(second.setUpIdentity("sameusername"), 409);
    expect(e.error.code).toBeDefined();
    // Nothing half-made: the account has no identity, and a free username then works.
    expect((await second.req("GET", "/v2/account")).account.identity).toBeNull();
    const r = await second.setUpIdentity("anotherfreename");
    expect(r.result).toBe("identity");
  });

  // Only MongoDB can be left like this: SQLite's foreign key and single transaction make the state impossible.
  it.skipIf(!domains)("repairs an identity link that was interrupted half-way", async () => {
    const c = await signUp("halfway");
    const s = await c.signIn();
    // As if the server stopped between claiming the account and writing the identity's rows.
    await accountRows(h).setAccount(s.account.id, { user_id: "u_neverwritten" });
    const r = await c.setUpIdentity();
    expect(r.result).toBe("identity");
    expect((await c.req("GET", "/v2/account")).account.identity.userId).toBe(r.userId);
  });

  it("removing an unverified sign-up removes its sessions and codes too", async () => {
    const address = email("unverified");
    await new AccountClient(h.baseUrl, address).req("POST", "/v2/auth/register", {
      name: "U", email: address, password: PASSWORD, inviteCode: (await createRegistrationInvite(h.ctx.identity, { maxUses: 1, days: 1 })).code,
    });
    const a = (await h.ctx.accounts.store.accountByEmail(address))!;
    expect(await h.ctx.accounts.store.code(a.id, "verify_email")).toBeDefined();
    expect(await h.ctx.accounts.store.deleteUnverifiedAccount(a.id)).toBe(true);
    expect(await h.ctx.accounts.store.code(a.id, "verify_email")).toBeUndefined();
    expect(await h.ctx.accounts.store.accountById(a.id)).toBeUndefined();
  });

  it("the retention job removes expired sessions and codes", async () => {
    const c = await signUp("retention");
    const s = await c.signIn();
    await accountRows(h).setSession(s.session.id, { expires_at: Date.now() - 2 * 86_400_000 });
    expect(await h.ctx.accounts.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await h.ctx.accounts.store.sessionById(s.session.id)).toBeUndefined();
  });
});
