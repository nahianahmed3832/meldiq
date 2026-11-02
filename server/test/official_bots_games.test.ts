import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draw, parseDuration, parseGiveaway } from "../src/modules/officialBots/giveawayParse.js";
import { OfficialBots } from "../src/modules/officialBots/runtime.js";
import { dailyWord, dayBefore, dayOf, score, squares, wordLists } from "../src/modules/officialBots/wordyGame.js";
import { WordyGame } from "../src/shared/contracts/http/officialBotTools.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Official bots that play (community parity batch D part 2, docs/COMMUNITY_PARITY_API.md › Official bots): Giveaways
 * (parsing and limits, staff only, entries by 🎉, ending on time across a restart, !gend, !greroll, Bots+ role and
 * limits, the lobby's card) and Wordy (the daily word, scoring with repeated letters, one game a day, no spoilers,
 * private play, streaks, stats and the recap). Runs with the community tables in SQLite and in MongoDB.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const STARTUP_MS = 120_000;
const DAY = 86_400_000;
const code = (e: { error: { code: string } }) => e.error.code;
let n = 0;
const nextId = () => `m_obg_${++n}_${Date.now()}`;

interface Stored {
  id: string;
  senderUserId: string;
  cls: string;
  payload: { type: string; text?: string; target?: string; mentions?: string[]; embeds?: { title?: string }[]; giveaway?: { ended: boolean; winnerIds?: string[] } };
}

describe("giveaway commands", () => {
  it("read durations in s, m, h, d and w, alone or together", () => {
    expect(["45s", "10m", "2h", "1d", "1w", "1d12h"].map(parseDuration)).toEqual([45_000, 600_000, 7_200_000, DAY, 7 * DAY, 1.5 * DAY]);
    for (const bad of ["", "1y", "d", "10", "1h-"]) expect(parseDuration(bad)).toBeNull();
  });

  it("take winners after the duration and keep to the free or Bots+ limits", () => {
    expect(parseGiveaway("2h 3w A game key", false)).toEqual({ ok: { durationMs: 7_200_000, winners: 3, prize: "A game key" } });
    expect(parseGiveaway("1w Stickers", false)).toEqual({ ok: { durationMs: 7 * DAY, winners: 1, prize: "Stickers" } });
    expect(parseGiveaway("1d 4w Prize", false)).toMatchObject({ error: expect.stringContaining("1 to 3 winners (20 with Bots+)") });
    expect(parseGiveaway("8d Prize", false)).toMatchObject({ error: expect.stringContaining("up to 7 days (30 with Bots+)") });
    expect(parseGiveaway("30d 20w Prize", true)).toMatchObject({ ok: { winners: 20 } });
    expect(parseGiveaway("31d Prize", true)).toHaveProperty("error");
    expect(parseGiveaway("5s Prize", false)).toHaveProperty("error");
    expect(parseGiveaway("1d", false)).toHaveProperty("error");
    expect(parseGiveaway("Prize", false)).toHaveProperty("error");
  });

  it("draw different people", () => {
    const won = draw(["a", "b", "c", "d"], 3, (max) => max - 1);
    expect(new Set(won).size).toBe(3);
    expect(draw(["a"], 3, () => 0)).toEqual(["a"]);
  });
});

describe("Wordy's game", () => {
  it("picks the same word for a community all day, and no word twice until the list is used up", () => {
    const { answers } = wordLists();
    expect(answers.length).toBeGreaterThan(300);
    expect(wordLists().valid.size).toBeGreaterThan(answers.length * 10);
    expect(dailyWord("o_one", "2026-10-30")).toBe(dailyWord("o_one", "2026-10-30"));
    const days = Array.from({ length: answers.length }, (_, i) => dayOf(Date.UTC(2026, 0, 1) + i * DAY));
    expect(new Set(days.map((d) => dailyWord("o_one", d))).size).toBe(answers.length);
    expect(days.slice(0, 20).map((d) => dailyWord("o_one", d))).not.toEqual(days.slice(0, 20).map((d) => dailyWord("o_two", d)));
  });

  it("scores repeated letters only as often as the word has them", () => {
    expect(squares(score("paper", "apple"))).toBe("🟨🟨🟩🟨⬛");
    expect(squares(score("eerie", "crane"))).toBe("⬛⬛🟨⬛🟩");
    expect(squares(score("level", "steal"))).toBe("⬛🟨⬛⬛🟩");
    expect(squares(score("crane", "crane"))).toBe("🟩🟩🟩🟩🟩");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
  });
});

describe.each([
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const)("official bots that play, in %s", (_backend, env) => {
  let h: Harness;
  let owner: GriipClient, ana: GriipClient, ben: GriipClient, cai: GriipClient, dee: GriipClient;
  let orgId: string, general: string, games: string, invite: string;
  const base = () => `/v1/orgs/${orgId}/official-bots`;
  const settle = () => h.ctx.officialBots.settled();
  const send = (c: GriipClient, conv: string, payload: Record<string, unknown>, cls = "message") =>
    c.req("POST", "/v2/messages", { conversationId: conv, messageId: nextId(), cls, sentAt: Date.now(), payload });
  const say = async (c: GriipClient, conv: string, text: string) => (await send(c, conv, { type: "text", text })).messageId as string;
  const react = (c: GriipClient, conv: string, target: string, emoji = "🎉") => send(c, conv, { type: "reaction", target, emoji, add: true }, "control");
  const events = async (conv: string, botId: string): Promise<Stored[]> => {
    await settle();
    const page = await owner.req("GET", `/v2/conversations/${conv}/messages?limit=100`);
    return [...(page.messages as Stored[]).reverse(), ...(page.changes as Stored[])].filter((m) => m.senderUserId === botId);
  };
  const lines = async (conv: string, botId: string) => (await events(conv, botId)).filter((m) => m.cls === "message").map((m) => m.payload.text ?? "");
  const put = (key: string, body: unknown) => owner.req("PUT", `${base()}/${key}`, body);
  const plus = (on: boolean) => h.ctx.officialBots.setPlus(orgId, on ? { by: "test", expiresAt: null, reason: "tests" } : null);
  const giveaway = (prize: string) => h.ctx.ws.get<{ id: string; ends_at: number; message_id: string; ended_at: number | null; winner_ids: string; entrants: number }>("bot_giveaways", { org_id: orgId, prize })!;

  beforeAll(async () => {
    h = await startServer({ ...env });
    [owner, ana, ben, cai, dee] = await Promise.all(["obgowner", "obgana", "obgben", "obgcai", "obgdee"].map((x) => h.client(x)));
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Game Night" })).org.id;
    invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [ana, ben, cai, dee]) await c.req("POST", "/v1/invites/accept", { code: invite });
    general = h.ctx.ws.get<{ id: string }>("conversations", { org_id: orgId, name: "general" })!.id;
    games = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "games", kind: "PUBLIC" })).channel.id;
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  describe("Giveaways", () => {
    let botId: string;
    beforeAll(async () => {
      botId = (await put("giveaways", { enabled: true })).bot.userId;
    });

    it("lets only people who manage messages start one, and answers mistakes with how to", async () => {
      await say(ana, general, "!giveaway 1h Free pizza");
      await say(owner, general, "!giveaway 8d Too long");
      await say(owner, general, "!giveaway soon Prize");
      const said = (await lines(general, botId)).slice(-3);
      expect(said[0]).toContain("Only people who manage messages");
      expect(said[1]).toContain("up to 7 days (30 with Bots+)");
      expect(said[2]).toContain("!giveaway 1d Prize");
      expect(h.ctx.ws.count("bot_giveaways", { org_id: orgId })).toBe(0);
    });

    it("posts a card people enter with 🎉, shown on the lobby, and draws members only when it ends, even after a restart", async () => {
      await say(owner, general, "!giveaway 1h 2w A game key");
      await settle();
      const g = giveaway("A game key");
      const card = (await events(general, botId)).find((m) => m.id === g.message_id)!;
      expect(card.payload.text).toMatch(/^🎉 Giveaway: A game key\nReact with 🎉 to enter · 2 winners · ends in 1 hour/);
      expect(card.payload.embeds?.[0]?.title).toBe("🎉 A game key");
      expect(card.payload.giveaway).toMatchObject({ ended: false });
      for (const c of [ana, ben, cai, dee]) await react(c, general, g.message_id);
      await settle();
      expect(giveaway("A game key").entrants).toBe(4);
      expect((await ana.req("GET", `/v1/orgs/${orgId}/lobby`)).giveaways).toEqual([{ id: g.id, title: "A game key", endsAt: g.ends_at, entrants: 4 }]);
      await cai.req("POST", "/v2/orgs/leave", { orgIds: [orgId] });
      await h.ctx.officialBots.scheduler.tick(g.ends_at - 1);
      expect(giveaway("A game key").ended_at).toBeNull();
      // A restarted server has nothing in memory: a fresh runtime's tick ends it from the stored end time.
      const restarted = new OfficialBots(h.ctx, true);
      await restarted.scheduler.tick(g.ends_at + 1);
      await restarted.settled();
      const ended = giveaway("A game key");
      const winners = JSON.parse(ended.winner_ids) as string[];
      expect(winners).toHaveLength(2);
      expect(winners.every((id) => [ana.userId, ben.userId, dee.userId].includes(id))).toBe(true);
      const after = await events(general, botId);
      expect(after.find((m) => m.payload.type === "edit" && m.payload.target === g.message_id)?.payload.giveaway).toMatchObject({ ended: true, winnerIds: winners });
      const called = after.filter((m) => m.cls === "message").at(-1)!;
      expect(called.payload.text).toMatch(/^🎉 Congratulations @.+, @.+! You won A game key\.$/);
      expect(called.payload.mentions?.sort()).toEqual([...winners].sort());
      expect((await ana.req("GET", `/v1/orgs/${orgId}/lobby`)).giveaways).toEqual([]);
      // A second tick finds nothing to end.
      await h.ctx.officialBots.scheduler.tick(g.ends_at + 2);
      expect((await lines(general, botId)).filter((t) => t.startsWith("🎉 Congratulations"))).toHaveLength(1);

      await say(owner, general, "!greroll");
      const third = [ana.userId, ben.userId, dee.userId].find((id) => !winners.includes(id))!;
      const rerolled = (await events(general, botId)).filter((m) => m.cls === "message").at(-1)!;
      expect(rerolled.payload.mentions).toEqual([third]);
      await say(owner, general, "!greroll");
      expect((await lines(general, botId)).at(-1)).toContain("everyone who entered has won already");
    });

    it("ends early with !gend, and says so when nobody entered", async () => {
      await say(owner, general, "!gend");
      expect((await lines(general, botId)).at(-1)).toContain("No giveaway is running");
      await say(owner, general, "!giveaway 1d Stickers");
      await settle();
      await say(owner, general, "!gend");
      await settle();
      expect(giveaway("Stickers").ended_at).not.toBeNull();
      expect((await lines(general, botId)).at(-1)).toBe("🎉 Nobody could win Stickers: no one entered in time.");
    });

    it("with Bots+: longer, more winners and only members with the required role", async () => {
      const role = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Supporter", permissions: [] })).role.id;
      expect(code(await expectStatus(put("giveaways", { settings: { requiredRoleId: role } }), 403))).toBe("bots_plus_required");
      await plus(true);
      expect(code(await expectStatus(put("giveaways", { settings: { requiredRoleId: "r_nowhere" } }), 400))).toBe("bad_request");
      await put("giveaways", { settings: { requiredRoleId: role } });
      await owner.req("PUT", `/v1/roles/${role}/members/${dee.userId}`);
      await say(owner, general, "!giveaway 20d 10w Signed poster");
      await settle();
      const g = giveaway("Signed poster");
      expect(g.ends_at).toBeGreaterThan(Date.now() + 19 * DAY);
      expect((await events(general, botId)).find((m) => m.id === g.message_id)!.payload.text).toContain("10 winners");
      for (const c of [ana, dee]) await react(c, general, g.message_id);
      await say(owner, general, "!gend");
      await settle();
      expect(JSON.parse(giveaway("Signed poster").winner_ids)).toEqual([dee.userId]);
      await plus(false);
    });
  });

  describe("Wordy", () => {
    let botId: string;
    let answer: string;
    let wrong: string[];
    const today = () => dayOf(Date.now());
    beforeAll(async () => {
      botId = (await put("wordy", { enabled: true, settings: { channelId: games } })).bot.userId;
      answer = dailyWord(orgId, today());
      wrong = wordLists().answers.filter((w) => w !== answer).slice(0, 6);
    });

    it("is played in its channel: !wordy starts, a bare word guesses, and the board never shows letters", async () => {
      await say(ana, general, "!wordy");
      expect((await lines(general, botId)).at(-1)).toBe("🔤 Wordy is played in #games.");
      await say(ana, games, "/wordy");
      expect((await lines(games, botId)).at(-1)).toMatch(/^🔤 Wordy #\d+ is on, obgana/);
      await say(ana, games, wrong[0]!);
      const board = (await lines(games, botId)).at(-1)!;
      expect(board).toMatch(/^🔤 obgana\d* · Wordy #\d+ · 1\/6\n[🟩🟨⬛]{5}$/u);
      expect(board.toLowerCase()).not.toContain(wrong[0]);
      await say(ana, games, "!wordy zzzzz");
      expect((await lines(games, botId)).at(-1)).toContain("not in Wordy's word list");
      await say(ana, games, "!wordy toolong");
      expect((await lines(games, botId)).at(-1)).toBe("🔤 Wordy only takes five-letter words.");
    });

    it("keeps streaks going from yesterday, and one game a day", async () => {
      await h.ctx.ws.write((w) =>
        w.insert("bot_wordy_stats", { org_id: orgId, user_id: ana.userId, played: 4, won: 4, streak: 4, best_streak: 4, last_day: dayBefore(today()), last_won_day: dayBefore(today()), distribution: "[0,1,2,1,0,0]" }),
      );
      await say(ana, games, answer);
      const won = (await lines(games, botId)).at(-1)!;
      expect(won).toMatch(/^🎉 obgana\d* solved Wordy #\d+ in 2\/6!\n[🟩🟨⬛]{5}\n🟩🟩🟩🟩🟩\nStreak: 5 🔥$/u);
      // A valid answer such as "solve" may be a substring of the fixed word "solved".
      expect(won.toLowerCase()).not.toMatch(new RegExp(`\\b${answer}\\b`));
      expect(h.ctx.ws.get<{ streak: number; best_streak: number; distribution: string }>("bot_wordy_stats", { org_id: orgId, user_id: ana.userId })).toMatchObject({ streak: 5, best_streak: 5, distribution: "[0,2,2,1,0,0]" });
      await say(ana, games, "!wordy");
      expect((await lines(games, botId)).at(-1)).toMatch(/has played Wordy #\d+ already \(2\/6\)/);
      const before = (await lines(games, botId)).length;
      await say(ana, games, wrong[1]!);
      expect(await lines(games, botId)).toHaveLength(before);
    });

    it("plays privately from the apps, posting only the finished board", async () => {
      const first = await ben.req("POST", `${base()}/wordy/game`, { guess: wrong[0] });
      expect(WordyGame.safeParse(first).success).toBe(true);
      expect(first.rows).toEqual([{ guess: wrong[0], marks: squares(score(wrong[0]!, answer)) }]);
      expect(code(await expectStatus(ben.req("POST", `${base()}/wordy/game`, { guess: "qqqqq" }), 400))).toBe("wordy_not_a_word");
      let last = first;
      for (const w of wrong.slice(1)) last = await ben.req("POST", `${base()}/wordy/game`, { guess: w });
      expect(last).toMatchObject({ finished: true, solved: false, channelId: games, stats: { played: 1, won: 0, streak: 0 } });
      expect(code(await expectStatus(ben.req("POST", `${base()}/wordy/game`, { guess: answer }), 409))).toBe("wordy_finished");
      const posted = (await lines(games, botId)).at(-1)!;
      expect(posted).toMatch(/^🔤 obgben\d* is out of tries on Wordy #\d+ \(X\/6\)\./);
      expect(wrong.some((w) => posted.toLowerCase().includes(w))).toBe(false);
      expect((await dee.req("GET", `${base()}/wordy/game`)).rows).toEqual([]);
    });

    it("shows your record and the best solvers here", async () => {
      await say(ben, games, "!wordy stats");
      const said = (await lines(games, botId)).at(-1)!;
      expect(said).toMatch(/^📊 obgben\d*: 1 played · 0 won \(0%\) · streak 0 \(best 0\)\nBest solvers here:\n1\. obgana\d* · 5 won · streak 5$/);
    });

    it("posts yesterday's recap once just after midnight UTC", async () => {
      const midnight = Date.parse(`${today()}T00:00:00Z`) + DAY;
      await h.ctx.officialBots.scheduler.tick(midnight + 30_000);
      await h.ctx.officialBots.scheduler.tick(midnight + 90_000);
      const recaps = (await lines(games, botId)).filter((t) => t.includes("recap:"));
      expect(recaps).toHaveLength(1);
      expect(recaps[0]).toContain(`recap: the word was ${answer.toUpperCase()}.\n1 of 2 solved it.\n1/6 ▏ 0\n2/6 ▏🟩`);
      expect(recaps[0]).toContain("X/6 ▏🟩");
    });
  });
});
