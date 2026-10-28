import { z } from "zod/v4";
import { CallWire } from "../realtime.js";
import { idParams } from "./primitives.js";
import { route } from "./route.js";

/** What a device needs to join the call's LiveKit room. Media stays end-to-end encrypted (docs/CALLING_AND_E2EE.md). */
export const MediaGrant = z.strictObject({
  /** The LiveKit server, e.g. wss://rtc.meldiq.app. */
  url: z.string(),
  /** A room-scoped token, valid for 10 minutes. */
  token: z.string(),
  room: z.string(),
  /** false: a voice channel the person may only listen in. */
  canSpeak: z.boolean(),
  /**
   * What this person may publish here (API 0.54.0, docs/MOJO.md): screen-share ceilings from their plan and the
   * community's Spark level together, and the voice bitrate ceiling. Apps choose within them; a larger screen share is
   * muted by the server.
   */
  limits: z
    .strictObject({
      screen: z.array(z.strictObject({ id: z.string(), width: z.number().int(), height: z.number().int(), fps: z.number().int() })),
      voiceKbps: z.number().int(),
    })
    .optional(),
});

export const CallOnly = z.strictObject({ call: CallWire });
export const CallWithMedia = z.strictObject({ call: CallWire, media: MediaGrant });
export const CallList = z.strictObject({ calls: z.array(CallWire) });

export const CallCreateBody = z.object({ conversationId: z.string().max(64), video: z.boolean().default(false) });
export const ConversationCallsQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const HandBody = z.object({ raised: z.boolean() });
export const ModerateBody = z.object({ userId: z.string().max(64), action: z.enum(["mute", "lower_hand", "remove"]) });
export const DeclineBody = z.object({ reason: z.enum(["declined", "busy"]).default("declined") });

const callAction = (url: string, summary: string, response: z.ZodType, extra: Partial<Parameters<typeof route>[0]> = {}) =>
  route({ method: "POST", url, tag: "calls", summary, auth: true, params: idParams, response, errors: ["not_found"], ...extra });

export const callRoutes = [
  route({
    method: "POST",
    url: "/v1/calls",
    tag: "calls",
    summary: "Start a call in a conversation, or join the one already live there.",
    auth: true,
    body: CallCreateBody,
    response: CallWithMedia.extend({ joinedExisting: z.boolean() }),
    errors: ["not_found", "conflict", "request_pending", "media_unavailable", "text_channel_no_calls", "call_full", "forbidden"],
  }),
  route({ method: "GET", url: "/v1/calls/active", tag: "calls", summary: "Live calls in this person's conversations (to recover missed rings).", auth: true, response: CallList }),
  route({
    method: "GET",
    url: "/v1/conversations/:id/calls",
    tag: "calls",
    summary: "A conversation's call history, newest first.",
    auth: true,
    params: idParams,
    query: ConversationCallsQuery,
    response: CallList,
    errors: ["not_found"],
  }),
  route({ method: "GET", url: "/v1/calls/:id", tag: "calls", summary: "One call.", auth: true, params: idParams, response: CallOnly, errors: ["not_found"] }),
  callAction("/v1/calls/:id/join", "Join a live call: the media grant for this device.", CallWithMedia, { errors: ["not_found", "call_ended", "call_full", "media_unavailable", "forbidden"] }),
  callAction("/v1/calls/:id/hand", "Voice rooms: raise or lower your hand.", CallOnly, { body: HandBody }),
  callAction("/v1/calls/:id/moderate", "Voice rooms: a moderator mutes someone, lowers their hand or removes them from the call.", CallOnly, {
    body: ModerateBody,
    errors: ["not_found", "forbidden"],
  }),
  callAction("/v1/calls/:id/connected", "This device's media connected (the call becomes active).", CallOnly),
  callAction("/v1/calls/:id/alerted", "This device is ringing (the caller sees Ringing).", CallOnly),
  callAction("/v1/calls/:id/decline", "Decline a ringing call, or say you're busy.", CallOnly, { body: DeclineBody }),
  callAction("/v1/calls/:id/end", "End the call for everyone (1:1) or leave it (group).", CallOnly),
  callAction("/v1/calls/:id/leave", "Leave the call.", CallOnly),
];
