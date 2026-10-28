import { requireStanding } from "../accounts/index.js";
import type { FastifyInstance } from "fastify";
import { AckBody, Envelope, MAX_CIPHERTEXT_B64, QueueQuery } from "../../shared/contracts/http/messaging.js";
import { ciphertextCeilingB64 } from "../billing/index.js";
import { REQUEST_MESSAGE_LIMIT } from "../accounts/relationships/rules.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse, zB64, zKey, zSig } from "../../shared/validation/index.js";
import { canonical, verifyEd25519 } from "../../shared/utilities/crypto.js";
import { queueItemToWire } from "../realtime/hub.js";
import { DuplicateSubmission, type QueueInsert, type QueueItemRow } from "./relay/store.js";
import { ApiError, badRequest, conflict, forbidden } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { MENTION_ALL_MESSAGES, mentionAllPermission, mentionAllRateLimited } from "./mentions.js";
import { memberUsers } from "./memberUsers.js";
import { rowsByIds } from "../../infrastructure/database/byIds.js";

export default async function messageRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const { authz } = ctx;

  /**
   * Accept an end-to-end encrypted envelope and fan it out into per-device delivery queues.
   * The server verifies the sender's signature and the recipient device set, but cannot read
   * the content. Idempotent on (messageId, senderDevice).
   */
  app.post("/v1/messages", { ...auth, bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const { userId, deviceId } = me(req);
    const e = parse(Envelope, req.body);
    // API 0.46.0: a suspended account can't send (account standing); controls and receipts still flow.
    if (e.cls === "message") requireStanding(ctx.safety, userId, "send_message");
    const conv = authz.requireMember(e.conversationId, userId);
    if (!authz.canPost(conv, userId)) {
      const timedOut = conv.org_id ? authz.timeoutUntil(conv.org_id, userId) : null;
      if (timedOut) throw new ApiError(403, "timed_out", `You're timed out in this community until ${new Date(timedOut).toISOString()}`, { until: timedOut });
      throw forbidden(
        conv.archived_at ? "This channel is archived" : conv.kind === "ANNOUNCEMENT" ? "Only managers can post in announcement channels" : "You can't post in this channel",
      );
    }
    // Batch B14: a voice channel is for talking. Its calls' encrypted controls (keys) still pass; messages don't.
    if (conv.voice === 1 && e.cls === "message") throw new ApiError(403, "voice_channel", "Voice channels don't take messages");
    // Meldiq Mojo (docs/MOJO.md): messages and edits are end-to-end encrypted, so the apps count characters and the
    // server refuses ciphertext far larger than the sender's plan could need (1,000 / 2,000 / 5,000 characters).
    const limits = ctx.mojo.limitsOf(userId);
    if (limits && e.ciphertext.length > ciphertextCeilingB64(limits.messageChars, MAX_CIPHERTEXT_B64)) {
      throw new ApiError(413, "message_too_long", `Messages can be up to ${limits.messageChars.toLocaleString("en-US")} characters on your plan`, { maxChars: limits.messageChars });
    }
    // Clock sanity: sentAt is signed by the client; reject wildly wrong clocks (±1 day).
    if (Math.abs(e.sentAt - now()) > 24 * 3600_000) throw new ApiError(400, "bad_clock", "Device clock is too far off");

    const retry = async () => {
      const prior = await ctx.relay.submission(e.messageId);
      if (!prior) return null;
      if (prior.sender_device_id !== deviceId) throw conflict("Message id collision");
      return { messageId: e.messageId, serverTs: prior.server_ts, recipientCount: prior.recipient_count, duplicate: true };
    };
    const earlier = await retry();
    if (earlier) return earlier;

    const sender = ctx.identity.get<{ signing_key: string }>("devices", { id: deviceId })!;
    const signed = canonical.envelope({
      messageId: e.messageId,
      conversationId: e.conversationId,
      senderUserId: userId,
      senderDeviceId: deviceId,
      sentAt: e.sentAt,
      cls: e.cls,
      nonce: e.nonce,
      ciphertext: e.ciphertext,
    });
    if (!verifyEd25519(sender.signing_key, signed, e.signature)) {
      throw new ApiError(400, "bad_signature", "Envelope signature does not verify against the sending device");
    }

    // Slowmode (batch B3): one new message per interval in a channel, for people it applies to. Only messages count:
    // edits, reactions and votes are controls. A retry of an accepted message returned above as a duplicate.
    if (e.cls === "message") {
      const next = authz.nextPostAt(conv, userId, now());
      if (next !== null) {
        throw new ApiError(429, "slowmode", "Slowmode is on in this channel. Wait a moment before posting again.", {
          retryAfter: Math.ceil((next - now()) / 1000),
          nextPostAt: next,
        });
      }
    }

    // Batch B6: a message request. Until the recipient answers, the sender may send REQUEST_MESSAGE_LIMIT messages and
    // the recipient can't post; their devices get the messages without a push. Once declined, nothing reaches them.
    const request = conv.type === "DM" ? await ctx.relationships.request(conv.id) : null;
    if (request?.state === "pending" && request.recipient === userId) {
      throw new ApiError(403, "request_pending", "Accept the message request to reply");
    }
    if (request?.state === "pending" && request.sender === userId && e.cls === "message" && request.sent >= REQUEST_MESSAGE_LIMIT) {
      throw new ApiError(429, "request_limit", "You can send more once they accept your message request");
    }
    const quietFor = new Set<string>(request && request.sender === userId ? [request.recipient] : []);
    const dropFor = new Set<string>(request?.state === "declined" && request.sender === userId ? [request.recipient] : []);

    // @everyone: only for messages, only where the policy allows, at most mentionAllPerHour new ones an hour. A retry of
    // an accepted message returned above (duplicate) and is never counted twice.
    const mentionAll = e.mentionAll === true && e.cls === "message";
    if (mentionAll) {
      const refusal = mentionAllPermission(ctx, conv, userId) ?? (mentionAllRateLimited(ctx, conv.id, userId) ? "mention_all_rate_limited" : null);
      if (refusal) throw new ApiError(refusal === "mention_all_rate_limited" ? 429 : 403, refusal, MENTION_ALL_MESSAGES[refusal]);
    }

    // The recipient set must equal the active devices of current members (minus this device). An AI agent's reader
    // device in this conversation may be in it too, never must: each sender's client decides, by their own choice, whether
    // their messages reach it (docs/AI_WORKFORCE_2_PLAN.md phase 5). Agents' devices are never required.
    // A self-only control (audience "self") goes to the sender's own other devices and nobody else.
    const selfOnly = e.audience === "self";
    if (selfOnly && e.cls !== "control") throw badRequest("Only controls can be sent to your own devices alone");
    const people = new Map(
      memberUsers<{ id: string; home_server_id: string | null; disabled_at: number | null; kind: string }>(ctx, conv.id, "id, home_server_id, disabled_at, kind")
        .filter(({ user }) => user.disabled_at == null && user.kind === "person" && (!selfOnly || user.id === userId))
        .map(({ user }) => [user.id, user]),
    );
    const expected = rowsByIds<{ id: string; user_id: string; revoked_at: number | null }>(ctx.identity, "devices", "user_id", people.keys(), "id, user_id, revoked_at")
      .filter((d) => d.revoked_at == null && d.id !== deviceId)
      .map((d) => ({ id: d.id, user_id: d.user_id, home_server_id: people.get(d.user_id)!.home_server_id }));
    const expectedIds = new Map(expected.map((d) => [d.id, d.user_id]));
    const provided = new Set(e.recipients.map((r) => r.deviceId));
    const missing = expected.filter((d) => !provided.has(d.id)).map((d) => ({ deviceId: d.id, userId: d.user_id }));
    const extra = [...provided].filter((id) => !expectedIds.has(id));
    if (missing.length || extra.length || provided.size !== e.recipients.length) {
      throw new ApiError(409, "device_mismatch", "Recipient devices changed; refresh keys and retry", { missing, extra });
    }

    const t = now();
    const expiresAt = t + ctx.config.queueTtlSeconds * 1000;
    // Devices of people on other servers go to the federation outbox (same ciphertext, same per-device key wrap).
    const homeOf = new Map(expected.map((d) => [d.id, d.home_server_id]));
    const ownerOf = new Map(expected.map((d) => [d.id, d.user_id]));
    if ([...homeOf.values()].some((h) => h) && !ctx.federation) throw new ApiError(503, "federation_disabled", "This server no longer federates");
    // People who blocked the sender don't get the message (the sender isn't told).
    const blockedBy = new Set(ctx.identity.all<{ user_id: string }>("user_blocks", { where: { blocked_user_id: userId } }).map((r) => r.user_id));
    const items: QueueInsert[] = [];
    const remote: { home: string; deviceId: string; payload: string }[] = [];
    for (const r of e.recipients) {
      if (blockedBy.has(ownerOf.get(r.deviceId) ?? "")) continue;
      if (dropFor.has(ownerOf.get(r.deviceId) ?? "")) continue;
      const payload = JSON.stringify({
        v: 1,
        cls: e.cls,
        sentAt: e.sentAt,
        serverTs: t,
        nonce: e.nonce,
        ciphertext: e.ciphertext,
        signature: e.signature,
        enc: r.enc,
        wrappedKey: r.wrappedKey,
        // Server-attested @everyone: omitted otherwise, so ordinary messages keep their exact queue payload.
        ...(mentionAll ? { mentionAll: true } : {}),
      });
      const home = homeOf.get(r.deviceId);
      if (home) remote.push({ home, deviceId: r.deviceId, payload });
      else {
        items.push({
          recipient_device_id: r.deviceId,
          kind: "envelope",
          conversation_id: conv.id,
          message_id: e.messageId,
          sender_user_id: userId,
          sender_device_id: deviceId,
          payload,
          created_at: t,
          expires_at: expiresAt,
        });
      }
    }
    // A full outbox to another server refuses the message before anything is accepted (the relay may not be SQLite,
    // so the outbox can't be relied on to roll the acceptance back).
    for (const home of new Set(remote.map((r) => r.home))) ctx.federation!.assertRoom(home);
    const submission = {
      message_id: e.messageId,
      sender_device_id: deviceId,
      sender_user_id: userId,
      conversation_id: conv.id,
      recipient_count: e.recipients.length,
      server_ts: t,
      expires_at: expiresAt,
    };
    let inserted: QueueItemRow[];
    try {
      inserted = await ctx.relay.accept(submission, items);
    } catch (err) {
      // The same id accepted by a concurrent request: answer as the retry it is.
      if (err instanceof DuplicateSubmission) {
        const dup = await retry();
        if (dup) return dup;
      }
      throw err;
    }
    // Devices of people on other servers go to the federation outbox (same ciphertext, same per-device key wrap), once
    // the message is accepted. The message is accepted and queued here either way; a retry answers as a duplicate, so
    // an outbox that fails now is logged rather than failing the send.
    for (const r of remote) {
      await ctx
        .federation!.routeRemote(r.home, {
          key: `env:${e.messageId}:${deviceId}:${r.deviceId}`,
          kind: "envelope",
          conversationId: conv.id,
          messageId: e.messageId,
          senderUserId: userId,
          senderDeviceId: deviceId,
          recipientDeviceId: r.deviceId,
          payload: r.payload,
          createdAt: t,
          expiresAt,
        })
        .catch((err) => ctx.log.error({ err, messageId: e.messageId }, "federation outbox: an accepted message wasn't queued for its server"));
    }
    // What the message changes about its conversation, once it's accepted (the conversation may not be in SQLite).
    if (mentionAll || e.cls === "message") {
      await ctx.ws.write((w) => {
        if (mentionAll) w.insert("mention_all_events", { conversation_id: conv.id, user_id: userId, message_id: e.messageId, at: t });
        if (e.cls !== "message") return;
        w.update("conversations", { id: conv.id }, { updated_at: t });
        w.update("conversation_members", { conversation_id: conv.id, user_id: userId }, { last_post_at: t });
      });
    }
    for (const row of inserted) ctx.hub.pushQueued(row.recipient_device_id, [row], { wake: !quietFor.has(ownerOf.get(row.recipient_device_id) ?? "") });
    if (request?.state === "pending" && e.cls === "message") await ctx.relationships.countSent(conv.id);
    return { messageId: e.messageId, serverTs: t, recipientCount: e.recipients.length, duplicate: false };
  });

  // REST fallback for the WebSocket queue (used after reconnect if the socket is unavailable).
  app.get("/v1/queue", auth, async (req) => {
    const { deviceId } = me(req);
    const { limit } = parse(QueueQuery, req.query);
    const rows = await ctx.relay.backlog(deviceId, now(), limit + 1);
    return { items: rows.slice(0, limit).map(queueItemToWire), more: rows.length > limit };
  });

  app.post("/v1/queue/ack", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const { ids } = parse(AckBody, req.body);
    let removed = 0;
    // In the device's work queue, like acknowledgements over its sockets (src/modules/realtime/hub.ts › onDevice).
    await ctx.hub.onDevice(deviceId, async () => {
      removed = await acknowledge(ctx, userId, deviceId, ids);
    });
    return { removed };
  });
}

/**
 * Delete acknowledged queue items (only the caller's own) and emit "delivered" receipts to the
 * sender's devices for DM/group messages. Receipts are routing metadata, not content.
 */
export async function acknowledge(ctx: AppContext, userId: string, deviceId: string, ids: number[]): Promise<number> {
  const t = now();
  const taken = await ctx.relay.take(deviceId, ids);
  const receipts: QueueInsert[] = [];

  const senderDevices = (senderId: string) => {
    const home = ctx.identity.get<{ home_server_id: string | null }>("users", { id: senderId })?.home_server_id ?? null;
    return ctx.identity.all<{ id: string }>("devices", { where: { user_id: senderId, revoked_at: null } }).map((d) => ({ id: d.id, home_server_id: home }));
  };
  for (const row of taken) {
    if (row.kind !== "envelope" || row.sender_user_id === userId) continue;
    const cls = (JSON.parse(row.payload) as { cls?: string }).cls;
    if (cls !== "message") continue;
    const type = ctx.ws.get<{ type: string }>("conversations", { id: row.conversation_id })?.type;
    if (type !== "DM" && type !== "GROUP") continue;
    const payload = JSON.stringify({ status: "delivered", at: t });
    const expiresAt = t + ctx.config.queueTtlSeconds * 1000;
    for (const d of senderDevices(row.sender_user_id)) {
      if (d.home_server_id) {
        // The sender is on another server: the receipt travels back through federation (best effort: a full
        // outbox drops the receipt rather than failing this acknowledgement).
        try {
          await ctx.federation?.routeRemote(d.home_server_id, {
            key: `rcpt:${row.message_id}:${deviceId}:${d.id}`,
            kind: "receipt",
            conversationId: row.conversation_id,
            messageId: row.message_id,
            senderUserId: userId,
            senderDeviceId: deviceId,
            recipientDeviceId: d.id,
            payload,
            createdAt: t,
            expiresAt,
          });
        } catch {
          /* receipt dropped */
        }
        continue;
      }
      receipts.push({
        recipient_device_id: d.id,
        kind: "receipt",
        conversation_id: row.conversation_id,
        message_id: row.message_id,
        sender_user_id: userId,
        sender_device_id: deviceId,
        payload,
        created_at: t,
        expires_at: expiresAt,
      });
    }
  }
  for (const r of await ctx.relay.enqueue(receipts)) ctx.hub.pushQueued(r.recipient_device_id, [r]);
  return taken.length;
}
