import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActivityService, ACTIVITY_TTL_MS } from "../src/modules/accounts/activity/service.js";
import { MemoryActivityStore } from "../src/modules/accounts/activity/store.js";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { VERSION } from "../src/app/server.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Activity status (API 0.56.0, docs/ACTIVITY_STATUS.md): "Playing PUBG Mobile" reported by the app, shown to exactly
 * the people who may see the person's presence, only while they appear online, and gone when they disconnect.
 */
let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer({ REMINDER_TICK_MS: "0" }, { mailer });
});
afterAll(async () => h.close());

const PUBG = { kind: "playing", name: "PUBG Mobile", packageId: "com.tencent.ig" } as const;
const FREE_FIRE = { kind: "playing", name: "Free Fire", packageId: "com.dts.freefireth" } as const;

const pair = async (a: string, b: string) => {
  const ada = await AccountClient.ready(h.baseUrl, mailer, a);
  const bob = await AccountClient.ready(h.baseUrl, mailer, b);
  const dm = (await ada.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  return { ada, bob, dm };
};
const memberOf = async (viewer: AccountClient, conv: string, userId: string) =>
  ((await viewer.req("GET", `/v1/conversations/${conv}`)).conversation.members as any[]).find((m) => m.id === userId);
const activityFrames = (c: AccountClient, userId: string) => c.events.filter((e) => e.t === "activity" && e.userId === userId);
const lastActivityFrame = (c: AccountClient, userId: string) => activityFrames(c, userId).at(-1);

describe("setting an activity", () => {
  it("is advertised", async () => {
    const info = await (await fetch(`${h.baseUrl}/v1/server-info`)).json();
    expect(info.features).toContain("activity-status");
    expect(info.version).toBe(VERSION);
  });

  it("is kept and read back, and null clears it", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "actself");
    expect(await c.req("GET", "/v2/me/activity")).toEqual({ activity: null });
    const set = (await c.req("PUT", "/v2/me/activity", { activity: PUBG })).activity;
    expect(set).toMatchObject(PUBG);
    expect(set.startedAt).toBeGreaterThan(Date.now() - 5000);
    expect((await c.req("GET", "/v2/me/activity")).activity).toEqual(set);
    expect(await c.req("PUT", "/v2/me/activity", { activity: null })).toEqual({ activity: null });
    expect(await c.req("GET", "/v2/me/activity")).toEqual({ activity: null });
  });

  it("keeps the start time when the same game is reported again, and starts over for another game", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "actrefresh");
    const startedAt = Date.now() - 20 * 60_000;
    const first = (await c.req("PUT", "/v2/me/activity", { activity: { ...PUBG, startedAt } })).activity;
    expect(first.startedAt).toBe(startedAt);
    const again = (await c.req("PUT", "/v2/me/activity", { activity: { ...PUBG, startedAt: Date.now() } })).activity;
    expect(again.startedAt).toBe(startedAt);
    const other = (await c.req("PUT", "/v2/me/activity", { activity: FREE_FIRE })).activity;
    expect(other.startedAt).toBeGreaterThan(startedAt);
  });

  it("replaces a start time in the future or over a day old with the time it arrived", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "actclock");
    const future = (await c.req("PUT", "/v2/me/activity", { activity: { ...PUBG, startedAt: Date.now() + 3_600_000 } })).activity;
    expect(future.startedAt).toBeLessThanOrEqual(Date.now());
    await c.req("PUT", "/v2/me/activity", { activity: null });
    const old = (await c.req("PUT", "/v2/me/activity", { activity: { ...PUBG, startedAt: Date.now() - 2 * 86_400_000 } })).activity;
    expect(old.startedAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it("refuses names that are empty, too long or more than one line, other kinds, and anything that isn't a package name", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "actrules");
    for (const activity of [
      { kind: "playing", name: "  " },
      { kind: "playing", name: "x".repeat(65) },
      { kind: "playing", name: "PUBG\nMobile" },
      { kind: "playing", name: "PUBG\u202eMobile" },
      { kind: "watching", name: "Netflix" },
      { kind: "playing", name: "PUBG Mobile", packageId: "not a package" },
      { kind: "playing", name: "PUBG Mobile", packageId: "single" },
    ]) {
      await expectStatus(c.req("PUT", "/v2/me/activity", { activity }), 400);
    }
    await expectStatus(c.req("PUT", "/v2/me/activity", {}), 400);
    expect((await c.req("PUT", "/v2/me/activity", { activity: { kind: "playing", name: "  Genshin Impact  " } })).activity.name).toBe("Genshin Impact");
  });

  it("needs a signed-in person", async () => {
    const res = await fetch(`${h.baseUrl}/v2/me/activity`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ activity: PUBG }) });
    expect(res.status).toBe(401);
  });
});

describe("who sees it", () => {
  it("shows it to a DM contact while the player is online: member list, profile, presence and a live frame", async () => {
    const { ada, bob, dm } = await pair("actada", "actbob");
    const stranger = await AccountClient.ready(h.baseUrl, mailer, "actstranger");
    await ada.connect();
    await bob.connect();
    try {
      await ada.req("PUT", "/v2/me/activity", { activity: PUBG });
      const frame = await bob.waitFor(() => lastActivityFrame(bob, ada.userId));
      expect(frame.activity).toMatchObject(PUBG);
      // Ada's own devices hear of it too.
      expect((await ada.waitFor(() => lastActivityFrame(ada, ada.userId))).activity).toMatchObject(PUBG);

      expect((await memberOf(bob, dm, ada.userId)).activity).toMatchObject(PUBG);
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.activity).toMatchObject(PUBG);
      const entry = (await bob.req("GET", `/v1/presence?ids=${ada.userId}`)).presence[0];
      expect(entry.activity).toMatchObject(PUBG);

      // Someone who shares nothing with Ada sees none of it, and gets no frame.
      expect((await stranger.req("GET", `/v1/users/${ada.userId}`)).user.activity).toBeUndefined();
      expect(activityFrames(stranger, ada.userId)).toHaveLength(0);

      // Refreshing the same game sends nothing new; stopping sends null.
      const before = activityFrames(bob, ada.userId).length;
      await ada.req("PUT", "/v2/me/activity", { activity: PUBG });
      await ada.req("PUT", "/v2/me/activity", { activity: null });
      await bob.waitFor(() => activityFrames(bob, ada.userId).length > before && lastActivityFrame(bob, ada.userId).activity === null);
      expect(activityFrames(bob, ada.userId)).toHaveLength(before + 1);
      expect((await memberOf(bob, dm, ada.userId)).activity).toBeUndefined();
    } finally {
      await ada.disconnect();
      await bob.disconnect();
    }
  });

  it("shows it to the members of a shared community", async () => {
    const owner = await AccountClient.ready(h.baseUrl, mailer, "actowner");
    const member = await AccountClient.ready(h.baseUrl, mailer, "actmember");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "Squad" })).org.id;
    const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
    await member.req("POST", "/v1/invites/accept", { code });
    await owner.connect();
    await member.connect();
    try {
      await member.req("PUT", "/v2/me/activity", { activity: FREE_FIRE });
      expect((await owner.waitFor(() => lastActivityFrame(owner, member.userId))).activity).toMatchObject(FREE_FIRE);
      const members = (await owner.req("GET", `/v1/orgs/${orgId}/members`)).members as any[];
      expect(members.find((m) => m.id === member.userId).activity).toMatchObject(FREE_FIRE);
    } finally {
      await owner.disconnect();
      await member.disconnect();
    }
  });

  it("hides it while the player appears invisible or limits who sees when they're online", async () => {
    const { ada, bob, dm } = await pair("actinvis", "actwatch");
    await ada.connect();
    await bob.connect();
    try {
      await ada.req("PUT", "/v2/me/activity", { activity: PUBG });
      await bob.waitFor(() => lastActivityFrame(bob, ada.userId)?.activity);

      await ada.req("PUT", "/v1/users/me/presence", { mode: "invisible" });
      await bob.waitFor(() => lastActivityFrame(bob, ada.userId)?.activity === null);
      expect((await memberOf(bob, dm, ada.userId)).activity).toBeUndefined();
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.activity).toBeUndefined();
      // Ada still sees her own.
      expect((await ada.req("GET", `/v1/users/${ada.userId}`)).user.activity).toMatchObject(PUBG);

      await ada.req("PUT", "/v1/users/me/presence", { mode: "auto" });
      await bob.waitFor(() => lastActivityFrame(bob, ada.userId)?.activity);
      expect((await memberOf(bob, dm, ada.userId)).activity).toMatchObject(PUBG);

      await ada.req("PUT", "/v1/users/me/privacy", { lastSeen: "nobody" });
      expect((await memberOf(bob, dm, ada.userId)).activity).toBeUndefined();
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.activity).toBeUndefined();
    } finally {
      await ada.disconnect();
      await bob.disconnect();
    }
  });

  it("ends when the player's last connection closes", async () => {
    const { ada, bob } = await pair("actleave", "actstay");
    await ada.connect();
    await bob.connect();
    try {
      await ada.req("PUT", "/v2/me/activity", { activity: PUBG });
      await bob.waitFor(() => lastActivityFrame(bob, ada.userId)?.activity);
      await ada.disconnect();
      await bob.waitFor(() => lastActivityFrame(bob, ada.userId)?.activity === null);
      expect(await ada.req("GET", "/v2/me/activity")).toEqual({ activity: null });
    } finally {
      await bob.disconnect();
    }
  });

  it("isn't shown while the player is offline even before it lapses", async () => {
    const { ada, bob, dm } = await pair("actoffline", "actpeer");
    await ada.req("PUT", "/v2/me/activity", { activity: PUBG });
    expect((await memberOf(bob, dm, ada.userId)).activity).toBeUndefined();
    expect((await ada.req("GET", "/v2/me/activity")).activity).toMatchObject(PUBG);
  });
});

describe("ActivityService", () => {
  const log = { warn: () => {} } as never;

  it("lets an activity lapse without a refresh and announces the end once", async () => {
    let at = 1_000_000;
    const store = new MemoryActivityStore();
    const svc = new ActivityService(store, log, () => at);
    const changed: string[] = [];
    svc.onChange = (u) => changed.push(u);
    await svc.set("u1", { kind: "playing", name: "Genshin Impact" });
    expect(changed).toEqual(["u1"]);
    at += ACTIVITY_TTL_MS - 1;
    expect(svc.current("u1")).not.toBeNull();
    at += 1;
    expect(svc.current("u1")).toBeNull();
    await svc.sweep();
    await svc.sweep();
    expect(changed).toEqual(["u1", "u1"]);
    expect(await store.live(at)).toEqual([]);
  });

  it("picks up activities that haven't lapsed after a restart", async () => {
    let at = 5_000_000;
    const store = new MemoryActivityStore();
    const first = new ActivityService(store, log, () => at);
    await first.set("u2", { kind: "playing", name: "Mobile Legends: Bang Bang" });
    await first.set("u3", { kind: "playing", name: "Free Fire" });
    await first.clear("u3");
    at += 1000;
    const second = new ActivityService(store, log, () => at);
    await second.start();
    second.stop();
    expect(second.current("u2")?.name).toBe("Mobile Legends: Bang Bang");
    expect(second.current("u3")).toBeNull();
  });
});

describe("activities in MongoDB", () => {
  let m: Harness;
  beforeAll(async () => {
    m = await startServer({ MONGODB_DOMAINS: "accounts,preferences" }, { mailer });
  });
  afterAll(async () => m.close());

  it("are written to user_activities and removed when cleared", async () => {
    expect(m.ctx.activity.backend).toBe("mongodb");
    const c = await AccountClient.ready(m.baseUrl, mailer, "actmongo");
    await c.req("PUT", "/v2/me/activity", { activity: PUBG });
    const doc = await m.ctx.mongo!.db.collection("user_activities").findOne({ _id: c.userId as never });
    expect(doc).toMatchObject({ activity: PUBG });
    expect(doc!.expires_at).toBeGreaterThan(Date.now());
    await c.req("PUT", "/v2/me/activity", { activity: null });
    expect(await m.ctx.mongo!.db.collection("user_activities").countDocuments({ _id: c.userId as never })).toBe(0);
  });
});
