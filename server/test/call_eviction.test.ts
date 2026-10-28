import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import type { LiveKitService } from "../src/modules/calls/livekit.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** Stands in for the LiveKit server: tracks who is in each room and records every removal. */
class RecordingLiveKit {
  publicUrl = "ws://livekit.test";
  rooms = new Map<string, Set<string>>();
  removed: { room: string; identity: string }[] = [];
  unreachable = false;

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
    return this.unreachable ? null : [...(this.rooms.get(room) ?? [])];
  }
  async participantUsers(room: string) {
    const ids = await this.participantIdentities(room);
    return ids && new Set(ids.map((i) => i.split(".")[0]));
  }
  async removeParticipant(room: string, identity: string) {
    if (this.unreachable) return "error" as const;
    if (!this.rooms.get(room)?.delete(identity)) return "absent" as const;
    this.removed.push({ room, identity });
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

/** Starts a call in a conversation; every client listed joins the room and confirms. */
async function callWith(convId: string, starter: GriipClient, ...others: GriipClient[]) {
  const r = await starter.req("POST", "/v1/calls", { conversationId: convId, video: true });
  for (const c of [starter, ...others]) {
    if (c !== starter) await c.req("POST", `/v1/calls/${r.call.id}/join`);
    lk.join(r.media.room, c);
    await c.req("POST", `/v1/calls/${r.call.id}/connected`);
  }
  return { id: r.call.id as string, room: r.media.room as string };
}

const participantIds = async (who: GriipClient, callId: string) =>
  (await who.req("GET", `/v1/calls/${callId}`)).call.participants.map((p: any) => p.userId);

describe("removing a member evicts them from live calls (T1.3)", () => {
  it("removal from a group: out of the room, marked left, told the call ended, can't rejoin; others carry on", async () => {
    const owner = await h.client("evowner");
    const a = await h.client("eva");
    const b = await h.client("evb");
    const group = (await owner.req("POST", "/v1/conversations/group", { name: "Ops", memberIds: [a.userId, b.userId] })).conversation.id;
    const call = await callWith(group, owner, a, b);
    await a.connect();
    await b.connect();

    await owner.req("DELETE", `/v1/conversations/${group}/members/${a.userId}`);

    expect(lk.removed).toEqual([{ room: call.room, identity: `${a.userId}.${a.deviceId}` }]);
    expect(await participantIds(owner, call.id)).toEqual(expect.arrayContaining([owner.userId, b.userId]));
    expect(await participantIds(owner, call.id)).not.toContain(a.userId);
    const after = await owner.req("GET", `/v1/calls/${call.id}`);
    expect(after.call.state).toBe("ACTIVE");
    await a.waitFor(() => a.events.find((e) => e.t === "call" && e.event === "ended" && e.call.id === call.id && e.call.endReason === "removed"));
    await b.waitFor(() => b.events.find((e) => e.t === "call" && e.event === "updated" && e.call.id === call.id && !e.call.participants.some((p: any) => p.userId === a.userId)));
    await expectStatus(a.req("POST", `/v1/calls/${call.id}/join`), 404);
    await expectStatus(a.req("POST", `/v1/calls/${call.id}/connected`), 404);
    await a.disconnect();
    await b.disconnect();
  });

  it("covers every community removal path: a role taken away, a ban, demotion to Guest and leaving", async () => {
    const owner = await h.client("orgevowner");
    const org = (await owner.req("POST", "/v1/orgs", { name: "Evict Co" })).org.id;
    const role = (await owner.req("POST", `/v1/orgs/${org}/roles`, { name: "Ops", permissions: [], denies: [] })).role.id;
    const cat = (await owner.req("POST", `/v1/orgs/${org}/categories`, { name: "Ops" })).category.id;
    await owner.req("PUT", `/v1/categories/${cat}/overwrites`, { subject: "everyone", deny: ["channels.view"] });
    await owner.req("PUT", `/v1/categories/${cat}/overwrites`, { subject: role, allow: ["channels.view"] });
    const join = async (name: string) => {
      const c = await h.client(name);
      const code = (await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER", roleId: role })).invite.code;
      await c.req("POST", "/v1/invites/accept", { code });
      return c;
    };
    const stays = await join("staysin");
    const viaRole = await join("viarole");
    const viaBan = await join("viaban");
    const viaGuest = await join("viaguest");
    const viaLeave = await join("vialeave");
    const all = [stays, viaRole, viaBan, viaGuest, viaLeave];
    const opsRoom = (await owner.req("POST", `/v1/orgs/${org}/channels`, { name: "ops-room", categoryId: cat, voice: true })).channel.id;
    const lobby = (await owner.req("POST", `/v1/orgs/${org}/channels`, { name: "lobby", kind: "PUBLIC", voice: true })).channel.id;
    for (const c of all) expect((await c.req("GET", "/v1/conversations")).conversations.map((x: any) => x.id)).toEqual(expect.arrayContaining([opsRoom, lobby]));

    const opsCall = await callWith(opsRoom, owner, ...all);
    const lobbyCall = await callWith(lobby, owner, viaRole);

    await owner.req("DELETE", `/v1/roles/${role}/members/${viaRole.userId}`);
    await owner.req("POST", `/v1/orgs/${org}/bans`, { userId: viaBan.userId });
    await owner.req("PATCH", `/v1/orgs/${org}/members/${viaGuest.userId}`, { role: "GUEST" });
    await viaLeave.req("DELETE", `/v1/orgs/${org}/members/${viaLeave.userId}`);

    for (const c of [viaRole, viaBan, viaGuest, viaLeave]) expect(lk.inRoom(opsCall.room, c)).toBe(false);
    const left = await participantIds(owner, opsCall.id);
    expect(left.sort()).toEqual([owner.userId, stays.userId].sort());
    expect(lk.inRoom(opsCall.room, stays)).toBe(true);
    // viaRole is still in the community-wide lobby, so its lobby call is untouched.
    expect(lk.inRoom(lobbyCall.room, viaRole)).toBe(true);
    expect(await participantIds(owner, lobbyCall.id)).toContain(viaRole.userId);
    expect(lk.removed.every((r) => r.room === opsCall.room)).toBe(true);
  });

  it("changes that remove nobody leave calls alone", async () => {
    const owner = await h.client("noopowner");
    const a = await h.client("noopa");
    const extra = await h.client("noopextra");
    const group = (await owner.req("POST", "/v1/conversations/group", { name: "Calm", memberIds: [a.userId] })).conversation.id;
    const call = await callWith(group, owner, a);
    await owner.req("PUT", `/v1/conversations/${group}/members/${extra.userId}`, {});
    await owner.req("DELETE", `/v1/conversations/${group}/members/${extra.userId}`);
    expect(lk.removed).toEqual([]);
    expect((await owner.req("GET", `/v1/calls/${call.id}`)).call.state).toBe("ACTIVE");
  });

  it("the last member's removal ends the call", async () => {
    const owner = await h.client("lastowner");
    const a = await h.client("lasta");
    const group = (await owner.req("POST", "/v1/conversations/group", { name: "Solo", memberIds: [a.userId] })).conversation.id;
    const call = await callWith(group, a); // only `a` is in the call
    await owner.req("DELETE", `/v1/conversations/${group}/members/${a.userId}`);
    const c = await owner.req("GET", `/v1/calls/${call.id}`);
    expect(c.call.state).toBe("ENDED");
    expect(c.call.endReason).toBe("empty");
  });

  it("a revoked device is evicted, without ending the call for others", async () => {
    const owner = await h.client("revowner");
    const a = await h.client("reva");
    const b = await h.client("revb");
    const group = (await owner.req("POST", "/v1/conversations/group", { name: "Rev", memberIds: [a.userId, b.userId] })).conversation.id;
    const call = await callWith(group, owner, a, b);
    await a.req("DELETE", `/v1/devices/${a.deviceId}`);
    expect(lk.inRoom(call.room, a)).toBe(false);
    expect(await participantIds(owner, call.id)).not.toContain(a.userId);
    expect((await owner.req("GET", `/v1/calls/${call.id}`)).call.state).toBe("ACTIVE");
  });
});

describe("eviction when LiveKit misbehaves", () => {
  it("LiveKit unreachable: call state is corrected at once and the cleanup job removes them later", async () => {
    const owner = await h.client("downowner");
    const a = await h.client("downa");
    const b = await h.client("downb");
    const group = (await owner.req("POST", "/v1/conversations/group", { name: "Down", memberIds: [a.userId, b.userId] })).conversation.id;
    const call = await callWith(group, owner, a, b);
    lk.unreachable = true;
    await owner.req("DELETE", `/v1/conversations/${group}/members/${a.userId}`);
    expect(await participantIds(owner, call.id)).not.toContain(a.userId);
    expect(lk.inRoom(call.room, a)).toBe(true); // still connected: LiveKit didn't answer

    lk.unreachable = false;
    const r = await runCleanup(h.ctx);
    expect(r.callEvictions).toBeGreaterThanOrEqual(1);
    expect(lk.inRoom(call.room, a)).toBe(false);
    expect(lk.inRoom(call.room, b)).toBe(true);
  });

  it("rejoining with a token issued before removal is refused by the webhook", async () => {
    const owner = await h.client("rejoinowner");
    const a = await h.client("rejoina");
    const group = (await owner.req("POST", "/v1/conversations/group", { name: "Rejoin", memberIds: [a.userId] })).conversation.id;
    const call = await callWith(group, owner, a);
    await owner.req("DELETE", `/v1/conversations/${group}/members/${a.userId}`);
    lk.join(call.room, a); // reconnects straight to LiveKit with the old token
    await fetch(`${h.baseUrl}/v1/livekit/webhook`, {
      method: "POST",
      headers: { "content-type": "application/webhook+json", authorization: "stub" },
      body: JSON.stringify({ event: "participant_joined", room: { name: call.room }, participant: { identity: `${a.userId}.${a.deviceId}` } }),
    });
    expect(lk.inRoom(call.room, a)).toBe(false);
    expect(await participantIds(owner, call.id)).not.toContain(a.userId);
  });

  it("an account disabled by the admin CLI (another process) is evicted by the cleanup job", async () => {
    const owner = await h.client("disowner");
    const a = await h.client("disa");
    const b = await h.client("disb");
    const group = (await owner.req("POST", "/v1/conversations/group", { name: "Dis", memberIds: [a.userId, b.userId] })).conversation.id;
    const call = await callWith(group, owner, a, b);
    await h.ctx.identity.write((w) => w.update("users", { id: a.userId }, { disabled_at: Date.now() })); // what `admin disable` writes
    await runCleanup(h.ctx);
    expect(lk.inRoom(call.room, a)).toBe(false);
    expect(lk.inRoom(call.room, b)).toBe(true);
  });
});
