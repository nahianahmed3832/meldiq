import {
  prepareManagedPoll,
  reserveManagedPoll,
  validateLegacyPollControl,
  settlePollDeletion,
} from "./managedPolls.js";
import {
  admitThreadReply,
  verifyThreadDeletionGrant,
  withThreadLock,
  settleThreadRootDeletion,
} from "./threadManagement.js";
import { threadRootOf } from "./store/messageStore.js";
import { admitForumMetadata } from "./forumPolicy.js";
import {
  messageAttachments,
  retainMessageAttachments,
} from "../files/index.js";
import type { FastifyBaseLogger } from "fastify";
import {
  MAX_PAYLOAD_BYTES,
  type SendMessage,
  type StoredEvent,
} from "../../shared/contracts/http/serverMessages.js";
import type { AppContext } from "../../app/context.js";
import { ApiError, badRequest, conflict } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { rowsByIds } from "../../infrastructure/database/byIds.js";
import { ExistingEvent } from "../../infrastructure/database/rows/postgresRows.js";
import { PostgresRelayStore } from "./relay/postgresStore.js";
import { botRichText } from "../../shared/contracts/http/botComponents.js";
import { DuplicateSubmission, type QueueInsert } from "./relay/store.js";
import type { MessageEvent } from "./store/messageStore.js";
import { memberUsers } from "./memberUsers.js";
import { admitChannelContent, moderatesMessage } from "./contentRules.js";
import {
  admitClock,
  admitCommunity,
  admitConversation,
  admitGranted,
  admitPost,
  recordPost,
  refusePostingTools,
} from "./sendRules.js";

/** Changes only a message's own sender may make. */
const AUTHOR_ONLY = new Set(["edit", "delete", "poll_close"]);
/** Payload types whose text counts against the sender's plan (docs/MOJO.md): a message and an edit of one. */
const COUNTED = new Set(["text", "edit"]);

/** Characters as people count them (grapheme clusters: an emoji with its skin tone or a flag is one), as the apps do. */
export function countChars(text: string): number {
  let n = 0;
  for (const _ of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(text))
    n++;
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
  /** Internal Bot API approval; native membership, channel and content rules still apply. Never read from a body. */
  botContent?: true;
  /** Internal synchronous recheck run inside the native PostgreSQL writer's acceptance unit. */
  beforeCommit?: () => void;
  /**
   * Posting tools (community parity batch C): a webhook or a community's "Tickets" account, which is a member nowhere.
   * The caller has checked that it may post in this one channel (a webhook's token, a manager's request), so
   * membership, posting rights and slowmode don't apply; an archived or voice channel still refuses. Only such senders
   * may put embeds, buttons and webhook details in a payload.
   */
  channelGrant?: string;
  /** Internal, scoped cleanup only; never read from request bodies. */
  threadGrant?: string;
}

/**
 * Sends a message or a change through the server (POST /v2/messages, docs/SERVER_MESSAGES.md): every rule people's
 * messages follow (standing, membership, posting rights, slowmode, requests, @everyone, the plan's characters, who may
 * change a message), then stored and queued to every member's devices. Bots send through here too (modules/bots), so
 * their messages are ordinary messages; a bot has no device, so the stored event names none and the relay records
 * "bot-<userId>" as the sending device.
 */
export async function sendServerMessage(
  ctx: AppContext,
  sender: Sender,
  m: SendMessage,
  log: FastifyBaseLogger,
): Promise<{ messageId: string; serverTs: number; duplicate: boolean }> {
  const { userId, deviceId } = sender;
  const relayDevice = deviceId ?? `bot-${userId}`;
  const inputPayload = JSON.stringify(m.payload);
  if (Buffer.byteLength(inputPayload) > MAX_PAYLOAD_BYTES)
    throw new ApiError(413, "message_too_long", "That message is too large");
  const managedPoll = prepareManagedPoll(m);
  const payload = JSON.stringify(m.payload);
  const granted = sender.channelGrant !== undefined;
  if (!granted) refusePostingTools(m.payload, sender.botContent === true);
  const deletion = sender.threadGrant
    ? m.cls === "control" &&
      m.payload.type === "delete" &&
      typeof m.payload.target === "string"
      ? await verifyThreadDeletionGrant(
          ctx,
          m.conversationId,
          sender.threadGrant,
          m.payload.target,
          userId,
        )
      : (() => {
          throw badRequest("A thread grant only deletes its own messages");
        })()
    : null;
  const conv =
    deletion ??
    (granted
      ? admitGranted(
          ctx,
          m.conversationId,
          sender.channelGrant!,
          m.cls,
          m.payload.type,
        )
      : admitConversation(ctx, userId, m.conversationId, m.cls, {
          type: m.payload.type,
          bot: deviceId === null,
        }));
  // A webhook isn't a member: the community's lock and verification level are for people (community parity A2).
  if (!granted && !deletion)
    await admitCommunity(ctx, conv, userId, m.cls, {
      type: m.payload.type,
      bot: deviceId === null,
    });
  const type = m.payload.type;
  // Meldiq Mojo: the plan's characters per message and per edit, counted as people count them (posting tools set
  // their own limits).
  const limits = granted ? null : ctx.mojo.limitsOf(userId);
  const text = sender.botContent ? botRichText(m.payload) : typeof m.payload.text === "string" ? m.payload.text : "";
  if (
    limits &&
    COUNTED.has(type) &&
    text &&
    countChars(text) > limits.messageChars
  ) {
    throw new ApiError(
      413,
      "message_too_long",
      `Messages can be up to ${limits.messageChars.toLocaleString("en-US")} characters on your plan`,
      { maxChars: limits.messageChars },
    );
  }
  admitClock(m.sentAt);

  const retry = async () => {
    const prior = await ctx.messages.get(m.messageId);
    if (!prior) return null;
    if (prior.sender_user_id !== userId || prior.conversation_id !== conv.id)
      throw conflict("Message id collision");
    const priorFiles = (
      JSON.parse(prior.payload) as {
        attachments?: { id: string; thumbnail?: { id: string } }[];
      }
    ).attachments;
    if (Array.isArray(priorFiles)) {
      const ids = priorFiles.flatMap((ref) =>
        ref.thumbnail ? [ref.id, ref.thumbnail.id] : [ref.id],
      );
      await retainMessageAttachments(ctx, ids, m.messageId).catch((err) =>
        log.warn({ err }, "attachment publication retry failed"),
      );
    }
    const accepted: SendMessage = {
      ...m,
      cls: prior.cls,
      audience: prior.audience === "self" ? "self" : undefined,
      payload: JSON.parse(prior.payload) as SendMessage["payload"],
    };
    await settlePollDeletion(ctx, accepted);
    await settleThreadRootDeletion(ctx, accepted);
    return {
      messageId: m.messageId,
      serverTs: prior.server_ts,
      duplicate: true,
    };
  };
  const atomicRelay =
    ctx.postgres?.database.config.deliveryMode === "legacy" &&
    ctx.relay instanceof PostgresRelayStore
      ? ctx.relay
      : null;
  if (!atomicRelay || (await atomicRelay.submission(m.messageId))) {
    const earlier = await retry();
    if (earlier) return earlier;
  }
  let committed = false;
  const controlTarget =
    m.cls === "control" &&
    ["edit", "vote"].includes(type) &&
    typeof m.payload.target === "string"
      ? await ctx.messages.get(m.payload.target)
      : null;
  const lifecycleRoot =
    m.cls === "message" && typeof m.payload.threadRoot === "string"
      ? m.payload.threadRoot
      : controlTarget
        ? threadRootOf(controlTarget)
        : null;
  const submit = async () => {
    if (lifecycleRoot) await admitThreadReply(ctx, conv, userId, lifecycleRoot);
    if (m.cls === "message")
      await admitForumMetadata(ctx, conv, userId, m.payload);

    const attachmentIds =
      m.cls === "message" || type === "edit"
        ? await messageAttachments(
            ctx,
            userId,
            conv.id,
            conv.org_id,
            m.payload.attachments,
          )
        : [];

    // A change to a message: only to one in this conversation, and edits, deletions and closing a poll only by its sender.
    // Community parity A1: a channel's moderators also delete other people's messages.
    const target =
      typeof m.payload.target === "string" ? m.payload.target : null;
    if (
      m.cls === "control" &&
      target &&
      ["edit", "vote", "poll_close"].includes(type) &&
      ctx.ws.get("managed_polls", {
        message_id: target,
        conversation_id: conv.id,
      })
    )
      throw badRequest("Use the managed poll controls in a current app");
    if (m.cls === "control" && target && AUTHOR_ONLY.has(type)) {
      const t = controlTarget ?? (await ctx.messages.get(target));
      if (!t || t.conversation_id !== conv.id)
        throw new ApiError(
          404,
          "not_found",
          "That message isn't in this conversation",
        );
      if (
        t.sender_user_id !== userId &&
        !(
          type === "delete" &&
          (deletion || moderatesMessage(ctx, conv, userId, t))
        )
      ) {
        throw new ApiError(
          403,
          "not_yours",
          "Only the person who sent a message can change it",
        );
      }
      if (type === "edit")
        await admitForumMetadata(ctx, conv, userId, m.payload, t);
    }
    await validateLegacyPollControl(ctx, m, userId);
    if (m.cls === "message" && target)
      throw badRequest("A message can't target another one");
    // Community parity A1: what a message may carry in this channel (links, polls, threads, new reactions, pins...). A
    // webhook's post was checked by the webhook's own limits instead.
    if (!granted && !deletion) await admitChannelContent(ctx, conv, userId, m);

    const { request, quietFor, dropFor, mentionAll } = deletion
      ? {
          request: null,
          quietFor: new Set<string>(),
          dropFor: new Set<string>(),
          mentionAll: false,
        }
      : await admitPost(ctx, conv, userId, m.cls, m.mentionAll === true);
    if (m.cls === "message" && lifecycleRoot) {
      const mentions = Array.isArray(m.payload.mentions)
        ? m.payload.mentions
        : [];
      for (const pref of ctx.ws.all<{ user_id: string }>("thread_preferences", {
        where: { root_id: lifecycleRoot, following: 0 },
      })) {
        if (!mentions.includes(pref.user_id)) quietFor.add(pref.user_id);
      }
    }
    const selfOnly = m.audience === "self";
    if (selfOnly && m.cls !== "control")
      throw badRequest("Only controls can be sent to your own devices alone");

    if (managedPoll) await reserveManagedPoll(ctx, m, userId, managedPoll);
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
    const people = memberUsers<{
      id: string;
      disabled_at: number | null;
      kind: string;
    }>(ctx, conv.id, "id, disabled_at, kind")
      .map(({ user }) => user)
      .filter(
        (u) =>
          u.disabled_at == null &&
          u.kind === "person" &&
          (!selfOnly || u.id === userId),
      );
    const blockedBy = new Set(
      ctx.identity
        .all<{ user_id: string }>("user_blocks", {
          where: { blocked_user_id: userId },
        })
        .map((r) => r.user_id),
    );
    const devices = rowsByIds<{
      id: string;
      user_id: string;
      revoked_at: number | null;
    }>(
      ctx.identity,
      "devices",
      "user_id",
      people.map((u) => u.id),
      "id, user_id, revoked_at",
    ).filter(
      (d) =>
        d.revoked_at == null &&
        d.id !== deviceId &&
        !blockedBy.has(d.user_id) &&
        !dropFor.has(d.user_id),
    );
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
    let queued;
    const submission = {
      message_id: m.messageId,
      sender_device_id: relayDevice,
      sender_user_id: userId,
      conversation_id: conv.id,
      recipient_count: items.length,
      server_ts: t,
      expires_at: expiresAt,
    };
    if (atomicRelay) {
      queued = await atomicRelay.acceptEvent(event, submission, items, sender.beforeCommit);
    } else {
      sender.beforeCommit?.();
      if (!(await ctx.messages.add(event))) {
        const dup = await retry();
        if (dup) return dup;
        throw conflict("Message id collision");
      }
      try {
        queued = await ctx.relay.accept(submission, items);
      } catch (err) {
        // Stored already: a concurrent acceptance of the same id queued it.
        if (err instanceof DuplicateSubmission)
          return { messageId: m.messageId, serverTs: t, duplicate: true };
        throw err;
      }
    }
    committed = true;
    await recordPost(ctx, conv.id, userId, m.messageId, m.cls, mentionAll, t);
    const ownerOf = new Map(devices.map((d) => [d.id, d.user_id]));
    // Controls (reactions, read markers, call keys) don't wake a sleeping phone; messages do, unless it's a request's.
    for (const row of queued)
      ctx.hub.pushQueued(row.recipient_device_id, [row], {
        wake:
          m.cls === "message" &&
          !quietFor.has(ownerOf.get(row.recipient_device_id) ?? ""),
      });
    if (request?.state === "pending" && m.cls === "message")
      await ctx.relationships.countSent(conv.id);
    await retainMessageAttachments(ctx, attachmentIds, m.messageId).catch(
      (err) =>
        log.warn(
          { err },
          "attachment retention will be retried by history keep",
        ),
    );
    // Posting tools: a reaction may give or take a reaction role, a deleted message takes its reaction roles with it.
    // Like points, this never fails a message that was accepted.
    if (m.cls === "control" && conv.org_id) {
      await ctx.reactionRoles
        .noteChange({
          orgId: conv.org_id,
          conversationId: conv.id,
          userId,
          payload: m.payload,
        })
        .catch((err: unknown) =>
          log.warn({ err }, "reaction roles: change not applied"),
        );
    }
    // Community parity batch D: official bots see what happens in community channels (commands, XP, logs, stars). This
    // only queues it: the bots act after the message was accepted and can never fail it.
    if (conv.org_id && !selfOnly)
      ctx.officialBots.noteMessage({
        orgId: conv.org_id,
        conversationId: conv.id,
        userId,
        messageId: m.messageId,
        cls: m.cls,
        payload: m.payload,
        at: t,
      });
    // API 0.65.0: chat minutes and the daily quests. Points never hold up or fail a message: a failure is only logged.
    if (!selfOnly) {
      await ctx.points
        .noteMessage({
          userId,
          conversationId: conv.id,
          messageId: m.messageId,
          cls: m.cls,
          payload: m.payload,
          at: t,
        })
        .catch((err) => log.warn({ err }, "points: message not counted"));
    }
    await settlePollDeletion(ctx, m);
    await settleThreadRootDeletion(ctx, m);
    return { messageId: m.messageId, serverTs: t, duplicate: false };
  };
  try {
    return lifecycleRoot
      ? await withThreadLock(ctx, lifecycleRoot, submit)
      : await submit();
  } catch (err) {
    if ((err as { code?: string })?.code === "PBDM1")
      throw new ApiError(403, "forbidden", "Direct messages with this bot are not enabled");
    if (
      atomicRelay &&
      !committed &&
      (err instanceof ApiError ||
        err instanceof ExistingEvent ||
        err instanceof DuplicateSubmission)
    ) {
      // Older/imported events may no longer have a relay marker. Preserve the original retry result
      // even when a current posting rule would refuse the same request.
      const duplicate = await retry();
      if (duplicate) return duplicate;
      if (err instanceof ExistingEvent || err instanceof DuplicateSubmission)
        throw conflict("Message id collision");
    }
    throw err;
  }
}
