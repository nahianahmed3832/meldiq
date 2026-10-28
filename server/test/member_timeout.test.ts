import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiveKitService } from "../src/modules/calls/livekit.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Member timeouts (docs/product/MELDIQ_FEATURE_GAP_MATRIX.md MOD-06): who may time out whom, what a timeout takes away
 * (posting, files, voice) everywhere in the community and nowhere else, the 28-day limit, ending it, and the audit trail.
 */
class FakeLiveKit {
  publicUrl = "ws://livekit.test";
  rooms = new Map<string, Set<string>>();
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
    return new Set([...(this.rooms.get(room) ?? [])].map((i) => i.split(".")[0]));
  }
  async removeParticipant(room: string, identity: string) {
    return this.rooms.get(room)?.delete(identity) ? ("removed" as const) : ("absent" as const);
  }
  join(room: string, c: GriipClient) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(`${c.userId}.${c.deviceId}`);
  }
}

const HOUR = 3_600_000;
let h: Harness;
let lk: FakeLiveKit;
let owner: GriipClient, mod: GriipClient, member: GriipClient, admin: GriipClient;
let orgId: string, general: string, voice: string, dm: string;

const timeout = (by: GriipClient, who: GriipClient, until: number | null, reason?: string) =>
  by.req("PUT", `/v1/orgs/${orgId}/members/${who.userId}/timeout`, { until, reason });
const post = (c: GriipClient, conv: string) => c.send(conv, { type: "text", text: "hello" });

beforeAll(async () => {
  h = await startServer();
  lk = new FakeLiveKit();
  h.ctx.livekit = lk as unknown as LiveKitService;
  [owner, mod, member, admin] = await Promise.all(["toowner", "tomod", "tomember", "toadmin"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Timeout Lab" })).org.id;
  for (const c of [mod, member, admin]) {
    const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
    await c.req("POST", "/v1/invites/accept", { code });
  }
  await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { role: "ADMIN" });
  const modRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Moderator", permissions: ["members.timeout"], denies: [] })).role.id;
  await owner.req("PUT", `/v1/roles/${modRole}/members/${mod.userId}`);
  general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "general", scope: "ORG", autoJoin: true })).channel.id;
  voice = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "Lounge", scope: "ORG", voice: true, autoJoin: true })).channel.id;
  dm = (await member.req("POST", "/v1/conversations/dm", { userId: mod.userId })).conversation.id;
  await Promise.all([owner, mod, member, admin].map((c) => c.connect()));
});
afterAll(async () => {
  await Promise.all([owner, mod, member, admin].map((c) => c.disconnect()));
  await h.close();
});

describe("who may time out whom", () => {
  it("needs members.timeout, and never reaches owners, admins (unless the owner acts) or oneself", async () => {
    const soon = Date.now() + HOUR;
    await expectStatus(timeout(member, mod, soon), 403);
    expect((await expectStatus(timeout(mod, owner, soon), 403)).error.message).toMatch(/Owners/);
    await expectStatus(timeout(mod, admin, soon), 403);
    await expectStatus(timeout(mod, mod, soon), 400);
    await expectStatus(timeout(owner, owner, soon), 400);
    // The owner may time out an admin; then end it again.
    expect((await timeout(owner, admin, soon)).timeoutUntil).toBe(soon);
    expect((await timeout(owner, admin, null)).timeoutUntil).toBeNull();
  });

  it("lasts between now and 28 days", async () => {
    await expectStatus(timeout(mod, member, Date.now() - 1000), 400);
    await expectStatus(timeout(mod, member, Date.now() + 29 * 24 * HOUR), 400);
  });
});

describe("a timed-out member", () => {
  it("can't post, upload or join voice in the community, says why, and is shown as timed out", async () => {
    const until = Date.now() + HOUR;
    expect(await timeout(mod, member, until, "spam")).toEqual({ userId: member.userId, timeoutUntil: until });
    const err = await expectStatus(post(member, general), 403);
    expect(err.error).toMatchObject({ code: "timed_out" });
    const conv = (await member.req("GET", `/v1/conversations/${general}`)).conversation;
    expect(conv).toMatchObject({ canPost: false, canAttach: false, timedOutUntil: until });
    const room = (await member.req("GET", `/v1/conversations/${voice}`)).conversation;
    expect(room).toMatchObject({ canConnect: false, canSpeak: false });
    await expectStatus(member.req("POST", "/v1/calls", { conversationId: voice, video: false }), 403);
    const listed = (await owner.req("GET", `/v1/orgs/${orgId}/members`)).members.find((m: { userId?: string; id?: string }) => (m.userId ?? m.id) === member.userId);
    expect(listed.timeoutUntil).toBe(until);
    // Others are unaffected, and so are direct messages outside the community's channels.
    await post(owner, general);
    await post(member, dm);
  });

  it("is removed from a live voice call when timed out", async () => {
    await timeout(mod, member, null);
    const r = await member.req("POST", "/v1/calls", { conversationId: voice, video: false });
    lk.join(r.media.room, member);
    await member.req("POST", `/v1/calls/${r.call.id}/connected`);
    await timeout(mod, member, Date.now() + HOUR);
    expect(lk.rooms.get(r.media.room)?.has(`${member.userId}.${member.deviceId}`) ?? false).toBe(false);
  });

  it("can post again when the timeout is ended or runs out", async () => {
    await timeout(mod, member, null);
    await post(member, general);
    await timeout(mod, member, Date.now() + HOUR);
    await expectStatus(post(member, general), 403);
    // Runs out: the stored time passes.
    await h.ctx.ws.write((w) => w.update("org_members", { org_id: orgId, user_id: member.userId }, { timeout_until: Date.now() - 1 }));
    await post(member, general);
    expect((await member.req("GET", `/v1/conversations/${general}`)).conversation.timedOutUntil).toBeUndefined();
  });

  it("is recorded in the audit log", async () => {
    const audit = (await owner.req("GET", `/v1/orgs/${orgId}/audit`)).entries ?? (await owner.req("GET", `/v1/orgs/${orgId}/audit`)).audit;
    const actions = (audit as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["member.timeout", "member.timeout_end"]));
  });
});
