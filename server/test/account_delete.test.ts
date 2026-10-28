import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

// Self-service account deletion (docs/ACCOUNT_DELETION.md), on a throwaway server with test accounts only.
let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer({ REMINDER_TICK_MS: "0" }, { mailer });
});
afterAll(async () => h.close());

const HOUR = 3_600_000;
const join = async (by: AccountClient, c: AccountClient, org: string, role: string) => {
  const code = (await by.req("POST", `/v1/orgs/${org}/invites`, { role })).invite.code;
  await c.req("POST", "/v1/invites/accept", { code });
};
const del = (c: AccountClient, body: Record<string, unknown>) => c.req("DELETE", "/v2/account", body);
const userRow = (id: string) => h.ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, any>;
const count = (sql: string, ...args: unknown[]) => (h.ctx.db.prepare(sql).get(...args) as { n: number }).n;

describe("deleting your own account", () => {
  it("is advertised in server-info", async () => {
    const info = await (await fetch(`${h.baseUrl}/v1/server-info`)).json();
    expect(info.features).toContain("account-delete");
  });

  it("needs a session, the password and the account's email, and changes nothing otherwise", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "careful");
    const anon = new AccountClient(h.baseUrl, email("nobody"));
    await expectStatus(anon.req("DELETE", "/v2/account", { password: PASSWORD, confirmEmail: c.email }), 401);
    expect((await expectStatus(del(c, { password: "not the password", confirmEmail: c.email }), 401)).error.code).toBe("invalid_credentials");
    expect((await expectStatus(del(c, { password: PASSWORD, confirmEmail: email("someone-else") }), 400)).error.code).toBe("confirm_mismatch");
    await expectStatus(del(c, { password: PASSWORD }), 400);
    // Still there and still working.
    expect((await c.req("GET", "/v2/account")).account.email).toBe(c.email);
    expect((await c.req("GET", "/v1/users/me")).user.id).toBe(c.userId);
    expect(userRow(c.userId).deleted_at).toBeNull();
  });

  it("is refused while the person is a workspace's only owner, and works once someone else owns it", async () => {
    const owner = await AccountClient.ready(h.baseUrl, mailer, "soleowner");
    const colleague = await AccountClient.ready(h.baseUrl, mailer, "colleague");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "Deletion Test Workspace" })).org.id;
    await join(owner, colleague, orgId, "MEMBER");
    const refused = await expectStatus(del(owner, { password: PASSWORD, confirmEmail: owner.email }), 409);
    expect(refused.error.code).toBe("owns_workspaces");
    expect(refused.error.details.workspaces).toEqual([{ id: orgId, name: "Deletion Test Workspace", members: 2 }]);
    expect(h.ctx.ws.count("org_members", { user_id: owner.userId })).toBe(1);
    expect((await owner.req("GET", "/v2/account")).account.email).toBe(owner.email);

    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${colleague.userId}`, { role: "OWNER" });
    await del(owner, { password: PASSWORD, confirmEmail: owner.email });
    expect(h.ctx.ws.count("org_members", { user_id: owner.userId })).toBe(0);
    // The workspace lives on with its remaining owner.
    expect(h.ctx.ws.count("org_members", { org_id: orgId, role: "OWNER" })).toBe(1);
  });

  it("erases the account and anonymises its identity; direct conversations stay for the other person", async () => {
    const ada = await AccountClient.ready(h.baseUrl, mailer, "ada");
    const bob = await AccountClient.ready(h.baseUrl, mailer, "bob");
    const cy = await AccountClient.ready(h.baseUrl, mailer, "cy");
    const orgId = (await bob.req("POST", "/v1/orgs", { name: "Bob's Workspace" })).org.id;
    await join(bob, ada, orgId, "MEMBER");
    const dm = (await ada.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    // A group with Ada as its only admin and a third person who must take over.
    const group = (await ada.req("POST", "/v1/conversations/group", { name: "Book club", memberIds: [bob.userId, cy.userId] })).conversation.id;
    await ada.req("POST", "/v1/reminders", { id: `rem_del_${Date.now()}`, sealed: "c2VhbGVkLXJlbWluZGVyLWNvbnRlbnRBQUFBQUFBQQ", dueAt: Date.now() + HOUR, timeZone: "UTC" });
    await ada.req("POST", "/v2/account/recovery-codes", { password: PASSWORD });
    h.ctx.db.prepare("INSERT INTO history_items (user_id, tag, conv_tag, seq, ts, body, size, updated_at) VALUES (?, 't1', 'c1', 1, 1, x'00', 1, 1)").run(ada.userId);
    const accountId = (await ada.req("GET", "/v2/account")).account.id;
    await bob.connect();

    const r = await del(ada, { password: PASSWORD, confirmEmail: ada.email.toUpperCase() });
    expect(r).toMatchObject({ deleted: true });
    expect(typeof r.deletedAt).toBe("number");

    // Signed out everywhere, and the email-and-password account is gone.
    await expectStatus(ada.req("GET", "/v2/account"), 401);
    await expectStatus(ada.req("GET", "/v1/users/me"), 401);
    expect((await expectStatus(ada.signIn(), 401)).error.code).toBe("invalid_credentials");
    expect(await h.ctx.accounts.store.accountById(accountId)).toBeUndefined();
    expect(await h.ctx.accounts.recovery.store.codes(accountId)).toEqual([]);

    // The identity row stays, anonymous: the username is free again and nothing personal is left.
    const u = userRow(ada.userId);
    expect(u.deleted_at).toEqual(expect.any(Number));
    expect(u.disabled_at).toEqual(expect.any(Number));
    expect(u.display_name).toBe("Deleted account");
    expect(u.username).toMatch(/^deleted-[0-9a-f]{16}$/);
    expect([u.first_name, u.last_name, u.phone, u.birthday, u.status_text, u.photo_rev, u.privacy]).toEqual([null, null, null, null, null, null, null]);
    expect(count("SELECT COUNT(*) n FROM devices WHERE user_id = ? AND revoked_at IS NULL", ada.userId)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM devices WHERE user_id = ? AND name != ''", ada.userId)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM history_items WHERE user_id = ?", ada.userId)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM reminders WHERE user_id = ?", ada.userId)).toBe(0);
    expect(h.ctx.ws.count("org_members", { user_id: ada.userId })).toBe(0);

    // Bob keeps the direct conversation; the group lost Ada and Cy now runs it.
    expect(h.ctx.ws.count("conversations", { id: dm })).toBe(1);
    expect(h.ctx.ws.count("conversation_members", { conversation_id: group, user_id: ada.userId })).toBe(0);
    expect(h.ctx.ws.count("conversation_members", { conversation_id: group, role: "ADMIN" })).toBe(1);
    // Bob's app is told to refresh Ada's (now empty) device list, and Ada no longer shows as present.
    await bob.waitFor(() => bob.events.find((e) => e.t === "devices.changed" && e.userId === ada.userId));
    const presence = await bob.req("GET", `/v1/presence?ids=${ada.userId}`);
    expect(presence.presence).toEqual([]);
    expect(await bob.req("GET", `/v1/users/${ada.userId}`).catch((e) => e.status)).toBe(404);
    // Recorded without the email, username or profile.
    const audit = h.ctx.ws.get<{ detail: string }>("audit_log", { action: "account.delete", target: ada.userId })!;
    expect(audit.detail).not.toContain(ada.email);
    await bob.disconnect();

    // The address can be used again for a brand-new account.
    const again = new AccountClient(h.baseUrl, ada.email, PASSWORD, "Ada again");
    await again.signUp(mailer);
    await again.signIn();
    expect((await again.req("GET", "/v2/account")).account.id).not.toBe(accountId);
  });

  it("deletes an account that never set up encryption", async () => {
    const c = new AccountClient(h.baseUrl, email("noidentity"), PASSWORD, "No Identity");
    await c.signUp(mailer);
    await c.signIn();
    const accountId = (await c.req("GET", "/v2/account")).account.id;
    expect(await del(c, { password: PASSWORD, confirmEmail: c.email })).toMatchObject({ deleted: true });
    expect(await h.ctx.accounts.store.accountById(accountId)).toBeUndefined();
  });
});
