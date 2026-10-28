import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LiveKitService } from "../src/modules/calls/livekit.js";
import { nextForumTags } from "../src/modules/messaging/conversationsRoutes.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * The Discord reference round (docs/product/MELDIQ_ANDROID_INTERACTION_MATRIX.md): voice channel permissions (join,
 * speak), forum tags, and deleting a channel. Through the API, as an app or someone bypassing one would call it.
 */

/** Stands in for LiveKit and remembers the grants of every token it issued. */
class GrantRecorder {
  publicUrl = "ws://livekit.test";
  tokens: { identity: string; canPublish: boolean }[] = [];
  deleted: string[] = [];
  async token(p: { identity: string; canPublish?: boolean }) {
    this.tokens.push({ identity: p.identity, canPublish: p.canPublish ?? true });
    return `token:${p.identity}`;
  }
  async deleteRoom(room: string) {
    this.deleted.push(room);
  }
  async participantIdentities() {
    return [];
  }
  async participantUsers() {
    return new Set<string>();
  }
  async removeParticipant() {
    return "absent" as const;
  }
}

let h: Harness;
let lk: GrantRecorder;
let owner: GriipClient, member: GriipClient, listener: GriipClient, outsider: GriipClient;
let orgId: string, listenerRole: string;

beforeAll(async () => {
  h = await startServer();
  owner = await h.client("rowner");
  member = await h.client("rmember");
  listener = await h.client("rlistener");
  outsider = await h.client("routsider");
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Signal Garden" })).org.id;
  for (const c of [member, listener]) {
    const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
    await c.req("POST", "/v1/invites/accept", { code });
  }
  listenerRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Listener", permissions: [], denies: [] })).role.id;
  await owner.req("PUT", `/v1/roles/${listenerRole}/members/${listener.userId}`);
});
afterAll(async () => h.close());
beforeEach(() => {
  lk = new GrantRecorder();
  h.ctx.livekit = lk as unknown as LiveKitService;
});

const lastGrant = (c: GriipClient) => lk.tokens.filter((t) => t.identity.startsWith(c.userId + ".")).at(-1);

describe("voice channel permissions", () => {
  it("let members join and speak by default, and say so on the channel", async () => {
    const stage = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "stage", voice: true })).channel;
    expect((await member.req("GET", `/v1/conversations/${stage.id}`)).conversation).toMatchObject({ voice: true, canConnect: true, canSpeak: true });
    const r = await member.req("POST", "/v1/calls", { conversationId: stage.id, video: false });
    expect(r.media.canSpeak).toBe(true);
    expect(lastGrant(member)?.canPublish).toBe(true);
  });

  it("make a role listen-only with a channel overwrite: it joins, its token can't publish", async () => {
    const talk = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "talk", voice: true })).channel;
    await owner.req("PUT", `/v1/conversations/${talk.id}/overwrites`, { subject: listenerRole, deny: ["voice.speak"] });
    expect((await listener.req("GET", `/v1/conversations/${talk.id}`)).conversation).toMatchObject({ canConnect: true, canSpeak: false });
    const started = await member.req("POST", "/v1/calls", { conversationId: talk.id, video: false });
    const joined = await listener.req("POST", `/v1/calls/${started.call.id}/join`);
    expect(joined.media.canSpeak).toBe(false);
    expect(lastGrant(listener)?.canPublish).toBe(false);
    // Starting the call yourself gives the same listen-only token.
    const again = await listener.req("POST", "/v1/calls", { conversationId: talk.id, video: false });
    expect(again.media.canSpeak).toBe(false);
  });

  it("refuse joining or opening a voice channel without voice.connect; owners skip overwrites", async () => {
    const quiet = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "quiet-room", voice: true })).channel;
    await owner.req("PUT", `/v1/conversations/${quiet.id}/overwrites`, { subject: "everyone", deny: ["voice.connect"] });
    expect((await member.req("GET", `/v1/conversations/${quiet.id}`)).conversation.canConnect).toBe(false);
    await expectStatus(member.req("POST", "/v1/calls", { conversationId: quiet.id, video: false }), 403);
    const call = await owner.req("POST", "/v1/calls", { conversationId: quiet.id, video: false });
    expect(call.media.canSpeak).toBe(true);
    await expectStatus(member.req("POST", `/v1/calls/${call.call.id}/join`), 403);
    // Not a member of the community at all: the call is not found.
    await expectStatus(outsider.req("POST", `/v1/calls/${call.call.id}/join`), 404);
  });

  it("keep the community-wide restriction of a role: no channel allow lifts it", async () => {
    const hush = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Hushed", permissions: [], denies: ["voice.speak"] })).role.id;
    const open = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "open-mic", voice: true })).channel;
    await owner.req("PUT", `/v1/conversations/${open.id}/overwrites`, { subject: "everyone", allow: ["voice.speak"] });
    await owner.req("PUT", `/v1/roles/${hush}/members/${member.userId}`);
    expect((await member.req("GET", `/v1/conversations/${open.id}`)).conversation.canSpeak).toBe(false);
    await owner.req("DELETE", `/v1/roles/${hush}/members/${member.userId}`);
    expect((await member.req("GET", `/v1/conversations/${open.id}`)).conversation.canSpeak).toBe(true);
  });

  it("don't limit calls outside communities", async () => {
    const group = (await member.req("POST", "/v1/conversations/group", { name: "Pals", memberIds: [outsider.userId] })).conversation;
    const r = await member.req("POST", "/v1/calls", { conversationId: group.id, video: false });
    expect(r.media.canSpeak).toBe(true);
    expect(lastGrant(member)?.canPublish).toBe(true);
  });
});

describe("forum tags", () => {
  it("are kept per forum: names trimmed, duplicates dropped, ids stable across renames of other tags", async () => {
    const forum = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "ideas", format: "forum" })).channel;
    const set = await owner.req("PATCH", `/v1/conversations/${forum.id}`, { forumTags: [{ name: " Bug " }, { name: "Idea" }, { name: "bug" }, { name: "" }] });
    const tags = set.conversation.forumTags as { id: string; name: string }[];
    expect(tags.map((t) => t.name)).toEqual(["Bug", "Idea"]);
    // Renaming "Idea" by id keeps its id; "Bug" sent without an id keeps its id by name.
    const renamed = await owner.req("PATCH", `/v1/conversations/${forum.id}`, { forumTags: [{ name: "bug" }, { id: tags[1].id, name: "Ideas" }] });
    expect(renamed.conversation.forumTags).toEqual([
      { id: tags[0].id, name: "bug" },
      { id: tags[1].id, name: "Ideas" },
    ]);
    // Members see them; they can't change them.
    expect((await member.req("GET", `/v1/conversations/${forum.id}`)).conversation.forumTags).toHaveLength(2);
    await expectStatus(member.req("PATCH", `/v1/conversations/${forum.id}`, { forumTags: [] }), 403);
  });

  it("refuse tags on text channels and more than 20", async () => {
    const text = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "plain" })).channel;
    await expectStatus(owner.req("PATCH", `/v1/conversations/${text.id}`, { forumTags: [{ name: "x" }] }), 400);
    expect((await owner.req("GET", `/v1/conversations/${text.id}`)).conversation.forumTags).toEqual([]);
    const forum = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "many", format: "forum" })).channel;
    await expectStatus(owner.req("PATCH", `/v1/conversations/${forum.id}`, { forumTags: Array.from({ length: 21 }, (_, i) => ({ name: `t${i}` })) }), 400);
  });

  it("merge a manager's list without losing ids (pure rule)", () => {
    let n = 0;
    const make = () => `tag_${++n}`;
    expect(nextForumTags([], [{ name: "A" }, { name: "a" }, { name: "  " }], make)).toEqual([{ id: "tag_1", name: "A" }]);
    expect(nextForumTags([{ id: "t1", name: "A" }], [{ id: "t1", name: "B" }, { name: "A" }], make)).toEqual([
      { id: "t1", name: "B" },
      { id: "tag_2", name: "A" },
    ]);
  });
});

describe("deleting a channel", () => {
  it("needs the channel's managers and its exact name; removes its messages and files for everyone", async () => {
    const doomed = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "old-news" })).channel;
    await member.req("POST", `/v1/conversations/${doomed.id}/join`).catch(() => undefined);
    await member.send(doomed.id, { type: "text", text: "last words" });
    await owner.req("POST", `/v1/attachments?conversationId=${doomed.id}`, undefined, crypto.randomBytes(128));
    await expectStatus(member.req("DELETE", `/v1/conversations/${doomed.id}`, { confirmName: "old-news" }), 403);
    const wrong = await expectStatus(owner.req("DELETE", `/v1/conversations/${doomed.id}`, { confirmName: "old" }), 400);
    expect(wrong.error.code).toBe("confirm_mismatch");
    const r = await owner.req("DELETE", `/v1/conversations/${doomed.id}`, { confirmName: "#old-news" });
    expect(r).toMatchObject({ deleted: true, id: doomed.id, files: 1 });
    await expectStatus(member.req("GET", `/v1/conversations/${doomed.id}`), 404);
    await expectStatus(owner.req("GET", `/v1/conversations/${doomed.id}`), 404);
    const left = (await owner.req("GET", `/v1/orgs/${orgId}/channels`)).channels.map((c: any) => c.id);
    expect(left).not.toContain(doomed.id);
    const audit = h.ctx.ws.get<{ detail: string }>("audit_log", { action: "channel.delete", target: doomed.id });
    expect(audit?.detail).toContain("old-news");
  });

  it("refuse deleting groups and direct conversations (people leave those)", async () => {
    const group = (await member.req("POST", "/v1/conversations/group", { name: "Mine", memberIds: [outsider.userId] })).conversation;
    await expectStatus(member.req("DELETE", `/v1/conversations/${group.id}`, { confirmName: "Mine" }), 400);
  });

  it("let a moderator role that manages channels delete one, and take its overwrites with it", async () => {
    const mod = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Gardener", permissions: ["channels.manage"], denies: [] })).role.id;
    await owner.req("PUT", `/v1/roles/${mod}/members/${member.userId}`);
    const weeds = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "weeds" })).channel;
    await owner.req("PUT", `/v1/conversations/${weeds.id}/overwrites`, { subject: "everyone", deny: ["messages.attach"] });
    await member.req("DELETE", `/v1/conversations/${weeds.id}`, { confirmName: "weeds" });
    const left = { n: h.ctx.ws.count("channel_overwrites", { target_type: "channel", target_id: weeds.id }) };
    expect(left.n).toBe(0);
  });
});
