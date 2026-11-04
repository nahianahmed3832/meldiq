import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/app/config.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { deviceIdsOf, queuedCount } from "./support/relay.js";

/**
 * Batch B6 (docs/product/MELDIQ_FRIENDS_AND_DMS_SPEC.md): connections, message requests and who may message you.
 * Runs on SQLite, and on MongoDB with MELDIQ_TEST_MONGO_DOMAINS=relationships.
 */
let h: Harness;
let ann: GriipClient, ben: GriipClient, cat: GriipClient, dan: GriipClient, eve: GriipClient, gil: GriipClient;
let orgId: string;
const text = (t: string) => ({ type: "text", text: t });
const queued = (convId: string, userId: string) => {
  const devices = deviceIdsOf(h, userId);
  return queuedCount(h, (r) => r.conversation_id === convId && devices.has(r.recipient_device_id));
};

beforeAll(async () => {
  // The default for people who never chose: strangers' DMs become requests (the server's default is "everyone" for now).
  h = await startServer({ DEFAULT_DM_POLICY: "communities" });
  [ann, ben, cat, dan, eve, gil] = await Promise.all(["ann", "ben", "cat", "dan", "eve", "gil"].map((n) => h.client(n)));
  // Ann and Ben share a community; Gil is only a guest there.
  orgId = (await ann.req("POST", "/v1/orgs", { name: "Shared" })).org.id;
  const code = (await ann.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 5 })).invite.code;
  await ben.req("POST", "/v1/invites/accept", { code });
  const guest = (await ann.req("POST", `/v1/orgs/${orgId}/invites`, { role: "GUEST", maxUses: 1 })).invite.code;
  await gil.req("POST", "/v1/invites/accept", { code: guest });
});
afterAll(async () => h.close());

describe("who may message you", () => {
  it("advertises the features and starts from the defaults", async () => {
    expect((await ann.req("GET", "/v1/server-info")).features).toEqual(expect.arrayContaining(["connections", "message-requests"]));
    expect(await cat.req("GET", "/v1/users/me/messaging")).toEqual({ dmPolicy: "communities", requestPolicy: "everyone", groupAddPolicy: "everyone", suggestable: true });
    expect(h.ctx.relationships.backend).toBe(process.env.MELDIQ_TEST_PG_URL ? "postgres" : process.env.MELDIQ_TEST_MONGO_DOMAINS?.includes("relationships") ? "mongodb" : "sqlite");
  });

  it("opens a DM directly between people who share a community", async () => {
    const dm = (await ann.req("POST", "/v1/conversations/dm", { userId: ben.userId })).conversation;
    expect(dm.request).toBeNull();
  });

  it("turns a stranger's DM into a message request, and a guest isn't in the community for this", async () => {
    const dm = (await cat.req("POST", "/v1/conversations/dm", { userId: ann.userId })).conversation;
    expect(dm.request).toMatchObject({ state: "pending", incoming: false, sent: 0, limit: 3 });
    const viaGuest = (await gil.req("POST", "/v1/conversations/dm", { userId: ben.userId })).conversation;
    expect(viaGuest.request).toMatchObject({ incoming: false });
    const forAnn = (await ann.req("GET", "/v1/conversations?requests=1")).conversations;
    expect(forAnn.map((c: { id: string }) => c.id)).toEqual([dm.id]);
    expect(forAnn[0].request).toMatchObject({ state: "pending", incoming: true });
  });

  it("refuses people your settings don't allow, and answers blocked and unknown people the same way", async () => {
    await dan.req("PUT", "/v1/users/me/messaging", { dmPolicy: "connections", requestPolicy: "nobody" });
    const refused = await expectStatus(eve.req("POST", "/v1/conversations/dm", { userId: dan.userId }), 403);
    expect(refused.error.code).toBe("dm_not_allowed");
    await eve.req("POST", "/v1/blocks", { userId: cat.userId });
    const blocked = await expectStatus(cat.req("POST", "/v1/conversations/dm", { userId: eve.userId }), 404);
    const blocker = await expectStatus(eve.req("POST", "/v1/conversations/dm", { userId: cat.userId }), 404);
    const unknown = await expectStatus(cat.req("POST", "/v1/conversations/dm", { userId: "u_nobody" }), 404);
    expect([blocked.error, blocker.error, unknown.error]).toEqual([unknown.error, unknown.error, unknown.error]);
    expect(unknown.error.code).toBe("not_available");
    await expectStatus(cat.req("POST", "/v1/conversations/dm", { userId: cat.userId }), 400);
    await expectStatus(cat.req("PUT", "/v1/users/me/messaging", { dmPolicy: "friends" }), 400);
  });
});

describe("message requests", () => {
  let dm: string;
  beforeAll(async () => {
    dm = (await cat.req("POST", "/v1/conversations/dm", { userId: ann.userId })).conversation.id;
  });

  it("let the sender send three messages, without a push, and the recipient can't reply before answering", async () => {
    const woken: string[] = [];
    const before = h.ctx.hub.onQueuedOffline;
    h.ctx.hub.onQueuedOffline = (d) => woken.push(d);
    try {
      for (const n of [1, 2, 3]) await cat.send(dm, text(`hi ${n}`));
      expect((await expectStatus(cat.send(dm, text("hi 4")), 429)).error.code).toBe("request_limit");
    } finally {
      h.ctx.hub.onQueuedOffline = before;
    }
    expect(woken).toEqual([]);
    expect(await queued(dm, ann.userId)).toBe(3);
    expect((await expectStatus(ann.send(dm, text("reply")), 403)).error.code).toBe("request_pending");
    // Neither side can ring through it.
    expect((await expectStatus(cat.req("POST", "/v1/calls", { conversationId: dm, video: false }), 403)).error.code).toBe("request_pending");
    expect((await cat.req("GET", `/v1/conversations/${dm}`)).conversation.request).toMatchObject({ sent: 3 });
  });

  it("only the recipient answers, and decline hides it from them and drops what was waiting", async () => {
    await expectStatus(cat.req("POST", `/v1/conversations/${dm}/request`, { action: "accept" }), 404);
    await ann.req("POST", `/v1/conversations/${dm}/request`, { action: "decline" });
    // MongoDB runs the cascade right after the answer (src/modules/messaging/relay/store.ts).
    await expect.poll(() => queued(dm, ann.userId)).toBe(0);
    expect((await ann.req("GET", "/v1/conversations")).conversations.map((c: { id: string }) => c.id)).not.toContain(dm);
    await expectStatus(ann.req("GET", `/v1/conversations/${dm}`), 404);
    // The sender sees nothing change.
    expect((await cat.req("GET", `/v1/conversations/${dm}`)).conversation.request).toMatchObject({ state: "pending", incoming: false });
  });

  it("opening the DM yourself after declining makes it an ordinary DM again", async () => {
    const back = (await ann.req("POST", "/v1/conversations/dm", { userId: cat.userId })).conversation;
    expect(back.id).toBe(dm);
    expect(back.request).toBeNull();
    await ann.send(dm, text("changed my mind"));
  });

  it("accept connects the two people; block declines and blocks", async () => {
    const eveDm = (await eve.req("POST", "/v1/conversations/dm", { userId: ann.userId })).conversation.id;
    await ann.req("POST", `/v1/conversations/${eveDm}/request`, { action: "accept" });
    expect((await ann.req("GET", "/v1/connections")).connected.map((u: { id: string }) => u.id)).toContain(eve.userId);
    await ann.send(eveDm, text("welcome"));
    const gilDm = (await gil.req("POST", "/v1/conversations/dm", { userId: ben.userId })).conversation.id;
    await ben.req("POST", `/v1/conversations/${gilDm}/request`, { action: "block" });
    expect((await ben.req("GET", "/v1/blocks")).userIds).toContain(gil.userId);
  });

  it("are limited to twenty new ones an hour", async () => {
    const spammer = await h.client("spammer");
    const targets = await Promise.all(Array.from({ length: 21 }, (_, i) => h.client(`target${i}`)));
    for (const t of targets.slice(0, 20)) await spammer.req("POST", "/v1/conversations/dm", { userId: t.userId });
    expect((await expectStatus(spammer.req("POST", "/v1/conversations/dm", { userId: targets[20].userId }), 429)).error.code).toBe("request_rate_limited");
  });
});

describe("connections", () => {
  it("accepts concurrent retries once and emits one relationship change", async () => {
    const [sender, recipient] = [gil, cat];
    await sender.req("POST", "/v1/connections", { userId: recipient.userId });
    const announced = vi.spyOn(h.ctx.hub, "sendToUsers");
    try {
      const results = await Promise.all(Array.from({ length: 3 }, () => recipient.req("POST", `/v1/connections/${sender.userId}/accept`)));
      expect(results.map((r) => r.state)).toEqual(["accepted", "accepted", "accepted"]);
      expect(announced.mock.calls.filter(([, frame]) => frame.t === "connections.updated")).toHaveLength(1);
      expect((await recipient.req("GET", "/v1/connections")).connected.map((u: { id: string }) => u.id)).toEqual([sender.userId]);
    } finally {
      announced.mockRestore();
    }
  });

  it("does not resurrect a request removed while acceptance is waiting", async () => {
    const [sender, recipient] = [gil, eve];
    await sender.req("POST", "/v1/connections", { userId: recipient.userId });
    const accept = h.ctx.relationships.acceptConnection.bind(h.ctx.relationships);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const transition = vi.spyOn(h.ctx.relationships, "acceptConnection").mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return accept(...args);
    });
    try {
      const result = expectStatus(recipient.req("POST", `/v1/connections/${sender.userId}/accept`), 404);
      await waiting;
      await sender.req("DELETE", `/v1/connections/${recipient.userId}`);
      release();
      await result;
      expect(await h.ctx.relationships.connection(sender.userId, recipient.userId)).toBeNull();
    } finally {
      release();
      transition.mockRestore();
    }
  });

  it("go from request to accepted, by id or username, and repeating changes nothing", async () => {
    expect((await ben.req("POST", "/v1/connections", { username: `@${cat.username}` })).state).toBe("pending");
    expect((await ben.req("POST", "/v1/connections", { userId: cat.userId })).state).toBe("pending");
    const lists = await cat.req("GET", "/v1/connections");
    expect(lists.incoming.map((e: { user: { id: string } }) => e.user.id)).toEqual([ben.userId]);
    expect((await ben.req("GET", "/v1/connections")).outgoing.map((e: { user: { id: string } }) => e.user.id)).toEqual([cat.userId]);
    // Someone else can't accept it, and the requester can't accept their own.
    await expectStatus(ann.req("POST", `/v1/connections/${ben.userId}/accept`), 404);
    await expectStatus(ben.req("POST", `/v1/connections/${cat.userId}/accept`), 404);
    await cat.req("POST", `/v1/connections/${ben.userId}/accept`);
    const accepted = await h.ctx.relationships.connection(cat.userId, ben.userId);
    expect((await cat.req("POST", `/v1/connections/${ben.userId}/accept`)).state).toBe("accepted");
    expect(await h.ctx.relationships.connection(cat.userId, ben.userId)).toEqual(accepted);
    expect((await ben.req("GET", "/v1/connections")).connected.map((u: { id: string }) => u.id)).toEqual([cat.userId]);
  });

  it("crossed requests accept each other; remove, cancel and decline are one call that says nothing to the other", async () => {
    await cat.req("POST", "/v1/connections", { userId: eve.userId }).catch(() => undefined); // Eve blocked Cat earlier
    await eve.req("DELETE", `/v1/blocks/${cat.userId}`);
    expect((await cat.req("POST", "/v1/connections", { userId: eve.userId })).state).toBe("pending");
    expect((await eve.req("POST", "/v1/connections", { userId: cat.userId })).state).toBe("accepted");
    await eve.req("DELETE", `/v1/connections/${cat.userId}`);
    expect((await cat.req("GET", "/v1/connections")).connected.map((u: { id: string }) => u.id)).not.toContain(eve.userId);
    expect((await cat.req("DELETE", `/v1/connections/${eve.userId}`)).ok).toBe(true);
  });

  it("make a DM direct even when your settings ask for connections", async () => {
    await ben.req("PUT", "/v1/users/me/messaging", { dmPolicy: "connections" });
    // Cat and Ben are connected; Dan isn't, and Ben still accepts requests.
    const fromCat = (await cat.req("POST", "/v1/conversations/dm", { userId: ben.userId })).conversation;
    expect(fromCat.request).toBeNull();
    expect((await dan.req("POST", "/v1/conversations/dm", { userId: ben.userId })).conversation.request).toMatchObject({ incoming: false });
  });

  it("respect who may send requests, and blocked people get the same answer as unknown ones", async () => {
    expect((await expectStatus(cat.req("POST", "/v1/connections", { userId: dan.userId }), 403)).error.code).toBe("requests_not_allowed");
    await dan.req("POST", "/v1/blocks", { userId: eve.userId });
    expect((await expectStatus(eve.req("POST", "/v1/connections", { userId: dan.userId }), 404)).error.code).toBe("not_available");
    expect((await expectStatus(eve.req("POST", "/v1/connections", { username: "nobody-here" }), 404)).error.code).toBe("not_available");
  });

  it("go with the account when it's deleted", async () => {
    const leaving = await h.client("leaving");
    await leaving.req("POST", "/v1/connections", { userId: ann.userId });
    expect((await ann.req("GET", "/v1/connections")).incoming.map((e: { user: { id: string } }) => e.user.id)).toContain(leaving.userId);
    await h.ctx.relationships.deleteForUser(leaving.userId);
    expect((await ann.req("GET", "/v1/connections")).incoming.map((e: { user: { id: string } }) => e.user.id)).not.toContain(leaving.userId);
  });
});

describe("the server's default", () => {
  it("keeps DMs open for people who never chose until the operator sets DEFAULT_DM_POLICY", () => {
    expect(loadConfig({ DATA_DIR: "/tmp/x" }).defaultDmPolicy).toBe("everyone");
    expect(loadConfig({ DATA_DIR: "/tmp/x", DEFAULT_DM_POLICY: "communities" }).defaultDmPolicy).toBe("communities");
    expect(() => loadConfig({ DATA_DIR: "/tmp/x", DEFAULT_DM_POLICY: "friends" })).toThrow(/DEFAULT_DM_POLICY/);
  });
});
