import type { ConversationRow } from "../organizations/authz.js";
import type { AppContext } from "../../app/context.js";
import { now } from "../../shared/utilities/util.js";

/** Why a sender may not notify everyone in a conversation, or null when they may (docs/MENTIONS.md). */
export type MentionAllRefusal = "mention_all_not_in_dm" | "mention_all_not_allowed" | "mention_all_rate_limited";

export const MENTION_ALL_MESSAGES: Record<MentionAllRefusal, string> = {
  mention_all_not_in_dm: "@everyone isn't available in direct messages.",
  mention_all_not_allowed: "Only admins and managers can mention everyone in this conversation.",
  mention_all_rate_limited: "You've mentioned everyone here too often in the last hour. Try again later, or send it without @everyone.",
};

/**
 * Whether [userId] may notify everyone in [conv] (ignoring the hourly limit). Group admins and channel managers always
 * may; other members only where the conversation has at most `mentionAllMemberLimit` members, so nobody can ping a
 * large group or channel. Also used for the conversation view's `canMentionAll`, so the app offers @everyone only
 * where the server will accept it.
 */
export function mentionAllPermission(ctx: AppContext, conv: ConversationRow, userId: string): MentionAllRefusal | null {
  if (conv.type === "DM") return "mention_all_not_in_dm";
  if (!ctx.authz.canPost(conv, userId)) return "mention_all_not_allowed";
  if (ctx.authz.canManageConversation(conv, userId)) return null;
  const members = ctx.ws.count("conversation_members", { conversation_id: conv.id });
  return members <= ctx.config.mentionAllMemberLimit ? null : "mention_all_not_allowed";
}

/** The hourly limit, for a new (not retried) @everyone message. */
export function mentionAllRateLimited(ctx: AppContext, convId: string, userId: string, t = now()): boolean {
  const recent = ctx.ws.count("mention_all_events", { conversation_id: convId, user_id: userId, at: { gt: t - 3600_000 } });
  return recent >= ctx.config.mentionAllPerHour;
}

/**
 * A queue payload received from another server, without the `mentionAll` attestation: only this server attests
 * @everyone for its own conversations (federated conversations are direct messages, where it never applies).
 */
export function withoutMentionAll(payloadJson: string): string {
  const p = JSON.parse(payloadJson) as Record<string, unknown>;
  if (!("mentionAll" in p)) return payloadJson;
  delete p.mentionAll;
  return JSON.stringify(p);
}
