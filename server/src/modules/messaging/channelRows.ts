import type { RowWriter } from "../../infrastructure/database/rows/index.js";

/**
 * Community channels made and archived by the server itself (community parity batch C: ticket channels), for modules
 * that don't own the conversation tables. The caller decides who may, inside its own write unit.
 */
export interface NewChannel {
  id: string;
  orgId: string;
  name: string;
  topic: string | null;
  kind: "PUBLIC" | "PRIVATE" | "ANNOUNCEMENT";
  categoryId: string | null;
  createdBy: string;
  at: number;
}

/** Inserts a text channel at the end of its category, with [members] in it (none of them its channel admin). */
export function insertChannel(w: RowWriter, c: NewChannel, members: readonly string[]): void {
  const last = w.get<{ position: number }>("conversations", { org_id: c.orgId, type: "CHANNEL", category_id: c.categoryId }, [["position", "desc"]]);
  w.insert("conversations", {
    id: c.id,
    type: "CHANNEL",
    org_id: c.orgId,
    scope: "ORG",
    scope_id: null,
    kind: c.kind,
    name: c.name,
    topic: c.topic,
    auto_join: c.kind === "PRIVATE" ? 0 : 1,
    created_by: c.createdBy,
    created_at: c.at,
    updated_at: c.at,
    voice: 0,
    category_id: c.categoryId,
    position: (last?.position ?? -1) + 1,
    format: "text",
  });
  for (const userId of members) addChannelMember(w, c.id, userId, c.at);
}

/** Puts [userId] in a channel; false when they were in it already. */
export function addChannelMember(w: RowWriter, channelId: string, userId: string, at: number): boolean {
  return w.insert("conversation_members", { conversation_id: channelId, user_id: userId, role: "MEMBER", joined_at: at }, { orIgnore: true }).inserted;
}

/** How many channels a category holds (archived ones too). */
export function channelsInCategory(w: RowWriter, categoryId: string): number {
  return w.count("conversations", { category_id: categoryId });
}

/** How many channels a community has (archived ones too). */
export function channelsInCommunity(w: RowWriter, orgId: string): number {
  return w.count("conversations", { org_id: orgId, type: "CHANNEL" });
}

/** Archives a channel, moving it out of its category when [uncategorise]; false when it's gone or archived already. */
export function archiveChannel(w: RowWriter, channelId: string, at: number, uncategorise: boolean): boolean {
  return w.update("conversations", { id: channelId, archived_at: null }, { archived_at: at, updated_at: at, ...(uncategorise ? { category_id: null } : {}) }) > 0;
}
