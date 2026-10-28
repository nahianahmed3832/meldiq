import type { AppContext } from "../../app/context.js";
import { mapByIds } from "../../infrastructure/database/byIds.js";

export interface MemberRow {
  conversation_id: string;
  user_id: string;
  role: string;
  joined_at: number;
  last_post_at?: number | null;
}

/**
 * A conversation's members with their user rows: members live with conversations (SQLite or MongoDB, ctx.ws), users in
 * SQLite, so the join runs here. Members whose user row is gone are left out, as the SQL join did. In no order.
 */
export function memberUsers<U extends Record<string, unknown>>(ctx: Pick<AppContext, "identity" | "ws">, conversationId: string, columns = "*"): { member: MemberRow; user: U }[] {
  const members = ctx.ws.all<MemberRow>("conversation_members", { where: { conversation_id: conversationId } });
  const users = mapByIds<U>(ctx.identity, "users", "id", members.map((m) => m.user_id), columns);
  return members.flatMap((member) => {
    const user = users.get(member.user_id);
    return user ? [{ member, user }] : [];
  });
}

/** The ids of everyone in [conversationId]. */
export const memberIds = (ctx: Pick<AppContext, "ws">, conversationId: string): string[] =>
  ctx.ws.all<{ user_id: string }>("conversation_members", { where: { conversation_id: conversationId } }).map((m) => m.user_id);
