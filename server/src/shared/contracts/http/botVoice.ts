import { z } from "zod/v4";
import { BotVoiceLease, BotVoicePacket } from "../botVoice.js";
import { MediaGrant } from "./calls.js";
import { route } from "./route.js";

export const BotVoiceJoinBody = z.strictObject({
  channelId: z.string().min(1).max(64),
  requestId: z.uuid(),
});
export const BotVoiceParams = z.strictObject({
  leaseId: z.string().min(1).max(64),
});
export const BotVoiceShareParams = BotVoiceParams.extend({
  callId: z.string().min(1).max(64),
});
const errors = [
  "not_found",
  "forbidden",
  "conflict",
  "rate_limited",
  "media_unavailable",
  "bot_events_unavailable",
  "voice_banned",
  "call_full",
] as const;
const botRoute = (
  method: "GET" | "POST" | "DELETE",
  url: string,
  summary: string,
  response: z.ZodType,
  body?: z.ZodType,
) =>
  route({
    method,
    url,
    tag: "Bots",
    scheme: "bot",
    auth: true,
    summary,
    ...(url.includes(":leaseId") ? { params: BotVoiceParams } : {}),
    ...(body ? { body } : {}),
    response,
    errors: [...errors],
  });
export const botVoiceRoutes = [
  botRoute(
    "POST",
    "/v2/bot/voice",
    "Join an existing native voice room with approved public key and a dedicated short-lived bot media lease.",
    BotVoiceLease.extend({
      media: MediaGrant.extend({
        token: z
          .string()
          .describe(
            "One-minute room-scoped bot token, initially receive-only. Current SFU admission enables approved microphone publishing.",
          ),
      }),
    }),
    BotVoiceJoinBody,
  ),
  botRoute(
    "GET",
    "/v2/bot/voice/:leaseId/key",
    "The current lease's HPKE-wrapped call key, or null while waiting for a connected human client.",
    BotVoiceLease.extend({
      key: BotVoicePacket.extend({
        senderUserId: z.string(),
        at: z.number().int(),
      }).nullable(),
    }),
  ),
  botRoute(
    "POST",
    "/v2/bot/voice/:leaseId/heartbeat",
    "Renew a currently authorized bot media lease; never revives a withdrawn lease.",
    BotVoiceLease,
  ),
  botRoute(
    "POST",
    "/v2/bot/voice/:leaseId/connected",
    "Confirm actual SFU presence of this bot media identity.",
    BotVoiceLease.extend({ canSpeak: z.boolean() }),
  ),
  botRoute(
    "DELETE",
    "/v2/bot/voice/:leaseId",
    "Close this bot's media admission and leave the existing voice room.",
    z.strictObject({ left: z.literal(true) }),
  ),
  route({
    method: "POST",
    url: "/v1/calls/:callId/bot-voice/:leaseId/key",
    tag: "calls",
    auth: true,
    summary:
      "A connected human client seals the room key to the currently approved bot public key. Ciphertext is memory-only.",
    params: BotVoiceShareParams,
    body: BotVoicePacket,
    response: z.strictObject({ accepted: z.literal(true) }),
    errors: [...errors],
  }),
];
