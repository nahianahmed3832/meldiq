import { requireStanding } from "../accounts/index.js";
import { REQUEST_MESSAGE_LIMIT } from "../accounts/relationships/rules.js";
import type { AppContext } from "../../app/context.js";
import { ApiError, badRequest, forbidden, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { MENTION_ALL_MESSAGES, mentionAllPermission, mentionAllRateLimited } from "./mentions.js";

type Cls = "message" | "control";

/** Changes that react to a message rather than say something (API 0.65.0): anyone who reads the rules channel may. */
const REACTING = new Set(["reaction", "vote", "read"]);
/** What members who haven't agreed to their community's rules can't send yet (API 0.65.0): messages and these changes. */
const NEEDS_AGREEMENT = new Set(["edit", "reaction", "vote", "pin"]);

/** The sender as posting rules need it: the payload's type when the server can read it, and whether it's a bot. */
export interface AdmitOptions {
  type?: string;
  bot?: boolean;
}

/**
 * Who may send in a conversation (shared by POST /v1/messages and POST /v2/messages): the account's standing,
 * membership, posting rights and timeouts, the community's rules, and voice channels. Returns the conversation.
 */
export function admitConversation(ctx: AppContext, userId: string, conversationId: string, cls: Cls, opts: AdmitOptions = {}) {
  // API 0.46.0: a suspended account can't send (account standing); controls and receipts still flow.
  if (cls === "message") requireStanding(ctx.safety, userId, "send_message");
  const { authz } = ctx;
  const conv = authz.requireMember(conversationId, userId);
  const reacting = cls === "control" && !!opts.type && REACTING.has(opts.type);
  if (!(reacting ? authz.canReact(conv, userId) : authz.canPost(conv, userId))) {
    const timedOut = conv.org_id ? authz.timeoutUntil(conv.org_id, userId) : null;
    if (timedOut) throw new ApiError(403, "timed_out", `You're timed out in this community until ${new Date(timedOut).toISOString()}`, { until: timedOut });
    if (!conv.archived_at && authz.isRulesChannel(conv)) throw new ApiError(403, "rules_channel", "Only people who can edit the community post in its rules channel. You can still read and react.");
    // Community parity A1: a read-only channel (only its poster roles and moderators post).
    if (!conv.archived_at && authz.readOnlyFor(conv, userId)) throw new ApiError(403, "read_only_channel", "This channel is read-only. You can still read and react.");
    throw forbidden(conv.archived_at ? "This channel is archived" : conv.kind === "ANNOUNCEMENT" ? "Only managers can post in announcement channels" : "You can't post in this channel");
  }
  // API 0.65.0: a community that asks members to agree to its rules first (bots are added by people who can edit it).
  const needsAgreement = cls === "message" || (!!opts.type && NEEDS_AGREEMENT.has(opts.type));
  // Community parity A3: new members of a community that asks them to finish onboarding first (its flow ends with
  // the rules, so this comes before them).
  if (needsAgreement && !opts.bot && conv.org_id && authz.mustFinishOnboarding(conv.org_id, userId)) {
    throw new ApiError(403, "onboarding_not_finished", "Finish this community's onboarding before you post or react", { orgId: conv.org_id });
  }
  if (needsAgreement && !opts.bot && conv.org_id && authz.mustAgreeRules(conv.org_id, userId)) {
    throw new ApiError(403, "rules_not_agreed", "Agree to this community's rules before you post or react", { orgId: conv.org_id });
  }
  // Batch B14: a voice channel is for talking. Its calls' controls (keys) still pass; messages don't.
  if (conv.voice === 1 && cls === "message") throw new ApiError(403, "voice_channel", "Voice channels don't take messages");
  return conv;
}

/** Community parity A2: changes that say something (held back while a community is locked) and reactions. */
const POSTING = new Set(["edit", "pin"]);
const REACTIONS = new Set(["reaction", "vote"]);

/**
 * A community's lock and verification level (community parity A2, docs/COMMUNITY_SAFETY_API.md): messages, edits and
 * pins wait for both, reactions and votes for the verification level only; read markers and anything the server can't
 * read (an encrypted change) pass. Call after [admitConversation].
 */
export async function admitCommunity(ctx: AppContext, conv: ReturnType<typeof admitConversation>, userId: string, cls: Cls, opts: AdmitOptions = {}): Promise<void> {
  const kind = cls === "message" || (!!opts.type && POSTING.has(opts.type)) ? "post" : !!opts.type && REACTIONS.has(opts.type) ? "react" : null;
  if (kind) await ctx.communitySafety.admitPost(conv, userId, kind, !!opts.bot);
}

/** Payload fields only posting tools write (community parity batch C): what people's apps send never carries them. */
const POSTING_TOOL_FIELDS = ["embeds", "buttons", "webhook"] as const;

/** Refuses a payload from a person or a bot that carries embeds, buttons or webhook details. */
export function refusePostingTools(payload: Record<string, unknown>): void {
  const field = POSTING_TOOL_FIELDS.find((f) => payload[f] !== undefined);
  if (field) throw badRequest(`Only webhooks and the community's own posts can carry "${field}"`);
}

/**
 * A webhook's or the Tickets account's message (community parity batch C): the sender isn't a member, so only the
 * channel it was granted is checked. It must be a live community channel that takes messages; changes (edits,
 * reactions) never come this way.
 */
export function admitGranted(ctx: AppContext, conversationId: string, grant: string, cls: Cls) {
  const conv = ctx.authz.conversation(conversationId);
  if (!conv || conv.id !== grant || conv.type !== "CHANNEL" || !conv.org_id) throw notFound("Conversation not found");
  if (cls !== "message") throw badRequest("Webhooks only post messages");
  if (conv.archived_at) throw forbidden("This channel is archived");
  if (conv.voice === 1) throw new ApiError(403, "voice_channel", "Voice channels don't take messages");
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
  // Community parity A2: raid protection counts messages per channel.
  if (cls === "message") ctx.communitySafety.noteMessage(conversationId, userId);
  await ctx.ws.write((w) => {
    if (mentionAll) w.insert("mention_all_events", { conversation_id: conversationId, user_id: userId, message_id: messageId, at });
    if (cls !== "message") return;
    w.update("conversations", { id: conversationId }, { updated_at: at });
    w.update("conversation_members", { conversation_id: conversationId, user_id: userId }, { last_post_at: at });
  });
}
