import { z } from "zod/v4";
import { QueueItemWire } from "../realtime.js";
import { zB64, zCount, zKey, zSig, zTime } from "./primitives.js";
import { route } from "./route.js";

/** Ciphertext per message: ≈ 96 KiB (attachments go through /v1/attachments). */
export const MAX_CIPHERTEXT_B64 = 128 * 1024;

/**
 * An end-to-end encrypted message (griip-envelope-v1, docs/CALLING_AND_E2EE.md): one ciphertext, its content key
 * wrapped once per recipient device, signed by the sending device.
 */
export const Envelope = z.object({
  conversationId: z.string().max(64),
  /** Chosen by the sender; a retry with the same id is answered as a duplicate. */
  messageId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  cls: z.enum(["message", "control"]),
  sentAt: z.number().int().positive(),
  /** 12 bytes, base64. */
  nonce: z.string().length(16).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  ciphertext: zB64.max(MAX_CIPHERTEXT_B64),
  signature: zSig,
  recipients: z
    .array(z.object({ deviceId: z.string().max(64), enc: zKey, wrappedKey: z.string().length(64).regex(/^[A-Za-z0-9+/]+={0,2}$/) }))
    .max(1000),
  /**
   * The sender asks for @everyone (docs/MENTIONS.md). Content stays encrypted: the server only checks its policy and
   * marks the recipients' copies, and recipients treat @everyone as a mention only with that mark.
   */
  mentionAll: z.boolean().optional(),
  /**
   * "self": a control only for the sender's own other devices (API 0.43.0), e.g. "I've read this channel up to here"
   * so the person's other browsers clear it too. Recipients are then exactly those devices; nobody else gets a copy.
   */
  audience: z.enum(["self"]).optional(),
});
export type Envelope = z.infer<typeof Envelope>;

export const SendResult = z.strictObject({
  messageId: z.string(),
  serverTs: zTime,
  recipientCount: zCount,
  /** true: the same device already sent this id; serverTs is the first acceptance's. */
  duplicate: z.boolean(),
});

/** What a recipient device finds in a queue item's `payload` for an envelope. */
export const EnvelopePayload = z.strictObject({
  v: z.literal(1),
  cls: z.enum(["message", "control"]),
  sentAt: zTime,
  serverTs: zTime,
  nonce: z.string(),
  ciphertext: z.string(),
  signature: z.string(),
  enc: z.string(),
  wrappedKey: z.string(),
  /** Server-attested @everyone; absent otherwise. */
  mentionAll: z.literal(true).optional(),
});

/** What a sender's device finds in a queue item's `payload` for a delivery receipt. */
export const ReceiptPayload = z.strictObject({ status: z.literal("delivered"), at: zTime });

export const QueuePage = z.strictObject({ items: z.array(QueueItemWire), more: z.boolean() });
export const QueueQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });
export const AckBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });

export const messagingRoutes = [
  route({
    method: "POST",
    url: "/v1/messages",
    tag: "messaging",
    summary: "Send an encrypted envelope: fanned out into each recipient device's delivery queue. Idempotent on messageId.",
    auth: true,
    body: Envelope,
    response: SendResult,
    errors: [
      "not_found",
      "forbidden",
      "timed_out",
      "voice_channel",
      "bad_clock",
      "conflict",
      "bad_signature",
      "slowmode",
      "request_pending",
      "request_limit",
      "mention_all_not_in_dm",
      "mention_all_not_allowed",
      "mention_all_rate_limited",
      "device_mismatch",
      "federation_disabled",
    ],
  }),
  route({
    method: "GET",
    url: "/v1/queue",
    tag: "messaging",
    summary: "This device's queued items in order (the REST fallback for the WebSocket queue).",
    auth: true,
    query: QueueQuery,
    response: QueuePage,
  }),
  route({
    method: "POST",
    url: "/v1/queue/ack",
    tag: "messaging",
    summary: "Acknowledge queue items: they are deleted and the senders get delivery receipts.",
    auth: true,
    body: AckBody,
    response: z.strictObject({ removed: zCount }),
  }),
];

