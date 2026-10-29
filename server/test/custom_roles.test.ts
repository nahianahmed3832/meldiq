import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Custom workspace roles through the API (docs/WORKSPACE_ROLES.md): templates, cloning, editing with revisions,
 * archiving, assignments, delegated admin powers, restrictions, ownership transfer, usage and the audit log. Every
 * refusal is tried as a direct API call, the way someone bypassing the app would.
 */
let h: Harness;
let owner: GriipClient, admin: GriipClient, member: GriipClient, member2: GriipClient, guest: GriipClient, outsider: GriipClient;
let orgId: string, otherOrg: string, channelId: string;

const roles = async (c: GriipClient, archived = false) => (await c.req("GET", `/v1/orgs/${orgId}/roles${archived ? "?includeArchived=true" : ""}`)) as any;
const createRole = (c: GriipClient, body: object, org = orgId) => c.req("POST", `/v1/orgs/${org}/roles`, body).then((r) => r.role);
const assign = (c: GriipClient, roleId: string, target: GriipClient) => c.req("PUT", `/v1/roles/${roleId}/members/${target.userId}`);
const unassign = (c: GriipClient, roleId: string, target: GriipClient) => c.req("DELETE", `/v1/roles/${roleId}/members/${target.userId}`);
const perms = async (c: GriipClient, org = orgId) => (await c.req("GET", `/v1/orgs/${org}`)).permissions.effective as string[];

beforeAll(async () => {
  h = await startServer();
  [owner, admin, member, member2, guest, outsider] = await Promise.all(["owner", "admin", "member", "membertwo", "guest", "outsider"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Roles Lab" })).org.id;
  otherOrg = (await outsider.req("POST", "/v1/orgs", { name: "Elsewhere" })).org.id;
  const invite = async (role: string) => (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role })).invite.code;
  await admin.req("POST", "/v1/invites/accept", { code: await invite("ADMIN") });
  await member.req("POST", "/v1/invites/accept", { code: await invite("MEMBER") });
  await member2.req("POST", "/v1/invites/accept", { code: await invite("MEMBER") });
  await guest.req("POST", "/v1/invites/accept", { code: await invite("GUEST") });
  channelId = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "general", scope: "ORG", kind: "PUBLIC", autoJoin: true })).channel.id;
});
afterAll(async () => h.close());

describe("catalog and visibility", () => {
  it("advertises custom roles and lists the catalog, templates and protected base roles", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toContain("custom-roles");
    const r = await roles(member);
    expect(r.catalog.length).toBeGreaterThan(20);
    expect(r.templates.map((t: any) => t.key)).toContain("read_only");
    expect(r.baseRoles.map((b: any) => [b.key, b.protected])).toEqual([["OWNER", true], ["ADMIN", true], ["MEMBER", true], ["GUEST", true]]);
    expect(r.me.canManage).toBe(false);
  });

  it("hides roles from guests and outsiders", async () => {
    await expectStatus(guest.req("GET", `/v1/orgs/${orgId}/roles`), 403);
    await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/roles`), 404);
  });
});

describe("creating, cloning and editing", () => {
  it("creates from a template and refuses duplicate or base-role names", async () => {
    const mod = await createRole(owner, { template: "moderator" });
    expect(mod).toMatchObject({ name: "Moderator", permissions: ["channels.manage", "channels.visibility", "messages.announce", "messages.bypass_slowmode", "members.remove", "members.ban", "members.timeout", "members.approve", "reports.view", "voice.mute_members", "voice.move_members"], rev: 1, memberCount: 0 });
    expect((await expectStatus(createRole(owner, { name: "moderator" }), 409)).error.code).toBe("role_name_taken");
    expect((await expectStatus(createRole(owner, { name: "Admin" }), 409)).error.code).toBe("role_name_taken");
  });

  it("clones a role and edits it with its revision; a stale revision is refused", async () => {
    const mod = (await roles(owner)).roles.find((r: any) => r.name === "Moderator");
    const clone = await createRole(owner, { cloneOf: mod.id, name: "Night moderator" });
    expect(clone.permissions).toEqual(mod.permissions);
    const edited = (await owner.req("PATCH", `/v1/roles/${clone.id}`, { baseRev: 1, permissions: ["messages.announce"], color: "#C9A27A" })).role;
    expect(edited).toMatchObject({ rev: 2, permissions: ["messages.announce"], color: "#C9A27A" });
    const stale = await expectStatus(owner.req("PATCH", `/v1/roles/${clone.id}`, { baseRev: 1, name: "Late" }), 409);
    expect(stale.error.code).toBe("stale");
    expect(stale.error.details.role.rev).toBe(2);
  });

  it("refuses unknown permissions and platform powers", async () => {
    await expectStatus(createRole(owner, { name: "Root", permissions: ["platform.admin"] }), 400);
    await expectStatus(createRole(owner, { name: "Owner-ish", permissions: ["workspace.delete"] }), 400);
  });

  it("stops admins giving roles admin powers (owners delegate), but lets them make everyday roles", async () => {
    expect((await expectStatus(createRole(admin, { name: "Channel boss", permissions: ["channels.manage"] }), 403)).error.code).toBe("delegation_required");
    const ann = await createRole(admin, { name: "Announcer", permissions: ["messages.announce"] });
    expect(ann.canEdit).toBe(true);
    // An admin can't edit the owner's Moderator (it holds admin powers they can't delegate).
    const mod = (await roles(admin)).roles.find((r: any) => r.name === "Moderator");
    expect(mod.canEdit).toBe(false);
    await expectStatus(admin.req("PATCH", `/v1/roles/${mod.id}`, { baseRev: mod.rev, name: "Mine now" }), 403);
  });

  it("refuses members without roles.manage, and role ids from other workspaces", async () => {
    await expectStatus(createRole(member, { name: "Self-made", permissions: [] }), 403);
    const foreign = await createRole(outsider, { name: "Foreign" }, otherOrg);
    await expectStatus(owner.req("PATCH", `/v1/roles/${foreign.id}`, { baseRev: 1, name: "Hijacked" }), 404);
    await expectStatus(assign(owner, foreign.id, member), 404);
    await expectStatus(owner.req("GET", `/v1/roles/${foreign.id}/members`), 404);
  });
});

describe("assignments and effective permissions", () => {
  it("grants exactly the role's permissions, enforced on the server, and takes them back at once", async () => {
    const mod = (await roles(owner)).roles.find((r: any) => r.name === "Moderator");
    expect(await perms(member)).not.toContain("channels.manage");
    await expectStatus(member.req("PATCH", `/v1/conversations/${channelId}`, { kind: "PRIVATE" }), 403);
    await assign(owner, mod.id, member);
    await assign(owner, mod.id, member); // twice is harmless
    expect(await perms(member)).toContain("channels.manage");
    await member.req("PATCH", `/v1/conversations/${channelId}`, { kind: "ANNOUNCEMENT" });
    await member.req("PATCH", `/v1/conversations/${channelId}`, { kind: "PUBLIC" });
    const listed = (await owner.req("GET", `/v1/orgs/${orgId}/members`)).members.find((m: any) => m.id === member.userId);
    expect(listed.customRoles.map((r: any) => r.name)).toEqual(["Moderator"]);
    expect((await owner.req("GET", `/v1/roles/${mod.id}/members`)).members.map((m: any) => m.id)).toEqual([member.userId]);
    await unassign(owner, mod.id, member);
    expect(await perms(member)).not.toContain("channels.manage");
    await expectStatus(member.req("PATCH", `/v1/conversations/${channelId}`, { kind: "PRIVATE" }), 403);
  });

  it("never reaches another workspace", async () => {
    const mod = (await roles(owner)).roles.find((r: any) => r.name === "Moderator");
    await expectStatus(assign(owner, mod.id, outsider), 404);
    const c = await outsider.req("POST", "/v1/invites/accept", { code: (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code });
    expect(c.org.id).toBe(orgId);
    await assign(owner, mod.id, outsider);
    // The outsider's own workspace is unaffected by a role in this one.
    expect((await perms(outsider, otherOrg)).length).toBeGreaterThan(20); // they own it
    expect(await perms(outsider)).toContain("channels.manage");
    await owner.req("DELETE", `/v1/orgs/${orgId}/members/${outsider.userId}`);
    // Removing someone removes their assignments with them.
    expect((await owner.req("GET", `/v1/roles/${mod.id}/members`)).members.map((m: any) => m.id)).not.toContain(outsider.userId);
  });

  it("refuses assignments by members, guests, and of roles beyond the assigner's powers", async () => {
    const ann = (await roles(owner)).roles.find((r: any) => r.name === "Announcer");
    const mod = (await roles(owner)).roles.find((r: any) => r.name === "Moderator");
    await expectStatus(assign(member, ann.id, member2), 403);
    await expectStatus(assign(guest, ann.id, guest), 403);
    await assign(admin, ann.id, member2);
    expect((await expectStatus(assign(admin, mod.id, member2), 403)).error.code).toBe("delegation_required");
    await expectStatus(assign(admin, ann.id, owner), 403); // admins don't act on owners
  });

  it("refuses roles guests can't hold", async () => {
    const mod = (await roles(owner)).roles.find((r: any) => r.name === "Moderator");
    expect((await expectStatus(assign(owner, mod.id, guest), 409)).error.code).toBe("not_for_guests");
  });

  it("explains where each permission comes from", async () => {
    const ann = (await roles(owner)).roles.find((r: any) => r.name === "Announcer");
    const r = await owner.req("GET", `/v1/orgs/${orgId}/members/${member2.userId}/permissions`);
    expect(r.base).toBe("MEMBER");
    expect(r.sources["messages.announce"]).toEqual([ann.id]);
    expect(r.sources["members.view"]).toEqual(["base"]);
    await expectStatus(guest.req("GET", `/v1/orgs/${orgId}/members/${member2.userId}/permissions`), 403);
    expect((await member.req("GET", `/v1/orgs/${orgId}/members/${member.userId}/permissions`)).base).toBe("MEMBER");
  });
});

describe("delegated administration", () => {
  it("lets a delegated co-admin manage members, while admins can't undo someone more powerful", async () => {
    const coAdmin = await createRole(owner, { name: "People lead", permissions: ["roles.delegate", "roles.assign", "members.remove", "members.titles", "channels.create"] });
    await assign(owner, coAdmin.id, member);
    // Real powers: create categories, set titles, remove a guest.
    await member.req("POST", `/v1/orgs/${orgId}/categories`, { name: "Chattogram" });
    await member.req("PATCH", `/v1/orgs/${orgId}/members/${member2.userId}`, { title: "Designer" });
    // Not beyond them: admins and owners stay out of reach.
    await expectStatus(member.req("DELETE", `/v1/orgs/${orgId}/members/${admin.userId}`), 403);
    await expectStatus(member.req("PATCH", `/v1/orgs/${orgId}/members/${member2.userId}`, { role: "ADMIN" }), 403);
    // An admin can't remove or re-role the co-admin (they hold roles.delegate, which admins lack).
    await expectStatus(admin.req("DELETE", `/v1/orgs/${orgId}/members/${member.userId}`), 403);
    await expectStatus(unassign(admin, coAdmin.id, member), 403);
    // The owner can.
    await unassign(owner, coAdmin.id, member);
    await expectStatus(member.req("POST", `/v1/orgs/${orgId}/categories`, { name: "Sylhet" }), 403);
  });

  it("doesn't let an admin restrict another admin by editing a role that admin holds", async () => {
    const admin2 = await h.client("admintwo");
    await admin2.req("POST", "/v1/invites/accept", { code: (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "ADMIN" })).invite.code });
    const r = await createRole(owner, { name: "Announcers", permissions: ["messages.announce"] });
    await assign(owner, r.id, admin2);
    // Renaming changes nobody's access; restricting or archiving would change admin2's.
    const renamed = (await admin.req("PATCH", `/v1/roles/${r.id}`, { baseRev: r.rev, name: "Announcements" })).role;
    expect((await expectStatus(admin.req("PATCH", `/v1/roles/${r.id}`, { baseRev: renamed.rev, denies: ["messages.post"] }), 403)).error.code).toBe("holder_out_of_reach");
    await expectStatus(admin.req("PATCH", `/v1/roles/${r.id}`, { baseRev: renamed.rev, archived: true }), 403);
    expect(await perms(admin2)).toContain("messages.post");
    // An owner can.
    await owner.req("PATCH", `/v1/roles/${r.id}`, { baseRev: renamed.rev, denies: ["messages.post"] });
    expect(await perms(admin2)).not.toContain("messages.post");
    await owner.req("DELETE", `/v1/orgs/${orgId}/members/${admin2.userId}`);
  });

  it("doesn't let promoting a guest back hand out admin powers the promoter lacks", async () => {
    const lead = await createRole(owner, { name: "Delegation lead", permissions: ["roles.delegate"] });
    const person = await h.client("demoted");
    await person.req("POST", "/v1/invites/accept", { code: (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code });
    await assign(owner, lead.id, person);
    // The owner demotes them to Guest: the role stays assigned but no longer counts.
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${person.userId}`, { role: "GUEST" });
    expect(await perms(person)).not.toContain("roles.delegate");
    // An admin (without roles.delegate) can't bring it back by promoting them; the owner can.
    await expectStatus(admin.req("PATCH", `/v1/orgs/${orgId}/members/${person.userId}`, { role: "MEMBER" }), 403);
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${person.userId}`, { role: "MEMBER" });
    expect(await perms(person)).toContain("roles.delegate");
    await owner.req("DELETE", `/v1/orgs/${orgId}/members/${person.userId}`);
  });
});

describe("restrictions", () => {
  it("a read-only role stops posting in channels (server-side) and can't be lifted by its holder", async () => {
    const ro = await createRole(owner, { template: "read_only" });
    await assign(owner, ro.id, member2);
    const conv = (await member2.req("GET", `/v1/conversations/${channelId}`)).conversation;
    expect(conv.canPost).toBe(false);
    await expectStatus(member2.send(channelId, { text: "hello?" }), 403);
    // Still reads and still a member.
    expect(await perms(member2)).toContain("members.view");
    await expectStatus(unassign(member2, ro.id, member2), 403);
    await unassign(owner, ro.id, member2);
    expect((await member2.req("GET", `/v1/conversations/${channelId}`)).conversation.canPost).toBe(true);
  });
});

describe("archiving and deleting", () => {
  it("archived roles grant nothing, can be restored, and only archived ones can be deleted", async () => {
    const r = await createRole(owner, { name: "Temporary", permissions: ["messages.announce"] });
    await assign(owner, r.id, member);
    expect(await perms(member)).toContain("messages.announce");
    await expectStatus(owner.req("DELETE", `/v1/roles/${r.id}`), 409);
    const archived = (await owner.req("PATCH", `/v1/roles/${r.id}`, { baseRev: 1, archived: true })).role;
    expect(archived.archived).toBe(true);
    expect(await perms(member)).not.toContain("messages.announce");
    expect((await roles(owner)).roles.map((x: any) => x.id)).not.toContain(r.id);
    expect((await roles(owner, true)).roles.map((x: any) => x.id)).toContain(r.id);
    await expectStatus(assign(owner, r.id, member2), 409);
    const restored = (await owner.req("PATCH", `/v1/roles/${r.id}`, { baseRev: archived.rev, archived: false })).role;
    expect(await perms(member)).toContain("messages.announce");
    await owner.req("PATCH", `/v1/roles/${r.id}`, { baseRev: restored.rev, archived: true });
    await owner.req("DELETE", `/v1/roles/${r.id}`);
    await expectStatus(owner.req("GET", `/v1/roles/${r.id}/members`), 404);
  });
});

describe("ownership", () => {
  it("needs the exact name, a non-guest member, and leaves the previous owner as an admin", async () => {
    await expectStatus(admin.req("POST", `/v1/orgs/${orgId}/ownership`, { userId: admin.userId, confirmName: "Roles Lab" }), 403);
    await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/ownership`, { userId: admin.userId, confirmName: "roles lab" }), 400);
    await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/ownership`, { userId: guest.userId, confirmName: "Roles Lab" }), 409);
    const r = await owner.req("POST", `/v1/orgs/${orgId}/ownership`, { userId: admin.userId, confirmName: "Roles Lab" });
    expect(r).toMatchObject({ ok: true, yourRole: "ADMIN" });
    expect((await admin.req("GET", `/v1/orgs/${orgId}`)).org.myRole).toBe("OWNER");
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).org.myRole).toBe("ADMIN");
    // The last owner can't step down or leave without handing over.
    await expectStatus(admin.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { role: "MEMBER" }), 409);
    await expectStatus(admin.req("DELETE", `/v1/orgs/${orgId}/members/${admin.userId}`), 409);
    // Hand it back for the rest of the suite.
    await admin.req("POST", `/v1/orgs/${orgId}/ownership`, { userId: owner.userId, confirmName: "Roles Lab" });
  });
});

describe("usage and audit", () => {
  it("shows usage figures to people allowed to see them", async () => {
    const u = await owner.req("GET", `/v1/orgs/${orgId}/usage`);
    expect(u.members.total).toBeGreaterThanOrEqual(5);
    expect(u.structure.channels).toBeGreaterThanOrEqual(1);
    expect(u.roles.custom).toBeGreaterThanOrEqual(2);
    expect(u.structure).toMatchObject({ branches: 0, teams: 0 });
    await expectStatus(member.req("GET", `/v1/orgs/${orgId}/usage`), 403);
    const fin = await createRole(owner, { name: "Treasurer", permissions: ["workspace.usage.view"] });
    await assign(owner, fin.id, member);
    expect((await member.req("GET", `/v1/orgs/${orgId}/usage`)).members.total).toBeGreaterThanOrEqual(5);
  });

  it("pages through the audit log for audit.view only, newest first", async () => {
    const first = await owner.req("GET", `/v1/orgs/${orgId}/audit?limit=5`);
    expect(first.entries).toHaveLength(5);
    expect(first.nextBefore).toBe(first.entries[4].id);
    const second = await owner.req("GET", `/v1/orgs/${orgId}/audit?limit=5&before=${first.nextBefore}`);
    expect(second.entries[0].id).toBeLessThan(first.entries[4].id);
    const roleEvents = await owner.req("GET", `/v1/orgs/${orgId}/audit?action=role&limit=100`);
    expect(roleEvents.entries.every((e: any) => e.action.startsWith("role."))).toBe(true);
    expect(roleEvents.entries.map((e: any) => e.action)).toEqual(expect.arrayContaining(["role.create", "role.assign", "role.unassign", "role.archive", "role.delete"]));
    await expectStatus(member.req("GET", `/v1/orgs/${orgId}/audit`), 403);
    // Members' activity feed still hides role administration.
    const feed = await member.req("GET", `/v1/orgs/${orgId}/activity`);
    expect(feed.activity.some((e: any) => e.action.startsWith("role."))).toBe(false);
  });
});
