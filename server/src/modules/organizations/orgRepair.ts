import type { AppContext } from "../../app/context.js";
import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { compareText, foldAscii } from "../../shared/utilities/sqlText.js";

/** What the repair reads: SQLite (users), and the stores of the domains that may live in MongoDB. */
export type OrgRepairStores = Pick<AppContext, "identity" | "ws" | "files" | "relay" | "calls">;

/**
 * Operator repair for duplicate organisations (admin CLI `org-duplicates`, `org-delete-empty`).
 *
 * Before org creation was idempotent (migration 006), a retried or repeated "Create workspace" made a new organisation
 * each time, so one person could own several workspaces with the same name. Nothing here runs automatically: the
 * operator lists the duplicates, reads what each one holds, and removes only one that is provably empty.
 */

export interface OrgFootprint {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  members: number;
  branches: number;
  teams: number;
  channels: number;
  /** Channels with someone other than the owner in them. */
  sharedChannels: number;
  usedInvites: number;
  attachments: number;
  calls: number;
  queued: number;
}

export interface DuplicateGroup {
  ownerId: string;
  ownerUsername: string | null;
  name: string;
  orgs: (OrgFootprint & { removable: boolean; keepReason: string | null })[];
}

/** What an organisation holds, in counts only (no names of people, no content). */
export async function orgFootprint(stores: OrgRepairStores, orgId: string): Promise<OrgFootprint | undefined> {
  const o = stores.ws.get<{ id: string; name: string; slug: string; created_at: number; created_by: string }>("orgs", { id: orgId });
  if (!o) return undefined;
  const channelIds = stores.ws.all<{ id: string }>("conversations", { where: { org_id: orgId } }).map((r) => r.id);
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    createdAt: o.created_at,
    ...workspaceFootprint(stores.ws, orgId, o.created_by),
    // Files, calls and queued messages may live elsewhere: each store counts its own.
    attachments: (await stores.files.attachmentIdsIn(channelIds)).length,
    calls: await stores.calls.countIn(channelIds),
    queued: await stores.relay.countInConversations(channelIds),
  };
}

/** The part of the footprint the workspace rows hold (checked again inside the deleting unit). */
function workspaceFootprint(rows: RowReader, orgId: string, owner: string) {
  const channelIds = rows.all<{ id: string }>("conversations", { where: { org_id: orgId } }).map((r) => r.id);
  const shared = rows.all<{ conversation_id: string }>("conversation_members", { where: { conversation_id: { in: channelIds }, user_id: { ne: owner } } });
  return {
    members: rows.count("org_members", { org_id: orgId }),
    branches: rows.count("branches", { org_id: orgId }),
    teams: rows.count("teams", { org_id: orgId }),
    channels: channelIds.length,
    sharedChannels: new Set(shared.map((m) => m.conversation_id)).size,
    usedInvites: rows.count("invitations", { org_id: orgId, uses: { gt: 0 } }),
  };
}

/** Why the workspace part of an organisation must be kept, or null (see [keepReason]). */
function workspaceKeepReason(rows: RowReader, orgId: string): string | null {
  const owner = rows.get<{ created_by: string }>("orgs", { id: orgId });
  if (!owner) return "no such organisation";
  const f = workspaceFootprint(rows, orgId, owner.created_by);
  const role = rows.get<{ role: string }>("org_members", { org_id: orgId, user_id: owner.created_by });
  if (f.members !== 1 || role?.role !== "OWNER") return `${f.members} members`;
  if (f.branches > 0 || f.teams > 0) return "has branches or teams";
  if (f.usedInvites > 0) return "someone joined through one of its invites";
  if (f.sharedChannels > 0) return "has channels shared with other people";
  return null;
}

/**
 * Why [orgId] must be kept, or null if it is provably empty: only its creator is a member (as owner), no branches or
 * teams, nobody has ever joined through one of its invites, its channels (if any) contain only the owner, and no
 * attachment, call or undelivered message references it.
 */
export async function keepReason(stores: OrgRepairStores, orgId: string): Promise<string | null> {
  const f = await orgFootprint(stores, orgId);
  if (!f) return "no such organisation";
  const workspace = workspaceKeepReason(stores.ws, orgId);
  if (workspace) return workspace;
  if (f.attachments > 0 || f.calls > 0 || f.queued > 0) return "has files, calls or undelivered messages";
  return null;
}

/** Groups of organisations owned by the same person under the same name, oldest first in each group. */
export async function findDuplicateOrgs(stores: OrgRepairStores): Promise<DuplicateGroup[]> {
  const { identity, ws } = stores;
  const nameKey = (o: { created_by: string; name: string }) => `${o.created_by}\u0000${foldAscii(o.name.trim())}`;
  const orgsAll = ws.all<{ id: string; name: string; created_by: string; created_at: number }>("orgs");
  const owned = orgsAll.filter((o) => ws.get<{ role: string }>("org_members", { org_id: o.id, user_id: o.created_by })?.role === "OWNER");
  const groups = new Map<string, { owner: string; k: string; c: number }>();
  for (const o of owned) {
    const g = groups.get(nameKey(o)) ?? { owner: o.created_by, k: foldAscii(o.name.trim()), c: 0 };
    groups.set(nameKey(o), { ...g, c: g.c + 1 });
  }
  const out: DuplicateGroup[] = [];
  for (const g of [...groups.values()].filter((x) => x.c > 1)) {
    const ids = orgsAll
      .filter((o) => o.created_by === g.owner && foldAscii(o.name.trim()) === g.k)
      .sort((a, b) => a.created_at - b.created_at || compareText(a.id, b.id))
      .map((r) => r.id);
    const orgs: DuplicateGroup["orgs"] = [];
    for (const id of ids) {
      const f = (await orgFootprint(stores, id))!;
      const reason = await keepReason(stores, id);
      orgs.push({ ...f, removable: reason === null, keepReason: reason });
    }
    const user = identity.get<{ username: string }>("users", { id: g.owner });
    out.push({ ownerId: g.owner, ownerUsername: user?.username ?? null, name: orgs[0]?.name ?? g.k, orgs });
  }
  return out;
}

/**
 * Deletes an organisation only if [keepReason] finds nothing to keep; SQLite's part is checked again inside the deleting
 * transaction. Its owner-only channels go with it (foreign keys cascade; calls in MongoDB are removed after). Throws,
 * deleting nothing, otherwise.
 */
export async function deleteEmptyOrg(stores: OrgRepairStores, orgId: string): Promise<OrgFootprint> {
  const { ws } = stores;
  const reason = await keepReason(stores, orgId);
  if (reason) throw new Error(`refusing to delete ${orgId}: ${reason}`);
  const f = (await orgFootprint(stores, orgId))!;
  const channels = ws.all<{ id: string }>("conversations", { where: { org_id: orgId } }).map((r) => r.id);
  await ws.write((w) => {
    const again = workspaceKeepReason(w, orgId);
    if (again) throw new Error(`refusing to delete ${orgId}: ${again}`);
    w.delete("orgs", { id: orgId });
  });
  await stores.calls.forgetConversations(channels);
  return f;
}
