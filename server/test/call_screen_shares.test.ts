import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiveKitService } from "../src/modules/calls/livekit.js";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Screen sharing shows on the call members see outside it (community-first brief §E): from LiveKit's track webhooks,
 * for current participants only, cleared when they stop, leave or the call ends, and only to the conversation's members.
 */
class FakeLiveKit {
  publicUrl = "ws://livekit.test";
  rooms = new Map<string, Set<string>>();
  join(room: string, c: GriipClient) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(`${c.userId}.${c.deviceId}`);
  }
  leave(room: string, c: GriipClient) {
    this.rooms.get(room)?.delete(`${c.userId}.${c.deviceId}`);
  }
  async token(p: { identity: string }) {
    return `token:${p.identity}`;
  }
  async deleteRoom(room: string) {
    this.rooms.delete(room);
  }
  async participantIdentities(room: string) {
    return [...(this.rooms.get(room) ?? [])];
  }
  async participantUsers(room: string) {
    return new Set((await this.participantIdentities(room)).map((i) => i.split(".")[0]));
  }
  async removeParticipant(room: string, identity: string) {
    return this.rooms.get(room)?.delete(identity) ? ("removed" as const) : ("absent" as const);
  }
  async receiveWebhook(body: string) {
    return JSON.parse(body);
  }
}

const SCREEN_SHARE = 3;
const CAMERA = 1;

let h: Harness;
let lk: FakeLiveKit;
let alice: GriipClient, bob: GriipClient, carol: GriipClient, dave: GriipClient;
let groupId: string;

beforeAll(async () => {
  h = await startServer();
  lk = new FakeLiveKit();
  h.ctx.livekit = lk as unknown as LiveKitService;
  alice = await h.client("ssalice");
  bob = await h.client("ssbob");
  carol = await h.client("sscarol");
  dave = await h.client("ssdave");
  groupId = (await alice.req("POST", "/v1/conversations/group", { name: "Design review", memberIds: [bob.userId, carol.userId] })).conversation.id;
  await carol.connect();
  await dave.connect();
});
afterAll(async () => h.close());

async function webhook(event: string, room: string, who: GriipClient, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${h.baseUrl}/v1/livekit/webhook`, {
    method: "POST",
    headers: { "content-type": "application/webhook+json", authorization: "stub" },
    body: JSON.stringify({ event, room: { name: room }, participant: { identity: `${who.userId}.${who.deviceId}` }, ...extra }),
  });
  expect(res.status).toBe(200);
}

async function startCall() {
  const r = await alice.req("POST", "/v1/calls", { conversationId: groupId, video: true });
  const call = { id: r.call.id as string, room: r.media.room as string };
  lk.join(call.room, alice);
  await alice.req("POST", `/v1/calls/${call.id}/connected`);
  await bob.req("POST", `/v1/calls/${call.id}/join`);
  lk.join(call.room, bob);
  await bob.req("POST", `/v1/calls/${call.id}/connected`);
  return call;
}

/** The newest call frame [c] received for [callId] after index [from]. */
const lastCall = (c: GriipClient, callId: string, from = 0) =>
  c.events
    .slice(from)
    .filter((e) => e.t === "call" && e.call.id === callId)
    .at(-1)?.call;

describe("screen sharing on a live call", () => {
  it("members outside the call see who starts and stops sharing; cameras don't count", async () => {
    const call = await startCall();
    let from = carol.events.length;
    await webhook("track_published", call.room, bob, { track: { source: SCREEN_SHARE } });
    await carol.waitFor(() => lastCall(carol, call.id, from)?.sharing?.includes(bob.userId));

    from = carol.events.length;
    await webhook("track_published", call.room, alice, { track: { source: CAMERA } });
    await new Promise((r) => setTimeout(r, 150));
    expect(carol.events.slice(from).filter((e) => e.t === "call")).toHaveLength(0);
    expect((await carol.req("GET", `/v1/calls/${call.id}`)).call.sharing).toEqual([bob.userId]);

    from = carol.events.length;
    await webhook("track_unpublished", call.room, bob, { track: { source: "SCREEN_SHARE" } });
    await carol.waitFor(() => lastCall(carol, call.id, from)?.sharing?.length === 0);
    await alice.req("POST", `/v1/calls/${call.id}/end`);
  });

  it("someone who leaves while sharing stops showing as sharing, even without an unpublish", async () => {
    const call = await startCall();
    await webhook("track_published", call.room, bob, { track: { source: SCREEN_SHARE } });
    await carol.waitFor(() => lastCall(carol, call.id)?.sharing?.includes(bob.userId));
    const from = carol.events.length;
    lk.leave(call.room, bob);
    await webhook("participant_left", call.room, bob);
    await carol.waitFor(() => lastCall(carol, call.id, from)?.sharing?.length === 0);
    await alice.req("POST", `/v1/calls/${call.id}/end`);
  });

  it("an ended call carries no sharing, and the next call starts clean", async () => {
    const call = await startCall();
    await webhook("track_published", call.room, alice, { track: { source: SCREEN_SHARE } });
    await carol.waitFor(() => lastCall(carol, call.id)?.sharing?.includes(alice.userId));
    await alice.req("POST", `/v1/calls/${call.id}/end`);
    const ended = await carol.waitFor(() => carol.events.find((e) => e.t === "call" && e.event === "ended" && e.call.id === call.id)?.call);
    expect(ended.sharing).toBeUndefined();
    const next = await startCall();
    expect((await carol.req("GET", `/v1/calls/${next.id}`)).call.sharing).toEqual([]);
    await alice.req("POST", `/v1/calls/${next.id}/end`);
  });

  it("people outside the conversation learn nothing about its calls", async () => {
    expect(dave.events.some((e) => e.t === "call")).toBe(false);
  });
});
