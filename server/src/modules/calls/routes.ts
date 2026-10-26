import crypto from "node:crypto";
import { CallCreateBody, ConversationCallsQuery, DeclineBody, HandBody, ModerateBody } from "../../shared/contracts/http/calls.js";
import { idParams } from "../../shared/contracts/http/primitives.js";
import type { CallAttendanceWire, CallEventExtras, CallEventName, CallWire, ServerEvent } from "../../shared/contracts/realtime.js";
import type { FastifyInstance } from "fastify";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { forgetSharing, isScreenShare, setSharing, sharingDevices } from "./screenShares.js";

export interface CallRow {
  id: string;
  conversation_id: string;
  room_name: string;
  created_by: string;
  video: number;
  state: "RINGING" | "ACTIVE" | "ENDED";
  created_at: number;
  answered_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  /** First time a recipient device confirmed it is ringing (null: no recipient has been reached yet). */
  alerted_at: number | null;
  /** Set on a mirror of a call hosted by another server (federation); null when this server hosts it. */
  host_server_id: string | null;
  /** 1: the call of a voice room (docs/VOICE_ROOMS.md): nobody rings; it lasts while anyone is in it. */
  room?: number;
}

/**
 * Who took part in an ended call, one entry per person (2026-10-17 call history): when they first connected, when they
 * last left, and how long they were connected in total (overlapping devices counted once). Built from the server's
 * own connection records, so it never includes anyone who only rang. Reconnecting on the same device keeps a single
 * record, so a person's time is a close lower bound rather than an exact sum.
 */
export function callAttendance(ctx: AppContext, c: CallRow): CallAttendanceWire[] {
  const rows = ctx.db.prepare("SELECT user_id, joined_at, left_at FROM call_participants WHERE call_id = ? ORDER BY joined_at").all(c.id) as {
    user_id: string;
    joined_at: number;
    left_at: number | null;
  }[];
  const end = c.ended_at ?? now();
  const byUser = new Map<string, [number, number][]>();
  for (const r of rows) {
    const to = Math.max(r.joined_at, Math.min(r.left_at ?? end, end));
    const list = byUser.get(r.user_id) ?? [];
    list.push([r.joined_at, to]);
    byUser.set(r.user_id, list);
  }
  return [...byUser.entries()].map(([userId, spans]) => {
    spans.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [from, to] = spans[0];
    for (const [a, b] of spans.slice(1)) {
      if (a <= to) to = Math.max(to, b);
      else {
        total += to - from;
        [from, to] = [a, b];
      }
    }
    total += to - from;
    return { userId, joinedAt: spans[0][0], leftAt: Math.max(...spans.map((x) => x[1])), seconds: Math.floor(total / 1000) };
  });
}

export function callView(ctx: AppContext, c: CallRow): CallWire {
  const participants = ctx.db
    .prepare("SELECT user_id, device_id, joined_at FROM call_participants WHERE call_id = ? AND left_at IS NULL")
    .all(c.id) as { user_id: string; device_id: string; joined_at: number }[];
  const conv = ctx.authz.conversation(c.conversation_id);
  return {
    id: c.id,
    conversationId: c.conversation_id,
    conversationType: conv?.type ?? null,
    createdBy: c.created_by,
    video: !!c.video,
    state: c.state,
    createdAt: c.created_at,
    answeredAt: c.answered_at,
    alertedAt: c.alerted_at ?? null,
    endedAt: c.ended_at,
    endReason: c.end_reason,
    participants: participants.map((p) => ({ userId: p.user_id, deviceId: p.device_id, joinedAt: p.joined_at })),
    // Voice rooms (round 6): the call is the room's, and people may raise a hand to speak.
    voiceRoom: !!c.room,
    hands: c.room
      ? (
          ctx.db
            .prepare(
              // Only people still in the call: a hand goes down when they leave.
              `SELECT h.user_id FROM call_hands h WHERE h.call_id = ? AND EXISTS (
                 SELECT 1 FROM call_participants p WHERE p.call_id = h.call_id AND p.user_id = h.user_id AND p.left_at IS NULL)
               ORDER BY h.raised_at`,
            )
            .all(c.id) as { user_id: string }[]
        ).map((h) => h.user_id)
      : [],
    // Live calls: who is sharing their screen now (LiveKit's account, current participants only; screenShares.ts).
    ...(c.state !== "ENDED" ? { sharing: sharersOf(ctx, c.id, participants) } : {}),
    // Ended calls only (older apps ignore it): who connected, for the call history line in the conversation.
    ...(c.state === "ENDED" ? { attended: callAttendance(ctx, c) } : {}),
  };
}

/** The people (each once) whose device still in the call is sharing its screen. */
function sharersOf(ctx: AppContext, callId: string, participants: { user_id: string; device_id: string }[]): string[] {
  const devices = sharingDevices(ctx, callId);
  if (devices.size === 0) return [];
  return [...new Set(participants.filter((p) => devices.has(p.device_id)).map((p) => p.user_id))];
}

export function conversationMemberIds(ctx: AppContext, convId: string): string[] {
  return (ctx.db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(convId) as { user_id: string }[]).map((r) => r.user_id);
}

export function loadCall(ctx: AppContext, id: string): CallRow | undefined {
  return ctx.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as CallRow | undefined;
}

export function broadcastCall(ctx: AppContext, c: CallRow, event: CallEventName, extra: CallEventExtras = {}): void {
  ctx.hub.sendToUsers(conversationMemberIds(ctx, c.conversation_id), { t: "call", event, call: callView(ctx, c), ...extra });
  // Hosted here with people on other servers: their home servers get the same event (signed, best effort).
  if (!c.host_server_id) ctx.federation?.relayCall(c, event, extra);
}

/**
 * 1:1 calls survive a dropped connection (2026-10-17, docs/CALLING_AND_E2EE.md › Reconnecting): when one person's media
 * connection goes away, the call waits [callPeerGraceMs] for them to rejoin before ending as "lost". Hanging up still
 * ends the call at once (it goes through /end or /leave, not this).
 */
const lostTimers = new WeakMap<AppContext, Map<string, NodeJS.Timeout>>();

function timers(ctx: AppContext) {
  let m = lostTimers.get(ctx);
  if (!m) lostTimers.set(ctx, (m = new Map()));
  return m;
}

export function cancelLostTimer(ctx: AppContext, callId: string) {
  const t = timers(ctx).get(callId);
  if (t) {
    clearTimeout(t);
    timers(ctx).delete(callId);
  }
}

export function scheduleLost(ctx: AppContext, c: CallRow) {
  if (timers(ctx).has(c.id)) return;
  const t = setTimeout(() => {
    timers(ctx).delete(c.id);
    if (!ctx.db.open) return;
    const cur = loadCall(ctx, c.id);
    if (!cur || cur.state === "ENDED") return;
    const users = (ctx.db.prepare("SELECT COUNT(DISTINCT user_id) n FROM call_participants WHERE call_id = ? AND left_at IS NULL").get(c.id) as { n: number }).n;
    if (users < 2) void endCallRow(ctx, cur, users === 0 ? "empty" : "lost");
  }, ctx.config.callPeerGraceMs);
  t.unref?.();
  timers(ctx).set(c.id, t);
}

export async function endCallRow(ctx: AppContext, c: CallRow, reason: string): Promise<void> {
  cancelLostTimer(ctx, c.id);
  const t = now();
  const res = ctx.db.prepare("UPDATE calls SET state = 'ENDED', ended_at = ?, end_reason = ? WHERE id = ? AND state != 'ENDED'").run(t, reason, c.id);
  if (res.changes === 0) return;
  // Observability (UI-003): the call's id, why it ended and how long it lasted; never names, identities or media.
  ctx.log.info({ callId: c.id, reason, seconds: c.answered_at ? Math.round((t - c.answered_at) / 1000) : 0 }, "call ended");
  ctx.db.prepare("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND left_at IS NULL").run(t, c.id);
  forgetSharing(ctx, c.id);
  broadcastCall(ctx, loadCall(ctx, c.id)!, "ended");
  if (!c.host_server_id) await ctx.livekit?.deleteRoom(c.room_name);
}

/**
 * Whether a device may be in a conversation's call: the user is still a member, the device is
 * theirs and not revoked, and the account isn't disabled. In a community voice channel they must
 * also still hold `voice.connect` there (a timeout or a changed permission takes it away).
 */
export function callAdmission(ctx: AppContext, conversationId: string): (userId: string, deviceId: string) => boolean {
  const member = ctx.db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?");
  const device = ctx.db.prepare(
    "SELECT d.revoked_at, u.disabled_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.user_id = ?",
  );
  const conv = ctx.authz.conversation(conversationId);
  const voiceChannel = conv && conv.voice && conv.type === "CHANNEL" && conv.org_id ? conv : null;
  return (userId, deviceId) => {
    if (!member.get(conversationId, userId)) return false;
    if (voiceChannel && !ctx.authz.canConnectVoice(voiceChannel, userId)) return false;
    const d = device.get(deviceId, userId) as { revoked_at: number | null; disabled_at: number | null } | undefined;
    return !!d && !d.revoked_at && !d.disabled_at;
  };
}

/**
 * Refuses a join that would take a call past [Config.callMaxParticipants] devices (UI-003). Counted from LiveKit (the
 * truth about who is connected) or, when it can't be reached, from the server's own records; the joining device itself
 * (a reconnect) never counts against it.
 */
export async function assertCallHasRoom(ctx: AppContext, c: CallRow, identity: string): Promise<void> {
  const fromLiveKit = ctx.livekit ? await ctx.livekit.participantIdentities(c.room_name) : null;
  const identities =
    fromLiveKit ??
    (ctx.db.prepare("SELECT user_id, device_id FROM call_participants WHERE call_id = ? AND left_at IS NULL").all(c.id) as {
      user_id: string;
      device_id: string;
    }[]).map((r) => `${r.user_id}.${r.device_id}`);
  const others = new Set(identities.filter((i) => i !== identity)).size;
  if (others >= ctx.config.callMaxParticipants) {
    ctx.log.info({ callId: c.id, others }, "call: join refused, call is full");
    throw new ApiError(409, "call_full", `This call is full (${ctx.config.callMaxParticipants} people at most)`);
  }
}

/**
 * Removes everyone no longer admitted to a live call (see `callAdmission`) from the LiveKit room
 * and from call state, tells their devices the call ended for them, and updates or ends the call
 * for the rest. Participants are found both in LiveKit (which also catches someone reconnecting
 * with a token issued before their removal) and in `call_participants`.
 * If LiveKit can't be reached the database is still corrected and a warning logged; the cleanup
 * job runs this again every interval, so the removal is retried rather than lost.
 * Returns the number of devices evicted.
 */
export async function evictFromCall(ctx: AppContext, c: CallRow): Promise<number> {
  const admitted = callAdmission(ctx, c.conversation_id);
  const identities = new Set((ctx.livekit && (await ctx.livekit.participantIdentities(c.room_name))) || []);
  const rows = ctx.db.prepare("SELECT user_id, device_id FROM call_participants WHERE call_id = ? AND left_at IS NULL").all(c.id) as {
    user_id: string;
    device_id: string;
  }[];
  for (const r of rows) identities.add(`${r.user_id}.${r.device_id}`);
  const evicted = new Map<string, string[]>(); // userId → evicted device ids
  let devices = 0;
  for (const identity of identities) {
    const [userId, deviceId] = identity.split(".");
    if (!userId || !deviceId || admitted(userId, deviceId)) continue;
    const outcome = ctx.livekit ? await ctx.livekit.removeParticipant(c.room_name, identity) : "absent";
    if (outcome === "error") ctx.log.warn({ callId: c.id }, "call eviction: LiveKit unreachable, the cleanup job will retry");
    ctx.db.prepare("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND device_id = ? AND left_at IS NULL").run(now(), c.id, deviceId);
    evicted.set(userId, [...(evicted.get(userId) ?? []), deviceId]);
    devices++;
  }
  if (devices === 0) return 0;
  const cur = loadCall(ctx, c.id)!;
  const removed: ServerEvent = { t: "call", event: "ended", call: { ...callView(ctx, cur), endReason: "removed" } };
  for (const [u, deviceIds] of evicted) {
    // A former member stops ringing on every device; a revoked device alone must not end the call
    // on the same person's other, still-admitted device.
    if (!ctx.authz.isMember(c.conversation_id, u)) ctx.hub.sendToUser(u, removed);
    else for (const d of deviceIds) ctx.hub.sendToDevice(d, removed);
  }
  if (cur.state === "ENDED") return devices;
  const remainingUsers = (
    ctx.db.prepare("SELECT COUNT(DISTINCT user_id) n FROM call_participants WHERE call_id = ? AND left_at IS NULL").get(c.id) as { n: number }
  ).n;
  const isDm = ctx.authz.conversation(c.conversation_id)?.type === "DM";
  if (remainingUsers === 0) await endCallRow(ctx, cur, "empty");
  else if (isDm && cur.state === "ACTIVE" && remainingUsers < 2) await endCallRow(ctx, cur, "hangup");
  else broadcastCall(ctx, cur, "updated");
  return devices;
}

/**
 * Newest device wins in a call (2026-10-24): one account is in a call from one device at a time. When [deviceId] joins
 * (it confirmed it's connected, or LiveKit says it joined), the account's other devices in the call leave it: out of the
 * LiveKit room, marked as left, and told the call ended for them (`endReason: "joined_elsewhere"`). The account stays
 * signed in on them, and the call goes on for everyone else. Returns the devices moved out.
 */
export async function replaceOtherDevices(ctx: AppContext, c: CallRow, userId: string, deviceId: string): Promise<string[]> {
  // Decided in the same turn as the join that triggered it, so of two devices joining together the later one stays.
  const moved = new Set(
    (
      ctx.db
        .prepare("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND user_id = ? AND device_id != ? AND left_at IS NULL RETURNING device_id")
        .all(now(), c.id, userId, deviceId) as { device_id: string }[]
    ).map((r) => r.device_id),
  );
  // A device may be in the room without having confirmed yet: LiveKit knows it.
  const candidates = new Set(moved);
  for (const identity of (ctx.livekit && (await ctx.livekit.participantIdentities(c.room_name))) || []) {
    const [u, d] = identity.split(".");
    if (u === userId && d && d !== deviceId) candidates.add(d);
  }
  const out: string[] = [];
  for (const d of candidates) {
    // It joined again meanwhile (now the newest itself): leave it be.
    const back = ctx.db.prepare("SELECT 1 FROM call_participants WHERE call_id = ? AND device_id = ? AND left_at IS NULL").get(c.id, d);
    if (back) continue;
    // Told before it's removed, so the app knows why its media connection is about to close. (Once: a device already
    // moved out is neither in the call nor in the room, so a second join report finds nothing to do.)
    ctx.hub.sendToDevice(d, { t: "call", event: "ended", call: { ...callView(ctx, loadCall(ctx, c.id)!), endReason: "joined_elsewhere" } });
    out.push(d);
    const outcome = ctx.livekit ? await ctx.livekit.removeParticipant(c.room_name, `${userId}.${d}`) : "absent";
    if (outcome === "error") ctx.log.warn({ callId: c.id }, "call: LiveKit unreachable while moving a device out");
  }
  if (out.length) ctx.log.info({ callId: c.id, devices: out.length }, "call: joined on another device, older device moved out");
  return out;
}

/** After a membership change: evict `userId` from live calls of the conversations they were removed from. */
export async function evictRemovedMember(ctx: AppContext, userId: string, conversationIds: Iterable<string>): Promise<number> {
  let n = 0;
  for (const convId of new Set(conversationIds)) {
    if (ctx.authz.isMember(convId, userId)) continue; // re-granted in the same change
    const live = ctx.db.prepare("SELECT * FROM calls WHERE conversation_id = ? AND state != 'ENDED'").all(convId) as CallRow[];
    for (const c of live) n += await evictFromCall(ctx, c);
  }
  return n;
}

/** After a device is revoked or an account disabled: evict it from every live call it could be in. */
export async function evictUserDevicesFromCalls(ctx: AppContext, userId: string): Promise<number> {
  const live = ctx.db
    .prepare(
      `SELECT DISTINCT c.* FROM calls c
       WHERE c.state != 'ENDED' AND (
         c.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?)
         OR c.id IN (SELECT call_id FROM call_participants WHERE user_id = ? AND left_at IS NULL))`,
    )
    .all(userId, userId) as CallRow[];
  let n = 0;
  for (const c of live) n += await evictFromCall(ctx, c);
  return n;
}

/**
 * Call actions shared by this server's own users (routes below) and by people on another server whose request their
 * home server forwards (federation, `/fed/v1/calls/:id/:action`). The caller has already been checked as a member.
 */
export function callActions(ctx: AppContext) {
  const { db, authz } = ctx;
  const load = (id: string) => loadCall(ctx, id);
  const broadcast = (c: CallRow, event: CallEventName, extra: CallEventExtras = {}) => broadcastCall(ctx, c, event, extra);
  const endCall = (c: CallRow, reason: string) => endCallRow(ctx, c, reason);

  /**
   * Media credentials for one device. In a voice channel the person's channel permissions decide (docs/VOICE_ROOMS.md):
   * without `voice.connect` they can't join at all; without `voice.speak` the token can't publish, so they listen only.
   */
  const issue = async (c: CallRow, userId: string, deviceId: string) => {
    if (!ctx.livekit) throw new ApiError(503, "media_unavailable", "Calling is not configured on this server");
    const conv = authz.conversation(c.conversation_id);
    const room = !!conv?.voice;
    if (room && conv && !authz.canConnectVoice(conv, userId)) throw forbidden("You can't join this voice channel");
    const canSpeak = !room || !conv || authz.canSpeakInVoice(conv, userId);
    const u = db.prepare("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string };
    const token = await ctx.livekit.token({
      room: c.room_name,
      identity: `${userId}.${deviceId}`,
      name: u.display_name,
      metadata: JSON.stringify({ userId, deviceId }),
      canPublish: canSpeak,
    });
    return { url: ctx.livekit.publicUrl, token, room: c.room_name, canSpeak };
  };

  return {
    issue,
    async join(c: CallRow, userId: string, deviceId: string) {
      if (c.state === "ENDED") throw new ApiError(410, "call_ended", "This call has ended");
      await assertCallHasRoom(ctx, c, `${userId}.${deviceId}`);
      return { call: callView(ctx, c), media: await issue(c, userId, deviceId) };
    },
    // Client-side confirmation that it is connected to the media room. Complements LiveKit
    // webhooks so call state stays correct even where webhooks can't reach the API.
    async connected(c: CallRow, userId: string, deviceId: string) {
      if (c.state === "ENDED") throw new ApiError(410, "call_ended", "This call has ended");
      db.prepare(
        "INSERT INTO call_participants (call_id, user_id, device_id, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT(call_id, device_id) DO UPDATE SET left_at = NULL",
      ).run(c.id, userId, deviceId, now());
      await replaceOtherDevices(ctx, c, userId, deviceId);
      const users = (db.prepare("SELECT COUNT(DISTINCT user_id) n FROM call_participants WHERE call_id = ? AND left_at IS NULL").get(c.id) as { n: number }).n;
      if (c.state === "RINGING" && users >= 2) db.prepare("UPDATE calls SET state = 'ACTIVE', answered_at = ? WHERE id = ?").run(now(), c.id);
      if (users >= 2) cancelLostTimer(ctx, c.id); // came back in time
      const cur = load(c.id)!;
      broadcast(cur, "updated");
      return { call: callView(ctx, cur) };
    },
    // A recipient device is ringing: lets the caller show "Ringing" instead of "Calling". Idempotent; only
    // the first confirmation is stored and announced. The caller's own devices can't alert.
    async alerted(c: CallRow, userId: string) {
      if (c.state === "ENDED") throw new ApiError(410, "call_ended", "This call has ended");
      if (c.created_by === userId) throw conflict("The caller can't alert their own call");
      if (c.alerted_at == null) {
        db.prepare("UPDATE calls SET alerted_at = ? WHERE id = ? AND alerted_at IS NULL").run(now(), c.id);
        notifyCallUser(ctx, load(c.id)!, c.created_by, "alerted");
      }
      return { call: callView(ctx, load(c.id)!) };
    },
    async decline(c: CallRow, userId: string, reason: "declined" | "busy") {
      if (c.state === "ENDED") return { call: callView(ctx, c) };
      const conv = authz.conversation(c.conversation_id)!;
      if (conv.type === "DM" && c.state === "RINGING") {
        await endCall(c, reason);
      } else {
        notifyCallUser(ctx, c, c.created_by, "declined", { userId, reason });
      }
      // Stop ringing on the decliner's other devices.
      notifyCallUser(ctx, load(c.id)!, userId, "dismissed");
      return { call: callView(ctx, load(c.id)!) };
    },
    async end(c: CallRow, userId: string) {
      const conv = authz.conversation(c.conversation_id)!;
      // In 1:1 calls either party ends the call for both. In group calls only the starter or a
      // conversation manager may end it for everyone; others just leave.
      if (conv.type !== "DM" && c.created_by !== userId && !authz.canManageConversation(conv, userId)) {
        throw forbidden("Only the person who started this call or a manager can end it for everyone");
      }
      await endCall(c, "hangup");
      return { call: callView(ctx, load(c.id)!) };
    },
    async leave(c: CallRow, userId: string, deviceId: string) {
      db.prepare("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND device_id = ? AND left_at IS NULL").run(now(), c.id, deviceId);
      const conv = authz.conversation(c.conversation_id)!;
      const remaining = (db.prepare("SELECT COUNT(*) n FROM call_participants WHERE call_id = ? AND left_at IS NULL").get(c.id) as { n: number }).n;
      if (conv.type === "DM" || remaining === 0) await endCall(c, conv.type === "DM" ? "hangup" : "empty");
      else broadcast(load(c.id)!, "updated");
      await ctx.livekit?.removeParticipant(c.room_name, `${userId}.${deviceId}`);
      return { call: callView(ctx, load(c.id)!) };
    },
  };
}

/** Sends a call event to one person: over their sockets here, or to their home server if they're on another one. */
export function notifyCallUser(ctx: AppContext, c: CallRow, userId: string, event: CallEventName, extra: CallEventExtras = {}) {
  const home = (ctx.db.prepare("SELECT home_server_id h FROM users WHERE id = ?").get(userId) as { h: string | null } | undefined)?.h;
  if (home) {
    if (!c.host_server_id) ctx.federation?.relayCall(c, event, extra, userId);
    return;
  }
  ctx.hub.sendToUser(userId, { t: "call", event, call: callView(ctx, c), ...extra });
  // A ring also wakes their devices that have no open socket (payload-free; the app finds the ringing call itself).
  if (event === "ring") {
    ctx.push?.ring(userId);
    ctx.fcm?.wakeUser(userId);
  }
}

export default async function callRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const { db, authz } = ctx;
  const actions = callActions(ctx);
  const load = (id: string) => loadCall(ctx, id);
  const broadcast = (c: CallRow, event: CallEventName, extra: CallEventExtras = {}) => broadcastCall(ctx, c, event, extra);
  const endCall = (c: CallRow, reason: string) => endCallRow(ctx, c, reason);
  const memberIds = (convId: string) => conversationMemberIds(ctx, convId);

  /** A call hosted by another server: the action goes to the host (signed), which answers with the new state. */
  const forwarded = async (c: CallRow, action: string, userId: string, deviceId: string, body: object = {}) => {
    if (!ctx.federation) throw new ApiError(503, "federation_disabled", "This server no longer federates");
    return ctx.federation.forwardCall(c, action, userId, deviceId, body);
  };

  const memberCall = (id: string, userId: string) => {
    const c = load(id);
    if (!c || !authz.isMember(c.conversation_id, userId)) throw notFound("Call not found");
    return c;
  };

  app.post("/v1/calls", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const body = parse(CallCreateBody, req.body);
    const conv = authz.requireMember(body.conversationId, userId);
    if (conv.archived_at) throw conflict("This channel is archived");
    // Batch B6: nobody rings through a message request; the recipient accepts it first.
    if (conv.type === "DM" && (await ctx.relationships.request(conv.id))) {
      throw new ApiError(403, "request_pending", "Calls start once the message request is accepted");
    }
    // One live call per conversation: starting while one exists joins it instead (also one hosted by another server).
    const existing = db.prepare("SELECT * FROM calls WHERE conversation_id = ? AND state != 'ENDED' ORDER BY created_at DESC LIMIT 1").get(conv.id) as
      | CallRow
      | undefined;
    if (existing?.host_server_id) return { ...(await forwarded(existing, "join", userId, deviceId)), joinedExisting: true };
    if (!ctx.livekit) throw new ApiError(503, "media_unavailable", "Calling is not configured on this server");
    const remote = db.prepare("SELECT 1 FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND u.home_server_id IS NOT NULL LIMIT 1").get(conv.id);
    if (remote && !ctx.federation?.callsEnabled()) {
      throw new ApiError(409, "federated_calls_unavailable", "Calls with people on other servers aren't available yet");
    }
    if (existing) {
      await assertCallHasRoom(ctx, existing, `${userId}.${deviceId}`);
      return { call: callView(ctx, existing), media: await actions.issue(existing, userId, deviceId), joinedExisting: true };
    }
    // Round 7: a text channel is for messages; calls in a workspace happen in its voice rooms. A call already running
    // in a text channel (started before this rule) can still be joined above.
    if (conv.type === "CHANNEL" && !conv.voice) {
      throw new ApiError(409, "text_channel_no_calls", "Calls happen in voice rooms, not in text channels");
    }
    if (conv.voice && !authz.canConnectVoice(conv, userId)) throw forbidden("You can't join this voice channel");
    const id = newId("call");
    const room = `griip-${crypto.randomBytes(12).toString("hex")}`;
    if (conv.voice) {
      // A voice room: no ringing; the call is active at once and lasts while anyone is in it (docs/VOICE_ROOMS.md).
      const t = now();
      db.prepare("INSERT INTO calls (id, conversation_id, room_name, created_by, video, state, created_at, answered_at, room) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 1)").run(
        id,
        conv.id,
        room,
        userId,
        body.video ? 1 : 0,
        t,
        t,
      );
      const c = load(id)!;
      ctx.log.info({ callId: id, room: true }, "voice room opened");
      if (conv.org_id) ctx.audit({ actorId: userId, orgId: conv.org_id, action: "voice_room.open", target: conv.id });
      broadcast(c, "started");
      return { call: callView(ctx, c), media: await actions.issue(c, userId, deviceId), joinedExisting: false };
    }
    db.prepare("INSERT INTO calls (id, conversation_id, room_name, created_by, video, state, created_at) VALUES (?, ?, ?, ?, ?, 'RINGING', ?)").run(
      id,
      conv.id,
      room,
      userId,
      body.video ? 1 : 0,
      now(),
    );
    const c = load(id)!;
    ctx.log.info({ callId: id, video: body.video, group: conv.type !== "DM" }, "call started");
    if (conv.org_id) ctx.audit({ actorId: userId, orgId: conv.org_id, action: "call.start", target: conv.id, detail: body.video ? "video" : "voice" });
    // Ring everyone else (people on another server through their home server). The media E2EE key is NOT in this
    // event: the caller sends it as an end-to-end encrypted control message through the normal messaging path.
    const callerName = (db.prepare("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string }).display_name;
    for (const m of memberIds(conv.id)) {
      if (m === userId) continue;
      notifyCallUser(ctx, c, m, "ring", { from: { userId, displayName: callerName } });
    }
    ctx.hub.sendToUser(userId, { t: "call", event: "started", call: callView(ctx, c) }, deviceId);
    return { call: callView(ctx, c), media: await actions.issue(c, userId, deviceId), joinedExisting: false };
  });

  app.get("/v1/calls/active", auth, async (req) => {
    const { userId } = me(req);
    const rows = db
      .prepare(
        `SELECT c.* FROM calls c JOIN conversation_members m ON m.conversation_id = c.conversation_id
         WHERE m.user_id = ? AND c.state != 'ENDED' ORDER BY c.created_at DESC`,
      )
      .all(userId) as CallRow[];
    return { calls: rows.map((c) => callView(ctx, c)) };
  });

  // Call history of one conversation (2026-10-17), newest first: calls since the caller became a member, live and ended.
  // Only call metadata the server already has (who started it, when, who connected); nothing from encrypted messages.
  app.get("/v1/conversations/:id/calls", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const q = parse(ConversationCallsQuery, req.query ?? {});
    authz.requireMember(id, userId);
    const since = (db.prepare("SELECT joined_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(id, userId) as { joined_at: number }).joined_at;
    const rows = db
      .prepare(`SELECT * FROM calls WHERE conversation_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
      .all(id, since, q.before ?? Number.MAX_SAFE_INTEGER, q.limit) as CallRow[];
    return { calls: rows.map((c) => callView(ctx, c)) };
  });

  app.get("/v1/calls/:id", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    return { call: callView(ctx, memberCall(id, userId)) };
  });

  app.post("/v1/calls/:id/join", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = memberCall(id, userId);
    if (c.host_server_id) return forwarded(c, "join", userId, deviceId);
    return actions.join(c, userId, deviceId);
  });

  // ───────────── Voice rooms (docs/VOICE_ROOMS.md) ─────────────

  /** Raise or lower your hand in a voice room's call (everyone in the conversation sees the queue). */
  app.post("/v1/calls/:id/hand", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const { raised } = parse(HandBody, req.body);
    const c = memberCall(id, userId);
    if (!c.room) throw badRequest("Hands are for voice rooms");
    if (c.state === "ENDED") throw new ApiError(410, "call_ended", "This call has ended");
    if (raised) db.prepare("INSERT OR IGNORE INTO call_hands (call_id, user_id, raised_at) VALUES (?, ?, ?)").run(c.id, userId, now());
    else db.prepare("DELETE FROM call_hands WHERE call_id = ? AND user_id = ?").run(c.id, userId);
    const cur = load(c.id)!;
    broadcast(cur, "updated");
    return { call: callView(ctx, cur) };
  });

  /**
   * A voice room's moderators (the conversation's managers): mute someone's microphone, lower their hand, or remove
   * them from the call (they can join again unless they're removed from the room itself).
   */
  app.post("/v1/calls/:id/moderate", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const body = parse(ModerateBody, req.body);
    const c = memberCall(id, userId);
    const conv = authz.conversation(c.conversation_id)!;
    if (!c.room) throw badRequest("Moderation is for voice rooms");
    if (!authz.canManageConversation(conv, userId)) throw forbidden("Only this room's managers can do that");
    if (c.state === "ENDED") throw new ApiError(410, "call_ended", "This call has ended");
    const devices = (db.prepare("SELECT device_id FROM call_participants WHERE call_id = ? AND user_id = ? AND left_at IS NULL").all(c.id, body.userId) as { device_id: string }[]).map((r) => r.device_id);
    if (body.action === "lower_hand") db.prepare("DELETE FROM call_hands WHERE call_id = ? AND user_id = ?").run(c.id, body.userId);
    if (body.action !== "lower_hand" && devices.length === 0) throw notFound("They aren't in this call");
    for (const d of devices) {
      const identity = `${body.userId}.${d}`;
      if (body.action === "mute") {
        const r = ctx.livekit ? await ctx.livekit.muteAudio(c.room_name, identity) : "error";
        if (r === "error") throw new ApiError(503, "media_unavailable", "The media server couldn't be reached. Try again.");
      } else if (body.action === "remove") {
        await ctx.livekit?.removeParticipant(c.room_name, identity);
        db.prepare("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND device_id = ? AND left_at IS NULL").run(now(), c.id, d);
        ctx.hub.sendToDevice(d, { t: "call", event: "ended", call: { ...callView(ctx, c), endReason: "removed" } });
      }
    }
    if (body.action === "remove") db.prepare("DELETE FROM call_hands WHERE call_id = ? AND user_id = ?").run(c.id, body.userId);
    ctx.hub.sendToUser(body.userId, { t: "call", event: "moderated", action: body.action, call: callView(ctx, load(c.id)!) });
    if (conv.org_id) ctx.audit({ actorId: userId, orgId: conv.org_id, action: `voice_room.${body.action}`, target: body.userId, detail: c.id });
    const cur = load(c.id)!;
    const remaining = (db.prepare("SELECT COUNT(*) n FROM call_participants WHERE call_id = ? AND left_at IS NULL").get(c.id) as { n: number }).n;
    if (remaining === 0) await endCall(cur, "empty");
    else broadcast(cur, "updated");
    return { call: callView(ctx, load(c.id)!) };
  });

  app.post("/v1/calls/:id/connected", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = memberCall(id, userId);
    if (c.host_server_id) return forwarded(c, "connected", userId, deviceId);
    return actions.connected(c, userId, deviceId);
  });

  app.post("/v1/calls/:id/alerted", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = memberCall(id, userId);
    if (c.host_server_id) {
      if (c.state === "ENDED") throw new ApiError(410, "call_ended", "This call has ended");
      return forwarded(c, "alerted", userId, deviceId);
    }
    return actions.alerted(c, userId);
  });

  app.post("/v1/calls/:id/decline", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const { id } = parse(idParams, req.params);
    const body = parse(DeclineBody, req.body ?? {});
    const c = memberCall(id, userId);
    if (c.host_server_id) {
      if (c.state === "ENDED") return { call: callView(ctx, c) };
      return forwarded(c, "decline", userId, deviceId, { reason: body.reason });
    }
    return actions.decline(c, userId, body.reason);
  });

  app.post("/v1/calls/:id/end", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = memberCall(id, userId);
    if (c.host_server_id) return forwarded(c, "end", userId, deviceId);
    return actions.end(c, userId);
  });

  app.post("/v1/calls/:id/leave", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = memberCall(id, userId);
    if (c.host_server_id) return forwarded(c, "leave", userId, deviceId);
    return actions.leave(c, userId, deviceId);
  });

  // LiveKit → API webhook: authoritative participant join/leave and room lifecycle.
  app.post("/v1/livekit/webhook", { config: { rawBody: true } }, async (req, reply) => {
    if (!ctx.livekit) return reply.code(404).send();
    let event;
    try {
      event = await ctx.livekit.receiveWebhook(req.body as string, req.headers.authorization);
    } catch {
      return reply.code(401).send({ error: "invalid webhook signature" });
    }
    const roomName = event.room?.name;
    if (!roomName) return { ok: true };
    const c = db.prepare("SELECT * FROM calls WHERE room_name = ?").get(roomName) as CallRow | undefined;
    if (!c) return { ok: true };
    const identity = event.participant?.identity ?? "";
    const [pUser, pDevice] = identity.split(".");
    if (event.event === "participant_joined" && pUser && pDevice && !callAdmission(ctx, c.conversation_id)(pUser, pDevice)) {
      // Joined with a token issued before they were removed (tokens live 10 minutes): send them out again.
      await ctx.livekit.removeParticipant(roomName, identity);
      ctx.hub.sendToDevice(pDevice, { t: "call", event: "ended", call: { ...callView(ctx, c), endReason: "removed" } });
    } else if (event.event === "participant_joined" && pUser && pDevice) {
      db.prepare(
        "INSERT INTO call_participants (call_id, user_id, device_id, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT(call_id, device_id) DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at",
      ).run(c.id, pUser, pDevice, now());
      await replaceOtherDevices(ctx, c, pUser, pDevice);
      const count = (db.prepare("SELECT COUNT(DISTINCT user_id) n FROM call_participants WHERE call_id = ? AND left_at IS NULL").get(c.id) as { n: number }).n;
      if (c.state === "RINGING" && count >= 2) db.prepare("UPDATE calls SET state = 'ACTIVE', answered_at = ? WHERE id = ?").run(now(), c.id);
      if (count >= 2) cancelLostTimer(ctx, c.id);
      broadcast(load(c.id)!, "updated");
    } else if (event.event === "participant_left" && pDevice) {
      // A device that rejoins (the app's reconnect, or a second connection) replaces its old session under the same
      // identity, and LiveKit's "left" for the old one can arrive after the new one joined. Marking the device as gone
      // then ended live 1:1 calls as "lost" (UI-003). Only a device LiveKit no longer has is marked as left.
      const still = await ctx.livekit.participantIdentities(roomName);
      if (still?.includes(identity)) {
        ctx.log.info({ callId: c.id }, "call: ignored a replaced session's leave");
        return { ok: true };
      }
      db.prepare("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND device_id = ? AND left_at IS NULL").run(now(), c.id, pDevice);
      forgetSharing(ctx, c.id, pDevice);
      const cur = load(c.id)!;
      const remaining = (db.prepare("SELECT COUNT(*) n FROM call_participants WHERE call_id = ? AND left_at IS NULL").get(c.id) as { n: number }).n;
      const conv = authz.conversation(c.conversation_id);
      if (cur.state !== "ENDED" && remaining === 0) await endCall(cur, "empty");
      else {
        // 1:1: the other person may only have lost their connection; give them time to come back.
        if (cur.state === "ACTIVE" && conv?.type === "DM") scheduleLost(ctx, cur);
        broadcast(cur, "updated");
      }
    } else if ((event.event === "track_published" || event.event === "track_unpublished") && pDevice && isScreenShare(event.track?.source)) {
      // Screen sharing started or stopped: members see it on the channel without joining (community-first brief §E).
      if (c.state !== "ENDED" && setSharing(ctx, c.id, pDevice, event.event === "track_published")) broadcast(load(c.id)!, "updated");
    } else if (event.event === "room_finished") {
      await endCall(c, "empty");
    }
    return { ok: true };
  });
}
