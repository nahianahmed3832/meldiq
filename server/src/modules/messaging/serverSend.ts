import type { FastifyBaseLogger } from "fastify";
import { MAX_PAYLOAD_BYTES, type SendMessage, type StoredEvent } from "../../shared/contracts/http/serverMessages.js";
import type { AppContext } from "../../app/context.js";
import { ApiError, badRequest, conflict } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { rowsByIds } from "../../infrastructure/database/byIds.js";
import { DuplicateSubmission, type QueueInsert } from "./relay/store.js";
import type { MessageEvent } from "./store/messageStore.js";
import { memberUsers } from "./memberUsers.js";
import { admitClock, admitConversation, admitPost, recordPost } from "./sendRules.js";

/** Changes only a message's own sender may make. */
const AUTHOR_ONLY = new Set(["edit", "delete", "poll_close"]);
/** Payload types whose text counts against the sender's plan (docs/MOJO.md): a message and an edit of one. */
const COUNTED = new Set(["text", "edit"]);

/** Characters as people count them (grapheme clusters: an emoji with its skin tone or a flag is one), as the apps do. */
export function countChars(text: string): number {
  let n = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) n++;
  return n;
}

/** A stored event as apps read it. */
export function eventToWire(e: MessageEvent): StoredEvent {
  return {
    id: e.id,
    conversationId: e.conversation_id,
    senderUserId: e.sender_user_id,
    senderDeviceId: e.sender_device_id,
    cls: e.cls,
    payload: JSON.parse(e.payload) as Record<string, unknown>,
    sentAt: e.sent_at,
    serverTs: e.server_ts,
    mentionAll: e.mention_all === 1,
    importedBy: e.imported_by,
  };
}

/** Who sends: a person's device, or a bot (API 0.65.0 batch B), which has no device. */
export interface Sender {
  userId: string;
  deviceId: string | null;
}

/**
 * Sends a message or a change through the server (POST /v2/messages, docs/SERVER_MESSAGES.md): every rule people's
 * messages follow (standing, membership, posting rights, slowmode, requests, @everyone, the plan's characters, who may
 * change a message), then stored and queued to every member's devices. Bots send through here too (modules/bots), so
 * their messages are ordinary messages; a bot has no device, so the stored event names none and the relay records
 * "bot-<userId>" as the sending device.
 */
export async function sendServerMessage(ctx: AppContext, sender: Sender, m: SendMessage, log: FastifyBaseLogger): Promise<{ messageId: string; serverTs: number; duplicate: boolean }> {
  const { userId, deviceId } = sender;
  const relayDevice = deviceId ?? `bot-${userId}`;
  const payload = JSON.stringify(m.payload);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new ApiError(413, "message_too_long", "That message is too large");
  const conv = admitConversation(ctx, userId, m.conversationId, m.cls);
  const type = m.payload.type;
  // Meldiq Mojo: the plan's characters per message and per edit, counted as people count them.
  const limits = ctx.mojo.limitsOf(userId);
  const text = typeof m.payload.text === "string" ? m.payload.text : "";
  if (limits && COUNTED.has(type) && text && countChars(text) > limits.messageChars) {
    throw new ApiError(413, "message_too_long", `Messages can be up to ${limits.messageChars.toLocaleString("en-US")} characters on your plan`, { maxChars: limits.messageChars });
  }
  admitClock(m.sentAt);

  const retry = async () => {
    const prior = await ctx.messages.get(m.messageId);
    if (!prior) return null;
    if (prior.sender_user_id !== userId || prior.conversation_id !== conv.id) throw conflict("Message id collision");
    return { messageId: m.messageId, serverTs: prior.server_ts, duplicate: true };
  };
  const earlier = await retry();
  if (earlier) return earlier;

  // A change to a message: only to one in this conversation, and edits, deletions and closing a poll only by its sender.
  const target = typeof m.payload.target === "string" ? m.payload.target : null;
  if (m.cls === "control" && target && AUTHOR_ONLY.has(type)) {
    const t = await ctx.messages.get(target);
    if (!t || t.conversation_id !== conv.id) throw new ApiError(404, "not_found", "That message isn't in this conversation");
    if (t.sender_user_id !== userId) throw new ApiError(403, "not_yours", "Only the person who sent a message can change it");
  }
  if (m.cls === "message" && target) throw badRequest("A message can't target another one");

  const { request, quietFor, dropFor, mentionAll } = await admitPost(ctx, conv, userId, m.cls, m.mentionAll === true);
  const selfOnly = m.audience === "self";
  if (selfOnly && m.cls !== "control") throw badRequest("Only controls can be sent to your own devices alone");

  const t = now();
  const event: MessageEvent = {
    id: m.messageId,
    conversation_id: conv.id,
    sender_user_id: userId,
    sender_device_id: deviceId,
    cls: m.cls,
    type,
    target,
    audience: selfOnly ? "self" : "all",
    payload,
    sent_at: m.sentAt,
    server_ts: t,
    mention_all: mentionAll ? 1 : 0,
    imported_by: null,
  };
  // Who gets it: every active device of the current members (the sender's other devices too), except people who
  // blocked the sender and the recipient of a declined message request; a self-only control, the sender's own.
  const people = memberUsers<{ id: string; disabled_at: number | null; kind: string }>(ctx, conv.id, "id, disabled_at, kind")
    .map(({ user }) => user)
    .filter((u) => u.disabled_at == null && u.kind === "person" && (!selfOnly || u.id === userId));
  const blockedBy = new Set(ctx.identity.all<{ user_id: string }>("user_blocks", { where: { blocked_user_id: userId } }).map((r) => r.user_id));
  const devices = rowsByIds<{ id: string; user_id: string; revoked_at: number | null }>(
    ctx.identity,
    "devices",
    "user_id",
    people.map((u) => u.id),
    "id, user_id, revoked_at",
  ).filter((d) => d.revoked_at == null && d.id !== deviceId && !blockedBy.has(d.user_id) && !dropFor.has(d.user_id));
  const expiresAt = t + ctx.config.queueTtlSeconds * 1000;
  const wire = JSON.stringify({ v: 2, event: eventToWire(event) });
  const items: QueueInsert[] = devices.map((d) => ({
    recipient_device_id: d.id,
    kind: "message",
    conversation_id: conv.id,
    message_id: m.messageId,
    sender_user_id: userId,
    sender_device_id: relayDevice,
    payload: wire,
    created_at: t,
    expires_at: expiresAt,
  }));
  if (!(await ctx.messages.add(event))) {
    const dup = await retry();
    if (dup) return dup;
    throw conflict("Message id collision");
  }
  let queued;
  try {
    queued = await ctx.relay.accept(
      { message_id: m.messageId, sender_device_id: relayDevice, sender_user_id: userId, conversation_id: conv.id, recipient_count: items.length, server_ts: t, expires_at: expiresAt },
      items,
    );
  } catch (err) {
    // Stored already: a concurrent acceptance of the same id queued it.
    if (err instanceof DuplicateSubmission) return { messageId: m.messageId, serverTs: t, duplicate: true };
    throw err;
  }
  await recordPost(ctx, conv.id, userId, m.messageId, m.cls, mentionAll, t);
  const ownerOf = new Map(devices.map((d) => [d.id, d.user_id]));
  // Controls (reactions, read markers, call keys) don't wake a sleeping phone; messages do, unless it's a request's.
  for (const row of queued) ctx.hub.pushQueued(row.recipient_device_id, [row], { wake: m.cls === "message" && !quietFor.has(ownerOf.get(row.recipient_device_id) ?? "") });
  if (request?.state === "pending" && m.cls === "message") await ctx.relationships.countSent(conv.id);
  // API 0.65.0: chat minutes and the daily quests. Points never hold up or fail a message: a failure is only logged.
  if (!selfOnly) {
    await ctx.points
      .noteMessage({ userId, conversationId: conv.id, messageId: m.messageId, cls: m.cls, payload: m.payload, at: t })
      .catch((err) => log.warn({ err }, "points: message not counted"));
  }
  return { messageId: m.messageId, serverTs: t, duplicate: false };
}
