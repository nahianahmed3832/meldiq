import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Messages stored and served by the server (API 0.56.0, docs/SERVER_MESSAGES.md). The payload is the same JSON the
 * apps used to encrypt (type, text, replyTo, attachments, target, emoji, ...), now sent and stored as it is.
 */

/** A payload's JSON text: up to 128 KiB (attachments go through /v1/attachments). */
export const MAX_PAYLOAD_BYTES = 128 * 1024;

const zMessageId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const zPayloadObject = z.looseObject({ type: z.string().min(1).max(40), target: z.string().max(64).optional(), text: z.string().optional() });

export const SendMessage = z.object({
  conversationId: z.string().max(64),
  /** Chosen by the sender; a retry with the same id is answered as a duplicate. */
  messageId: zMessageId,
  cls: z.enum(["message", "control"]),
  sentAt: z.number().int().positive(),
  payload: zPayloadObject,
  /** The sender asks for @everyone (docs/MENTIONS.md): the server checks its policy and marks the message. */
  mentionAll: z.boolean().optional(),
  /** "self": a control only for the sender's own other devices (read markers). */
  audience: z.enum(["self"]).optional(),
});
export type SendMessage = z.infer<typeof SendMessage>;

export const SendMessageResult = z.strictObject({
  messageId: z.string(),
  serverTs: zTime,
  /** true: this id was already accepted; serverTs is the first acceptance's. */
  duplicate: z.boolean(),
});

/** A stored message or change as apps read it, in pages and in the queue's `message` items. */
export const StoredEvent = z.strictObject({
  id: z.string(),
  conversationId: z.string(),
  senderUserId: z.string(),
  senderDeviceId: z.string().nullable(),
  cls: z.enum(["message", "control"]),
  payload: z.record(z.string(), z.unknown()),
  sentAt: zTime,
  serverTs: zTime,
  mentionAll: z.boolean(),
  /** Who uploaded it from their device's own history when their app updated; null: sent through the server. */
  importedBy: z.string().nullable(),
});
export type StoredEvent = z.infer<typeof StoredEvent>;

/** What a device finds in a queue item's `payload` when its kind is "message" (the stored event itself). */
export const MessageItemPayload = z.strictObject({ v: z.literal(2), event: StoredEvent });

export const HistoryQuery = z.object({
  /** Messages strictly older than this serverTs; omitted: the newest. */
  before: z.coerce.number().int().positive().optional(),
  /** Instead of a page: the messages around this one (a link or a search hit). */
  around: zMessageId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const HistoryResponse = z.strictObject({
  /** Newest first. */
  messages: z.array(StoredEvent),
  /** Changes to those messages (edits, reactions, deletions, votes, pins, reads), oldest first: apply them in order. */
  changes: z.array(StoredEvent),
  more: z.boolean(),
});

/** History a device held from before the server kept messages: uploaded once when the app updates. */
export const ImportBody = z.object({
  items: z
    .array(
      z.object({
        id: zMessageId,
        conversationId: z.string().max(64),
        senderUserId: z.string().max(64),
        cls: z.enum(["message", "control"]),
        sentAt: z.number().int().positive(),
        serverTs: z.number().int().positive(),
        payload: zPayloadObject,
      }),
    )
    .min(1)
    .max(200),
});

export const ImportResult = z.strictObject({ added: zCount, skipped: zCount });

export const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  /** Only this conversation; omitted: every conversation the person is in. */
  conversationId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const SearchResponse = z.strictObject({ messages: z.array(StoredEvent) });

/** Each conversation you're in: its newest message, where you've read up to, and what's new since (the apps' list). */
export const SummaryResponse = z.strictObject({
  conversations: z.array(
    z.strictObject({
      conversationId: z.string(),
      last: StoredEvent.nullable(),
      readUpTo: z.number().int().nonnegative(),
      /** Others' messages since readUpTo, counted up to 99. */
      unread: zCount,
      mentions: zCount,
    }),
  ),
});

export const serverMessagesRoutes = [
  route({
    method: "POST",
    url: "/v2/messages",
    tag: "messaging",
    summary: "Send a message or a change to one: stored, then delivered to every member's devices. Idempotent on messageId.",
    auth: true,
    body: SendMessage,
    response: SendMessageResult,
    errors: [
      "not_found",
      "forbidden",
      "timed_out",
      "voice_channel",
      "bad_clock",
      "conflict",
      "slowmode",
      "request_pending",
      "request_limit",
      "message_too_long",
      "not_yours",
      "mention_all_not_in_dm",
      "mention_all_not_allowed",
      "mention_all_rate_limited",
    ],
  }),
  route({
    method: "GET",
    url: "/v2/conversations/:id/messages",
    tag: "messaging",
    summary: "A conversation's history, newest first, with the changes to those messages.",
    auth: true,
    query: HistoryQuery,
    response: HistoryResponse,
    errors: ["not_found"],
  }),
  route({
    method: "POST",
    url: "/v2/messages/import",
    tag: "messaging",
    summary: "Upload history this device held from before the server kept messages; messages already stored are skipped.",
    auth: true,
    body: ImportBody,
    response: ImportResult,
  }),
  route({
    method: "GET",
    url: "/v2/messages/summary",
    tag: "messaging",
    summary: "Every conversation you're in: its newest message, your read position, and unread messages and mentions since.",
    auth: true,
    response: SummaryResponse,
  }),
  route({
    method: "GET",
    url: "/v2/messages/search",
    tag: "messaging",
    summary: "Search the text of messages in the conversations you're in.",
    auth: true,
    query: SearchQuery,
    response: SearchResponse,
  }),
];
