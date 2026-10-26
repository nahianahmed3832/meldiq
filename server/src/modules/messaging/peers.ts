import type { AppContext } from "../../app/context.js";

/** People who share at least one conversation with [userId] (not [userId] themself): who may be showing their name. */
export function conversationPeers(ctx: AppContext, userId: string): string[] {
  return (
    ctx.db
      .prepare(
        `SELECT DISTINCT m2.user_id FROM conversation_members m1
         JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
         WHERE m1.user_id = ? AND m2.user_id != ?`,
      )
      .all(userId, userId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

/** The members of one conversation (AI Workforce tells them an agent posted; the fetch that follows checks access). */
export function conversationMemberIds(ctx: AppContext, conversationId: string): string[] {
  return (ctx.db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(conversationId) as { user_id: string }[]).map((r) => r.user_id);
}

/** Whether [a] and [b] share a direct message or a group (not just a channel). */
export function sharesDirectConversation(ctx: AppContext, a: string, b: string): boolean {
  return !!ctx.db
    .prepare(
      `SELECT 1 FROM conversation_members m1 JOIN conversations c ON c.id = m1.conversation_id AND c.type IN ('DM','GROUP')
       JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1`,
    )
    .get(a, b);
}
