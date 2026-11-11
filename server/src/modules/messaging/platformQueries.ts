import type { RowReader } from "../../infrastructure/database/rows/index.js";

/** Channel counts of a community for the Platform Admin Console: how many, never their names, members or messages. */
export function channelCounts(rows: RowReader, orgId: string): { total: number; private: number } {
  const channels = rows.all<{ kind: string }>("conversations", { where: { org_id: orgId, type: "CHANNEL" } });
  return { total: channels.length, private: channels.filter((c) => c.kind === "PRIVATE").length };
}

/** Membership boundaries used by permitted activity ranking; no message content. */
export function conversationMembershipHistory(rows: RowReader, userId: string) {
  return rows.all<{ conversation_id: string; joined_at: number }>("conversation_members", { where: { user_id: userId } });
}
