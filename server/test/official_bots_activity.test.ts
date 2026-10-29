import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levelOf, xpForLevel } from "../src/modules/officialBots/levels.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Official bots that follow what happens (community parity batch D, docs/COMMUNITY_PARITY_API.md › Official bots):
 * Levels (XP, cooldown, level-ups, role rewards, !rank, !top, the lobby board), Logger (edits, deletions, members and
 * roles, never pinging, never its own channel) and Starboard (thresholds, own stars, private channels, never twice).
 * Runs with the community tables in SQLite and in MongoDB.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const STARTUP_MS = 120_000;
const code = (e: { error: { code: string } }) => e.error.code;
let n = 0;
const nextId = () => `m_oba_${++n}_${Date.now()}`;

interface Stored {
  id: string;
  senderUserId: string;
  cls: string;
  payload: { type: string; text?: string; target?: string; mentions?: string[]; starboard?: unknown };
}

describe("levels", () => {
  it("are floor(√(XP / 100))", () => {
    expect([0, 99, 100, 399, 400, 899, 900, 10_000].map(levelOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 10]);
    expect([1, 2, 3].map(xpForLevel)).toEqual([100, 400, 900]);
  });
});

describe.each([
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const)("official bots following a community in %s", (_backend, env) => {
  let h: Harness;
  let owner: GriipClient, ana: GriipClient, ben: GriipClient, cai: GriipClient, dee: GriipClient, late: GriipClient;
  let orgId: string, general: string, memes: string, logs: string, members: string, stars: string, secret: string, invite: string;
  const base = () => `/v1/orgs/${orgId}/official-bots`;
  const settle = () => h.ctx.officialBots.settled();
  const send = (c: GriipClient, conv: string, payload: Record<string, unknown>, cls = "message") =>
    c.req("POST", "/v2/messages", { conversationId: conv, messageId: nextId(), cls, sentAt: Date.now(), payload });
  const say = async (c: GriipClient, conv: string, text: string, extra: Record<string, unknown> = {}) => (await send(c, conv, { type: "text", text, ...extra })).messageId as string;
  const react = (c: GriipClient, conv: string, target: string, emoji: string, add = true) => send(c, conv, { type: "reaction", target, emoji, add }, "control");
  const events = async (conv: string, botId: string): Promise<Stored[]> => {
    await settle();
    const page = await owner.req("GET", `/v2/conversations/${conv}/messages?limit=100`);
    return [...(page.messages as Stored[]).reverse(), ...(page.changes as Stored[])].filter((m) => m.senderUserId === botId);
  };
  const lines = async (conv: string, botId: string) => (await events(conv, botId)).filter((m) => m.cls === "message").map((m) => m.payload.text ?? "");
  const put = (key: string, body: unknown) => owner.req("PUT", `${base()}/${key}`, body);
  const plus = (on: boolean) => h.ctx.officialBots.setPlus(orgId, on ? { by: "test", expiresAt: null, reason: "tests" } : null);
  const xpOf = (c: GriipClient) => h.ctx.ws.get<{ xp: number; last_xp_at: number }>("bot_levels", { org_id: orgId, user_id: c.userId });
  const setXp = (c: GriipClient, xp: number) => h.ctx.ws.write((w) => w.upsert("bot_levels", { org_id: orgId, user_id: c.userId, xp, last_xp_at: 0 }, { xp, last_xp_at: 0 }));

  beforeAll(async () => {
    h = await startServer({ ...env });
    [owner, ana, ben, cai, dee, late] = await Promise.all(["obaowner", "obaana", "obaben", "obacai", "obadee", "obalate"].map((x) => h.client(x)));
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Busy Place" })).org.id;
    invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [ana, ben, cai, dee]) await c.req("POST", "/v1/invites/accept", { code: invite });
    general = h.ctx.ws.get<{ id: string }>("conversations", { org_id: orgId, name: "general" })!.id;
    const channel = async (name: string, kind = "PUBLIC") => (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name, kind })).channel.id as string;
    memes = await channel("memes");
    stars = await channel("starboard");
    logs = await channel("mod-log", "PRIVATE");
    members = await channel("member-log", "PRIVATE");
    secret = await channel("secret", "PRIVATE");
    for (const c of [ana, ben, cai, dee]) await owner.req("PUT", `/v1/conversations/${secret}/members/${c.userId}`);
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  describe("Levels", () => {
    let botId: string;
    beforeAll(async () => {
      botId = (await put("levels", { enabled: true })).bot.userId;
    });

    it("gives 15–25 XP at most once a minute, not for commands or one-character messages", async () => {
      await say(ana, general, "hi");
      await settle();
      const first = xpOf(ana)!.xp;
      expect(first).toBeGreaterThanOrEqual(15);
      expect(first).toBeLessThanOrEqual(25);
      await say(ana, general, "and again right away");
      await settle();
      expect(xpOf(ana)!.xp).toBe(first);
      await setXp(ana, first);
      await say(ana, general, "k");
      await say(ana, general, "!top");
      await settle();
      expect(xpOf(ana)!.xp).toBe(first);
    });

    it("announces a level-up where they chat, with Meldiq's line", async () => {
      await setXp(ben, 395);
      await say(ben, general, "almost there");
      const said = (await events(general, botId)).filter((m) => m.payload.text?.includes("just reached"));
      expect(said).toHaveLength(1);
      expect(said[0]!.payload).toEqual({ type: "text", text: `🎉 @${ben.username} just reached level 2!`, mentions: [ben.userId] });
    });

    it("answers !rank and !top, and fills the lobby's Levels board", async () => {
      await setXp(cai, 1000);
      await say(cai, general, "!rank");
      await say(dee, general, "!rank");
      await say(dee, general, "!top");
      const said = (await lines(general, botId)).slice(-3);
      expect(said[0]).toMatch(/^📈 obacai: level 3 · 1,000 XP · #1 of 3\. 600 XP to level 4\.$/);
      expect(said[1]).toContain("obadee hasn't earned any XP here yet");
      expect(said[2]!.split("\n")[1]).toBe("1. obacai · level 3 · 1,000 XP");
      const lobby = await dee.req("GET", `/v1/orgs/${orgId}/lobby`);
      const board = lobby.leaderboards.find((b: { board: string }) => b.board === "levels");
      expect(board.entries.map((e: { user: { id: string }; count: number }) => [e.user.id, e.count])[0]).toEqual([cai.userId, 1000]);
    });

    it("with Bots+: boosts XP, gives role rewards and says the community's own line in its channel", async () => {
      const cosmetic = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Regular", permissions: [] })).role.id;
      const powerful = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Keeper", permissions: ["workspace.edit"] })).role.id;
      expect(code(await expectStatus(put("levels", { settings: { boost: 2 } }), 403))).toBe("bots_plus_required");
      await plus(true);
      const refused = await expectStatus(put("levels", { settings: { roleRewards: [{ level: 3, roleId: powerful }] } }), 403);
      expect(refused.error).toMatchObject({ code: "bot_role_not_givable", details: { roleId: powerful } });
      await put("levels", { settings: { boost: 2, roleRewards: [{ level: 3, roleId: cosmetic }], levelUpMessage: "{user} is level {level} now", announceChannelId: memes } });
      await setXp(dee, 880);
      await say(dee, general, "ten more points please");
      await settle();
      const gained = xpOf(dee)!.xp - 880;
      expect(gained).toBeGreaterThanOrEqual(30);
      expect(gained).toBeLessThanOrEqual(50);
      expect(h.ctx.ws.get<{ assigned_by: string }>("org_role_members", { role_id: cosmetic, user_id: dee.userId })?.assigned_by).toBe("bot:levels");
      expect((await lines(memes, botId)).at(-1)).toBe(`@${dee.username} is level 3 now`);
      await plus(false);
    });
  });

  describe("Logger", () => {
    let botId: string;
    beforeAll(async () => {
      botId = (await put("logger", { enabled: true })).bot.userId;
    });

    it("stays quiet until it has a channel", async () => {
      const m = await say(ana, general, "nobody logs this");
      await send(ana, general, { type: "delete", target: m }, "control");
      expect(await lines(general, botId)).toHaveLength(0);
      await put("logger", { settings: { channelId: logs } });
    });

    it("logs edits with the text before, and deletions with the last text, never pinging", async () => {
      const m = await say(ana, general, `see you at 8 @${ben.username}`, { mentions: [ben.userId] });
      await send(ana, general, { type: "edit", target: m, text: "see you at 9" }, "control");
      await send(ana, general, { type: "edit", target: m, text: "see you at 10" }, "control");
      await send(owner, general, { type: "delete", target: m }, "control");
      const logged = (await events(logs, botId)).filter((e) => e.cls === "message");
      expect(logged.map((e) => e.payload.text)).toEqual([
        "✏️ obaana edited a message in #general: “see you at 8 obaben” → “see you at 9”",
        "✏️ obaana edited a message in #general: “see you at 9” → “see you at 10”",
        "🗑️ obaowner deleted a message by obaana in #general: “see you at 10”",
      ]);
      expect(logged.every((e) => e.payload.mentions === undefined)).toBe(true);
    });

    it("never logs its own channel", async () => {
      const before = (await lines(logs, botId)).length;
      const m = await say(owner, logs, "note to self");
      await send(owner, logs, { type: "edit", target: m, text: "note to myself" }, "control");
      expect(await lines(logs, botId)).toHaveLength(before);
    });

    it("logs joins (new accounts flagged), leaves, kicks, bans, unbans, timeouts and roles with who did it", async () => {
      const role = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Artist", permissions: [] })).role.id;
      const before = (await lines(logs, botId)).length;
      await late.req("POST", "/v1/invites/accept", { code: invite });
      await owner.req("PUT", `/v1/roles/${role}/members/${late.userId}`);
      await owner.req("DELETE", `/v1/roles/${role}/members/${late.userId}`);
      const until = Date.now() + 2 * 86_400_000;
      await owner.req("PUT", `/v1/orgs/${orgId}/members/${late.userId}/timeout`, { until, reason: "cool off" });
      await owner.req("PUT", `/v1/orgs/${orgId}/members/${late.userId}/timeout`, { until: null });
      await late.req("DELETE", `/v1/orgs/${orgId}/members/${late.userId}`);
      await late.req("POST", "/v1/invites/accept", { code: invite });
      await owner.req("DELETE", `/v1/orgs/${orgId}/members/${late.userId}`);
      await owner.req("POST", `/v1/orgs/${orgId}/bans`, { userId: late.userId });
      await owner.req("DELETE", `/v1/orgs/${orgId}/bans/${late.userId}`);
      const said = (await lines(logs, botId)).slice(before);
      expect(said).toEqual([
        `📥 obalate (@${late.username}) joined. ⚠️ New account: made in the last 7 days.`,
        "🏷️ obaowner gave obalate the Artist role.",
        "🏷️ obaowner took the Artist role from obalate.",
        `⏳ obalate (@${late.username}) was timed out by obaowner until ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC. Reason: cool off`,
        `✅ obaowner ended obalate (@${late.username})'s timeout.`,
        `📤 obalate (@${late.username}) left.`,
        `📥 obalate (@${late.username}) joined. ⚠️ New account: made in the last 7 days.`,
        `👢 obalate (@${late.username}) was removed by obaowner.`,
        `🔨 obalate (@${late.username}) was banned by obaowner.`,
        `🕊️ obalate (@${late.username}) was unbanned by obaowner.`,
      ]);
    });

    it("with Bots+: member events in their own channel, and channels left out", async () => {
      await plus(true);
      await put("logger", { settings: { memberChannelId: members, excludeChannelIds: [memes] } });
      await late.req("POST", "/v1/invites/accept", { code: invite });
      const m = await say(ana, memes, "left out");
      await send(ana, memes, { type: "delete", target: m }, "control");
      expect((await lines(members, botId)).at(-1)).toContain(`obalate (@${late.username}) joined.`);
      expect((await lines(logs, botId)).some((l) => l.includes("left out"))).toBe(false);
      await plus(false);
    });
  });

  describe("Starboard", () => {
    let botId: string;
    beforeAll(async () => {
      expect(code(await expectStatus(put("starboard", { settings: { threshold: 6 } }), 400))).toBe("bad_request");
      botId = (await put("starboard", { enabled: true, settings: { channelId: stars, threshold: 2 } })).bot.userId;
    });

    it("copies a message once enough other people star it, then follows its count", async () => {
      const m = await say(ana, general, "this is the one");
      await react(ana, general, m, "⭐");
      await react(ben, general, m, "⭐");
      await react(cai, general, m, "👍");
      expect(await lines(stars, botId)).toHaveLength(0);
      await react(cai, general, m, "🌟");
      const posts = (await events(stars, botId)).filter((e) => e.cls === "message");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.payload).toMatchObject({ type: "text", text: "⭐ 2 · obaana in #general\nthis is the one", starboard: { channelId: general, messageId: m } });
      await react(dee, general, m, "⭐");
      await react(ben, general, m, "⭐", false);
      await react(ben, general, m, "⭐");
      const all = await events(stars, botId);
      expect(all.filter((e) => e.cls === "message")).toHaveLength(1);
      const edits = all.filter((e) => e.payload.type === "edit").map((e) => e.payload.text!.split("\n")[0]);
      expect(edits).toEqual(["⭐ 3 · obaana in #general", "⭐ 2 · obaana in #general", "⭐ 3 · obaana in #general"]);
      expect(h.ctx.ws.count("bot_starboard", { org_id: orgId })).toBe(1);
    });

    it("skips private channels and the starboard itself", async () => {
      const hidden = await say(ana, secret, "between us");
      for (const c of [ben, cai, dee]) await react(c, secret, hidden, "⭐");
      const onBoard = (await events(stars, botId)).find((e) => e.cls === "message")!.id;
      for (const c of [ben, cai, dee]) await react(c, stars, onBoard, "⭐");
      expect((await events(stars, botId)).filter((e) => e.cls === "message")).toHaveLength(1);
    });

    it("with Bots+: its own emoji and self-stars", async () => {
      expect(code(await expectStatus(put("starboard", { settings: { emoji: "🔥" } }), 403))).toBe("bots_plus_required");
      await plus(true);
      await put("starboard", { settings: { emoji: "🔥", selfStar: true } });
      const m = await say(ben, memes, "hot take");
      await react(ana, memes, m, "⭐");
      await react(ben, memes, m, "🔥");
      await react(cai, memes, m, "🔥");
      const posts = (await events(stars, botId)).filter((e) => e.cls === "message");
      expect(posts.at(-1)!.payload.text).toBe("🔥 2 · obaben in #memes\nhot take");
      await plus(false);
    });
  });
});
