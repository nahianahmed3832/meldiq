import { requireStanding } from "../accounts/index.js";
import { REQUEST_MESSAGE_LIMIT } from "../accounts/relationships/rules.js";
import type { AppContext } from "../../app/context.js";
import { ApiError, forbidden } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { MENTION_ALL_MESSAGES, mentionAllPermission, mentionAllRateLimited } from "./mentions.js";

type Cls = "message" | "control";

/**
 * Who may send in a conversation (shared by POST /v1/messages and POST /v2/messages): the account's standing,
 * membership, posting rights and timeouts, and voice channels. Returns the conversation.
 */
export function admitConversation(ctx: AppContext, userId: string, conversationId: string, cls: Cls) {
  // API 0.46.0: a suspended account can't send (account standing); controls and receipts still flow.
  if (cls === "message") requireStanding(ctx.safety, userId, "send_message");
  const { authz } = ctx;
  const conv = authz.requireMember(conversationId, userId);
  if (!authz.canPost(conv, userId)) {
    const timedOut = conv.org_id ? authz.timeoutUntil(conv.org_id, userId) : null;
    if (timedOut) throw new ApiError(403, "timed_out", `You're timed out in this community until ${new Date(timedOut).toISOString()}`, { until: timedOut });
    throw forbidden(conv.archived_at ? "This channel is archived" : conv.kind === "ANNOUNCEMENT" ? "Only managers can post in announcement channels" : "You can't post in this channel");
  }
  // Batch B14: a voice channel is for talking. Its calls' controls (keys) still pass; messages don't.
  if (conv.voice === 1 && cls === "message") throw new ApiError(403, "voice_channel", "Voice channels don't take messages");
  return conv;
}

/** Clock sanity: sentAt comes from the client; wildly wrong clocks (±1 day) are refused. */
export function admitClock(sentAt: number): void {
  if (Math.abs(sentAt - now()) > 24 * 3600_000) throw new ApiError(400, "bad_clock", "Device clock is too far off");
}

export interface PostAdmission {
  /** The pending message request in a DM, if any. */
  request: Awaited<ReturnType<AppContext["relationships"]["request"]>> | null;
  /** People whose devices get it without a push (the recipient of a pending request). */
  quietFor: Set<string>;
  /** People who get nothing (the recipient who declined the request). */
  dropFor: Set<string>;
  /** @everyone, checked against the policy and the rate. */
  mentionAll: boolean;
}

/**
 * What applies to a new submission once it isn't a retry: slowmode, message requests and @everyone. A retry of an
 * accepted message is answered as a duplicate before this, so it never counts twice.
 */
export async function admitPost(ctx: AppContext, conv: ReturnType<typeof admitConversation>, userId: string, cls: Cls, mentionAllAsked: boolean): Promise<PostAdmission> {
  // Slowmode (batch B3): one new message per interval in a channel, for people it applies to. Only messages count.
  if (cls === "message") {
    const next = ctx.authz.nextPostAt(conv, userId, now());
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
  if (request?.state === "pending" && request.recipient === userId) throw new ApiError(403, "request_pending", "Accept the message request to reply");
  if (request?.state === "pending" && request.sender === userId && cls === "message" && request.sent >= REQUEST_MESSAGE_LIMIT) {
    throw new ApiError(429, "request_limit", "You can send more once they accept your message request");
  }
  const quietFor = new Set<string>(request && request.sender === userId ? [request.recipient] : []);
  const dropFor = new Set<string>(request?.state === "declined" && request.sender === userId ? [request.recipient] : []);
  // @everyone: only for messages, only where the policy allows, at most mentionAllPerHour new ones an hour.
  const mentionAll = mentionAllAsked && cls === "message";
  if (mentionAll) {
    const refusal = mentionAllPermission(ctx, conv, userId) ?? (mentionAllRateLimited(ctx, conv.id, userId) ? "mention_all_rate_limited" : null);
    if (refusal) throw new ApiError(refusal === "mention_all_rate_limited" ? 429 : 403, refusal, MENTION_ALL_MESSAGES[refusal]);
  }
  return { request, quietFor, dropFor, mentionAll };
}

/** What an accepted message changes about its conversation: its activity time, the sender's last post, @everyone. */
export async function recordPost(ctx: AppContext, conversationId: string, userId: string, messageId: string, cls: Cls, mentionAll: boolean, at: number): Promise<void> {
  if (!mentionAll && cls !== "message") return;
  await ctx.ws.write((w) => {
    if (mentionAll) w.insert("mention_all_events", { conversation_id: conversationId, user_id: userId, message_id: messageId, at });
    if (cls !== "message") return;
    w.update("conversations", { id: conversationId }, { updated_at: at });
    w.update("conversation_members", { conversation_id: conversationId, user_id: userId }, { last_post_at: at });
  });
}
