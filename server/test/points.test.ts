import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MemoryPointsStore,
  POINTS,
  PointsService,
} from "../src/modules/points/index.js";
import {
  CheckinResult,
  PointsView,
} from "../src/shared/contracts/http/points.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** Points, quests and levels (API 0.65.0, docs/SETTINGS_PARITY_API.md). */

const PRODUCTION_DOMAINS =
  "preferences,reports,relationships,history,accounts,files,relay,billing";
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-02T10:00:00Z");

const mid = () => crypto.randomBytes(12).toString("base64url");
const send = (
  c: GriipClient,
  conversationId: string,
  payload: Record<string, unknown>,
  cls: "message" | "control" = "message",
) =>
  c.req("POST", "/v2/messages", {
    conversationId,
    messageId: mid(),
    cls,
    sentAt: Date.now(),
    payload,
  });

/** Makes [c]'s account [days] days old, so it earns. */
const age = (h: Harness, c: GriipClient, days = 2, clock = Date.now()) =>
  h.ctx.identity.write((w) =>
    w.update(
      "users",
      { id: c.userId },
      { created_at: clock - days * DAY },
    ),
  );
const quest = (view: PointsView, id: string) =>
  view.quests.find((q) => q.id === id)!;

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
  ["memory", { MONGODB_DOMAINS: "" }],
  ["mongodb", { MONGODB_DOMAINS: PRODUCTION_DOMAINS }],
] as const)("points kept in %s", (backend, env) => {
  let h: Harness;

  beforeAll(async () => {
    h = await startServer({ MESSAGES_ACCEPT_ENCRYPTED: "false", ...env });
    expect(h.ctx.points.store.backend).toBe(backend);
  });
  afterAll(async () => h?.close());

  /** A service over the server's own store on a clock the test moves. */
  const at = (clock: { t: number }) =>
    new PointsService(h.ctx, h.ctx.points.store, () => clock.t);

  it("gives nothing to accounts under a day old", async () => {
    const c = await h.client("ptnew");
    const r = await c.req("POST", "/v2/points/checkin");
    expect(CheckinResult.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({
      counted: false,
      points: { balance: 0, earning: false, level: 1 },
    });
  });

  it("counts the daily visit once a day, however often the apps check in", async () => {
    const c = await h.client("ptvisit");
    await age(h, c);
    const [a, b] = await Promise.all([
      c.req("POST", "/v2/points/checkin"),
      c.req("POST", "/v2/points/checkin"),
    ]);
    expect([a.counted, b.counted].sort()).toEqual([false, true]);
    const again = await c.req("POST", "/v2/points/checkin");
    expect(again).toMatchObject({
      counted: false,
      points: { balance: 5, earnedToday: 5, earnedTotal: 5, streak: 1 },
    });
    expect(again.points.history).toEqual([
      expect.objectContaining({ kind: "visit", amount: 5 }),
    ]);
  });

  it("adds 30 for each 7 days in a row, and starts the streak again after a missed day", async () => {
    const c = await h.client("ptstreak");
    await age(h, c, 30, T0);
    const clock = { t: T0 };
    const points = at(clock);
    for (let d = 0; d < 7; d++) {
      clock.t = T0 + d * DAY;
      await points.checkin(c.userId);
    }
    let v = await points.view(c.userId);
    expect(v).toMatchObject({
      balance: 7 * POINTS.visit + POINTS.streakBonus,
      streak: 7,
    });
    expect(v.history.filter((e) => e.kind === "streak")).toEqual([
      expect.objectContaining({ amount: 30, detail: "7" }),
    ]);
    clock.t = T0 + 9 * DAY;
    expect((await points.view(c.userId)).streak).toBe(0);
    await points.checkin(c.userId);
    v = await points.view(c.userId);
    expect(v).toMatchObject({
      streak: 1,
      balance: 8 * POINTS.visit + POINTS.streakBonus,
    });
  });

  it("counts a chat minute once however many messages it has, 5 points per 5 minutes, at most 25 a day", async () => {
    const c = await h.client("ptchat");
    await age(h, c, 2, T0);
    const clock = { t: T0 };
    const points = at(clock);
    const msg = (t: number) =>
      points.noteMessage({
        userId: c.userId,
        conversationId: "c_somewhere",
        messageId: mid(),
        cls: "message",
        payload: { type: "text", text: "hi" },
        at: t,
      });
    await Promise.all([msg(T0), msg(T0 + 10_000), msg(T0 + 59_000)]);
    expect((await points.view(c.userId)).chatMinutesToday).toBe(1);
    for (let m = 1; m < 5; m++) await msg(T0 + m * 60_000);
    let v = await points.view(c.userId);
    expect(v).toMatchObject({
      chatMinutesToday: 5,
      chatPointsToday: 5,
      balance: 5,
    });
    for (let m = 5; m < 40; m++) await msg(T0 + m * 60_000);
    v = await points.view(c.userId);
    expect(v).toMatchObject({
      chatMinutesToday: 25,
      chatPointsToday: 25,
      chatDailyCap: 25,
      balance: 35,
    });
    // A new UTC day counts again.
    await msg(T0 + DAY);
    clock.t = T0 + DAY;
    expect((await points.view(c.userId)).chatMinutesToday).toBe(1);
  });

  it("finishes the daily quests from real messages: 3 chats, 3 reactions and a reply to others", async () => {
    const [ada, bob, cat, dan] = await Promise.all(
      ["ptqada", "ptqbob", "ptqcat", "ptqdan"].map((n) => h.client(n)),
    );
    await age(h, ada);
    const dms = await Promise.all(
      [bob, cat, dan].map(
        async (o) =>
          (await ada.req("POST", "/v1/conversations/dm", { userId: o.userId }))
            .conversation.id as string,
      ),
    );
    const mine = (await send(ada, dms[0], { type: "text", text: "mine" }))
      .messageId;
    await send(ada, dms[1], { type: "text", text: "two" });
    let v: PointsView = await ada.req("GET", "/v2/points");
    expect(quest(v, "daily-chats")).toMatchObject({
      progress: 2,
      goal: 3,
      state: "open",
    });
    await send(ada, dms[2], { type: "text", text: "three" });
    await send(ada, dms[2], { type: "text", text: "three again" });
    v = await ada.req("GET", "/v2/points");
    expect(PointsView.safeParse(v).success).toBe(true);
    expect(quest(v, "daily-chats")).toMatchObject({
      progress: 3,
      state: "claimed",
      reward: 10,
    });

    // Reacting to your own message doesn't count; three of others' do, once each.
    await send(
      ada,
      dms[0],
      { type: "reaction", target: mine, emoji: "👍", add: true },
      "control",
    );
    const theirs = [];
    for (let i = 0; i < 3; i++)
      theirs.push(
        (await send(bob, dms[0], { type: "text", text: `b${i}` })).messageId,
      );
    await send(
      ada,
      dms[0],
      { type: "reaction", target: theirs[0], emoji: "👍", add: true },
      "control",
    );
    await send(
      ada,
      dms[0],
      { type: "reaction", target: theirs[0], emoji: "🎉", add: true },
      "control",
    );
    expect(
      quest(await ada.req("GET", "/v2/points"), "daily-reactions"),
    ).toMatchObject({ progress: 1, state: "open" });
    for (const t of theirs.slice(1))
      await send(
        ada,
        dms[0],
        { type: "reaction", target: t, emoji: "👍", add: true },
        "control",
      );
    await send(ada, dms[0], { type: "text", text: "to myself", replyTo: mine });
    expect(quest(await ada.req("GET", "/v2/points"), "daily-reply").state).toBe(
      "open",
    );
    await send(ada, dms[0], {
      type: "text",
      text: "answer",
      replyTo: theirs[2],
    });
    v = await ada.req("GET", "/v2/points");
    expect(quest(v, "daily-reactions")).toMatchObject({
      progress: 3,
      state: "claimed",
    });
    expect(quest(v, "daily-reply")).toMatchObject({
      progress: 1,
      state: "claimed",
    });
    expect(
      v.history
        .filter((e) => e.kind === "quest")
        .map((e) => e.detail)
        .sort(),
    ).toEqual(["daily-chats", "daily-reactions", "daily-reply"]);
    for (let i = 0; i < 4; i++)
      await send(ada, dms[0], {
        type: "text",
        text: "same target",
        replyTo: theirs[2],
      });
    expect(
      quest(await ada.req("GET", "/v2/points"), "daily-thoughtful"),
    ).toMatchObject({ progress: 1, state: "open" });
    for (const target of theirs.slice(0, 2))
      await send(ada, dms[0], {
        type: "text",
        text: "another answer",
        replyTo: target,
      });
    expect(
      quest(await ada.req("GET", "/v2/points"), "daily-thoughtful"),
    ).toMatchObject({ progress: 3, state: "claimed" });
    for (let i = 0; i < 2; i++) {
      const target = (
        await send(bob, dms[0], { type: "text", text: `extra${i}` })
      ).messageId;
      await send(
        ada,
        dms[0],
        { type: "reaction", target, emoji: "👍", add: true },
        "control",
      );
    }
    expect(
      quest(await ada.req("GET", "/v2/points"), "daily-appreciation"),
    ).toMatchObject({ progress: 5, state: "claimed" });
  });

  it("claims one-time quests when the account meets them", async () => {
    const c = await h.client("ptonce");
    await age(h, c);
    let v: PointsView = await c.req("GET", "/v2/points");
    expect(quest(v, "profile")).toMatchObject({
      progress: 0,
      goal: 2,
      state: "open",
    });
    await h.ctx.identity.write((w) =>
      w.update(
        "users",
        { id: c.userId },
        { photo_rev: Date.now(), about_me: "Hello" },
      ),
    );
    await c.req("PUT", "/v1/users/me/profile-style", { decoration: "aurora" });
    v = await c.req("GET", "/v2/points");
    expect(quest(v, "profile").state).toBe("claimed");
    expect(quest(v, "decoration").state).toBe("claimed");
    expect(v.balance).toBe(25 + 15 + 10 + 10);
    // Claimed for good: taking the decoration off changes nothing, and asking again pays nothing more.
    await c.req("PUT", "/v1/users/me/profile-style", { decoration: null });
    v = await c.req("GET", "/v2/points");
    expect(quest(v, "decoration")).toMatchObject({
      state: "claimed",
      progress: 1,
    });
    expect(v.balance).toBe(60);
  });

  it("keeps achievement awards through reloads and missed streaks without inflating the wallet or quest totals", async () => {
    const c = await h.client("ptachieve");
    await age(h, c, 30, T0);
    const clock = { t: T0 };
    const points = at(clock);
    await points.load();
    await Promise.all([
      points.checkin(c.userId),
      points.checkin(c.userId),
      points.view(c.userId),
    ]);
    for (let day = 1; day < 3; day++) {
      clock.t = T0 + day * DAY;
      await points.checkin(c.userId);
    }
    const view = await points.view(c.userId);
    expect(view.quests).toHaveLength(19);
    expect(view.achievements).toHaveLength(26);
    expect(view.balance).toBe(15);
    expect(view.achievements.find((a) => a.id === "kindling")).toMatchObject({
      earnedAt: T0 + 2 * DAY,
      progress: 3,
    });
    expect(await points.store.countSince(c.userId, "quest", 0)).toBe(0);
    expect(
      (await points.store.achievementAwards(c.userId)).filter(
        (a) => a.achievementId === "first-ember",
      ),
    ).toHaveLength(1);
    expect(view.history.every((e) => e.amount !== 0)).toBe(true);
    clock.t = T0 + 8 * DAY;
    const restarted = at(clock);
    await restarted.load();
    const later = await restarted.view(c.userId);
    expect(later.streak).toBe(0);
    expect(later.achievements.find((a) => a.id === "kindling")).toEqual(
      view.achievements.find((a) => a.id === "kindling"),
    );
    expect(restarted.earnedAchievements(c.userId).map((a) => a.id)).toContain(
      "kindling",
    );
    expect(await points.store.account(c.userId)).toMatchObject({
      balance: 15,
      earnedTotal: 15,
    });
  });

  it("levels up for 100 points, refuses without them, and shows the level on profiles", async () => {
    const [c, viewer] = await Promise.all([
      h.client("ptlevel"),
      h.client("ptviewer"),
    ]);
    expect(
      (await expectStatus(c.req("POST", "/v2/points/level-up"), 409)).error
        .code,
    ).toBe("not_enough_points");
    for (let i = 0; i < 21; i++) {
      await h.ctx.points.store.earn({
        id: `test:${c.userId}:${i}`,
        userId: c.userId,
        kind: "visit",
        amount: 5,
        detail: null,
        day: "2026-11-01",
        at: Date.now(),
      });
    }
    expect(await c.req("POST", "/v2/points/level-up")).toEqual({
      level: 2,
      balance: 5,
      nextLevelCost: 100,
    });
    await expectStatus(c.req("POST", "/v2/points/level-up"), 409);
    expect((await viewer.req("GET", `/v1/users/${c.userId}`)).user.level).toBe(
      2,
    );
    const v: PointsView = await c.req("GET", "/v2/points");
    expect(v).toMatchObject({ level: 2, balance: 5, earnedTotal: 105 });
    expect(v.history.filter((e) => e.kind === "level")).toEqual([
      expect.objectContaining({ amount: -100, detail: "2" }),
    ]);
  });

  it("pays an inviter 100 once the person they brought has stayed 7 days, at most 10 a month", async () => {
    const [ada, bob, cat] = await Promise.all(
      ["ptinvada", "ptinvbob", "ptinvcat"].map((n) => h.client(n)),
    );
    await age(h, ada);
    const org = (
      await ada.req("POST", "/v1/orgs", {
        name: "Invite place",
        visibility: "public",
        joinPolicy: "invite",
      })
    ).org.id;
    const code = (
      await ada.req("POST", `/v1/orgs/${org}/invites`, {
        role: "MEMBER",
        maxUses: 5,
      })
    ).invite.code;
    for (const c of [bob, cat])
      await c.req("POST", "/v1/invites/accept", { code });
    let v: PointsView = await ada.req("GET", "/v2/points");
    expect(v.invites).toEqual({
      pending: 2,
      credited: 0,
      creditedThisMonth: 0,
      monthlyLimit: 10,
    });
    await cat.req("DELETE", `/v1/orgs/${org}/members/${cat.userId}`);
    const later = at({ t: Date.now() + 7 * DAY + 1000 });
    v = await later.view(ada.userId);
    expect(v.invites).toMatchObject({ pending: 0, credited: 1 });
    expect(v.history.find((e) => e.kind === "invite")).toMatchObject({
      amount: 100,
      detail: org,
    });
    expect((await later.view(ada.userId)).balance).toBe(v.balance);

    const dan = await h.client("ptinvdan");
    await age(h, dan);
    for (let i = 0; i < 10; i++) {
      await h.ctx.points.store.earn({
        id: `test:invite:${dan.userId}:${i}`,
        userId: dan.userId,
        kind: "invite",
        amount: 100,
        detail: null,
        day: "2026-11-01",
        at: Date.now(),
      });
    }
    await h.ctx.points.noteInviteJoin(dan.userId, bob.userId, org, Date.now());
    expect((await later.view(dan.userId)).invites).toMatchObject({
      pending: 0,
      credited: 0,
    });
  });

  it("earns 1.5 times on Meldiq Plus", async () => {
    const c = await h.client("ptplus");
    await age(h, c);
    const plan = vi.spyOn(h.ctx.mojo, "planOf").mockReturnValue("plus");
    try {
      const r = await c.req("POST", "/v2/points/checkin");
      expect(r.points).toMatchObject({
        balance: 8,
        multiplier: 1.5,
        chatDailyCap: 40,
      });
      expect(quest(r.points, "two-step").reward).toBe(75);
    } finally {
      plan.mockRestore();
    }
  });
});

describe("the points store", () => {
  it("never spends below zero, even with level-ups at once", async () => {
    const store = new MemoryPointsStore();
    await store.earn({
      id: "e1",
      userId: "u",
      kind: "visit",
      amount: 150,
      detail: null,
      day: "2026-11-01",
      at: 1,
    });
    const results = await Promise.all(
      [1, 2].map(() =>
        store.levelUp("u", 100, (level) => ({
          id: `lvl${level}`,
          userId: "u",
          kind: "level",
          amount: -100,
          detail: String(level),
          day: "2026-11-01",
          at: 2,
        })),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.account("u")).toMatchObject({
      balance: 50,
      level: 2,
      earnedTotal: 150,
    });
  });
});
