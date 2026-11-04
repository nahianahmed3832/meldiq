import type { RowWriter } from "../../infrastructure/database/rows/index.js";

/** Called only after personal consent. A new consent epoch gets a fresh conversation, never prior revoked history. */
export function createBotDirectConversation(
  w: RowWriter,
  id: string,
  botId: string,
  userId: string,
  at: number,
) {
  w.insert("conversations", {
    id,
    type: "DM",
    dm_key: `botdm|${id}`,
    created_by: userId,
    created_at: at,
    updated_at: at,
  });
  for (const user of [botId, userId])
    w.insert("conversation_members", {
      conversation_id: id,
      user_id: user,
      role: "MEMBER",
      joined_at: at,
    });
}

export function closeBotDirectConversation(
  w: RowWriter,
  id: string,
  at: number,
) {
  w.update(
    "conversations",
    { id, type: "DM" },
    { archived_at: at, updated_at: at },
  );
}
