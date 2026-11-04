import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RAID_LIMITS } from "../src/modules/organizations/safety/rules.js";
import { SafetySettings } from "../src/shared/contracts/http/orgs.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Community safety (community parity A2, feature "community-safety", docs/COMMUNITY_SAFETY_API.md): locking a community,
 * raid protection, verification levels, the account-age gate, voice bans, server mutes and disconnecting. The clock the
 * gates go by is moved forward instead of waiting; the media server (LiveKit) is replaced where a call is involved.
 * Runs on memory and on MongoDB (with the community tables there too).
 */

const PRODUCTION_DOMAINS = "preferences,reports,relationships,history,accounts,files,relay,billing";
const MIN = 60_000;

let n = 0;
const text = (c: GriipClient, conv: string, words = "hi") => c.send(conv, { type: "text", text: words }, "message", `m_safe_${++n}_${Date.now()}`);
const react = (c: GriipClient, conv: string, target: string) => c.send(conv, { type: "reaction", target, emoji: "👍", add: true }, "control", `r_safe_${++n}_${Date.now()}`);
const read = (c: GriipClient, conv: string, upTo: number) => c.send(conv, { type: "read", upTo }, "control", `d_safe_${++n}_${Date.now()}`);
const err = (e: { error: { code: string; details?: Record<string, unknown> } }) => e.error;

const backends = process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}] as const] : [
  ["memory", {}],
  ["mongodb", { MONGODB_DOMAINS: `${PRODUCTION_DOMAINS},workspace,conversations,calls` }],
] as const;
describe.each(backends)("community safety kept in %s", (_backend, env) => {
  let h: Harness;
  let owner: GriipClient, admin: GriipClient, mod: GriipClient, member: GriipClient, helper: GriipClient;
  let orgId: string, invite: string, general: string, lounge: string;
  const people: GriipClient[] = [];
  const person = async (name: string) => {
    const c = await h.client(`${name}${people.length}`);
    c.serverMessages = true;
    people.push(c);
    return c;
  };
  const safety = () => h.ctx.communitySafety;
  const later = (ms: number) => (safety().clock = () => Date.now() + ms);
  const join = (c: GriipClient) => c.req("POST", "/v1/invites/accept", { code: invite });
  const settings = (body: object) => owner.req("PUT", `/v1/orgs/${orgId}/safety`, body);
  const audit = (action: string) => h.ctx.ws.all<{ actor_id: string | null; detail: string | null }>("audit_log", { where: { org_id: orgId, action } });

  beforeAll(async () => {
    h = await startServer({ ...env });
    [owner, admin, mod, member, helper] = await Promise.all(["owner", "admin", "mod", "member", "helper"].map(person));
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Safe Harbour", visibility: "public", joinPolicy: "open" })).org.id;
    invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 100 })).invite.code;
    for (const c of [admin, mod, member, helper]) await join(c);
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { role: "ADMIN" });
    const modRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { template: "moderator" })).role;
    await owner.req("PUT", `/v1/roles/${modRole.id}/members/${mod.userId}`);
    general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "chat" })).channel.id;
    lounge = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "lounge", voice: true })).channel.id;
    // No media server in tests: LiveKit answers that nobody is in a room unless a test says otherwise.
    vi.spyOn(h.ctx.livekit!, "participantIdentities").mockResolvedValue([]);
  });
  afterEach(() => {
    safety().clock = Date.now;
  });
  afterAll(async () => h.close());

  it("is advertised, starts with the defaults and shows the settings to moderators only", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("community-safety");
    const v = await mod.req("GET", `/v1/orgs/${orgId}/safety`);
    expect(SafetySettings.safeParse(v).success).toBe(true);
    expect(v).toEqual({ verificationLevel: "none", newAccountGate: "off", raidProtection: true, lockedUntil: null, lockReason: null });
    await expectStatus(member.req("GET", `/v1/orgs/${orgId}/safety`), 403);
    const outsider = await person("outsider");
    await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/safety`), 404);
    const seen = (await member.req("GET", `/v1/orgs/${orgId}`)).org;
    expect(seen.lockedUntil).toBeNull();
    expect(seen.safety).toBeUndefined();
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).org.safety).toMatchObject({ verificationLevel: "none" });
  });

  it("lets only people who can edit the community change the settings, audited", async () => {
    expect(err(await expectStatus(mod.req("PUT", `/v1/orgs/${orgId}/safety`, { raidProtection: false }), 403)).code).toBe("forbidden");
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/safety`, { verificationLevel: "extreme" }), 400);
    expect(await settings({ raidProtection: false })).toMatchObject({ raidProtection: false });
    expect(await settings({ raidProtection: true })).toMatchObject({ raidProtection: true });
    expect(audit("community.safety").map((a) => a.detail)).toEqual(expect.arrayContaining(["raid protection off", "raid protection on"]));
  });

  it("locks the community: nobody new joins and only moderators post, the rest read and react", async () => {
    await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/lock`, { duration: "1h" }), 403);
    const before = await text(owner, general, "Welcome");
    const lock = await mod.req("PUT", `/v1/orgs/${orgId}/lock`, { duration: "15m" });
    expect(lock).toMatchObject({ lockReason: "manual", lockedBy: mod.userId });
    expect(lock.lockedUntil).toBeGreaterThan(Date.now() + 14 * MIN);
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.lockedUntil).toBe(lock.lockedUntil);

    const refused = err(await expectStatus(text(member, general), 403));
    expect(refused).toMatchObject({ code: "community_locked_posting", details: { until: lock.lockedUntil } });
    await react(member, general, before.messageId);
    await read(member, general, before.serverTs);
    for (const c of [owner, admin, mod]) await text(c, general, "Moderators keep talking");

    const newcomer = await person("newcomer");
    expect(err(await expectStatus(join(newcomer), 403))).toMatchObject({ code: "community_locked", details: { until: lock.lockedUntil } });
    expect(err(await expectStatus(newcomer.req("POST", `/v1/communities/${orgId}/join`), 403)).code).toBe("community_locked");

    // It ends by itself.
    later(16 * MIN);
    await text(member, general, "Back to normal");
    await join(newcomer);
  });

  it("unlocks early, audited, and keeps Pause joining as it was", async () => {
    await owner.req("PUT", `/v1/orgs/${orgId}/lock`, { duration: "1d" });
    expect(await owner.req("PUT", `/v1/orgs/${orgId}/lock`, { duration: null })).toEqual({ lockedUntil: null, lockReason: null, lockedBy: null });
    expect(audit("community.lock").length).toBeGreaterThanOrEqual(2);
    expect(audit("community.unlock").length).toBe(1);
    await owner.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: Date.now() + 3_600_000 });
    expect(err(await expectStatus(join(await person("paused")), 403)).code).toBe("invites_paused");
    await text(member, general, "Pausing joins doesn't stop chat");
    await owner.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: null });
  });

  it("locks itself for 15 minutes on a join flood, audited as automatic", async () => {
    // Earlier joins of this suite don't count towards the smaller flood.
    safety().raid.forget(orgId);
    safety().raid.limits = { ...RAID_LIMITS, joins: 3 };
    try {
      const flood = await Promise.all(["raid", "raid", "raid", "raid"].map(person));
      for (const c of flood.slice(0, 3)) await join(c);
      const v = await owner.req("GET", `/v1/orgs/${orgId}/safety`);
      expect(v.lockReason).toBe("raid");
      expect(v.lockedUntil).toBeGreaterThan(Date.now() + 14 * MIN);
      expect(audit("community.lock").some((a) => a.actor_id === null && a.detail?.startsWith("automatic: 3 joins"))).toBe(true);
      expect(err(await expectStatus(join(flood[3]!), 403)).code).toBe("community_locked");
      await owner.req("PUT", `/v1/orgs/${orgId}/lock`, { duration: null });
      safety().raid.forget(orgId);
      // With raid protection off a flood locks nothing.
      await settings({ raidProtection: false });
      for (const c of await Promise.all(["calm", "calm", "calm"].map(person))) await join(c);
      expect((await owner.req("GET", `/v1/orgs/${orgId}/safety`)).lockedUntil).toBeNull();
    } finally {
      safety().raid.limits = { ...RAID_LIMITS };
      await settings({ raidProtection: true });
      await owner.req("PUT", `/v1/orgs/${orgId}/lock`, { duration: null });
    }
  });

  it("slows a channel down for 10 minutes on a message flood, then lets it go", async () => {
    safety().raid.forget(general);
    safety().raid.limits = { ...RAID_LIMITS, messages: 4, posters: 2 };
    try {
      for (const c of [member, helper, member, helper]) await text(c, general, "spam");
      expect(audit("channel.auto_slowmode").some((a) => a.actor_id === null && a.detail?.startsWith("automatic: 4 messages from 2 people"))).toBe(true);
      expect(err(await expectStatus(text(member, general), 429))).toMatchObject({ code: "slowmode", details: { retryAfter: expect.any(Number) } });
      await text(mod, general, "Moderators skip slowmode");
      later(11 * MIN);
      await text(member, general, "Calm again");
    } finally {
      safety().raid.limits = { ...RAID_LIMITS };
    }
  });

  it("asks for a verified email at low and a wait at medium and high; moderators and role holders skip it", async () => {
    const target = (await text(owner, general, "React to me")).messageId;
    await settings({ verificationLevel: "low" });
    expect(err(await expectStatus(text(member, general), 403))).toMatchObject({ code: "verification_required", details: { level: "low", reason: "email", allowedAt: null } });
    expect(err(await expectStatus(react(member, general, target), 403)).code).toBe("verification_required");
    for (const c of [admin, mod]) await text(c, general, "Exempt");
    const regular = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Regular", permissions: [] })).role;
    await owner.req("PUT", `/v1/roles/${regular.id}/members/${helper.userId}`);
    await text(helper, general, "Any role skips it");

    safety().emailVerified = async () => true;
    await text(member, general, "Verified now");
    await settings({ verificationLevel: "medium" });
    const fresh = await person("fresh");
    await join(fresh);
    const wait = err(await expectStatus(text(fresh, general), 403));
    expect(wait).toMatchObject({ code: "verification_required", details: { level: "medium", reason: "wait" } });
    const joinedAt = h.ctx.ws.get<{ joined_at: number }>("org_members", { org_id: orgId, user_id: fresh.userId })!.joined_at;
    expect(wait.details!.allowedAt).toBeGreaterThanOrEqual(joinedAt + 5 * MIN);
    later(6 * MIN);
    await text(fresh, general, "Five minutes later");
    await settings({ verificationLevel: "high" });
    expect(err(await expectStatus(text(fresh, general), 403)).details).toMatchObject({ level: "high", allowedAt: joinedAt + 10 * MIN });
    later(11 * MIN);
    await react(fresh, general, target);
    await settings({ verificationLevel: "none" });
  });

  it("keeps accounts younger than the gate out, unless they're platform staff", async () => {
    await settings({ newAccountGate: "1h" });
    const staff = await person("staff");
    safety().isStaff = async (id) => id === staff.userId;
    await join(staff);
    const young = await person("young");
    const refused = err(await expectStatus(join(young), 403));
    expect(refused).toMatchObject({ code: "account_too_new", details: { minAccountAge: "1h" } });
    expect(refused.details!.allowedAt).toBeGreaterThan(Date.now() + 59 * MIN);
    expect(err(await expectStatus(young.req("POST", `/v1/communities/${orgId}/join`), 403)).code).toBe("account_too_new");
    later(61 * MIN);
    await join(young);
    await settings({ newAccountGate: "off" });
  });

  it("voice-bans people from the voice channels only, listed with the bans and audited", async () => {
    await expectStatus(member.req("GET", `/v1/orgs/${orgId}/voice-bans`), 403);
    expect(err(await expectStatus(member.req("POST", `/v1/orgs/${orgId}/voice-bans`, { userId: helper.userId }), 403)).code).toBe("forbidden");
    await expectStatus(mod.req("POST", `/v1/orgs/${orgId}/voice-bans`, { userId: owner.userId }), 403);
    const call = await admin.req("POST", "/v1/calls", { conversationId: lounge, video: false });
    await member.req("POST", "/v1/calls", { conversationId: lounge, video: false });
    await member.req("POST", `/v1/calls/${call.call.id}/connected`);
    const removed = vi.spyOn(h.ctx.livekit!, "removeParticipant").mockResolvedValue("removed");

    const list = await mod.req("POST", `/v1/orgs/${orgId}/voice-bans`, { userId: member.userId, reason: "Mic spam" });
    expect(list.voiceBans).toEqual([expect.objectContaining({ userId: member.userId, reason: "Mic spam", bannedBy: mod.userId })]);
    expect((await h.ctx.calls.present(call.call.id)).map((p) => p.user_id)).not.toContain(member.userId);
    expect(removed).toHaveBeenCalledWith(call.media.room, `${member.userId}.${member.deviceId}`);
    expect(err(await expectStatus(member.req("POST", "/v1/calls", { conversationId: lounge, video: false }), 403)).code).toBe("voice_banned");
    expect((await member.req("GET", `/v1/conversations/${lounge}`)).conversation.canConnect).toBe(false);
    await text(member, general, "Still chatting");
    expect((await owner.req("GET", `/v1/orgs/${orgId}/bans`)).voiceBans).toHaveLength(1);
    expect((await mod.req("GET", `/v1/orgs/${orgId}/voice-bans`)).voiceBans).toEqual(list.voiceBans);

    expect((await mod.req("DELETE", `/v1/orgs/${orgId}/voice-bans/${member.userId}`)).voiceBans).toEqual([]);
    await expectStatus(mod.req("DELETE", `/v1/orgs/${orgId}/voice-bans/${member.userId}`), 404);
    expect(audit("member.voice_ban")).toHaveLength(1);
    expect(audit("member.voice_unban")).toHaveLength(1);
    removed.mockRestore();
  });

  it("server-mutes someone until unmuted: their media stops publishing and new tokens listen only", async () => {
    // The voice ban emptied the earlier call, so this starts the room's call again.
    const joined = await member.req("POST", "/v1/calls", { conversationId: lounge, video: false });
    expect(joined.media.canSpeak).toBe(true);
    const live = (await h.ctx.calls.liveIn([lounge]))[0]!;
    await member.req("POST", `/v1/calls/${live.id}/connected`);
    vi.spyOn(h.ctx.livekit!, "participantIdentities").mockResolvedValue([`${member.userId}.${member.deviceId}`]);
    const publish = vi.spyOn(h.ctx.livekit!, "setCanPublish").mockResolvedValue("updated");
    try {
      await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/voice/members/${helper.userId}/mute`, { muted: true }), 403);
      await expectStatus(mod.req("PUT", `/v1/orgs/${orgId}/voice/members/${owner.userId}/mute`, { muted: true }), 403);
      await expectStatus(mod.req("PUT", `/v1/orgs/${orgId}/voice/members/${mod.userId}/mute`, { muted: true }), 400);
      const muted = await mod.req("PUT", `/v1/orgs/${orgId}/voice/members/${member.userId}/mute`, { muted: true });
      expect(muted).toMatchObject({ userId: member.userId, muted: true, mutedAt: expect.any(Number), devices: 1 });
      expect(publish).toHaveBeenLastCalledWith(live.room_name, `${member.userId}.${member.deviceId}`, false);
      expect((await member.req("POST", "/v1/calls", { conversationId: lounge, video: false })).media.canSpeak).toBe(false);
      expect((await member.req("GET", `/v1/conversations/${lounge}`)).conversation.canSpeak).toBe(false);

      expect(await mod.req("PUT", `/v1/orgs/${orgId}/voice/members/${member.userId}/mute`, { muted: false })).toMatchObject({ muted: false, mutedAt: null, devices: 1 });
      expect(publish).toHaveBeenLastCalledWith(live.room_name, `${member.userId}.${member.deviceId}`, true);
      expect((await member.req("POST", "/v1/calls", { conversationId: lounge, video: false })).media.canSpeak).toBe(true);
      expect(audit("member.voice_mute")).toHaveLength(1);
      expect(audit("member.voice_unmute")).toHaveLength(1);
    } finally {
      publish.mockRestore();
    }
  });

  it("disconnects someone from the voice call they're in, with voice.move_members", async () => {
    const live = (await h.ctx.calls.liveIn([lounge]))[0]!;
    const removed = vi.spyOn(h.ctx.livekit!, "removeParticipant").mockResolvedValue("removed");
    try {
      await expectStatus(helper.req("POST", `/v1/orgs/${orgId}/voice/members/${member.userId}/disconnect`), 403);
      expect(await mod.req("POST", `/v1/orgs/${orgId}/voice/members/${member.userId}/disconnect`)).toEqual({ userId: member.userId, disconnected: 1 });
      expect(removed).toHaveBeenCalledWith(live.room_name, `${member.userId}.${member.deviceId}`);
      expect((await h.ctx.calls.present(live.id)).map((p) => p.user_id)).not.toContain(member.userId);
      vi.spyOn(h.ctx.livekit!, "participantIdentities").mockResolvedValue([]);
      await expectStatus(mod.req("POST", `/v1/orgs/${orgId}/voice/members/${member.userId}/disconnect`), 404);
      expect(audit("member.voice_disconnect")).toHaveLength(1);
    } finally {
      removed.mockRestore();
    }
  });

  it("lets a voice channel's own mute power mute in its call", async () => {
    await owner.req("PUT", `/v1/conversations/${lounge}/overwrites`, { subject: `user:${helper.userId}`, allow: ["voice.mute_members"], deny: [] });
    const live = (await member.req("POST", "/v1/calls", { conversationId: lounge, video: false })).call;
    await member.req("POST", `/v1/calls/${live.id}/connected`);
    vi.spyOn(h.ctx.livekit!, "muteAudio").mockResolvedValue("muted");
    await helper.req("POST", `/v1/calls/${live.id}/moderate`, { userId: member.userId, action: "mute" });
    await expectStatus(helper.req("POST", `/v1/calls/${live.id}/moderate`, { userId: member.userId, action: "remove" }), 403);
  });
});

describe("community safety switched off", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ COMMUNITY_SAFETY: "off" });
  });
  afterAll(async () => h.close());

  it("isn't advertised, answers 503 and enforces nothing", async () => {
    const owner = await h.client("offowner");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "Unguarded" })).org.id;
    expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("community-safety");
    expect(err(await expectStatus(owner.req("GET", `/v1/orgs/${orgId}/safety`), 503)).code).toBe("feature_disabled");
    expect(err(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/lock`, { duration: "1h" }), 503)).code).toBe("feature_disabled");
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).org.lockedUntil).toBeUndefined();
    expect((await owner.req("GET", `/v1/orgs/${orgId}/bans`)).voiceBans).toBeUndefined();
  });
});
