import { Authz, type ConversationRow } from "../organizations/authz.js";
import type { Rows } from "../../infrastructure/database/rows/index.js";

/**
 * Repair for round 7 bug 6 (docs/MELDIQ_ROUND7_PLAN_2026-10-19.md): public channels created before the fix were
 * stored as opt-in (auto_join = 0) because neither app sent `autoJoin`, so workspace members weren't in them. The
 * repair marks those channels auto-joined and adds the members who may see them, as the fixed server does for new
 * channels. Someone who left a channel themselves (an audit `channel.leave`) isn't put back. Private, announcement,
 * archived and already auto-joined channels are untouched. Admin CLI: `channel-access-repair [--yes]`.
 */
export interface ChannelRepair {
  channelId: string;
  orgId: string;
  name: string;
  scope: string;
  add: string[];
  skippedLeft: number;
}

export function planChannelAccessRepair(rows: Rows): ChannelRepair[] {
  const authz = new Authz(rows);
  const channels = rows.all<ConversationRow>("conversations", {
    where: { type: "CHANNEL", kind: "PUBLIC", auto_join: 0, archived_at: null },
    orderBy: [["created_at", "asc"]],
  });
  const leaves = rows.all<{ target: string }>("audit_log", { where: { action: "channel.leave" } });
  return channels.map((c) => {
    const left = new Set(leaves.filter((r) => r.target?.startsWith(`${c.id}:`)).map((r) => r.target.slice(c.id.length + 1)));
    const inChannel = new Set(rows.all<{ user_id: string }>("conversation_members", { where: { conversation_id: c.id } }).map((m) => m.user_id));
    const candidates = rows
      .all<{ user_id: string }>("org_members", { where: { org_id: c.org_id } })
      .map((r) => r.user_id)
      .filter((u) => !inChannel.has(u) && authz.scopeEligible(c, u));
    return {
      channelId: c.id,
      orgId: c.org_id ?? "",
      name: c.name ?? "",
      scope: c.scope ?? "",
      add: candidates.filter((u) => !left.has(u)),
      skippedLeft: candidates.filter((u) => left.has(u)).length,
    };
  });
}

/** Applies [plan] in one write unit; returns how many memberships were added. */
export async function applyChannelAccessRepair(rows: Rows, plan: ChannelRepair[], now: number): Promise<number> {
  return rows.write((w) => {
    let added = 0;
    for (const r of plan) {
      w.update("conversations", { id: r.channelId }, { auto_join: 1, updated_at: now });
      for (const u of r.add) {
        if (w.insert("conversation_members", { conversation_id: r.channelId, user_id: u, role: "MEMBER", joined_at: now }, { orIgnore: true }).inserted) added++;
      }
    }
    return added;
  });
}
