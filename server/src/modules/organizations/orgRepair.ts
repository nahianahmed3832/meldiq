import type { AppContext } from "../../app/context.js";
import type { DB } from "../../infrastructure/database/db.js";

/** What the repair reads: SQLite, and the stores of the domains that may live in MongoDB (files, relay, calls). */
export type OrgRepairStores = Pick<AppContext, "db" | "files" | "relay" | "calls">;

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

const n = (db: DB, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

/** What an organisation holds, in counts only (no names of people, no content). */
export async function orgFootprint(stores: OrgRepairStores, orgId: string): Promise<OrgFootprint | undefined> {
  const { db } = stores;
  const o = db.prepare("SELECT id, name, slug, created_at, created_by FROM orgs WHERE id = ?").get(orgId) as
    | { id: string; name: string; slug: string; created_at: number; created_by: string }
    | undefined;
  if (!o) return undefined;
  const conv = "SELECT id FROM conversations WHERE org_id = ?";
  const channelIds = (db.prepare(conv).all(orgId) as { id: string }[]).map((r) => r.id);
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    createdAt: o.created_at,
    ...sqliteFootprint(db, orgId, o.created_by),
    // Files, calls and queued messages may live in MongoDB: each store counts its own.
    attachments: (await stores.files.attachmentIdsIn(channelIds)).length,
    calls: await stores.calls.countIn(channelIds),
    queued: await stores.relay.countInConversations(channelIds),
  };
}

/** The part of the footprint SQLite holds (checked again inside the deleting transaction). */
function sqliteFootprint(db: DB, orgId: string, owner: string) {
  const conv = "SELECT id FROM conversations WHERE org_id = ?";
  return {
    members: n(db, "SELECT COUNT(*) n FROM org_members WHERE org_id = ?", orgId),
    branches: n(db, "SELECT COUNT(*) n FROM branches WHERE org_id = ?", orgId),
    teams: n(db, "SELECT COUNT(*) n FROM teams WHERE org_id = ?", orgId),
    channels: n(db, "SELECT COUNT(*) n FROM conversations WHERE org_id = ?", orgId),
    sharedChannels: n(
      db,
      `SELECT COUNT(DISTINCT cm.conversation_id) n FROM conversation_members cm WHERE cm.conversation_id IN (${conv}) AND cm.user_id != ?`,
      orgId,
      owner,
    ),
    usedInvites: n(db, "SELECT COUNT(*) n FROM invitations WHERE org_id = ? AND uses > 0", orgId),
  };
}

/** Why the SQLite part of an organisation must be kept, or null (see [keepReason]). */
function sqliteKeepReason(db: DB, orgId: string): string | null {
  const owner = db.prepare("SELECT created_by FROM orgs WHERE id = ?").get(orgId) as { created_by: string } | undefined;
  if (!owner) return "no such organisation";
  const f = sqliteFootprint(db, orgId, owner.created_by);
  const role = db.prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?").get(orgId, owner.created_by) as { role: string } | undefined;
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
  const sqlite = sqliteKeepReason(stores.db, orgId);
  if (sqlite) return sqlite;
  if (f.attachments > 0 || f.calls > 0 || f.queued > 0) return "has files, calls or undelivered messages";
  return null;
}

/** Groups of organisations owned by the same person under the same name, oldest first in each group. */
export async function findDuplicateOrgs(stores: OrgRepairStores): Promise<DuplicateGroup[]> {
  const { db } = stores;
  const groups = db
    .prepare(
      `SELECT o.created_by owner, lower(trim(o.name)) k, COUNT(*) c FROM orgs o
        JOIN org_members m ON m.org_id = o.id AND m.user_id = o.created_by AND m.role = 'OWNER'
       GROUP BY o.created_by, lower(trim(o.name)) HAVING c > 1`,
    )
    .all() as { owner: string; k: string; c: number }[];
  const out: DuplicateGroup[] = [];
  for (const g of groups) {
    const ids = (
      db.prepare("SELECT id FROM orgs WHERE created_by = ? AND lower(trim(name)) = ? ORDER BY created_at, id").all(g.owner, g.k) as { id: string }[]
    ).map((r) => r.id);
    const orgs: DuplicateGroup["orgs"] = [];
    for (const id of ids) {
      const f = (await orgFootprint(stores, id))!;
      const reason = await keepReason(stores, id);
      orgs.push({ ...f, removable: reason === null, keepReason: reason });
    }
    const user = db.prepare("SELECT username FROM users WHERE id = ?").get(g.owner) as { username: string } | undefined;
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
  const { db } = stores;
  const reason = await keepReason(stores, orgId);
  if (reason) throw new Error(`refusing to delete ${orgId}: ${reason}`);
  const f = (await orgFootprint(stores, orgId))!;
  const channels = (db.prepare("SELECT id FROM conversations WHERE org_id = ?").all(orgId) as { id: string }[]).map((r) => r.id);
  db.transaction(() => {
    const again = sqliteKeepReason(db, orgId);
    if (again) throw new Error(`refusing to delete ${orgId}: ${again}`);
    db.prepare("DELETE FROM orgs WHERE id = ?").run(orgId);
  })();
  await stores.calls.forgetConversations(channels);
  return f;
}
