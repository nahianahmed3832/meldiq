import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Community administration (docs/WORKSPACE_ADMINISTRATION.md, docs/COMMUNITY_REBUILD_2026-10-21.md): role changes and
 * titles, removal and leaving, channel access modes, channel-level managers and invitation states. Every check is a direct API call, the way
 * someone bypassing the app would try it.
 */
let h: Harness;
let owner: GriipClient, admin: GriipClient, admin2: GriipClient, bdManager: GriipClient, lead: GriipClient;
let member: GriipClient, member2: GriipClient, intlMember: GriipClient, guest: GriipClient, outsider: GriipClient;
let orgId: string, dhakaRole: string, dhakaFloor: string, modRole: string, greeterRole: string;

const invite = async (by: GriipClient, body: object) => (await by.req("POST", `/v1/orgs/${orgId}/invites`, body)).invite as { id: string; code: string };
const join = (c: GriipClient, code: string) => c.req("POST", "/v1/invites/accept", { code });
const roleOf = async (userId: string) =>
  ((await owner.req("GET", `/v1/orgs/${orgId}/members`)).members as any[]).find((m) => m.id === userId)?.orgRole as string | undefined;
const setRole = (by: GriipClient, target: GriipClient, role: string) => by.req("PATCH", `/v1/orgs/${orgId}/members/${target.userId}`, { role });
const channelFor = async (c: GriipClient, id: string) => (await c.req("GET", `/v1/conversations/${id}`)).conversation;

beforeAll(async () => {
  h = await startServer();
  [owner, admin, admin2, bdManager, lead, member, member2, intlMember, guest, outsider] = await Promise.all(
    ["owner", "admin", "admintwo", "bdmanager", "lead", "member", "membertwo", "intl", "guest", "outsider"].map((n) => h.client(n)),
  );
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Admin Lab" })).org.id;
  // "Dhaka" gates a category; bdManager moderates (channel access); greeters invite.
  dhakaRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Dhaka", permissions: [], denies: [] })).role.id;
  modRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Channel moderator", permissions: ["channels.create", "channels.manage", "channels.visibility"], denies: [] })).role.id;
  greeterRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Greeter", permissions: ["members.invite"], denies: [] })).role.id;
  dhakaFloor = (await owner.req("POST", `/v1/orgs/${orgId}/categories`, { name: "Dhaka" })).category.id;
  await owner.req("PUT", `/v1/categories/${dhakaFloor}/overwrites`, { subject: "everyone", deny: ["channels.view"] });
  await owner.req("PUT", `/v1/categories/${dhakaFloor}/overwrites`, { subject: dhakaRole, allow: ["channels.view"] });
  await join(admin, (await invite(owner, { role: "ADMIN" })).code);
  await join(admin2, (await invite(owner, { role: "ADMIN" })).code);
  for (const c of [bdManager, lead, member, member2]) await join(c, (await invite(owner, { role: "MEMBER", roleId: dhakaRole })).code);
  await join(intlMember, (await invite(owner, { role: "MEMBER" })).code);
  await join(guest, (await invite(owner, { role: "GUEST" })).code);
  await owner.req("PUT", `/v1/roles/${modRole}/members/${bdManager.userId}`);
  await owner.req("PUT", `/v1/roles/${greeterRole}/members/${bdManager.userId}`);
});
afterAll(async () => h.close());

describe("server-info", () => {
  it("advertises workspace administration", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toContain("workspace-admin");
  });
});

describe("organization roles can't be self-granted or escalated", () => {
  it("refuses admins creating owners or admins, or touching other admins", async () => {
    await expectStatus(setRole(admin, admin, "OWNER"), 403);
    await expectStatus(setRole(admin, member2, "ADMIN"), 403);
    await expectStatus(setRole(admin, member2, "OWNER"), 403);
    await expectStatus(setRole(admin, admin2, "MEMBER"), 403);
    await expectStatus(setRole(admin, owner, "GUEST"), 403);
    expect(await roleOf(admin.userId)).toBe("ADMIN");
    expect(await roleOf(member2.userId)).toBe("MEMBER");
  });

  it("refuses members, guests and moderators changing anyone's base role, their own included", async () => {
    await expectStatus(setRole(member, member, "ADMIN"), 403);
    await expectStatus(setRole(member, member, "GUEST"), 403);
    await expectStatus(setRole(member, member2, "GUEST"), 403);
    await expectStatus(setRole(guest, guest, "MEMBER"), 403);
    await expectStatus(setRole(bdManager, member2, "GUEST"), 403);
    await expectStatus(setRole(bdManager, bdManager, "ADMIN"), 403);
    expect(await roleOf(guest.userId)).toBe("GUEST");
  });

  it("lets admins switch members and guests, and step down themselves", async () => {
    await setRole(admin, member2, "GUEST");
    expect(await roleOf(member2.userId)).toBe("GUEST");
    await setRole(admin, member2, "MEMBER");
    expect(await roleOf(member2.userId)).toBe("MEMBER");
    // Their roles survive the guest round trip, so the Dhaka category comes back with them.
    expect(((await owner.req("GET", `/v1/orgs/${orgId}/members`)).members as any[]).find((m) => m.id === member2.userId).customRoles.map((r: any) => r.id)).toContain(dhakaRole);
    // admin2 steps down: from then on they can't do admin things.
    await setRole(admin2, admin2, "MEMBER");
    expect(await roleOf(admin2.userId)).toBe("MEMBER");
    await expectStatus(admin2.req("POST", `/v1/orgs/${orgId}/categories`, { name: "Rogue" }), 403);
    await expectStatus(setRole(admin2, admin2, "ADMIN"), 403); // and can't take it back
  });

  it("keeps at least one owner", async () => {
    await expectStatus(setRole(owner, owner, "ADMIN"), 409);
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).permissions.canLeave).toBe(false);
    await setRole(owner, admin2, "OWNER");
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).permissions.canLeave).toBe(true);
    await setRole(admin2, admin2, "ADMIN"); // with two owners, either may step down
    expect(await roleOf(admin2.userId)).toBe("ADMIN");
    await expectStatus(setRole(owner, owner, "MEMBER"), 409);
  });

  it("limits who can change titles", async () => {
    await member.req("PATCH", `/v1/orgs/${orgId}/members/${member.userId}`, { title: "Support agent" });
    await expectStatus(member.req("PATCH", `/v1/orgs/${orgId}/members/${member2.userId}`, { title: "Intern" }), 403);
    await expectStatus(admin.req("PATCH", `/v1/orgs/${orgId}/members/${owner.userId}`, { title: "Boss" }), 403);
    await expectStatus(admin.req("PATCH", `/v1/orgs/${orgId}/members/${admin2.userId}`, { title: "Deputy" }), 403);
    await admin.req("PATCH", `/v1/orgs/${orgId}/members/${member2.userId}`, { title: "Analyst" });
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { title: "Operations" });
    const titles = Object.fromEntries(((await owner.req("GET", `/v1/orgs/${orgId}/members`)).members as any[]).map((m) => [m.id, m.title]));
    expect(titles[member.userId]).toBe("Support agent");
    expect(titles[member2.userId]).toBe("Analyst");
    expect(titles[admin.userId]).toBe("Operations");
    expect(titles[owner.userId]).toBeNull();
  });

  it("hides everything from outsiders (404, not 403)", async () => {
    await expectStatus(setRole(outsider, member, "GUEST"), 404);
    await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/archived`), 404);
    await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/invites`), 404);
    await expectStatus(outsider.req("DELETE", `/v1/orgs/${orgId}/members/${member.userId}`), 404);
    await expectStatus(outsider.req("PATCH", `/v1/orgs/${orgId}`, { name: "Taken" }), 404);
  });
});

describe("removing people and leaving", () => {
  it("lets admins remove members and guests only; members remove nobody", async () => {
    const spare = await h.client("spare");
    await join(spare, (await invite(owner, { role: "MEMBER" })).code);
    await expectStatus(member.req("DELETE", `/v1/orgs/${orgId}/members/${spare.userId}`), 403);
    await expectStatus(admin.req("DELETE", `/v1/orgs/${orgId}/members/${admin2.userId}`), 403);
    await expectStatus(admin.req("DELETE", `/v1/orgs/${orgId}/members/${owner.userId}`), 403);
    await admin.req("DELETE", `/v1/orgs/${orgId}/members/${spare.userId}`);
    await expectStatus(spare.req("GET", `/v1/orgs/${orgId}`), 404);
  });

  it("lets a member leave, taking their channels with them; the last owner can't", async () => {
    const leaver = await h.client("leaver");
    await join(leaver, (await invite(owner, { role: "MEMBER", roleId: dhakaRole })).code);
    const general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "general", scope: "ORG", kind: "PUBLIC", autoJoin: true })).channel;
    expect((await leaver.req("GET", "/v1/conversations")).conversations.map((c: any) => c.id)).toContain(general.id);
    await leaver.req("DELETE", `/v1/orgs/${orgId}/members/${leaver.userId}`);
    expect((await leaver.req("GET", "/v1/orgs")).orgs.map((o: any) => o.id)).not.toContain(orgId);
    expect((await leaver.req("GET", "/v1/conversations")).conversations.map((c: any) => c.id)).not.toContain(general.id);
    // admin2 stepped down from owner earlier, so owner is the only owner again.
    await expectStatus(owner.req("DELETE", `/v1/orgs/${orgId}/members/${owner.userId}`), 409);
  });
});

describe("channel access modes", () => {
  let bdChannel: string, orgChannel: string, teamChannel: string;

  beforeAll(async () => {
    bdChannel = (await bdManager.req("POST", `/v1/orgs/${orgId}/channels`, { name: "dhaka-floor", categoryId: dhakaFloor, kind: "PUBLIC", autoJoin: false })).channel.id;
    orgChannel = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "company", kind: "PUBLIC", autoJoin: false })).channel.id;
    teamChannel = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "support-desk", categoryId: dhakaFloor, kind: "PUBLIC" })).channel.id;
    // lead runs the support desk channel: channels.manage there, nothing else.
    await owner.req("PUT", `/v1/conversations/${teamChannel}/overwrites`, { subject: `user:${lead.userId}`, allow: ["channels.manage"] });
    await member2.req("POST", `/v1/conversations/${bdChannel}/join`);
    await bdManager.req("POST", `/v1/conversations/${orgChannel}/join`);
  });

  it("tells each person whether they may change access", async () => {
    expect((await channelFor(bdManager, bdChannel)).canManageAccess).toBe(true);
    expect((await channelFor(bdManager, orgChannel)).canManageAccess).toBe(true);
    expect((await channelFor(member2, bdChannel)).canManageAccess).toBe(false);
    expect((await channelFor(owner, orgChannel)).canManageAccess).toBe(true);
    expect((await channelFor(lead, teamChannel)).canManage).toBe(true);
    expect((await channelFor(lead, teamChannel)).canManageAccess).toBe(false);
  });

  it("refuses a channel admin by role alone, a channel-level manager, and people who can't see the channel", async () => {
    // member2 is made an admin of the channel: they may rename it, but not make it private or public.
    await bdManager.req("PUT", `/v1/conversations/${bdChannel}/members/${member2.userId}`, { role: "ADMIN" });
    expect((await channelFor(member2, bdChannel)).canManage).toBe(true);
    await member2.req("PATCH", `/v1/conversations/${bdChannel}`, { topic: "Floor chat" });
    await expectStatus(member2.req("PATCH", `/v1/conversations/${bdChannel}`, { kind: "PRIVATE" }), 403);
    await expectStatus(member2.req("PATCH", `/v1/conversations/${bdChannel}`, { kind: "ANNOUNCEMENT" }), 403);
    await lead.req("PATCH", `/v1/conversations/${teamChannel}`, { topic: "Tier 1 and 2" });
    await expectStatus(lead.req("PATCH", `/v1/conversations/${teamChannel}`, { kind: "PRIVATE" }), 403);
    // Someone without the Dhaka role can't even see it.
    await expectStatus(intlMember.req("PATCH", `/v1/conversations/${bdChannel}`, { kind: "PRIVATE" }), 404);
    expect((await channelFor(owner, bdChannel)).kind).toBe("PUBLIC");
  });

  it("makes a channel private: members stay, others can no longer see or join it", async () => {
    await bdManager.req("PATCH", `/v1/conversations/${bdChannel}`, { kind: "PRIVATE" });
    expect((await channelFor(member2, bdChannel)).kind).toBe("PRIVATE");
    const listed = (await member.req("GET", `/v1/orgs/${orgId}/channels`)).channels.map((c: any) => c.id);
    expect(listed).not.toContain(bdChannel);
    await expectStatus(member.req("GET", `/v1/conversations/${bdChannel}`), 404);
    await expectStatus(member.req("POST", `/v1/conversations/${bdChannel}/join`), 404);
    await expectStatus(member.req("GET", `/v1/conversations/${bdChannel}/members`), 404);
    const log = (await owner.req("GET", `/v1/orgs/${orgId}/activity`)).activity as any[];
    expect(log.find((a) => a.action === "channel.access" && a.target === bdChannel)?.detail).toBe("PUBLIC→PRIVATE");
    // Members who can't see it don't get the change in their activity log either.
    const memberLog = (await member.req("GET", `/v1/orgs/${orgId}/activity`)).activity as any[];
    expect(memberLog.some((a) => a.target === bdChannel)).toBe(false);
  });

  it("makes it public again (the people who may see it join), and announcement-only: only managers post", async () => {
    await bdManager.req("PATCH", `/v1/conversations/${bdChannel}`, { kind: "PUBLIC" });
    expect((await member.req("GET", `/v1/orgs/${orgId}/channels`)).channels.map((c: any) => c.id)).toContain(bdChannel);
    expect((await member.req("GET", "/v1/conversations")).conversations.map((c: any) => c.id)).toContain(bdChannel);
    expect((await intlMember.req("GET", "/v1/conversations")).conversations.map((c: any) => c.id)).not.toContain(bdChannel);
    await bdManager.req("PATCH", `/v1/conversations/${bdChannel}`, { kind: "ANNOUNCEMENT" });
    const asMember = await channelFor(member2, bdChannel);
    expect(asMember.kind).toBe("ANNOUNCEMENT");
    // member2 is still the channel's admin by role, which in an announcement channel lets them post (existing rule).
    expect(asMember.canPost).toBe(true);
    await bdManager.req("PUT", `/v1/conversations/${bdChannel}/members/${member2.userId}`, { role: "MEMBER" });
    expect((await channelFor(member2, bdChannel)).canPost).toBe(false);
    expect((await channelFor(bdManager, bdChannel)).canPost).toBe(true);
    // Announcement channels can't be left by plain members.
    await expectStatus(member2.req("DELETE", `/v1/conversations/${bdChannel}/members/${member2.userId}`), 403);
  });

  it("refuses access changes on archived channels and non-channels", async () => {
    await owner.req("PATCH", `/v1/conversations/${orgChannel}`, { archived: true });
    await expectStatus(owner.req("PATCH", `/v1/conversations/${orgChannel}`, { kind: "PRIVATE" }), 409);
    await owner.req("PATCH", `/v1/conversations/${orgChannel}`, { archived: false, kind: "PRIVATE" }); // restore and change at once
    expect((await channelFor(owner, orgChannel)).kind).toBe("PRIVATE");
    const dm = (await member.req("POST", "/v1/conversations/dm", { userId: member2.userId })).conversation;
    await expectStatus(member.req("PATCH", `/v1/conversations/${dm.id}`, { kind: "PRIVATE" }), 403);
    const group = (await member.req("POST", "/v1/conversations/group", { name: "Lunch", memberIds: [member2.userId] })).conversation;
    await expectStatus(member.req("PATCH", `/v1/conversations/${group.id}`, { kind: "PRIVATE" }), 400);
    const log = (await owner.req("GET", `/v1/orgs/${orgId}/activity`)).activity as any[];
    expect(log.some((a) => a.action === "channel.archive" && a.target === orgChannel)).toBe(true);
    expect(log.some((a) => a.action === "channel.restore" && a.target === orgChannel)).toBe(true);
  });

  it("answers older apps' archived branches and teams with empty lists", async () => {
    expect(await owner.req("GET", `/v1/orgs/${orgId}/archived`)).toEqual({ branches: [], teams: [] });
  });
});

describe("invitation states", () => {
  it("reports one state per invite and who created it", async () => {
    const active = await invite(owner, { role: "MEMBER", maxUses: 5 });
    const revoked = await invite(owner, { role: "MEMBER" });
    await owner.req("DELETE", `/v1/invites/${revoked.id}`);
    const used = await invite(owner, { role: "MEMBER", maxUses: 1 });
    await join(await h.client("joiner"), used.code);
    const expired = await invite(owner, { role: "GUEST" });
    await h.ctx.ws.write((w) => w.update("invitations", { id: expired.id }, { expires_at: Date.now() - 1000 }));
    const byManager = await invite(bdManager, { role: "MEMBER" });

    const list = (await owner.req("GET", `/v1/orgs/${orgId}/invites`)).invites as any[];
    const state = (id: string) => list.find((i) => i.id === id);
    expect(state(active.id)).toMatchObject({ status: "active", active: true, createdByName: "owner" });
    expect(state(revoked.id)).toMatchObject({ status: "revoked", active: false });
    expect(state(used.id)).toMatchObject({ status: "used_up", active: false, uses: 1 });
    expect(state(expired.id)).toMatchObject({ status: "expired", active: false });
    expect(state(byManager.id)).toMatchObject({ status: "active", createdBy: bdManager.userId });
    await expectStatus(join(await h.client("late"), expired.code), 404);

    // Someone who may invite sees only their own invites; members can list nothing they didn't create.
    expect(((await bdManager.req("GET", `/v1/orgs/${orgId}/invites`)).invites as any[]).map((i) => i.id)).toEqual([byManager.id]);
    expect((await member.req("GET", `/v1/orgs/${orgId}/invites`)).invites).toEqual([]);
    // Revoking someone else's invite needs admin rights.
    await expectStatus(member.req("DELETE", `/v1/invites/${active.id}`), 403);
    await expectStatus(bdManager.req("DELETE", `/v1/invites/${active.id}`), 403);
  });
});
