import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { newEd25519, newX25519 } from "./support/griipClient.js";
import { accountRows } from "./support/accountRows.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer({}, { mailer });
});
afterAll(async () => h.close());

/** The same account on another phone that holds the account's identity (as after typing the recovery key). */
function sameIdentityOnNewPhone(c: AccountClient): AccountClient {
  const p = new AccountClient(h.baseUrl, c.email, c.password, c.name);
  p.identity = c.identity;
  p.device = newEd25519();
  p.enc = newX25519();
  return p;
}

describe("device setup after sign-in", () => {
  it("creates the encryption identity on the first device and opens the messaging API", async () => {
    const c = new AccountClient(h.baseUrl, email("first"), PASSWORD, "Grace Hopper");
    await c.signUp(mailer);
    await c.signIn();
    // An unbound session can't use the messaging routes yet.
    await expectStatus(c.req("GET", "/v1/users/me"), 401);
    const r = await c.setUpIdentity();
    expect(r.result).toBe("identity");
    expect(r.username).toMatch(/^gracehopper\d{4}$/);
    const me = await c.req("GET", "/v1/users/me");
    expect(me.user).toMatchObject({ id: r.userId, username: r.username, displayName: "Grace Hopper", identityKey: c.identityKeyB64 });
    const acc = await c.req("GET", "/v2/account");
    expect(acc.account.identity).toEqual({ userId: r.userId, username: r.username, identityKey: c.identityKeyB64 });
    expect(acc.session.deviceId).toBe(r.deviceId);
  });

  it("refuses a second identity for the same account", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "twice");
    const other = new AccountClient(h.baseUrl, c.email);
    await other.signIn();
    const r = await expectStatus(other.req("POST", "/v2/account/devices", await other.deviceBody("register", { identityKey: other.identityKeyB64 })), 409);
    expect(r.error.code).toBe("identity_mismatch");
  });

  it("adds a phone certified by the account's identity (recovery key) and refuses one that isn't", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "recover");
    const phone = sameIdentityOnNewPhone(c);
    await phone.signIn();
    const r = await phone.addThisDevice();
    expect(r).toMatchObject({ result: "device", userId: c.userId });
    expect(r.deviceId).not.toBe(c.deviceId);
    // A retry of the same setup finds the device instead of adding another.
    expect((await phone.req("POST", "/v2/account/devices", await phone.deviceBody("add-device"))).result).toBe("existing");
    const stranger = new AccountClient(h.baseUrl, c.email);
    await stranger.signIn();
    expect((await expectStatus(stranger.req("POST", "/v2/account/devices", await stranger.deviceBody("add-device")), 401)).error.code).toBe("invalid_certificate");
  });

  it("binds a returning device at sign-in with its device key, and refuses a revoked one", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "return");
    const s = await c.signIn(true);
    expect(s.session.deviceId).toBe(c.deviceId);
    await c.req("GET", "/v1/users/me");
    const phone = sameIdentityOnNewPhone(c);
    await phone.signIn();
    await phone.addThisDevice();
    await phone.req("DELETE", `/v1/devices/${c.deviceId}`);
    // The removed device's v2 session ends with it.
    await expectStatus(c.req("GET", "/v1/users/me"), 401);
    expect((await expectStatus(c.signIn(true), 401)).error.code).toBe("device_revoked");
  });

  it("starts fresh with the password: new identity, other devices removed, server history gone", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "fresh");
    const old = c.deviceId;
    await h.ctx.history.put(c.userId, [{ tag: "t1", conv: "c1", ts: 1, body: Buffer.from([0]) }], { maxItems: 100, maxBytes: 1_000_000, maxTotalBytes: 1_000_000_000 }, 1);
    const lost = new AccountClient(h.baseUrl, c.email);
    await lost.signIn();
    await expectStatus(lost.req("POST", "/v2/account/identity/reset", await lost.deviceBody("register", { password: "wrong password!!", identityKey: lost.identityKeyB64 })), 401);
    const r = await lost.req("POST", "/v2/account/identity/reset", await lost.deviceBody("register", { password: PASSWORD, identityKey: lost.identityKeyB64 }));
    expect(r).toMatchObject({ result: "identity", userId: c.userId });
    const me = await lost.req("GET", "/v1/users/me");
    expect(me.user.identityKey).toBe(lost.identityKeyB64);
    expect(h.ctx.identity.get<{ revoked_at: number | null }>("devices", { id: old })!.revoked_at).not.toBeNull();
    expect(await h.ctx.history.items(c.userId, 0, 10)).toEqual([]);
    await expectStatus(c.req("GET", "/v2/account"), 401);
  });
});

describe("a v2 account messaging a v1 account", () => {
  it("exchanges end-to-end encrypted messages, and the socket survives token renewal", async () => {
    const ada = await AccountClient.ready(h.baseUrl, mailer, "ada");
    const bob = await h.client("bob");
    await ada.connect();
    await bob.connect();
    const dm = (await ada.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    await ada.send(dm, { type: "text", text: "hello from Orbit 2.0" });
    const got = await bob.waitFor(() => bob.received.find((m) => m.payload?.text === "hello from Orbit 2.0"));
    expect(got.senderUserId).toBe(ada.userId);
    // Renew the access token: the open socket is checked by session, not by the old token, so it keeps working.
    await ada.refresh();
    await bob.send(dm, { type: "text", text: "hi back" });
    await ada.waitFor(() => ada.received.find((m) => m.payload?.text === "hi back"));
    ada.ws!.send(JSON.stringify({ t: "ping" }));
    await ada.waitFor(() => ada.events.find((e) => e.t === "pong"));
    expect(ada.ws!.readyState).toBe(1);
  });

  it("closes the socket of a session that is signed out elsewhere", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "cut");
    await c.connect();
    const closed = new Promise<number>((resolve) => c.ws!.once("close", (code) => resolve(code)));
    const other = new AccountClient(h.baseUrl, c.email);
    await other.signIn();
    await other.req("DELETE", `/v2/account/sessions/${c.sessionId}`);
    expect([4001, 4401]).toContain(await closed);
  });

  it("re-checks the session on every frame: an account disabled meanwhile is cut off at its next frame", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "frame");
    await c.connect();
    const closed = new Promise<number>((resolve) => c.ws!.once("close", (code) => resolve(code)));
    // Changed underneath (as the operator CLI does), with no disconnect from the server.
    await accountRows(h).setAccount(c.accountId, { disabled_at: Date.now() });
    c.ws!.send(JSON.stringify({ t: "ping" }));
    expect(await closed).toBe(4401);
  });
});

describe("workspaces", () => {
  it("lists the personal workspace for an account without encryption keys yet", async () => {
    const c = await new AccountClient(h.baseUrl, email("bare")).signUp(mailer);
    await c.signIn();
    const r = await c.req("GET", "/v2/workspaces");
    expect(r).toEqual({ workspaces: [{ id: "personal", kind: "personal", name: "Personal", role: "OWNER", slug: null, photoRev: null }], selectedWorkspaceId: "personal" });
  });

  it("creates and joins organisations, switches between them and remembers the choice for every device", async () => {
    const owner = await AccountClient.ready(h.baseUrl, mailer, "owner");
    const org = (await owner.req("POST", "/v1/orgs", { name: `Acme ${Date.now()}` })).org;
    const invite = await owner.req("POST", `/v1/orgs/${org.id}/invites`, { role: "MEMBER", maxUses: 5, expiresInHours: 24 });
    const member = await AccountClient.ready(h.baseUrl, mailer, "member");
    await member.req("POST", "/v1/invites/accept", { code: invite.invite.code });
    const list = await member.req("GET", "/v2/workspaces");
    expect(list.workspaces.map((w: any) => [w.id, w.kind, w.role])).toEqual([
      ["personal", "personal", "OWNER"],
      [org.id, "organization", "MEMBER"],
    ]);
    expect((await owner.req("GET", "/v2/workspaces")).workspaces[1].role).toBe("OWNER");
    await member.req("PUT", "/v2/account/preferences", { selectedWorkspaceId: org.id });
    const elsewhere = new AccountClient(h.baseUrl, member.email);
    await elsewhere.signIn();
    expect((await elsewhere.req("GET", "/v2/workspaces")).selectedWorkspaceId).toBe(org.id);
    expect((await elsewhere.req("GET", "/v2/account")).account.selectedWorkspaceId).toBe(org.id);
    // Removed from the organisation: the remembered choice falls back to the personal workspace.
    await owner.req("DELETE", `/v1/orgs/${org.id}/members/${member.userId}`);
    expect((await member.req("GET", "/v2/workspaces")).selectedWorkspaceId).toBe("personal");
  });

  it("refuses to switch to, or read, an organisation the person isn't in", async () => {
    const a = await AccountClient.ready(h.baseUrl, mailer, "orga");
    const b = await AccountClient.ready(h.baseUrl, mailer, "orgb");
    const org = (await a.req("POST", "/v1/orgs", { name: `Private ${Date.now()}` })).org;
    expect((await expectStatus(b.req("PUT", "/v2/account/preferences", { selectedWorkspaceId: org.id }), 404)).error.code).toBe("workspace_not_found");
    expect((await expectStatus(b.req("PUT", "/v2/account/preferences", { selectedWorkspaceId: "o_doesnotexist" }), 404)).error.code).toBe("workspace_not_found");
    // The organisation APIs enforce membership whatever the app shows.
    await expectStatus(b.req("GET", `/v1/orgs/${org.id}`), 404);
    await expectStatus(b.req("GET", `/v1/orgs/${org.id}/members`), 404);
    await expectStatus(b.req("GET", `/v1/orgs/${org.id}/channels`), 404);
  });

  it("enforces roles on the server: a member can't invite admins or delete the organisation", async () => {
    const owner = await AccountClient.ready(h.baseUrl, mailer, "roles");
    const org = (await owner.req("POST", "/v1/orgs", { name: `Roles ${Date.now()}` })).org;
    const invite = await owner.req("POST", `/v1/orgs/${org.id}/invites`, { role: "MEMBER", maxUses: 1, expiresInHours: 24 });
    const m = await AccountClient.ready(h.baseUrl, mailer, "rolem");
    await m.req("POST", "/v1/invites/accept", { code: invite.invite.code });
    await expectStatus(m.req("POST", `/v1/orgs/${org.id}/invites`, { role: "ADMIN", maxUses: 1, expiresInHours: 24 }), 403);
    await expectStatus(m.req("DELETE", `/v1/orgs/${org.id}`, { confirmName: org.name }), 403);
    await expectStatus(m.req("PATCH", `/v1/orgs/${org.id}/members/${owner.userId}`, { role: "MEMBER" }), 403);
  });

  it("renames the account and the identity contacts see together", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "rename");
    const r = await c.req("PATCH", "/v2/account", { name: "New Name" });
    expect(r.account.name).toBe("New Name");
    expect((await c.req("GET", "/v1/users/me")).user.displayName).toBe("New Name");
  });
});
