import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** Batch B6b: a group's photo, and the presence people choose (online, idle, do not disturb, invisible). */
let h: Harness;
let ann: GriipClient, ben: GriipClient, cid: GriipClient;
let group: string;
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const waitFor = async (cond: () => boolean, ms = 2000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

beforeAll(async () => {
  h = await startServer();
  [ann, ben, cid] = await Promise.all(["ann", "ben", "cid"].map((n) => h.client(n)));
  group = (await ann.req("POST", "/v1/conversations/group", { name: "Trip", memberIds: [ben.userId] })).conversation.id;
});
afterAll(async () => h.close());

describe("group photo", () => {
  it("is set by the group's admins, seen by its members, and removed", async () => {
    expect((await ann.req("GET", "/v1/server-info")).features).toEqual(expect.arrayContaining(["group-photos", "presence-modes"]));
    await expectStatus(ben.req("PUT", `/v1/conversations/${group}/photo`, undefined, jpeg), 403);
    await expectStatus(cid.req("PUT", `/v1/conversations/${group}/photo`, undefined, jpeg), 404);
    await expectStatus(ann.req("PUT", `/v1/conversations/${group}/photo`, undefined, Buffer.from("not a jpeg")), 400);
    const { photoRev } = await ann.req("PUT", `/v1/conversations/${group}/photo`, undefined, jpeg);
    expect((await ben.req("GET", `/v1/conversations/${group}`)).conversation.photoRev).toBe(photoRev);
    expect(Buffer.compare(await ben.req("GET", `/v1/conversations/${group}/photo`), jpeg)).toBe(0);
    await expectStatus(cid.req("GET", `/v1/conversations/${group}/photo`), 404);
    await ann.req("DELETE", `/v1/conversations/${group}/photo`);
    expect((await ben.req("GET", `/v1/conversations/${group}`)).conversation.photoRev).toBeNull();
    await expectStatus(ben.req("GET", `/v1/conversations/${group}/photo`), 404);
  });

  it("is only for groups", async () => {
    const dm = (await ann.req("POST", "/v1/conversations/dm", { userId: ben.userId })).conversation.id;
    await expectStatus(ann.req("PUT", `/v1/conversations/${dm}/photo`, undefined, jpeg), 404);
  });
});

describe("presence", () => {
  const seen = async () => (await ann.req("GET", `/v1/users/${ben.userId}`)).user;

  it("is online while connected, and follows what the person chose", async () => {
    await ann.connect();
    await ben.connect();
    expect(await seen()).toMatchObject({ online: true, presence: "online" });
    expect((await ben.req("PUT", "/v1/users/me/presence", { mode: "idle" })).mode).toBe("idle");
    expect(await seen()).toMatchObject({ online: true, presence: "idle" });
    expect(await waitFor(() => ann.events.some((e) => e.t === "presence" && e.userId === ben.userId && e.presence === "idle"))).toBe(true);
    await ben.req("PUT", "/v1/users/me/presence", { mode: "dnd", until: Date.now() + 3_600_000 });
    expect(await seen()).toMatchObject({ online: true, presence: "dnd" });
    expect((await ben.req("GET", "/v1/users/me")).user).toMatchObject({ presenceMode: "dnd", presenceUntil: expect.any(Number) });
  });

  it("invisible appears offline everywhere, and coming and going changes nothing others see", async () => {
    await ben.req("PUT", "/v1/users/me/presence", { mode: "invisible" });
    expect(await seen()).toMatchObject({ online: false, presence: "offline" });
    expect(await waitFor(() => ann.events.some((e) => e.t === "presence" && e.userId === ben.userId && e.online === false))).toBe(true);
    const members = (await ann.req("GET", `/v1/conversations/${group}/members`)).members;
    expect(members.find((m: { id: string }) => m.id === ben.userId)).toMatchObject({ online: false, presence: "offline" });
    expect((await ann.req("GET", `/v1/presence?ids=${ben.userId}`)).presence[0]).toMatchObject({ online: false, presence: "offline" });
    const lastSeen = (await seen()).lastSeenAt;
    const before = ann.events.length;
    await ben.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    expect(ann.events.slice(before).filter((e) => e.t === "presence" && e.userId === ben.userId)).toEqual([]);
    expect((await seen()).lastSeenAt).toBe(lastSeen);
  });

  it("goes back to automatic, and refuses unknown choices and end times out of range", async () => {
    await ben.connect();
    await ben.req("PUT", "/v1/users/me/presence", { mode: "auto" });
    expect(await seen()).toMatchObject({ online: true, presence: "online" });
    await expectStatus(ben.req("PUT", "/v1/users/me/presence", { mode: "busy" }), 400);
    await expectStatus(ben.req("PUT", "/v1/users/me/presence", { mode: "idle", until: Date.now() - 1 }), 400);
    await expectStatus(ben.req("PUT", "/v1/users/me/presence", { mode: "idle", until: Date.now() + 40 * 86_400_000 }), 400);
  });

  it("a timed choice ends by itself", async () => {
    await h.ctx.identity.write((w) => w.update("users", { id: ben.userId }, { presence_mode: "invisible", presence_until: Date.now() - 1000 }));
    expect(await seen()).toMatchObject({ online: true, presence: "online" });
  });
});
