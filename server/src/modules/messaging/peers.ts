import type { AppContext } from "../../app/context.js";
import { memberIds } from "./memberUsers.js";

/** The conversations [userId] is in, optionally only those whose type is one of [types]. */
function conversationsOf(ctx: Pick<AppContext, "ws">, userId: string, types?: readonly string[]): string[] {
  const ids = ctx.ws.all<{ conversation_id: string }>("conversation_members", { where: { user_id: userId } }).map((m) => m.conversation_id);
  return types ? ctx.ws.all<{ id: string }>("conversations", { where: { id: { in: ids }, type: { in: types } } }).map((c) => c.id) : ids;
}

/** Everyone else in [conversationIds], once each. */
function othersIn(ctx: Pick<AppContext, "ws">, conversationIds: readonly string[], userId: string): string[] {
  const out = new Set<string>();
  for (const m of ctx.ws.all<{ user_id: string }>("conversation_members", { where: { conversation_id: { in: conversationIds } } })) if (m.user_id !== userId) out.add(m.user_id);
  return [...out];
}

/** People who share at least one conversation with [userId] (not [userId] themself): who may be showing their name. */
export function conversationPeers(ctx: Pick<AppContext, "ws">, userId: string): string[] {
  return othersIn(ctx, conversationsOf(ctx, userId), userId);
}

/** People who share a direct message or a group with [userId] (not [userId] themself). */
export function directPeers(ctx: Pick<AppContext, "ws">, userId: string): string[] {
  return othersIn(ctx, conversationsOf(ctx, userId, ["DM", "GROUP"]), userId);
}

/** The members of one conversation (AI Workforce tells them an agent posted; the fetch that follows checks access). */
export function conversationMemberIds(ctx: Pick<AppContext, "ws">, conversationId: string): string[] {
  return memberIds(ctx, conversationId);
}

/** Whether [a] and [b] share a direct message or a group (not just a channel). */
export function sharesDirectConversation(ctx: Pick<AppContext, "ws">, a: string, b: string): boolean {
  const direct = conversationsOf(ctx, a, ["DM", "GROUP"]);
  return direct.length > 0 && ctx.ws.count("conversation_members", { conversation_id: { in: direct }, user_id: b }) > 0;
}
