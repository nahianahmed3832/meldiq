import { z } from "zod/v4";

/**
 * The WebSocket contract (`/v1/ws`): every frame the server sends and every frame it accepts, as one discriminated
 * union on `t` (docs/architecture/ARCHITECTURE_1_0_PLAN.md §4). `Hub` only sends `ServerEvent`s, so a new frame or
 * field has to be added here first, where every client team can see it. The schemas are the source of the JSON
 * Schema in docs/api/ and of the checks the test suite runs on every frame it sees.
 *
 * Compatibility: fields are only ever added; clients ignore frames and fields they don't know.
 * Ids are opaque strings; times are epoch milliseconds.
 */

const id = z.string().min(1).max(128);
const time = z.number().int().nonnegative();

// ───────────── Shared payloads ─────────────

/** One delivery-queue item: an encrypted envelope for this device, or a delivery receipt. */
export const QueueItemWire = z.strictObject({
  /** Per-device order: items arrive in increasing id order and are acknowledged by id. */
  id: z.number().int().positive(),
  kind: z.enum(["envelope", "receipt"]),
  conversationId: id,
  messageId: id,
  senderUserId: id,
  senderDeviceId: id,
  createdAt: time,
  expiresAt: time,
  /** The envelope or receipt as the sender submitted it (ciphertext; the server can't read it). */
  payload: z.unknown(),
});
export type QueueItemWire = z.infer<typeof QueueItemWire>;

export const CallState = z.enum(["RINGING", "ACTIVE", "ENDED"]);
export type CallState = z.infer<typeof CallState>;

export const CallParticipantWire = z.strictObject({ userId: id, deviceId: id, joinedAt: time });
export type CallParticipantWire = z.infer<typeof CallParticipantWire>;

/** Who took part in an ended call, merged over rejoins (the call history line). */
export const CallAttendanceWire = z.strictObject({ userId: id, joinedAt: time, leftAt: time, seconds: z.number().int().nonnegative() });
export type CallAttendanceWire = z.infer<typeof CallAttendanceWire>;

export const CallWire = z.strictObject({
  id,
  conversationId: id,
  conversationType: z.string().nullable(),
  createdBy: id,
  video: z.boolean(),
  state: CallState,
  createdAt: time,
  answeredAt: time.nullable(),
  alertedAt: time.nullable(),
  endedAt: time.nullable(),
  endReason: z.string().nullable(),
  participants: z.array(CallParticipantWire),
  voiceRoom: z.boolean(),
  /** Voice rooms: people with a raised hand, in the order they raised it. */
  hands: z.array(id),
  /** Live calls: people sharing their screen now, from the media server (servers from 2026-10-26; older ones leave it out). */
  sharing: z.array(id).optional(),
  /** Ended calls only. */
  attended: z.array(CallAttendanceWire).optional(),
});
export type CallWire = z.infer<typeof CallWire>;

export const PresenceState = z.enum(["online", "idle", "dnd", "offline"]);
export type PresenceState = z.infer<typeof PresenceState>;

// ───────────── Server → client ─────────────

export const CallEventName = z.enum(["ring", "started", "updated", "ended", "declined", "dismissed", "alerted"]);
export type CallEventName = z.infer<typeof CallEventName>;

/** Extra fields some call events carry. */
const callEventExtras = {
  /** `ring`: who is calling. */
  from: z.strictObject({ userId: id, displayName: z.string() }).optional(),
  /** `declined`: who declined, and why. */
  userId: id.optional(),
  reason: z.enum(["declined", "busy"]).optional(),
};
export const CallEventExtras = z.strictObject(callEventExtras);
export type CallEventExtras = z.infer<typeof CallEventExtras>;

const orgId = { orgId: id };
const meeting = { ...orgId, meetingId: id, startsAt: time };

export const ServerEvent = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("hello"), userId: id, deviceId: id, serverTime: time }),
  z.strictObject({ t: z.literal("pong"), serverTime: time }),
  /** Queue items: live (`backlog` absent) or a backlog batch after connecting (`backlog: true`, acknowledged with it). */
  z.strictObject({ t: z.literal("queue"), items: z.array(QueueItemWire), more: z.boolean(), backlog: z.literal(true).optional() }),
  /** The backlog has been sent completely. */
  z.strictObject({ t: z.literal("queue.drained") }),
  z.strictObject({ t: z.literal("typing"), c: id, u: id, on: z.boolean() }),
  z.strictObject({ t: z.literal("presence"), userId: id, online: z.boolean(), presence: PresenceState, lastSeenAt: time.nullable() }),
  z.discriminatedUnion("event", [
    z.strictObject({ t: z.literal("call"), event: CallEventName, call: CallWire, ...callEventExtras }),
    /** Voice rooms: a moderator muted this person, lowered their hand or removed them. */
    z.strictObject({ t: z.literal("call"), event: z.literal("moderated"), action: z.enum(["mute", "lower_hand", "remove"]), call: CallWire }),
  ]),
  /** Reload the conversation (membership, settings, or it's gone). */
  z.strictObject({ t: z.literal("conv.updated"), conversationId: id }),
  /** Reload the community. */
  z.strictObject({ t: z.literal("org.updated"), ...orgId }),
  z.strictObject({ t: z.literal("org.deleted"), ...orgId }),
  /** Moderators: the number of open reports changed. */
  z.strictObject({ t: z.literal("org.reports"), ...orgId, open: z.number().int().nonnegative() }),
  /** Approvers: join applications changed. */
  z.strictObject({ t: z.literal("org.applications"), ...orgId }),
  /** The applicant: their application was decided. */
  z.strictObject({ t: z.literal("org.application"), ...orgId, status: z.enum(["approved", "denied"]) }),
  /** Safety moderators: an activity alert (a burst of joins). */
  z.strictObject({ t: z.literal("org.alert"), ...orgId, kind: z.literal("joins"), count: z.number().int().positive(), at: time }),
  /** Someone's devices changed: refresh their keys before encrypting to them. */
  z.strictObject({ t: z.literal("devices.changed"), userId: id }),
  /**
   * Someone's profile changed (name, status, photo, privacy), or, sent only to that person's own devices, one of their
   * account settings (who may message them, blocks, the selected workspace). Fetch it again: what you're allowed to see
   * is decided by that fetch, never by the frame.
   */
  z.strictObject({ t: z.literal("user.updated"), userId: id }),
  z.strictObject({ t: z.literal("connections.updated") }),
  z.strictObject({ t: z.literal("prefs.updated"), workspaceId: id, rev: z.number().int().nonnegative() }),
  z.strictObject({ t: z.literal("reminders.changed"), id, rev: z.number().int().nonnegative().optional(), deleted: z.literal(true).optional() }),
  z.strictObject({ t: z.literal("reminder.due"), id, occurrenceAt: time, firedAt: time }),
  z.strictObject({ t: z.literal("meeting.updated"), ...meeting }),
  z.strictObject({ t: z.literal("meeting.soon"), ...meeting }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export type ServerEventName = ServerEvent["t"];

// ───────────── Client → server ─────────────

export const ClientEvent = z.discriminatedUnion("t", [
  /** Browsers only, as the first frame (they can't set headers on a WebSocket). */
  z.strictObject({ t: z.literal("auth"), token: z.string() }),
  z.strictObject({ t: z.literal("ping") }),
  /** Acknowledge queue items (at most 500 ids per frame); `backlog: true` asks for the next backlog batch. */
  z.strictObject({ t: z.literal("ack"), ids: z.array(z.number().int()), backlog: z.boolean().optional() }),
  z.strictObject({ t: z.literal("typing"), c: id, on: z.boolean() }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;
export type ClientEventName = ClientEvent["t"];
