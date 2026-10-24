import type { DB } from "../../infrastructure/database/db.js";

/**
 * A person's direct conversation with an AI agent's bot identity (docs/AI_WORKFORCE_2_PLAN.md phase 5): a DM with
 * both as members, created once (dm_key), without the message-request rules of DMs between people (the person starts
 * it, and the bot never writes end-to-end encrypted messages).
 */
export function botDm(db: DB, p: { id: string; userId: string; botUserId: string; at: number }): string {
  const key = [p.userId, p.botUserId].sort().join("|");
  const have = db.prepare("SELECT id FROM conversations WHERE dm_key = ?").get(key) as { id: string } | undefined;
  if (have) return have.id;
  db.transaction(() => {
    db.prepare("INSERT INTO conversations (id, type, dm_key, created_by, created_at, updated_at) VALUES (?, 'DM', ?, ?, ?, ?)").run(p.id, key, p.userId, p.at, p.at);
    const ins = db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)");
    ins.run(p.id, p.userId, p.at);
    ins.run(p.id, p.botUserId, p.at);
  })();
  return p.id;
}

/** Open channels of a community (an agent's "read every channel"). */
export function openChannelIds(db: DB, orgId: string): string[] {
  return (db.prepare("SELECT id FROM conversations WHERE org_id = ? AND type = 'CHANNEL' AND archived_at IS NULL ORDER BY created_at").all(orgId) as { id: string }[]).map((c) => c.id);
}
