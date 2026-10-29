import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LobbySettingsView } from "../src/shared/contracts/http/communityLobby.js";
import { LobbyView } from "../src/shared/contracts/http/communityLobbyView.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * The community lobby (community parity B, feature "community-lobby", docs/COMMUNITY_PARITY_API.md › Lobby): settings
 * people who can edit the community change, templates, the member's view worked out by the server (main channels, who
 * runs it, live rooms, leaderboards, feed), the feed URL and "seen". Runs with the community tables in SQLite and in
 * MongoDB.
 */

const PRODUCTION_DOMAINS = "preferences,reports,relationships,history,accounts,files,relay,billing";

let n = 0;
const text = (c: GriipClient, conv: string, words = "hi") => c.send(conv, { type: "text", text: words }, "message", `m_lobby_${++n}_${Date.now()}`);
const code = (e: { error: { code: string } }) => e.error.code;

async function feedPost(h: Harness, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.baseUrl}/v1/lobby-feed/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe.each([
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: `${PRODUCTION_DOMAINS},workspace,conversations,calls` }],
] as const)("community lobby kept in %s", (backend, env) => {
  let h: Harness;
  let owner: GriipClient, admin: GriipClient, mod: GriipClient, member: GriipClient, outsider: GriipClient;
  let orgId: string, otherOrg: string, general: string, art: string, secret: string, voice: string, hiddenVoice: string, foreign: string;
  const lobbyOf = (c: GriipClient) => c.req("GET", `/v1/orgs/${orgId}/lobby`);
  const settingsOf = (c: GriipClient) => c.req("GET", `/v1/orgs/${orgId}/lobby/settings`);
  const put = (c: GriipClient, body: object) => c.req("PUT", `/v1/orgs/${orgId}/lobby/settings`, body);
  const rev = async () => (await settingsOf(owner)).rev as number;

  beforeAll(async () => {
    h = await startServer({ ...env, LOBBY_FEED_IMAGE_HOSTS: "cdn.example.org" });
    expect(h.ctx.ws.backend).toBe(backend);
    [owner, admin, mod, member, outsider] = await Promise.all(["lbowner", "lbadmin", "lbmod", "lbmember", "lbout"].map((x) => h.client(x)));
    for (const c of [owner, admin, mod, member, outsider]) c.serverMessages = true;
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Lobby Club" })).org.id;
    const invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [admin, mod, member]) await c.req("POST", "/v1/invites/accept", { code: invite });
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { role: "ADMIN" });
    const modRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { template: "moderator" })).role;
    await owner.req("PUT", `/v1/roles/${modRole.id}/members/${mod.userId}`);
    general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "chat" })).channel.id;
    art = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "art" })).channel.id;
    secret = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "staff", kind: "PRIVATE" })).channel.id;
    voice = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "lounge", voice: true })).channel.id;
    hiddenVoice = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "staff-room", voice: true, kind: "PRIVATE" })).channel.id;
    otherOrg = (await outsider.req("POST", "/v1/orgs", { name: "Elsewhere" })).org.id;
    foreign = (await outsider.req("POST", `/v1/orgs/${otherOrg}/channels`, { name: "theirs" })).channel.id;
  });
  afterAll(async () => h.close());

  it("is advertised, and community views say whether it's on and seen", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("community-lobby");
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.lobby).toEqual({ enabled: true, seen: false });
  });

  it("starts with the default lobby, for members only", async () => {
    const s = await settingsOf(member);
    expect(LobbySettingsView.safeParse(s).success).toBe(true);
    expect(s).toMatchObject({ rev: 0, updatedAt: null, canEdit: false, feed: null });
    expect(s.settings).toMatchObject({ enabled: true, about: null, mainChannelIds: [], faq: [], showWhoRunsIt: true, leaderboards: ["levels", "messages_week", "invites"] });
    expect(s.settings.look).toEqual({ layout: "classic", accent: "auto", background: "glow", cards: "filled", font: "default", bannerHeight: "normal", title: "left" });
    expect(s.settings.sections.map((x: { key: string; column: string }) => `${x.key}:${x.column}`)).toEqual([
      "about:main", "main_channels:main", "live_now:main", "giveaways:main", "feed:main", "faq:main",
      "leaderboard:side", "pick_roles:side", "rules:side", "who_runs_it:side", "links:side",
    ]);
    expect((await settingsOf(owner)).canEdit).toBe(true);
    await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/lobby`), 404);
    await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/lobby/settings`), 404);
  });

  it("is changed by people who can edit the community, checking every field", async () => {
    expect(code(await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/lobby/settings`, { rev: 0, about: "x" }), 403))).toBe("forbidden");
    expect(code(await expectStatus(mod.req("PUT", `/v1/orgs/${orgId}/lobby/settings`, { rev: 0, about: "x" }), 403))).toBe("forbidden");
    const bad: object[] = [
      { mainChannelIds: [general, art, secret, voice, hiddenVoice, general, art] },
      { mainChannelIds: [general, general] },
      { buttons: [{ label: "Site", url: "http://example.com" }] },
      { buttons: [{ label: "Both", url: "https://example.com", channelId: general }] },
      { buttons: Array.from({ length: 5 }, (_, i) => ({ label: `b${i}`, url: "https://example.com" })) },
      { tagline: "x".repeat(121) },
      { about: "x".repeat(2001) },
      { faq: Array.from({ length: 11 }, () => ({ question: "q", answer: "a" })) },
      { faq: [{ question: "q".repeat(201), answer: "a" }] },
      { look: { accent: "red" } },
      { look: { layout: "grid" } },
      { leaderboards: [] },
      { leaderboards: ["invites", "invites"] },
      { sections: [{ key: "about", shown: true, column: "main" }] },
    ];
    for (const b of bad) expect(code(await expectStatus(put(owner, { rev: 0, ...b }), 400))).toBe("bad_request");
    for (const ids of [[foreign], ["c_nowhere"]]) {
      expect(code(await expectStatus(put(owner, { rev: 0, mainChannelIds: ids }), 400))).toBe("lobby_channel_invalid");
    }
    expect(code(await expectStatus(put(owner, { rev: 0, buttons: [{ label: "Go", channelId: foreign }] }), 400))).toBe("lobby_channel_invalid");

    const v = await put(admin, {
      rev: 0,
      tagline: "  Make things together  ",
      about: "**Welcome!** Say hi.",
      mainChannelIds: [secret, general],
      buttons: [{ label: "Chat", channelId: general }, { label: "Site", url: "https://example.com/club" }, { label: "Staff", channelId: secret }],
      faq: [{ question: "Is it free?", answer: "Yes." }, { id: "keep_me", question: "Who runs it?", answer: "See the card." }],
      look: { accent: "#AABBCC", font: "serif" },
    });
    expect(v.rev).toBe(1);
    expect(v.settings).toMatchObject({ tagline: "Make things together", about: "**Welcome!** Say hi.", mainChannelIds: [secret, general] });
    expect(v.settings.look).toMatchObject({ accent: "#aabbcc", font: "serif", layout: "classic" });
    expect(v.settings.faq.map((f: { id: string }) => f.id)).toEqual([expect.stringMatching(/^faq_/), "keep_me"]);
    expect(v.settings.buttons[1]).toEqual({ label: "Site", url: "https://example.com/club", channelId: null });
    // A stale revision is refused; one change after another works.
    const stale = await expectStatus(put(owner, { rev: 0, about: "lost" }), 409);
    expect(stale.error).toMatchObject({ code: "lobby_stale", details: { rev: 1 } });
    expect((await put(owner, { rev: 1, enabled: true })).rev).toBe(1);
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "community.lobby" })).toBe(1);
  });

  it("never shows members the channels they can't open", async () => {
    const s = await settingsOf(member);
    expect(s.settings.mainChannelIds).toEqual([general]);
    expect(s.settings.buttons.map((b: { label: string }) => b.label)).toEqual(["Chat", "Site"]);
    const view = await lobbyOf(member);
    expect(LobbyView.safeParse(view).success).toBe(true);
    expect(view.mainChannels.map((c: { id: string }) => c.id)).toEqual([general]);
    expect(view.mainChannelsPicked).toBe(true);
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(JSON.stringify(view)).not.toContain("staff");
    const mine = await lobbyOf(owner);
    expect(mine.mainChannels.map((c: { id: string; name: string }) => c.name)).toEqual(["staff", "chat"]);
  });

  it("picks the busiest channels the viewer can see when none are picked, and counts this week's messages", async () => {
    await put(owner, { rev: await rev(), mainChannelIds: [] });
    for (let i = 0; i < 3; i++) await text(member, art, `art ${i}`);
    await text(owner, art, "nice");
    await text(admin, general, "hello");
    for (let i = 0; i < 5; i++) await text(owner, secret, `staff ${i}`);
    h.ctx.lobby.activity.clear();
    const view = await lobbyOf(member);
    expect(view.mainChannelsPicked).toBe(false);
    // Then the community's other channels in its order (the starter ones), never the staff room.
    expect(view.mainChannels.map((c: { name: string }) => c.name).slice(0, 2)).toEqual(["art", "chat"]);
    expect(view.mainChannels.length).toBeLessThanOrEqual(6);
    expect(view.mainChannels.map((c: { id: string }) => c.id)).not.toContain(secret);
    expect(view.mainChannels[0].lastActiveAt).toEqual(expect.any(Number));
    const week = view.leaderboards.find((b: { board: string }) => b.board === "messages_week");
    // The owner's staff-room messages don't count on a member's board.
    // Busiest first; ties by id.
    const ones = [owner.userId, admin.userId].sort();
    expect(week.entries.map((e: { user: { id: string }; count: number; rank: number }) => [e.rank, e.user.id, e.count])).toEqual([
      [1, member.userId, 3],
      [2, ones[0], 1],
      [3, ones[1], 1],
    ]);
    const ownerWeek = (await lobbyOf(owner)).leaderboards.find((b: { board: string }) => b.board === "messages_week");
    expect(ownerWeek.entries[0]).toMatchObject({ rank: 1, count: 6, user: { id: owner.userId } });
    expect(view.leaderboards.find((b: { board: string }) => b.board === "levels").entries).toEqual([]);
    // The owner's invitation brought three people in.
    expect(view.leaderboards.find((b: { board: string }) => b.board === "invites").entries).toEqual([{ rank: 1, count: 3, user: expect.objectContaining({ id: owner.userId }) }]);
  });

  it("lists who runs it with badges, and hides them from members when switched off", async () => {
    const staff = (await lobbyOf(member)).whoRunsIt.map((s: { user: { id: string }; badge: string }) => [s.user.id, s.badge]);
    expect(staff).toEqual([[owner.userId, "owner"], [admin.userId, "admin"], [mod.userId, "mod"]]);
    const off = await put(owner, { rev: await rev(), showWhoRunsIt: false });
    expect(off.settings.sections.find((s: { key: string }) => s.key === "who_runs_it").shown).toBe(false);
    expect((await lobbyOf(member)).whoRunsIt).toEqual([]);
    expect((await lobbyOf(owner)).whoRunsIt).toHaveLength(3);
    // The card's switch is the same setting.
    const sections = off.settings.sections.map((s: { key: string }) => (s.key === "who_runs_it" ? { ...s, shown: true } : s));
    expect((await put(owner, { rev: off.rev, sections })).settings.showWhoRunsIt).toBe(true);
  });

  it("shows voice rooms with people in them, only the ones the viewer can see", async () => {
    const t = Date.now();
    for (const [id, conv] of [["call_lobby_a", voice], ["call_lobby_b", hiddenVoice]] as const) {
      await h.ctx.calls.insert({ id: `${id}_${backend}`, conversation_id: conv, room_name: `room_${id}_${backend}`, created_by: owner.userId, video: 0, state: "ACTIVE", created_at: t, answered_at: t, ended_at: null, end_reason: null, alerted_at: null, host_server_id: null, room: 1 });
      await h.ctx.calls.join(`${id}_${backend}`, owner.userId, owner.deviceId, t, false);
    }
    await h.ctx.calls.join(`call_lobby_a_${backend}`, member.userId, member.deviceId, t, false);
    const live = (await lobbyOf(member)).liveNow;
    expect(live).toEqual([
      { channelId: voice, name: "lounge", callId: `call_lobby_a_${backend}`, startedAt: t, participantCount: 2, participants: expect.arrayContaining([expect.objectContaining({ id: member.userId })]) },
    ]);
    expect((await lobbyOf(owner)).liveNow.map((r: { channelId: string }) => r.channelId).sort()).toEqual([voice, hiddenVoice].sort());
  });

  it("offers the onboarding answers that give roles, and the rules channel members can see", async () => {
    const painter = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Painter", permissions: [], denies: [] })).role.id;
    await owner.req("PUT", `/v1/orgs/${orgId}/onboarding`, {
      enabled: true,
      prompts: [{ title: "What do you make?", required: false, single: false, options: [{ title: "Paintings", emoji: "🎨", roleIds: [painter], channelIds: [] }, { title: "Nothing yet", roleIds: [], channelIds: [] }] }],
    });
    await owner.req("PUT", `/v1/orgs/${orgId}/rules`, { channelId: general, required: false, rules: [{ title: "Be kind" }] });
    const view = await lobbyOf(member);
    expect(view.pickRoles.prompts).toEqual([
      { id: expect.any(String), title: "What do you make?", single: false, options: [{ id: expect.any(String), title: "Paintings", emoji: "🎨", roles: [{ id: painter, name: "Painter", color: null }] }] },
    ]);
    expect(view.pickRoles.answered).toEqual([]);
    expect(view.rules).toEqual({ channelId: general });
    expect(view.links).toEqual([]);
    expect(view.giveaways).toEqual([]);
  });

  it("applies templates: look and sections change, text stays, starter questions only fill an empty FAQ", async () => {
    expect(code(await expectStatus(member.req("POST", `/v1/orgs/${orgId}/lobby/template`, { key: "gaming" }), 403))).toBe("forbidden");
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/lobby/template`, { key: "gaming", rev: 0 }), 409))).toBe("lobby_stale");
    const before = await settingsOf(owner);
    const g = await owner.req("POST", `/v1/orgs/${orgId}/lobby/template`, { key: "gaming", rev: before.rev });
    expect(g.rev).toBe(before.rev + 1);
    expect(g.settings.look).toMatchObject({ layout: "classic", background: "mesh", cards: "glass", font: "display" });
    expect(g.settings.sections[0]).toEqual({ key: "live_now", shown: true, column: "main" });
    expect(g.settings.sections).toHaveLength(11);
    expect(g.settings).toMatchObject({ about: before.settings.about, tagline: before.settings.tagline, buttons: before.settings.buttons, faq: before.settings.faq });

    await put(owner, { rev: g.rev, faq: [] });
    const m = await owner.req("POST", `/v1/orgs/${orgId}/lobby/template`, { key: "minimal" });
    expect(m.settings.look).toMatchObject({ layout: "compact", accent: "auto" });
    expect(m.settings.faq.length).toBeGreaterThanOrEqual(3);
    expect(m.settings.sections.filter((s: { shown: boolean }) => s.shown).map((s: { key: string }) => s.key)).toEqual(["about", "main_channels", "faq", "rules"]);
    expect(m.settings.showWhoRunsIt).toBe(false);
    const looks = new Set<string>();
    for (const key of ["gaming", "study", "creators", "hangout", "minimal"]) {
      looks.add(JSON.stringify((await owner.req("POST", `/v1/orgs/${orgId}/lobby/template`, { key })).settings.look));
    }
    expect(looks.size).toBe(5);
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "community.lobby_template" })).toBe(7);
  });

  it("takes posts through a secret feed URL that can be replaced and deleted", async () => {
    expect(code(await expectStatus(member.req("POST", `/v1/orgs/${orgId}/lobby/feed`), 403))).toBe("forbidden");
    const first = await owner.req("POST", `/v1/orgs/${orgId}/lobby/feed`);
    expect(first).toMatchObject({ token: expect.stringMatching(/^lf_/), feed: { createdAt: expect.any(Number), lastPostAt: null } });
    expect(h.ctx.ws.count("community_lobby_feeds", { token_hash: first.token })).toBe(0);

    const own = await feedPost(h, first.token, { title: "New video", text: "Out now", url: "https://www.youtube.com/watch?v=abc", image: "https://i.ytimg.com/vi/abc/hq.jpg" });
    expect(own.status).toBe(200);
    expect(own.json).toEqual({ id: expect.stringMatching(/^lp_/), postedAt: expect.any(Number) });
    const discord = await feedPost(h, first.token, { content: "fallback", embeds: [{ title: "Stream", description: "Live!", url: "https://twitch.tv/club", image: { url: "https://evil.example.com/x.png" } }] });
    expect(discord.status).toBe(200);
    await feedPost(h, first.token, { text: "From our CDN", image: { url: "https://media.cdn.example.org/p.png" } });
    await feedPost(h, first.token, { title: "t".repeat(300) });
    expect((await feedPost(h, first.token, { title: "x", url: "http://example.com" })).json.error.code).toBe("lobby_feed_invalid");
    expect((await feedPost(h, first.token, { image: "https://i.imgur.com/a.png" })).json.error.code).toBe("lobby_feed_invalid");
    expect((await feedPost(h, first.token, {})).status).toBe(400);

    const feed = (await lobbyOf(member)).feed;
    expect(feed[3]).toMatchObject({ title: "New video", text: "Out now", url: "https://www.youtube.com/watch?v=abc", image: "https://i.ytimg.com/vi/abc/hq.jpg" });
    expect(feed[2]).toMatchObject({ title: "Stream", text: "Live!", url: "https://twitch.tv/club", image: null });
    expect(feed[1]).toMatchObject({ text: "From our CDN", image: "https://media.cdn.example.org/p.png" });
    expect([...feed[0].title]).toHaveLength(200);
    expect((await settingsOf(owner)).feed).toMatchObject({ lastPostAt: expect.any(Number) });
    expect((await settingsOf(member)).feed).toBeNull();

    // A new URL replaces the old one, which stops working; only the newest 20 posts are kept.
    const second = await owner.req("POST", `/v1/orgs/${orgId}/lobby/feed`);
    expect((await feedPost(h, first.token, { title: "old" })).status).toBe(404);
    for (let i = 0; i < 22; i++) expect((await feedPost(h, second.token, { title: `post ${i}` })).status).toBe(200);
    const kept = (await lobbyOf(member)).feed;
    expect(kept).toHaveLength(20);
    expect(kept[0].title).toBe("post 21");
    expect(h.ctx.ws.count("community_lobby_posts", { org_id: orgId })).toBe(20);

    expect(await owner.req("DELETE", `/v1/orgs/${orgId}/lobby/feed`)).toEqual({ feed: null });
    expect((await feedPost(h, second.token, { title: "gone" })).status).toBe(404);
    expect((await lobbyOf(member)).feed).toHaveLength(20);
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "community.lobby_feed" })).toBe(3);
  });

  it("remembers the first time a member opened it, until they leave", async () => {
    expect((await lobbyOf(member)).seen).toBe(false);
    const first = await member.req("POST", `/v1/orgs/${orgId}/lobby/seen`);
    expect(first).toEqual({ seen: true, seenAt: expect.any(Number) });
    expect((await member.req("POST", `/v1/orgs/${orgId}/lobby/seen`)).seenAt).toBe(first.seenAt);
    expect(await lobbyOf(member)).toMatchObject({ seen: true, seenAt: first.seenAt });
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.lobby).toEqual({ enabled: true, seen: true });
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).org.lobby.seen).toBe(false);
    await expectStatus(outsider.req("POST", `/v1/orgs/${orgId}/lobby/seen`), 404);

    await member.req("DELETE", `/v1/orgs/${orgId}/members/${member.userId}`);
    expect(h.ctx.ws.count("community_lobby_seen", { org_id: orgId, user_id: member.userId })).toBe(0);
  });
});

describe("community lobby switched off", () => {
  let h: Harness;
  let owner: GriipClient;
  let orgId: string;

  beforeAll(async () => {
    h = await startServer({ COMMUNITY_LOBBY: "off" });
    owner = await h.client("lboff");
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Quiet" })).org.id;
  });
  afterAll(async () => h.close());

  it("isn't advertised, answers 503 and leaves community views alone", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("community-lobby");
    expect(code(await expectStatus(owner.req("GET", `/v1/orgs/${orgId}/lobby`), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/lobby/settings`, { rev: 0, about: "x" }), 503))).toBe("feature_disabled");
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).org.lobby).toBeUndefined();
    const res = await fetch(`${h.baseUrl}/v1/lobby-feed/lf_aaaaaaaaaaaaaaaa`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
  });
});
