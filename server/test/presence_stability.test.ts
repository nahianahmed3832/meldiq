import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Presence doesn't flash online or offline (reported: sending a message made someone appear online, then offline about a
 * second later). Short timings here; production waits 4 s before announcing and 10 s before taking it back.
 */
const SETTLE_MS = 300;
const GRACE_MS = 600;
const settled = () => sleep(SETTLE_MS + 400);
const gone = () => sleep(GRACE_MS + 400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let h: Harness;
let target: GriipClient, watcher: GriipClient;
let dm: string, channel: string;

beforeAll(async () => {
  h = await startServer({ PRESENCE_SETTLE_MS: String(SETTLE_MS), PRESENCE_GRACE_MS: String(GRACE_MS) });
  target = await h.client("pstarget");
  watcher = await h.client("pswatcher");
  dm = (await watcher.req("POST", "/v1/conversations/dm", { userId: target.userId })).conversation.id;
  const org = (await target.req("POST", "/v1/orgs", { name: "Steady Co" })).org.id;
  const code = (await target.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })).invite.code;
  await watcher.req("POST", "/v1/invites/accept", { code });
  channel = (await target.req("POST", `/v1/orgs/${org}/channels`, { name: "lounge", scope: "ORG", kind: "PRIVATE", memberIds: [watcher.userId] })).channel.id;
  await watcher.connect();
});
afterAll(async () => h.close());

/** Presence frames about [who] that [seen] received from index [from] on. */
const changes = (seen: GriipClient, who: GriipClient, from = 0) =>
  seen.events.slice(from).filter((e) => e.t === "presence" && e.userId === who.userId).map((e) => e.online as boolean);
const restOnline = async () => (await watcher.req("GET", `/v1/users/${target.userId}`)).user.online;

/** A second connection for [c]'s device, as another tab of the same browser opens. */
function secondSocket(c: GriipClient): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(c.baseUrl.replace(/^http/, "ws") + "/v1/ws", { headers: { authorization: `Bearer ${c.token}` } });
    ws.on("message", (d) => JSON.parse(d.toString()).t === "hello" && resolve(ws));
    ws.on("error", reject);
  });
}
const closeSocket = (ws: WebSocket) => new Promise<void>((r) => (ws.once("close", () => r()), ws.close()));

describe("presence stays steady", () => {
  it("a wake-up connection shorter than the settle time is never announced", async () => {
    const from = watcher.events.length;
    await target.connect();
    await target.disconnect();
    await settled();
    expect(changes(watcher, target, from)).toEqual([]);
    expect(await restOnline()).toBe(false);
  });

  it("a message sent to someone offline doesn't make them appear online", async () => {
    const from = watcher.events.length;
    await watcher.send(dm, { kind: "text", text: "are you there?" });
    await settled();
    expect(changes(watcher, target, from)).toEqual([]);
    expect(await restOnline()).toBe(false);
  });

  it("a connected person sending in a DM and a community channel stays online, announced once", async () => {
    const from = watcher.events.length;
    await target.connect();
    expect(await restOnline()).toBe(false); // not yet: still settling
    await watcher.waitFor(() => changes(watcher, target, from).length > 0);
    const targetFrom = target.events.length;
    await target.send(dm, { kind: "text", text: "hi" });
    await target.send(channel, { kind: "text", text: "hello all" });
    await watcher.send(dm, { kind: "text", text: "hey" });
    await gone();
    expect(changes(watcher, target, from)).toEqual([true]);
    expect(changes(target, watcher, targetFrom)).toEqual([]);
    expect(await restOnline()).toBe(true);
  });

  it("reconnecting within the grace period shows no offline flash", async () => {
    const from = watcher.events.length;
    await target.disconnect();
    await sleep(GRACE_MS / 3);
    await target.connect();
    await gone();
    expect(changes(watcher, target, from)).toEqual([]);
    expect(await restOnline()).toBe(true);
  });

  it("one of two connections closing keeps the person online", async () => {
    const from = watcher.events.length;
    const tab = await secondSocket(target);
    await target.disconnect();
    await gone();
    expect(changes(watcher, target, from)).toEqual([]);
    expect(await restOnline()).toBe(true);
    await closeSocket(tab);
    await watcher.waitFor(() => changes(watcher, target, from).length > 0);
    expect(changes(watcher, target, from)).toEqual([false]);
  });

  it("someone who really leaves appears offline after the grace period, once, with a last-seen time", async () => {
    await target.connect();
    await watcher.waitFor(() => changes(watcher, target).at(-1) === true);
    const from = watcher.events.length;
    await target.disconnect();
    expect(await restOnline()).toBe(true); // within the grace period
    await gone();
    expect(changes(watcher, target, from)).toEqual([false]);
    expect(await restOnline()).toBe(false);
    const offline = watcher.events.slice(from).find((e) => e.t === "presence" && e.userId === target.userId);
    expect(typeof offline.lastSeenAt).toBe("number");
  });
});
