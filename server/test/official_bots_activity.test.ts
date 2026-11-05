import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { levelOf, xpForLevel } from "../src/modules/officialBots/levels.js";
import { PostgresRelayStore } from "../src/modules/messaging/relay/postgresStore.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { setAttachmentExpiry } from "./support/files.js";

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

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
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

    it("requires private destinations for Logger content and member logs", async () => {
      const original = h.ctx.officialBots.rows.bot(orgId, "logger")!;
      try {
        expect(code(await expectStatus(put("logger", { settings: { channelId: memes } }), 400))).toBe("official_bot_channel_invalid");
        await plus(true);
        expect(code(await expectStatus(put("logger", { settings: { memberChannelId: general } }), 400))).toBe("official_bot_channel_invalid");
      } finally {
        await h.ctx.officialBots.rows.save(original);
        await plus(false);
      }
    });

    it("suppresses restored public Logger destinations and reports the configuration problem", async () => {
      const original = h.ctx.officialBots.rows.bot(orgId, "logger")!;
      const before = (await lines(memes, botId)).length;
      try {
        // Emulate older persisted settings without going through the new configuration validation.
        await h.ctx.officialBots.rows.save({ ...original, settings: JSON.stringify({ ...JSON.parse(original.settings), channelId: memes }) });
        const diagnostics = await owner.req("GET", `${base()}/logger/diagnostics`);
        const message = await say(ana, secret, "private source before edit");
        await send(ana, secret, { type: "edit", target: message, text: "private source after edit" }, "control");
        await send(ana, secret, { type: "delete", target: message }, "control");
        expect(await lines(memes, botId)).toHaveLength(before);
        expect(diagnostics.checks.find((check: { label: string }) => check.label === "channelId")).toMatchObject({ ok: false });
      } finally {
        await settle();
        await h.ctx.officialBots.rows.save(original);
      }
    });

    it("does not publish a prepared Logger event after its manager disables it", async () => {
      await put("logger", { settings: { channelId: logs } });
      const message = await say(ana, general, "retained before disable");
      const before = (await lines(logs, botId)).length;
      let entered!: () => void, release!: () => void;
      const reading = new Promise<void>((resolve) => { entered = resolve; });
      const continueReading = new Promise<void>((resolve) => { release = resolve; });
      const changesTo = h.ctx.messages.changesTo.bind(h.ctx.messages);
      const spy = vi.spyOn(h.ctx.messages, "changesTo").mockImplementation(async (cid, target, type) => {
        const result = await changesTo(cid, target, type);
        if (cid === general && target === message && type === "edit") { entered(); await continueReading; }
        return result;
      });
      const pending = send(ana, general, { type: "edit", target: message, text: "retained after disable" }, "control");
      try {
        await reading;
        await put("logger", { enabled: false });
        release();
        await pending;
        expect(await lines(logs, botId)).toHaveLength(before);
      } finally {
        release();
        await pending;
        await settle();
        spy.mockRestore();
        await put("logger", { enabled: true });
      }
    });

    it("suppresses a restored public member-log destination without exposing a timeout reason", async () => {
      const original = h.ctx.officialBots.rows.bot(orgId, "logger")!;
      const before = (await lines(memes, botId)).length;
      try {
        await plus(true);
        await h.ctx.officialBots.rows.save({ ...original, settings: JSON.stringify({ ...JSON.parse(original.settings), channelId: logs, memberChannelId: memes }) });
        await owner.req("PUT", `/v1/orgs/${orgId}/members/${ben.userId}/timeout`, { until: Date.now() + 60_000, reason: "private moderation detail" });
        expect(await lines(memes, botId)).toHaveLength(before);
      } finally {
        await settle();
        await h.ctx.officialBots.rows.save(original);
        await plus(false);
        await owner.req("PUT", `/v1/orgs/${orgId}/members/${ben.userId}/timeout`, { until: null });
        await settle();
      }
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

    it("does not widen a nominally public Starboard source beyond its current audience", async () => {
      const source = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "limited-source", kind: "PUBLIC" })).channel.id;
      await owner.req("PUT", `/v1/conversations/${source}/overwrites`, { subject: `user:${dee.userId}`, allow: [], deny: ["channels.view"] });
      await expectStatus(dee.req("GET", `/v2/conversations/${source}/messages?limit=10`), 404);
      const message = await say(ana, source, "content behind a source permission");
      await react(ben, source, message, "⭐");
      await react(cai, source, message, "⭐");
      await settle();
      const board = await dee.req("GET", `/v2/conversations/${stars}/messages?limit=100`);
      expect((board.messages as Stored[]).some((event) => event.payload.text?.includes("content behind a source permission"))).toBe(false);
    });

    it("rechecks Starboard source visibility when access changes during a reaction read", async () => {
      const source = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "changing-source", kind: "PUBLIC" })).channel.id;
      const message = await say(ana, source, "content before a source restriction");
      await react(ben, source, message, "⭐");
      await settle();
      let entered!: () => void, release!: () => void;
      const reading = new Promise<void>((resolve) => { entered = resolve; });
      const continueReading = new Promise<void>((resolve) => { release = resolve; });
      const changesTo = h.ctx.messages.changesTo.bind(h.ctx.messages);
      const spy = vi.spyOn(h.ctx.messages, "changesTo").mockImplementation(async (cid, target, type) => {
        const result = await changesTo(cid, target, type);
        if (cid === source && target === message && type === "reaction") { entered(); await continueReading; }
        return result;
      });
      const pending = react(cai, source, message, "⭐");
      try {
        await reading;
        await owner.req("PUT", `/v1/conversations/${source}/overwrites`, { subject: `user:${dee.userId}`, allow: [], deny: ["channels.view"] });
        release();
        await pending;
        await settle();
        const board = await dee.req("GET", `/v2/conversations/${stars}/messages?limit=100`);
        expect((board.messages as Stored[]).some((event) => event.payload.text?.includes("content before a source restriction"))).toBe(false);
      } finally {
        release();
        await pending;
        await settle();
        spy.mockRestore();
      }
    });

    it.skipIf(!process.env.MELDIQ_TEST_PG_URL)("checks already prepared Starboard recipients inside PostgreSQL acceptance", async () => {
      const relay = h.ctx.relay;
      if (!(relay instanceof PostgresRelayStore)) throw new Error("PostgreSQL relay was not selected");
      const source = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "prepared-source", kind: "PUBLIC" })).channel.id;
      const message = await say(ana, source, "content with prepared recipients");
      await react(ben, source, message, "⭐");
      await settle();
      let entered!: (id: string) => void, release!: () => void;
      const preparing = new Promise<string>((resolve) => { entered = resolve; });
      const continueAcceptance = new Promise<void>((resolve) => { release = resolve; });
      const accept = relay.acceptEvent.bind(relay);
      const spy = vi.spyOn(relay, "acceptEvent").mockImplementation(async (event, submission, items, admit) => {
        if (event.conversation_id === stars && event.cls === "message" && JSON.parse(event.payload).starboard?.messageId === message) {
          entered(event.id);
          await continueAcceptance;
        }
        return accept(event, submission, items, admit);
      });
      const pending = react(cai, source, message, "⭐");
      try {
        const mirror = await preparing;
        for (const cid of [source, stars])
          await owner.req("PUT", `/v1/conversations/${cid}/overwrites`, { subject: `user:${dee.userId}`, allow: [], deny: ["channels.view"] });
        release();
        await pending;
        await settle();
        expect(await h.ctx.messages.get(mirror)).toBeNull();
        expect(h.ctx.ws.count("delivery_queue", { message_id: mirror })).toBe(0);
      } finally {
        release();
        await pending;
        await settle();
        spy.mockRestore();
        await owner.req("PUT", `/v1/conversations/${stars}/overwrites`, { subject: `user:${dee.userId}`, allow: [], deny: [] });
      }
    });

    it("withholds the body and old count edits of a stored Starboard copy after source access is lost", async () => {
      const source = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "previously-readable", kind: "PUBLIC" })).channel.id;
      const marker = "original source text that was previously readable";
      const message = await say(ana, source, marker);
      for (const voter of [ben, cai, dee]) await react(voter, source, message, "⭐");
      await settle();
      const copy = h.ctx.ws.get<{ star_message_id: string }>("bot_starboard", { message_id: message })!.star_message_id;
      const before = await dee.req("GET", `/v2/conversations/${stars}/messages?around=${copy}&limit=20`);
      expect(before.messages.find((event: Stored) => event.id === copy).payload.text).toContain(marker);
      expect(before.changes.some((event: Stored) => event.payload.type === "edit" && event.payload.target === copy && event.payload.text?.includes(marker))).toBe(true);
      await owner.req("PUT", `/v1/conversations/${source}/overwrites`, { subject: `user:${dee.userId}`, allow: [], deny: ["channels.view"] });
      await expectStatus(dee.req("GET", `/v2/conversations/${source}/messages?limit=10`), 404);
      const after = await dee.req("GET", `/v2/conversations/${stars}/messages?around=${copy}&limit=20`);
      expect(JSON.stringify(after)).not.toContain(marker);
      expect(JSON.stringify(await dee.req("GET", "/v2/messages/summary"))).not.toContain(marker);
      expect(JSON.stringify(await owner.req("GET", `/v2/conversations/${stars}/messages?around=${copy}&limit=20`))).toContain(marker);
    });

    it("withholds an existing Starboard body and its source pointer when the original is deleted", async () => {
      const source = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "removed-original", kind: "PUBLIC" })).channel.id;
      const marker = "source content removed after the board copied it";
      const message = await say(ana, source, marker);
      for (const voter of [ben, cai]) await react(voter, source, message, "⭐");
      await settle();
      const copy = h.ctx.ws.get<{ star_message_id: string }>("bot_starboard", { message_id: message })!.star_message_id;
      const route = `/v2/conversations/${stars}/messages?around=${copy}&limit=20`;
      const before = (await owner.req("GET", route)).messages.find((event: Stored) => event.id === copy);
      expect(before.payload.text).toContain(marker);
      expect(before.payload.starboard).toEqual({ channelId: source, messageId: message });
      await send(ana, source, { type: "delete", target: message }, "control");
      await settle();
      const redacted = (await owner.req("GET", route)).messages.find((event: Stored) => event.id === copy);
      expect(JSON.stringify(redacted)).not.toContain(marker);
      expect(redacted.payload.starboard).toBeUndefined();
    });

    it("keeps Starboard snapshots out of search pagination and protects collection and thread context reads", async () => {
      const source = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "searchable-source", kind: "PUBLIC" })).channel.id;
      const marker = "only the original should match this Starboard search";
      const message = await say(ana, source, marker);
      for (const voter of [ben, cai, dee]) await react(voter, source, message, "⭐");
      await settle();
      const copy = h.ctx.ws.get<{ star_message_id: string }>("bot_starboard", { message_id: message })!.star_message_id;
      const collection = `/v2/conversations/${stars}/message-collections`;
      const page = `${collection}?kind=main&around=${copy}&limit=10`;
      const thread = `${collection}?kind=thread&root=${copy}&limit=10`;
      expect(JSON.stringify(await dee.req("GET", page))).toContain(marker);
      expect(JSON.stringify(await dee.req("GET", thread))).toContain(marker);
      await owner.req("PUT", `/v1/conversations/${source}/overwrites`, { subject: `user:${dee.userId}`, allow: [], deny: ["channels.view"] });
      for (const route of [page, thread]) expect(JSON.stringify(await dee.req("GET", route))).not.toContain(marker);
      const search = `/v2/messages/search?q=${encodeURIComponent(marker)}&limit=1`;
      expect(await dee.req("GET", search)).toEqual({ messages: [], changes: [], more: false, nextCursor: null });
      const authorized = await owner.req("GET", search);
      expect(authorized.messages.map((event: Stored) => event.id)).toEqual([message]);
      expect(authorized).toMatchObject({ more: false, nextCursor: null });
    });

    it("redacts queued Starboard bodies and old edits for a revoked reader in REST and WebSocket replay", async () => {
      const source = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "replay-source", kind: "PUBLIC" })).channel.id;
      const marker = "synthetic private Starboard replay canary";
      const message = await say(ana, source, marker);
      for (const voter of [ben, cai, dee]) await react(voter, source, message, "⭐");
      await settle();
      const copy = h.ctx.ws.get<{ star_message_id: string }>("bot_starboard", { message_id: message })!.star_message_id;
      const board = (items: { conversationId: string; id: number; payload: { event: Stored } }[]) => items.filter((item) => item.conversationId === stars && (item.payload.event?.id === copy || item.payload.event?.payload.target === copy));
      const queued = async (c: GriipClient) => board((await c.req("GET", "/v1/queue?limit=200")).items);
      const before = await queued(dee);
      expect(before).toHaveLength(2);
      expect(before.every((item) => item.payload.event.payload.text?.includes(marker))).toBe(true);
      await owner.req("PUT", `/v1/conversations/${source}/overwrites`, { subject: `user:${dee.userId}`, allow: [], deny: ["channels.view"] });
      const revoked = await queued(dee);
      expect(revoked.map((item) => item.id)).toEqual(before.map((item) => item.id));
      expect.soft(JSON.stringify(revoked)).not.toContain(marker);
      expect.soft(JSON.stringify(revoked)).not.toContain(message);
      expect(JSON.stringify(await queued(owner))).toContain(marker);

      const start = dee.events.length;
      await dee.connect();
      try {
        await dee.waitFor(() => dee.events.slice(start).some((event) => event.t === "queue.drained"));
        const delivered = dee.events.slice(start).filter((event) => event.t === "queue").flatMap((event) => board(event.items));
        expect(delivered.map((item) => item.id)).toEqual(before.map((item) => item.id));
        expect.soft(JSON.stringify(delivered)).not.toContain(marker);
        expect.soft(JSON.stringify(delivered)).not.toContain(message);
      } finally {
        await dee.disconnect();
      }
      // An edit can be on a different queue page, or the original copy can have been acknowledged already.
      const ownerQueue = await queued(owner);
      const original = ownerQueue.find((item) => item.payload.event.id === copy)!;
      await owner.req("POST", "/v1/queue/ack", { ids: [original.id] });
      expect(JSON.stringify(await queued(owner))).toContain(marker);
      await send(ana, source, { type: "delete", target: message }, "control");
      const afterDelete = await queued(owner);
      expect(afterDelete).toHaveLength(1);
      expect(afterDelete[0]!.payload.event.payload.target).toBe(copy);
      expect(JSON.stringify(afterDelete)).not.toContain(marker);
    });

    it("shows an uploaded Starboard image only through the current readable original", async () => {
      const source = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "starred-image-source", kind: "PUBLIC" })).channel.id;
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+yYAAAAASUVORK5CYII=", "base64");
      const key = randomBytes(32), nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(png), cipher.final(), cipher.getAuthTag()]);
      const { id } = await ana.req("POST", `/v1/attachments?conversationId=${source}`, undefined, encrypted);
      const ref = { id, name: "pixel.png", mime: "image/png", size: png.length, key: key.toString("base64"), nonce: nonce.toString("base64"), sha256: createHash("sha256").update(encrypted).digest("base64") };
      const original = await say(ana, source, "an uploaded picture", { attachments: [ref] });
      await expectStatus(send(ana, stars, { type: "text", text: "attempted cross-channel reuse", attachments: [ref] }), 400);
      for (const voter of [ben, cai]) await react(voter, source, original, "⭐");
      await settle();
      const mirror = h.ctx.ws.get<{ star_message_id: string | null }>("bot_starboard", { message_id: original })?.star_message_id;
      expect(mirror).toEqual(expect.any(String));
      const board = `/v2/conversations/${stars}/messages?around=${mirror}&limit=20`;
      const image = (await dee.req("GET", board)).messages.find((m: Stored) => m.id === mirror).payload.attachments[0];
      expect(image).toMatchObject(ref);
      const downloaded: Buffer = await dee.req("GET", `/v1/attachments/${image.id}`);
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(image.key, "base64"), Buffer.from(image.nonce, "base64"));
      decipher.setAuthTag(downloaded.subarray(-16));
      expect(Buffer.concat([decipher.update(downloaded.subarray(0, -16)), decipher.final()])).toEqual(png);
      expect(await h.ctx.files.attachment(id)).toMatchObject({ conversation_id: source, message_id: original });
      await owner.req("PUT", `/v1/conversations/${source}/overwrites`, { subject: `user:${dee.userId}`, allow: [], deny: ["channels.view"] });
      expect(JSON.stringify(await dee.req("GET", board))).not.toContain(id);
      await expectStatus(dee.req("GET", `/v1/attachments/${id}`), 404);
      expect(JSON.stringify(await owner.req("GET", board))).toContain(id);
      await setAttachmentExpiry(h, [id], Date.now() - 1);
      const expired = JSON.stringify(await owner.req("GET", board));
      expect(expired).not.toContain(id);
      expect(expired).toContain("an uploaded picture");
      await send(ana, source, { type: "delete", target: original }, "control");
      expect(JSON.stringify(await owner.req("GET", board))).not.toContain("an uploaded picture");
    });
  });
});
