import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RolesOverview } from "../src/shared/contracts/http/roles.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Community parity A1 (feature "community-permissions", docs/COMMUNITY_PERMISSIONS.md): the new message permissions and
 * where they're enforced, the community's "@everyone" defaults, nicknames, role extras and order, and channel options
 * (text only, no GIFs, read-only, stage). Runs on memory and on MongoDB (the workspace rows there too).
 */

const MONGO_DOMAINS = "preferences,reports,relationships,history,accounts,files,relay,billing,platform,federation,calls,workspace,conversations";

let n = 0;
const nextId = (tag: string) => `m_cp_${tag}_${++n}_${Date.now()}`;
const say = (c: GriipClient, conv: string, payload: Record<string, unknown>) => c.send(conv, { type: "text", text: "hi", ...payload }, "message", nextId("msg"));
const change = (c: GriipClient, conv: string, payload: Record<string, unknown>) => c.send(conv, payload, "control", nextId("ctl"));
const code = (e: { error: { code: string } }) => e.error.code;
const refused = async (p: Promise<unknown>, status: number) => code(await expectStatus(p, status));
const voiceNote = { id: "att_voice_1", name: "voice.ogg", mime: "audio/ogg", size: 1000, key: "k", nonce: "n", sha256: "s", voice: true };

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
  ["memory", {}],
  ["mongodb", { MONGODB_DOMAINS: MONGO_DOMAINS }],
] as const)("community permissions kept in %s", (_backend, env) => {
  // MongoDB in tests can be slow on a busy machine: each step gets a minute (the describe's last argument).
  let h: Harness;
  let owner: GriipClient, mod: GriipClient, member: GriipClient, other: GriipClient;
  let orgId: string, general: string, invite: string;
  const role = async (body: Record<string, unknown>) => (await owner.req("POST", `/v1/orgs/${orgId}/roles`, body)).role;
  const give = (roleId: string, c: GriipClient) => owner.req("PUT", `/v1/roles/${roleId}/members/${c.userId}`);
  const channel = async (body: Record<string, unknown>) => (await owner.req("POST", `/v1/orgs/${orgId}/channels`, body)).channel;
  const view = async (c: GriipClient, conv: string) => (await c.req("GET", `/v1/conversations/${conv}`)).conversation;

  beforeAll(async () => {
    h = await startServer({ ...env, MENTION_ALL_MEMBER_LIMIT: "2" });
    [owner, mod, member, other] = await Promise.all(["cpowner", "cpmod", "cpmember", "cpother"].map((x) => h.client(x)));
    for (const c of [owner, mod, member, other]) c.serverMessages = true;
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Parity Place" })).org.id;
    invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [mod, member, other]) await c.req("POST", "/v1/invites/accept", { code: invite });
    const moderator = await role({ template: "moderator" });
    await give(moderator.id, mod);
    general = await channel({ name: "general" }).then((c) => c.id);
  }, 120_000);
  afterAll(async () => h.close());

  it("is advertised, and the catalog carries the new keys with everyday ones held by default", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("community-permissions");
    const overview = await member.req("GET", `/v1/orgs/${orgId}/roles`);
    expect(RolesOverview.safeParse(overview).success).toBe(true);
    const keys = overview.catalog.map((p: { key: string }) => p.key);
    for (const k of ["messages.react", "messages.embed", "messages.manage", "threads.manage", "messages.history", "members.nicknames"]) expect(keys).toContain(k);
    expect(overview.everyone).toMatchObject({ customized: false, updatedAt: null });
    expect(overview.everyone.permissions).toEqual(expect.arrayContaining(["messages.react", "messages.embed", "threads.create", "members.nickname"]));
    expect(overview.everyone.allowed).not.toContain("messages.manage");
    expect(overview.me.permissions).not.toContain("messages.manage");
  });

  it("lets owners change what plain members may do by default, within their own powers", async () => {
    const without = (overview: { everyone: { permissions: string[] } }, drop: string[]) => overview.everyone.permissions.filter((p) => !drop.includes(p));
    const now = await owner.req("GET", `/v1/orgs/${orgId}/roles`);
    const body = { permissions: without(now, ["messages.embed", "messages.polls"]) };
    expect(await refused(member.req("PUT", `/v1/orgs/${orgId}/roles/everyone`, body), 403)).toBe("forbidden");
    expect(await refused(owner.req("PUT", `/v1/orgs/${orgId}/roles/everyone`, { permissions: [...body.permissions, "messages.manage"] }), 400)).toBe("not_member_safe");
    const v = (await owner.req("PUT", `/v1/orgs/${orgId}/roles/everyone`, body)).everyone;
    expect(v).toMatchObject({ customized: true });
    expect(v.permissions).not.toContain("messages.embed");
    expect(await refused(say(member, general, { text: "see https://example.com/x" }), 403)).toBe("links_not_allowed");
    expect(await refused(say(member, general, { link: { url: "https://example.com" } }), 403)).toBe("links_not_allowed");
    expect(await refused(say(member, general, { poll: { question: "Pizza?", options: [{ id: "a", text: "yes" }] } }), 403)).toBe("polls_not_allowed");
    // Roles still add what @everyone lacks; owners and admins hold everything anyway.
    await say(owner, general, { text: "https://example.com" });
    const linker = await role({ name: "Linker", permissions: ["messages.embed"] });
    await give(linker.id, other);
    await say(other, general, { text: "https://example.com/ok" });
    // The base role in the overview follows the community's defaults.
    const base = (await member.req("GET", `/v1/orgs/${orgId}/roles`)).baseRoles.find((b: { key: string }) => b.key === "MEMBER");
    expect(base.permissions).not.toContain("messages.embed");
    // Saving the standard set again removes the community's own.
    const reset = (await owner.req("PUT", `/v1/orgs/${orgId}/roles/everyone`, { permissions: v.standard })).everyone;
    expect(reset).toMatchObject({ customized: false });
    await say(member, general, { text: "https://example.com/back" });
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "everyone.update" })).toBe(2);
  });

  it("refuses what a restricting role takes away, and allows what it leaves", async () => {
    const quiet = await role({ name: "Quiet", denies: ["messages.react", "messages.voice", "messages.external_emoji", "messages.big_text", "threads.create"] });
    await give(quiet.id, member);
    const posted = await say(owner, general, { text: "react to me" });
    expect(await refused(change(member, general, { type: "reaction", target: posted.messageId, emoji: "🎉", add: true }), 403)).toBe("reactions_not_allowed");
    await change(owner, general, { type: "reaction", target: posted.messageId, emoji: "🎉", add: true });
    await change(member, general, { type: "reaction", target: posted.messageId, emoji: "🎉", add: true });
    await change(member, general, { type: "reaction", target: posted.messageId, emoji: "🎉", add: false });
    expect(await refused(say(member, general, { attachments: [voiceNote] }), 403)).toBe("voice_messages_not_allowed");
    await say(member, general, { attachments: [{ ...voiceNote, voice: false, name: "photo.jpg", mime: "image/jpeg" }] });
    const elsewhere = { id: "e1", orgId: "o_somewhere_else", name: "wave", sha256: "x", animated: false };
    expect(await refused(say(member, general, { text: ":wave:", customEmoji: [elsewhere] }), 403)).toBe("external_emoji_not_allowed");
    await say(member, general, { text: ":wave:", customEmoji: [{ ...elsewhere, orgId }] });
    expect(await refused(say(member, general, { text: "# Big news" }), 403)).toBe("headings_not_allowed");
    const mine = await say(member, general, { text: "#hashtags are fine" });
    expect(await refused(change(member, general, { type: "edit", target: mine.messageId, text: "## now a heading" }), 403)).toBe("headings_not_allowed");
    // Threads: the first reply starts one; later replies need threads.post.
    const root = await say(owner, general, { text: "Thread here" });
    expect(await refused(say(member, general, { threadRoot: root.messageId }), 403)).toBe("threads_not_allowed");
    await say(other, general, { threadRoot: root.messageId, text: "first" });
    await say(member, general, { threadRoot: root.messageId, text: "joining in" });
    await owner.req("PATCH", `/v1/roles/${quiet.id}`, { baseRev: quiet.rev, denies: ["threads.post"] });
    expect(await refused(say(member, general, { threadRoot: root.messageId, text: "again" }), 403)).toBe("thread_replies_not_allowed");
    await owner.req("DELETE", `/v1/roles/${quiet.id}/members/${member.userId}`);
  });

  it("takes channel overwrites of the new powers", async () => {
    const noLinks = await channel({ name: "no-links" });
    await owner.req("PUT", `/v1/conversations/${noLinks.id}/overwrites`, { subject: "everyone", allow: [], deny: ["messages.embed", "messages.polls"] });
    expect(await refused(say(member, noLinks.id, { text: "https://example.com" }), 403)).toBe("links_not_allowed");
    await say(mod, noLinks.id, { text: "plain words" });
    await say(member, general, { text: "https://example.com/general" });
  });

  it("starts history at joining for people without messages.history", async () => {
    const vault = await channel({ name: "vault", kind: "PRIVATE" });
    const before = await say(owner, vault.id, { text: "before anyone else" });
    const hidden = await role({ name: "Newcomer", denies: ["messages.history"] });
    await give(hidden.id, member);
    await new Promise((r) => setTimeout(r, 5));
    for (const c of [member, other]) await owner.req("PUT", `/v1/conversations/${vault.id}/members/${c.userId}`, { role: "MEMBER" });
    await new Promise((r) => setTimeout(r, 5));
    const after = await say(owner, vault.id, { text: "after they joined" });
    const seen = (c: GriipClient) => c.req("GET", `/v2/conversations/${vault.id}/messages`).then((p) => p.messages.map((m: { id: string }) => m.id));
    expect(await seen(member)).toEqual([after.messageId]);
    expect(await seen(other)).toEqual([after.messageId, before.messageId]);
    expect((await member.req("GET", `/v2/messages/search?q=anyone&conversationId=${vault.id}`)).messages).toEqual([]);
    await owner.req("DELETE", `/v1/roles/${hidden.id}/members/${member.userId}`);
    expect(await seen(member)).toEqual([after.messageId, before.messageId]);
  });

  it("lets message moderators delete and pin anyone's messages and skip slowmode", async () => {
    const slow = await channel({ name: "slow", slowmodeSec: 60 });
    expect((await view(member, slow.id)).slowmodeSec).toBe(60);
    const theirs = await say(member, slow.id, { text: "mine" });
    expect(await refused(say(member, slow.id, { text: "again" }), 429)).toBe("slowmode");
    await say(mod, slow.id, { text: "one" });
    await say(mod, slow.id, { text: "two" });
    expect(await refused(change(other, slow.id, { type: "delete", target: theirs.messageId }), 403)).toBe("not_yours");
    expect(await refused(change(other, slow.id, { type: "pin", target: theirs.messageId, pinned: true }), 403)).toBe("manage_messages_required");
    await change(mod, slow.id, { type: "pin", target: theirs.messageId, pinned: true });
    await change(mod, slow.id, { type: "delete", target: theirs.messageId });
    // threads.manage: only messages inside threads.
    const keeper = await role({ name: "Thread keeper", permissions: ["threads.manage"] });
    await give(keeper.id, other);
    const root = await say(owner, general, { text: "root" });
    const reply = await say(member, general, { threadRoot: root.messageId, text: "reply" });
    expect(await refused(change(other, general, { type: "delete", target: root.messageId }), 403)).toBe("not_yours");
    await change(other, general, { type: "delete", target: reply.messageId });
  });

  it("lets holders of messages.mention_all mention everyone and any role", async () => {
    expect(await refused(member.send(general, { type: "text", text: "@everyone" }, "message", nextId("all"), { mentionAll: true }), 403)).toBe("mention_all_not_allowed");
    const loud = await role({ name: "Loud", permissions: ["messages.mention_all"] });
    await give(loud.id, other);
    await other.send(general, { type: "text", text: "@everyone" }, "message", nextId("all"), { mentionAll: true });
    const team = await role({ name: "Team" });
    expect(await refused(say(member, general, { roleMentions: [team.id] }), 403)).toBe("role_mention_not_allowed");
    await say(other, general, { roleMentions: [team.id] });
    await owner.req("PUT", `/v1/roles/${team.id}/extras`, { mentionable: true });
    await say(member, general, { roleMentions: [team.id] });
  });

  it("keeps nicknames per community, within each person's reach", async () => {
    const put = (c: GriipClient, who: GriipClient, nickname: string | null) => c.req("PUT", `/v1/orgs/${orgId}/members/${who.userId}/nickname`, { nickname });
    expect(await put(member, member, "  Sunny  ")).toEqual({ userId: member.userId, nickname: "Sunny" });
    expect(await refused(put(member, member, "x".repeat(33)), 400)).toBe("bad_request");
    const listed = (await owner.req("GET", `/v1/orgs/${orgId}/members`)).members;
    expect(listed.find((m: { id: string }) => m.id === member.userId).nickname).toBe("Sunny");
    expect(listed.find((m: { id: string }) => m.id === owner.userId).nickname).toBeNull();
    expect(await refused(put(member, other, "Grumpy"), 403)).toBe("nicknames_not_allowed");
    await put(mod, other, "Helper");
    expect(await refused(put(mod, owner, "Boss"), 403)).toBe("nicknames_not_allowed");
    expect(await put(member, member, "")).toEqual({ userId: member.userId, nickname: null });
    const everyone = (await owner.req("GET", `/v1/orgs/${orgId}/roles`)).everyone;
    await owner.req("PUT", `/v1/orgs/${orgId}/roles/everyone`, { permissions: everyone.permissions.filter((p: string) => p !== "members.nickname") });
    expect(await refused(put(member, member, "Again"), 403)).toBe("nickname_not_allowed");
    await owner.req("PUT", `/v1/orgs/${orgId}/roles/everyone`, { permissions: everyone.standard });
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "member.nickname" })).toBe(3);
  });

  it("gives roles automatically, keeps them for show, and takes back what it gave", async () => {
    const fan = await role({ name: "Fan", color: "#E39B7B" });
    const set = (body: Record<string, unknown>) => owner.req("PUT", `/v1/roles/${fan.id}/extras`, body);
    const r = await set({ color2: "#7FA7D9", autoAssign: { mode: "everyone" } });
    expect(r.extras).toEqual({ color2: "#7FA7D9", mentionable: false, autoAssign: { mode: "everyone", before: null } });
    expect(r.memberCount).toBe(4);
    expect(await refused(set({ autoAssign: { mode: "joined_before" } }), 400)).toBe("bad_request");
    expect(await refused(member.req("PUT", `/v1/roles/${fan.id}/extras`, { mentionable: true }), 403)).toBe("forbidden");
    const after = (await owner.req("GET", `/v1/orgs/${orgId}/roles`)).roles.find((x: { id: string }) => x.id === fan.id);
    expect(await refused(owner.req("PATCH", `/v1/roles/${fan.id}`, { baseRev: after.rev, permissions: ["messages.announce"] }), 400)).toBe("auto_role_has_powers");
    const powered = await role({ name: "Powered", permissions: ["messages.announce"] });
    expect(await refused(owner.req("PUT", `/v1/roles/${powered.id}/extras`, { autoAssign: { mode: "everyone" } }), 400)).toBe("auto_role_has_powers");
    // People who join later get it too.
    const late = await h.client("cplate");
    late.serverMessages = true;
    await late.req("POST", "/v1/invites/accept", { code: invite });
    const members = (await owner.req("GET", `/v1/orgs/${orgId}/members`)).members;
    const lateRoles = members.find((m: { id: string }) => m.id === late.userId).customRoles;
    expect(lateRoles).toEqual([expect.objectContaining({ id: fan.id, color2: "#7FA7D9" })]);
    // Only those who joined before a time; the rest it gave lose it.
    const cut = (await set({ autoAssign: { mode: "joined_before", before: Date.now() - 1 } })).memberCount;
    expect(cut).toBe(5);
    expect((await set({ autoAssign: { mode: "joined_before", before: 1 } })).memberCount).toBe(0);
    expect((await set({ autoAssign: { mode: "none" } })).memberCount).toBe(0);
  });

  it("reorders roles, moving only roles below the caller's highest unless they're an owner or admin", async () => {
    const order = async () => (await owner.req("GET", `/v1/orgs/${orgId}/roles`)).roles.map((r: { id: string }) => r.id);
    const manager = await role({ name: "Arranger", permissions: ["roles.manage"] });
    const low1 = await role({ name: "Low one" });
    const low2 = await role({ name: "Low two" });
    await give(manager.id, other);
    const ids = await order();
    const reversed = (await owner.req("PUT", `/v1/orgs/${orgId}/roles/order`, { roleIds: [...ids].reverse() })).order.map((r: { id: string }) => r.id);
    expect(reversed).toEqual([...ids].reverse());
    // Now the Arranger sits below both low roles, so it can't move them; put it back on top first.
    expect(await refused(other.req("PUT", `/v1/orgs/${orgId}/roles/order`, { roleIds: [low2.id, low1.id] }), 403)).toBe("beyond_your_powers");
    await owner.req("PUT", `/v1/orgs/${orgId}/roles/order`, { roleIds: [manager.id, ...reversed.filter((id: string) => id !== manager.id)] });
    await other.req("PUT", `/v1/orgs/${orgId}/roles/order`, { roleIds: [low1.id, low2.id] });
    expect(await refused(other.req("PUT", `/v1/orgs/${orgId}/roles/order`, { roleIds: [low1.id, manager.id] }), 403)).toBe("beyond_your_powers");
    expect(await refused(member.req("PUT", `/v1/orgs/${orgId}/roles/order`, { roleIds: [low1.id] }), 403)).toBe("forbidden");
    expect(await refused(owner.req("PUT", `/v1/orgs/${orgId}/roles/order`, { roleIds: [low1.id, low1.id] }), 400)).toBe("bad_request");
  });

  it("keeps text-only and no-GIF channels to text, except for their moderators", async () => {
    const words = await channel({ name: "words", textOnly: true });
    expect((await view(member, words.id)).options).toEqual({ textOnly: true, noGifs: false, stage: false, readOnly: false, posterRoleIds: [] });
    expect((await view(member, words.id)).canAttach).toBe(false);
    const photo = { ...voiceNote, voice: false, name: "p.jpg", mime: "image/jpeg" };
    expect(await refused(say(member, words.id, { attachments: [photo] }), 403)).toBe("text_only_channel");
    expect(await refused(say(member, words.id, { sticker: { pack: "p", id: "s" } }), 403)).toBe("text_only_channel");
    await say(mod, words.id, { attachments: [photo] });
    await say(member, words.id, { text: "just words" });
    const calm = await channel({ name: "calm" });
    await owner.req("PATCH", `/v1/conversations/${calm.id}`, { noGifs: true });
    const gif = { provider: "tenor", id: "g1", url: "https://media.tenor.com/abc/cat.gif", width: 200, height: 200 };
    expect(await refused(say(member, calm.id, { text: gif.url, gif }), 403)).toBe("gifs_not_allowed");
    expect(await refused(say(member, calm.id, { text: "look https://giphy.com/gifs/cat" }), 403)).toBe("gifs_not_allowed");
    await say(member, calm.id, { attachments: [photo] });
    await say(mod, calm.id, { text: gif.url, gif });
    expect(await refused(member.req("PATCH", `/v1/conversations/${calm.id}`, { noGifs: false }), 403)).toBe("forbidden");
    expect(await refused(owner.req("PATCH", `/v1/conversations/${calm.id}`, { stage: true }), 400)).toBe("bad_request");
  });

  it("lets everyone read and react in a read-only channel, and only its poster roles post", async () => {
    const posters = await role({ name: "Poster" });
    await give(posters.id, other);
    const news = await channel({ name: "news", readOnly: true, posterRoleIds: [posters.id] });
    expect((await view(member, news.id)).canPost).toBe(false);
    expect((await view(other, news.id)).canPost).toBe(true);
    const post = await say(other, news.id, { text: "Big news" });
    expect(await refused(say(member, news.id, { text: "me too" }), 403)).toBe("read_only_channel");
    await change(member, news.id, { type: "reaction", target: post.messageId, emoji: "👍", add: true });
    await say(owner, news.id, { text: "Managers post too" });
    expect(await refused(owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "bad", readOnly: true, posterRoleIds: ["rl_nowhere"] }), 400)).toBe("bad_request");
    await owner.req("PATCH", `/v1/conversations/${news.id}`, { readOnly: false });
    await say(member, news.id, { text: "open again" });
  });

  it("lets a stage's moderators bring listeners up to speak", async () => {
    const stage = await channel({ name: "town hall", voice: true, stage: true });
    expect(await refused(owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "bad stage", stage: true }), 400)).toBe("bad_request");
    expect((await view(member, stage.id)).canSpeak).toBe(false);
    expect((await view(owner, stage.id)).canSpeak).toBe(true);
    expect((await view(owner, stage.id)).options.speakerIds).toEqual([]);
    expect((await view(member, stage.id)).options.speakerIds).toBeUndefined();
    expect(await refused(member.req("PUT", `/v1/conversations/${stage.id}/stage/speakers/${member.userId}`), 403)).toBe("forbidden");
    expect(await refused(owner.req("PUT", `/v1/conversations/${general}/stage/speakers/${member.userId}`), 400)).toBe("bad_request");
    expect((await owner.req("PUT", `/v1/conversations/${stage.id}/stage/speakers/${member.userId}`)).speakerIds).toEqual([member.userId]);
    expect((await view(member, stage.id)).canSpeak).toBe(true);
    // Speakers may step down themselves.
    expect((await member.req("DELETE", `/v1/conversations/${stage.id}/stage/speakers/${member.userId}`)).speakerIds).toEqual([]);
    expect((await view(member, stage.id)).canSpeak).toBe(false);
  });

  it("forgets a nickname when its member leaves", async () => {
    await other.req("PUT", `/v1/orgs/${orgId}/members/${other.userId}/nickname`, { nickname: "Leaving soon" });
    expect(h.ctx.ws.count("org_nicknames", { org_id: orgId, user_id: other.userId })).toBe(1);
    await other.req("DELETE", `/v1/orgs/${orgId}/members/${other.userId}`);
    expect(h.ctx.ws.count("org_nicknames", { org_id: orgId, user_id: other.userId })).toBe(0);
  });
}, 60_000);

describe("community permissions switched off", () => {
  let h: Harness;
  let owner: GriipClient;
  let orgId: string;

  beforeAll(async () => {
    h = await startServer({ COMMUNITY_PERMISSIONS: "off" });
    owner = await h.client("cpoffowner");
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Off Place" })).org.id;
  });
  afterAll(async () => h.close());

  it("hides the feature, answers its routes with 503 and leaves views as they were", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("community-permissions");
    expect(await refused(owner.req("PUT", `/v1/orgs/${orgId}/members/${owner.userId}/nickname`, { nickname: "x" }), 503)).toBe("feature_disabled");
    expect(await refused(owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "t", textOnly: true }), 503)).toBe("feature_disabled");
    expect((await owner.req("GET", `/v1/orgs/${orgId}/roles`)).everyone).toBeUndefined();
    const c = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "plain" })).channel;
    expect(c.options).toBeUndefined();
  });
});
