import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LiveKitService } from "../src/modules/calls/livekit.js";
import { canonical, GriipClient, sign } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";
import { presentDevices } from "./support/calls.js";

/**
 * Newest device wins in a call (API 0.33.0): one account is in a call from one device at a time. Joining from another
 * device moves the older one out of the call (out of the media room, told why); the account stays signed in on both, and
 * the call goes on.
 */
class RecordingLiveKit {
  publicUrl = "ws://livekit.test";
  rooms = new Map<string, Set<string>>();
  removed: string[] = [];

  join(room: string, c: GriipClient) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(`${c.userId}.${c.deviceId}`);
  }
  inRoom(room: string, c: GriipClient) {
    return this.rooms.get(room)?.has(`${c.userId}.${c.deviceId}`) ?? false;
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
    if (!this.rooms.get(room)?.delete(identity)) return "absent" as const;
    this.removed.push(identity);
    return "removed" as const;
  }
  async receiveWebhook(body: string) {
    return JSON.parse(body);
  }
}

let h: Harness;
let lk: RecordingLiveKit;
beforeAll(async () => {
  h = await startServer();
});
afterAll(async () => h.close());
beforeEach(() => {
  lk = new RecordingLiveKit();
  h.ctx.livekit = lk as unknown as LiveKitService;
});

/** [c]'s account on a second device (added with its identity key, as a new phone or browser is). */
async function secondDevice(c: GriipClient): Promise<GriipClient> {
  const d = new GriipClient(h.baseUrl, c.username);
  d.identity = c.identity;
  const { nonce } = await d.req("POST", "/v1/auth/challenge");
  const r = await d.req("POST", "/v1/auth/add-device", {
    username: c.username,
    device: { name: "tablet", signingKey: d.signingKeyB64, encryptionKey: d.encKeyB64, certificate: d.certificate() },
    nonce,
    signature: sign(d.device, canonical.authProof("add-device", nonce, d.signingKeyB64)),
  });
  Object.assign(d, { userId: r.userId, deviceId: r.deviceId, token: r.sessionToken });
  return d;
}

/** [c] joins [callId] and confirms it's connected (as the apps do once in the media room). */
async function enter(c: GriipClient, callId: string, room: string, starter = false) {
  if (!starter) await c.req("POST", `/v1/calls/${callId}/join`);
  lk.join(room, c);
  await c.req("POST", `/v1/calls/${callId}/connected`);
}

const movedOut = (c: GriipClient, callId: string) =>
  c.waitFor(() => c.events.find((e) => e.t === "call" && e.event === "ended" && e.call.id === callId && e.call.endReason === "joined_elsewhere"));

const devicesIn = (callId: string) => presentDevices(h.ctx, callId);

async function dmCall(name: string) {
  const alice = await h.client(`${name}a`);
  const bob = await h.client(`${name}b`);
  const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  const r = await alice.req("POST", "/v1/calls", { conversationId: dm, video: false });
  const call = { id: r.call.id as string, room: r.media.room as string };
  await enter(alice, call.id, call.room, true);
  await enter(bob, call.id, call.room);
  return { alice, bob, call };
}

describe("newest device wins in a call", () => {
  it("joining from another device moves the older one out; the call and both sign-ins carry on", async () => {
    const { alice, bob, call } = await dmCall("nd1");
    await bob.connect();
    await alice.connect();
    const tablet = await secondDevice(bob);
    await enter(tablet, call.id, call.room);

    await movedOut(bob, call.id);
    expect(lk.removed).toEqual([`${bob.userId}.${bob.deviceId}`]);
    expect(lk.inRoom(call.room, bob)).toBe(false);
    expect(lk.inRoom(call.room, tablet)).toBe(true);
    expect(await devicesIn(call.id)).toEqual([alice.deviceId, tablet.deviceId].sort());
    const now = (await alice.req("GET", `/v1/calls/${call.id}`)).call;
    expect(now.state).toBe("ACTIVE");
    expect(now.participants.filter((p: any) => p.userId === bob.userId)).toHaveLength(1);
    // The other person isn't told the call ended; the older device is still signed in.
    expect(alice.events.some((e) => e.t === "call" && e.event === "ended")).toBe(false);
    await bob.req("GET", "/v1/conversations");
    await alice.disconnect();
    await bob.disconnect();
  });

  it("the older device coming back moves the newer one out in turn", async () => {
    const { bob, call } = await dmCall("nd2");
    const tablet = await secondDevice(bob);
    await tablet.connect();
    await enter(tablet, call.id, call.room);
    await enter(bob, call.id, call.room);
    await movedOut(tablet, call.id);
    expect(lk.inRoom(call.room, bob)).toBe(true);
    expect(lk.inRoom(call.room, tablet)).toBe(false);
    await tablet.disconnect();
  });

  it("also when LiveKit reports the join first, or the device never confirmed", async () => {
    const { bob, call } = await dmCall("nd3");
    await bob.connect();
    const tablet = await secondDevice(bob);
    lk.join(call.room, tablet);
    await fetch(`${h.baseUrl}/v1/livekit/webhook`, {
      method: "POST",
      headers: { "content-type": "application/webhook+json", authorization: "stub" },
      body: JSON.stringify({ event: "participant_joined", room: { name: call.room }, participant: { identity: `${tablet.userId}.${tablet.deviceId}` } }),
    });
    await movedOut(bob, call.id);
    expect(lk.inRoom(call.room, bob)).toBe(false);
    // The tablet's own confirmation afterwards doesn't tell the phone a second time.
    await tablet.req("POST", `/v1/calls/${call.id}/connected`);
    expect(bob.events.filter((e) => e.t === "call" && e.event === "ended")).toHaveLength(1);
    await bob.disconnect();
  });

  it("leaves other people's devices alone, in a group call too", async () => {
    const owner = await h.client("nd4o");
    const a = await h.client("nd4a");
    const b = await h.client("nd4b");
    const group = (await owner.req("POST", "/v1/conversations/group", { name: "Ops", memberIds: [a.userId, b.userId] })).conversation.id;
    const r = await owner.req("POST", "/v1/calls", { conversationId: group, video: true });
    await enter(owner, r.call.id, r.media.room, true);
    await enter(a, r.call.id, r.media.room);
    await enter(b, r.call.id, r.media.room);
    const a2 = await secondDevice(a);
    await enter(a2, r.call.id, r.media.room);
    expect(lk.removed).toEqual([`${a.userId}.${a.deviceId}`]);
    expect(await devicesIn(r.call.id)).toEqual([owner.deviceId, b.deviceId, a2.deviceId].sort());
  });
});
