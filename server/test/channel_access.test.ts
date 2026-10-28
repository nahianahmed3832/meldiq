import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Round 7, bug 6: people added to a workspace couldn't see or post in its channels. Org-wide public channels created
 * without an explicit `autoJoin` (neither app sends one) were stored as not auto-joined, so neither the members there
 * at creation nor people who joined later were added. The whole member journey, end to end.
 */
let h: Harness;
let owner: GriipClient, member: GriipClient, outsider: GriipClient;
let orgId: string, general: string, secret: string, optIn: string;

const myChannels = async (c: GriipClient) =>
  ((await c.req("GET", "/v1/conversations")).conversations as { id: string; type: string; canPost: boolean }[]).filter((x) => x.type === "CHANNEL");

beforeAll(async () => {
  h = await startServer();
  [owner, member, outsider] = await Promise.all(["chowner", "chmember", "choutsider"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Access Co" })).org.id;
  // Created before the member joins, the way the apps create them: no autoJoin field.
  general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "general", scope: "ORG", kind: "PUBLIC" })).channel.id;
  secret = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "leadership", scope: "ORG", kind: "PRIVATE" })).channel.id;
  optIn = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "random", scope: "ORG", kind: "PUBLIC", autoJoin: false })).channel.id;
  const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
  await member.req("POST", "/v1/invites/accept", { code });
  await Promise.all([owner, member].map((c) => c.connect()));
});
afterAll(async () => {
  await Promise.all([owner, member].map((c) => c.disconnect()));
  await h.close();
});

describe("workspace members and channels (round 7, bug 6)", () => {
  it("a new member is in the org-wide public channel and may post there", async () => {
    const mine = await myChannels(member);
    expect(mine.map((c) => c.id)).toContain(general);
    expect(mine.find((c) => c.id === general)?.canPost).toBe(true);
  });

  it("members already in the workspace join a public channel created later", async () => {
    const later = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "announcements-chat", scope: "ORG", kind: "PUBLIC" })).channel.id;
    expect((await myChannels(member)).map((c) => c.id)).toContain(later);
  });

  it("an opt-in public channel is listed for joining, and joining works", async () => {
    expect((await myChannels(member)).map((c) => c.id)).not.toContain(optIn);
    const listed = (await member.req("GET", `/v1/orgs/${orgId}/channels`)).channels as { id: string; joined: boolean }[];
    expect(listed.find((c) => c.id === optIn)).toMatchObject({ joined: false });
    await member.req("POST", `/v1/conversations/${optIn}/join`);
    expect((await myChannels(member)).map((c) => c.id)).toContain(optIn);
  });

  it("messages and attachments reach the channel, live", async () => {
    await member.send(general, { type: "text", text: "hello team" });
    await owner.waitFor(() => owner.received.find((m) => (m.payload as { text?: string }).text === "hello team"));
    const up = await member.req("POST", `/v1/attachments?conversationId=${general}`, undefined, Buffer.from("encrypted bytes"));
    expect(up.id).toBeTruthy();
  });

  it("a private channel stays hidden and closed to members who aren't invited", async () => {
    expect((await myChannels(member)).map((c) => c.id)).not.toContain(secret);
    const listed = (await member.req("GET", `/v1/orgs/${orgId}/channels`)).channels as { id: string }[];
    expect(listed.map((c) => c.id)).not.toContain(secret);
    await expectStatus(member.req("POST", `/v1/conversations/${secret}/join`), 404);
    await expectStatus(member.req("GET", `/v1/conversations/${secret}`), 404);
    await expectStatus(member.req("POST", `/v1/attachments?conversationId=${secret}`, undefined, Buffer.from("x")), 404);
  });

  it("an invitation from a channel manager opens the private channel", async () => {
    await owner.req("PUT", `/v1/conversations/${secret}/members/${member.userId}`, { role: "MEMBER" });
    expect((await myChannels(member)).map((c) => c.id)).toContain(secret);
  });

  it("people outside the workspace see none of it", async () => {
    await expectStatus(outsider.req("GET", `/v1/conversations/${general}`), 404);
    await expectStatus(outsider.req("POST", `/v1/conversations/${general}/join`), 404);
    expect(await myChannels(outsider)).toEqual([]);
  });

  it("an ordinary member can't manage channels", async () => {
    await expectStatus(member.req("PATCH", `/v1/conversations/${general}`, { name: "renamed" }), 403);
    await expectStatus(member.req("PUT", `/v1/conversations/${secret}/members/${outsider.userId}`, { role: "MEMBER" }), 403);
  });

  it("the repair adds members to public channels created as opt-in before the fix, except people who left", async () => {
    const t = Date.now();
    // Two channels as the old server stored them: opt-in, with only their creator.
    for (const [id, name] of [["c_legacy1", "legacy-general"], ["c_legacy2", "legacy-left"]]) {
      await h.ctx.ws.write((w) => {
        w.insert("conversations", { id, type: "CHANNEL", org_id: orgId, scope: "ORG", kind: "PUBLIC", name, auto_join: 0, created_by: owner.userId, created_at: t, updated_at: t });
        w.insert("conversation_members", { conversation_id: id, user_id: owner.userId, role: "ADMIN", joined_at: t });
      });
    }
    await h.ctx.ws.write((w) => w.insert("audit_log", { at: t, actor_id: member.userId, org_id: orgId, action: "channel.leave", target: `c_legacy2:${member.userId}` }));
    const { planChannelAccessRepair, applyChannelAccessRepair } = await import("../src/modules/messaging/channelRepair.js");
    const plan = planChannelAccessRepair(h.ctx.ws).filter((r) => r.channelId.startsWith("c_legacy"));
    expect(plan.find((r) => r.channelId === "c_legacy1")?.add).toEqual([member.userId]);
    expect(plan.find((r) => r.channelId === "c_legacy2")).toMatchObject({ add: [], skippedLeft: 1 });
    await applyChannelAccessRepair(h.ctx.ws, plan, t);
    const ids = (await myChannels(member)).map((c) => c.id);
    expect(ids).toContain("c_legacy1");
    expect(ids).not.toContain("c_legacy2");
    expect(planChannelAccessRepair(h.ctx.ws).filter((r) => r.channelId.startsWith("c_legacy"))).toEqual([]);
    // The opt-in channel created with an explicit autoJoin: false above is listed too: the operator sees it in the dry
    // run before applying (the apps never sent that flag, so old opt-in channels were all defaults).
  });

  it("a guest isn't auto-joined, and removing someone from the workspace closes its channels", async () => {
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${member.userId}`, { role: "GUEST" });
    expect((await myChannels(member)).map((c) => c.id)).not.toContain(general);
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${member.userId}`, { role: "MEMBER" });
    await owner.req("DELETE", `/v1/orgs/${orgId}/members/${member.userId}`);
    await expectStatus(member.req("GET", `/v1/conversations/${general}`), 404);
  });
});
