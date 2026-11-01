import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import {
  leaderboard,
  voiceTotals,
} from "../src/modules/leaderboards/service.js";
import type { CallParticipantRow } from "../src/modules/calls/store.js";

const DAY = 86400_000;
describe.each([
  ["sqlite", {}],
  [
    "mongodb",
    {
      MONGODB_DOMAINS:
        "accounts,preferences,reports,relationships,history,files,relay,billing,workspace,conversations,calls",
    },
  ],
] as const)("leaderboards on %s", (_backend, env) => {
  let h: Harness, alice: GriipClient, bob: GriipClient, carol: GriipClient;
  let general: string, secret: string, voice: string, hiddenVoice: string;
  beforeAll(async () => {
    h = await startServer({ ...env, MESSAGES_ACCEPT_ENCRYPTED: "false" });
    [alice, bob, carol] = await Promise.all(
      ["rankalice", "rankbob", "rankcarol"].map((n) => h.client(n)),
    );
    const org = (await alice.req("POST", "/v1/orgs", { name: "Ranking Club" }))
      .org.id;
    const code = (
      await alice.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
    ).invite.code;
    await bob.req("POST", "/v1/invites/accept", { code });
    general = (
      await alice.req("POST", `/v1/orgs/${org}/channels`, { name: "chat" })
    ).channel.id;
    secret = (
      await alice.req("POST", `/v1/orgs/${org}/channels`, {
        name: "staff",
        kind: "PRIVATE",
      })
    ).channel.id;
    voice = (
      await alice.req("POST", `/v1/orgs/${org}/channels`, {
        name: "voice",
        voice: true,
      })
    ).channel.id;
    hiddenVoice = (
      await alice.req("POST", `/v1/orgs/${org}/channels`, {
        name: "private voice",
        voice: true,
        kind: "PRIVATE",
      })
    ).channel.id;
  }, 120000);
  afterAll(async () => h?.close(), 120000);
  it("requires a session and validates the category", async () => {
    expect((await fetch(`${h.baseUrl}/v2/leaderboards`)).status).toBe(401);
    await expectStatus(alice.req("GET", "/v2/leaderboards?metric=money"), 400);
  });
  it("uses earned totals, shared ranks, actual levels and a separate own position", async () => {
    for (const [c, amount] of [
      [alice, 1000],
      [bob, 1000],
      [carol, 500],
    ] as const) {
      await h.ctx.points.store.earn({
        id: `seed-${c.userId}`,
        userId: c.userId,
        amount,
        kind: "quest",
        day: "2026-11-01",
        at: Date.now(),
        detail: null,
      });
    }
    await h.ctx.points.store.levelUp(alice.userId, 100, () => ({
      id: "lvla",
      userId: alice.userId,
      amount: -100,
      kind: "level",
      day: "2026-11-01",
      at: Date.now(),
      detail: null,
    }));
    const b = await alice.req("GET", "/v2/leaderboards?metric=embers");
    expect(b.entries.map((e: any) => [e.rank, e.value])).toEqual([
      [1, 1000],
      [1, 1000],
      [3, 500],
    ]);
    expect(b.me).toMatchObject({
      rank: 1,
      value: 1000,
      user: { id: alice.userId },
    });
    expect(
      (await alice.req("GET", "/v2/leaderboards?metric=level")).entries,
    ).toMatchObject([{ value: 2, user: { id: alice.userId } }]);
  });
  it("hides blocked, disabled, synthetic, deleted and non-discoverable people and private photos", async () => {
    await h.ctx.identity.write((w) =>
      w.update(
        "users",
        { id: carol.userId },
        {
          privacy: JSON.stringify({
            photo: "nobody",
            findByUsername: "nobody",
          }),
        },
      ),
    );
    expect(
      (await alice.req("GET", "/v2/leaderboards?metric=embers")).total,
    ).toBe(2);
    await h.ctx.identity.write((w) =>
      w.update(
        "users",
        { id: bob.userId },
        {
          privacy: JSON.stringify({ photo: "nobody" }),
          photo_rev: 55,
          avatar_media: JSON.stringify({ kind: "gif", rev: 55 }),
        },
      ),
    );
    expect(
      (await alice.req("GET", "/v2/leaderboards?metric=embers")).entries.find(
        (e: any) => e.user.id === bob.userId,
      ).user,
    ).toMatchObject({ photoRev: null, avatarMedia: null });
    for (const patch of [
      { disabled_at: 1 },
      { synthetic: 1 },
      { deleted_at: 1 },
    ]) {
      await h.ctx.identity.write((w) =>
        w.update("users", { id: bob.userId }, patch),
      );
      expect((await leaderboard(h.ctx, alice.userId, "embers")).total).toBe(1);
      await h.ctx.identity.write((w) =>
        w.update(
          "users",
          { id: bob.userId },
          { disabled_at: null, synthetic: 0, deleted_at: null },
        ),
      );
    }
    await h.ctx.identity.write((w) =>
      w.insert("user_blocks", {
        user_id: alice.userId,
        blocked_user_id: bob.userId,
        created_at: Date.now(),
      }),
    );
    expect((await leaderboard(h.ctx, alice.userId, "embers")).total).toBe(1);
    await h.ctx.identity.write((w) =>
      w.delete("user_blocks", {
        user_id: alice.userId,
        blocked_user_id: bob.userId,
      }),
    );
  });
  it("counts live messages only in visible community channels, excluding DMs, imports and old events", async () => {
    const now = Date.now();
    const dm = (
      await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })
    ).conversation.id;
    for (const [id, conv, sender, age, imported] of [
      ["public-a", general, alice, 0, null],
      ["public-b", general, bob, 0, null],
      ["secret", secret, alice, 0, null],
      ["direct", dm, alice, 0, null],
      ["old", general, alice, 8 * DAY, null],
      ["import", general, alice, 0, alice.userId],
    ] as const)
      await h.ctx.messages.add({
        id,
        conversation_id: conv,
        sender_user_id: sender.userId,
        sender_device_id: sender.deviceId,
        cls: "message",
        type: "text",
        target: null,
        audience: "all",
        payload: '{"type":"text","text":"hi"}',
        sent_at: now - age,
        server_ts: now - age,
        mention_all: 0,
        imported_by: imported,
      });
    const view = await bob.req("GET", "/v2/leaderboards?metric=messages");
    expect(view.scope).toBe("visible_communities");
    expect(view.entries.map((e: any) => e.value)).toEqual([1, 1]);
    expect(
      (await carol.req("GET", "/v2/leaderboards?metric=messages")).entries,
    ).toEqual([]);
  });
  it("counts only visible voice rooms and never multiplies overlapping devices", async () => {
    const now = Date.now();
    for (const [id, conv] of [
      ["v", voice],
      ["h", hiddenVoice],
      ["t", general],
    ]) {
      await h.ctx.calls.insert({
        id,
        conversation_id: conv,
        room_name: id,
        created_by: alice.userId,
        video: 0,
        state: "ENDED",
        created_at: now - 180000,
        answered_at: now - 180000,
        ended_at: now,
        end_reason: "ended",
        alerted_at: null,
        host_server_id: null,
        room: 1,
      });
      await h.ctx.calls.join(
        id,
        alice.userId,
        alice.deviceId,
        now - 180000,
        false,
      );
      await h.ctx.calls.leave(id, alice.deviceId, now);
    }
    await h.ctx.calls.join(
      "v",
      alice.userId,
      "second-device",
      now - 120000,
      false,
    );
    await h.ctx.calls.leave("v", "second-device", now);
    const b = await bob.req("GET", "/v2/leaderboards?metric=voice");
    expect(b.entries).toMatchObject([{ user: { id: alice.userId }, value: 3 }]);
  });
  it("counts credited invites only", async () => {
    for (const state of ["credited", "pending", "lapsed", "capped"] as const)
      await h.ctx.points.store.addInvite({
        id: `inv-${state}`,
        inviterId: alice.userId,
        joinerId: bob.userId,
        orgId: "test",
        joinedAt: Date.now() - 8 * DAY,
        state,
        settledAt: Date.now(),
      });
    const b = await alice.req("GET", "/v2/leaderboards?metric=invites");
    expect(b.entries).toMatchObject([{ user: { id: alice.userId }, value: 1 }]);
  });
  it("never counts unpaid, refunded or disputed gifts or exposes purchase details", async () => {
    for (const [id, status, refund, dispute] of [
      ["paid", "paid", null, null],
      ["used", "redeemed", null, null],
      ["pending", "pending", null, null],
      ["refund", "refunded", "refunded", null],
      ["dispute", "paid", null, "open"],
    ]) {
      await h.ctx.billing.rows.write((w) =>
        w.insert("mojo_gifts", {
          id,
          buyer_account_id: "test",
          buyer_user_id: alice.userId,
          recipient_user_id: bob.userId,
          plan_key: "plus",
          months: 1,
          currency: "USD",
          amount_minor: 999,
          note: "private",
          status,
          provider: "test",
          provider_session_ref: null,
          provider_payment_ref: null,
          grant_id: null,
          created_at: Date.now(),
          expires_at: Date.now() + DAY,
          paid_at: status === "pending" ? null : Date.now(),
          redeemed_at: null,
          updated_at: Date.now(),
          refund_status: refund ?? "none",
          dispute_status: dispute,
        }),
      );
    }
    const b = await alice.req("GET", "/v2/leaderboards?metric=gifts");
    expect(b.entries).toMatchObject([{ user: { id: alice.userId }, value: 2 }]);
    expect(JSON.stringify(b)).not.toMatch(
      /private|999|recipient|currency|amount_minor/,
    );
  });
});
it("clips voice spans to the week and merges overlaps, ignoring invalid spans", () => {
  const span = (start: number, end: number | null) =>
    ({ user_id: "a", joined_at: start, left_at: end }) as CallParticipantRow;
  expect(
    voiceTotals(
      [
        span(-60000, 120000),
        span(60000, 180000),
        span(120000, null),
        span(240000, 100000),
      ],
      0,
      240000,
    ),
  ).toEqual([{ userId: "a", count: 4 }]);
});
