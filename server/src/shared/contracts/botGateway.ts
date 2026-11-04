import { z } from "zod/v4";
import { BotEventPage, BotEventsQuery } from "./http/botPlatform.js";

const credentials = z.strictObject({
  op: z.enum(["identify", "resume"]),
  token: z.string().min(1).max(200),
  cursor: z.string().max(640).optional(),
});
export const BotGatewayClientFrame = z.union([
  credentials,
  z.strictObject({
    op: z.literal("heartbeat"),
    nonce: z.string().max(64).optional(),
  }),
  z.strictObject({
    op: z.literal("presence"),
    status: z.enum(["online", "idle", "dnd", "offline"]),
  }),
  z.strictObject({
    op: z.literal("request"),
    requestId: z.string().min(1).max(64),
    action: z.literal("self"),
    data: z.strictObject({}).optional(),
  }),
  z.strictObject({
    op: z.literal("request"),
    requestId: z.string().min(1).max(64),
    action: z.literal("communities"),
    data: z.strictObject({}).optional(),
  }),
  z.strictObject({
    op: z.literal("request"),
    requestId: z.string().min(1).max(64),
    action: z.literal("events"),
    data: BotEventsQuery,
  }),
]);
export const BotGatewayServerFrame = z.union([
  z.strictObject({
    op: z.literal("hello"),
    version: z.literal(1),
    heartbeatIntervalMs: z.number().int().positive(),
    authTimeoutMs: z.number().int().positive(),
    maxFrameBytes: z.number().int().positive(),
  }),
  z.strictObject({
    op: z.enum(["ready", "resumed"]),
    botId: z.string(),
    version: z.literal(1),
  }),
  BotEventPage.extend({
    op: z.literal("events"),
    sequence: z.number().int().positive(),
  }),
  z.strictObject({
    op: z.literal("heartbeat_ack"),
    nonce: z.string().nullable(),
    cursor: z.string().optional(),
  }),
  z.strictObject({
    op: z.literal("presence_ack"),
    status: z.enum(["online", "idle", "dnd", "offline"]),
  }),
  z.strictObject({
    op: z.literal("response"),
    requestId: z.string(),
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.strictObject({
    op: z.literal("response"),
    requestId: z.string(),
    ok: z.literal(false),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);
