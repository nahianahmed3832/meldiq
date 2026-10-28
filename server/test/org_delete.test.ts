import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { queuedCount } from "./support/relay.js";

// Only isolated test data on a throwaway server: never a real organization.
describe("deleting an organization", () => {
  let h: Harness;
  let owner: GriipClient, coOwner: GriipClient, admin: GriipClient, member: GriipClient, outsider: GriipClient;
  let orgId: string, otherOrg: string, channel: string, dm: string, group: string, fileId: string, otherChannel: string;

  const join = async (by: GriipClient, c: GriipClient, org: string, role: string) => {
    const code = (await by.req("POST", `/v1/orgs/${org}/invites`, { role })).invite.code;
    await c.req("POST", "/v1/invites/accept", { code });
  };

  beforeAll(async () => {
    h = await startServer();
    owner = await h.client("owner");
    coOwner = await h.client("coowner");
    admin = await h.client("admin");
    member = await h.client("member");
    outsider = await h.client("outsider");
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Test Org To Delete" })).org.id;
    await join(owner, admin, orgId, "ADMIN");
    await join(owner, member, orgId, "MEMBER");
    await join(owner, coOwner, orgId, "MEMBER");
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${coOwner.userId}`, { role: "OWNER" });
    channel = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "general-test", scope: "ORG", autoJoin: true })).channel.id;
    await member.req("POST", `/v1/conversations/${channel}/join`).catch(() => {});
    // A file in the channel, an outstanding invitation, and things that must survive.
    fileId = (await member.req("POST", `/v1/attachments?conversationId=${channel}`, undefined, crypto.randomBytes(2000))).id;
    await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" });
    dm = (await owner.req("POST", "/v1/conversations/dm", { userId: member.userId })).conversation.id;
    group = (await owner.req("POST", "/v1/conversations/group", { name: "Friends", memberIds: [member.userId, admin.userId] })).conversation.id;
    otherOrg = (await member.req("POST", "/v1/orgs", { name: "Unrelated Org" })).org.id;
    await join(member, owner, otherOrg, "MEMBER");
    otherChannel = (await member.req("POST", `/v1/orgs/${otherOrg}/channels`, { name: "keep-me", scope: "ORG", autoJoin: true })).channel.id;
  });
  afterAll(async () => h.close());

  it("is refused to admins, members and outsiders, and without the exact name", async () => {
    await expectStatus(admin.req("DELETE", `/v1/orgs/${orgId}`, { confirmName: "Test Org To Delete" }), 403);
    await expectStatus(member.req("DELETE", `/v1/orgs/${orgId}`, { confirmName: "Test Org To Delete" }), 403);
    await expectStatus(outsider.req("DELETE", `/v1/orgs/${orgId}`, { confirmName: "Test Org To Delete" }), 404);
    const wrong = await owner.req("DELETE", `/v1/orgs/${orgId}`, { confirmName: "test org to delete" }).catch((e) => e);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("confirm_mismatch");
    await expectStatus(owner.req("DELETE", `/v1/orgs/${orgId}`, {}), 400);
    expect(h.ctx.ws.get("orgs", { id: orgId })).toBeTruthy();
  });

  it("an owner deletes it: members, channels, files and invitations go; accounts, DMs, groups and other orgs stay", async () => {
    await member.connect();
    const requestId = crypto.randomUUID();
    const r = await owner.req("DELETE", `/v1/orgs/${orgId}`, { confirmName: "Test Org To Delete", requestId });
    // The channel made here plus the five every community starts with.
    expect(r).toMatchObject({ deleted: true, orgId, channels: 6, files: 1 });
    expect(r.members).toBe(4);
    // Gone for everyone.
    await expectStatus(owner.req("GET", `/v1/orgs/${orgId}`), 404);
    await expectStatus(member.req("GET", `/v1/conversations/${channel}`), 404);
    expect((await member.req("GET", "/v1/orgs")).orgs.map((o: any) => o.id)).not.toContain(orgId);
    expect((await member.req("GET", "/v1/conversations")).conversations.map((c: any) => c.id)).not.toContain(channel);
    await expectStatus(member.req("GET", `/v1/attachments/${fileId}`), 404);
    expect(fs.existsSync(path.join(h.dir, "attachments", fileId))).toBe(false);
    for (const t of ["org_members", "invitations", "branches", "teams", "channel_categories", "channel_overwrites", "org_bans", "org_roles"]) {
      expect((h.ctx.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE org_id = ?`).get(orgId) as { n: number }).n).toBe(0);
    }
    await expect.poll(() => queuedCount(h, (r) => r.conversation_id === channel)).toBe(0);
    // Untouched.
    expect((await member.req("GET", `/v1/conversations/${dm}`)).conversation.id).toBe(dm);
    expect((await admin.req("GET", `/v1/conversations/${group}`)).conversation.id).toBe(group);
    expect((await owner.req("GET", `/v1/orgs/${otherOrg}`)).org.id).toBe(otherOrg);
    expect((await owner.req("GET", `/v1/conversations/${otherChannel}`)).conversation.id).toBe(otherChannel);
    for (const c of [owner, coOwner, admin, member]) expect((await c.req("GET", "/v1/users/me")).user.id).toBe(c.userId);
    // Devices are told.
    await member.waitFor(() => member.events.find((e) => e.t === "org.deleted" && e.orgId === orgId));
    await member.waitFor(() => member.events.find((e) => e.t === "conv.updated" && e.conversationId === channel));
    // Audited, without content.
    const audit = h.ctx.ws.get<any>("audit_log", { action: "org.delete", org_id: orgId });
    expect(audit.actor_id).toBe(owner.userId);
    expect(audit.detail).not.toContain("Test Org");
    // Retrying the same request gets the same answer; anything else gets 404.
    expect(await owner.req("DELETE", `/v1/orgs/${orgId}`, { confirmName: "Test Org To Delete", requestId })).toEqual(r);
    await expectStatus(coOwner.req("DELETE", `/v1/orgs/${orgId}`, { confirmName: "Test Org To Delete", requestId }), 404);
    await expectStatus(owner.req("DELETE", `/v1/orgs/${orgId}`, { confirmName: "Test Org To Delete" }), 404);
  });

  it("two owners deleting at the same time: exactly one deletion happens", async () => {
    const o = (await owner.req("POST", "/v1/orgs", { name: "Race Org" })).org.id;
    await join(owner, coOwner, o, "MEMBER");
    await owner.req("PATCH", `/v1/orgs/${o}/members/${coOwner.userId}`, { role: "OWNER" });
    const results = await Promise.allSettled([
      owner.req("DELETE", `/v1/orgs/${o}`, { confirmName: "Race Org" }),
      coOwner.req("DELETE", `/v1/orgs/${o}`, { confirmName: "Race Org" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.status).toBe(404);
    expect(h.ctx.ws.count("org_deletions", { org_id: o })).toBe(1);
  });

  it("the organization's name can be used again afterwards", async () => {
    const again = await owner.req("POST", "/v1/orgs", { name: "Test Org To Delete" });
    expect(again.org.id).not.toBe(orgId);
  });
});
