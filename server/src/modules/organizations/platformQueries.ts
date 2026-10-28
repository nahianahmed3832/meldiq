import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { compareText, foldAscii, likeContains } from "../../shared/utilities/sqlText.js";

/**
 * What the Platform Admin Console (modules/platformAdmin) may read about workspaces and communities: names, settings,
 * member and role counts, and one person's memberships. Never member lists, channel contents or reports.
 */
export type OrgKind = "team" | "community";

export interface OrgSummaryRow {
  id: string;
  name: string;
  slug: string;
  kind: OrgKind;
  visibility: string;
  created_at: number;
  members: number;
}

export interface OrgRecordRow extends OrgSummaryRow {
  join_policy: string;
  created_by: string;
  updated_at: number;
  invites_paused_until: number | null;
  dms_paused_until: number | null;
  guests_allowed: number;
  activity_alerts: number;
  raid_alert_at: number | null;
}

export interface MembershipRow {
  org_id: string;
  name: string;
  kind: OrgKind;
  role: string;
  joined_at: number;
  custom_roles: string | null;
}

const DAY_MS = 86_400_000;

type OrgRow = Omit<OrgRecordRow, "members"> & { synthetic: number };

const withMembers = <O extends { id: string }>(rows: RowReader, o: O): O & { members: number } => ({ ...o, members: rows.count("org_members", { org_id: o.id }) });
const summary = (o: OrgSummaryRow): OrgSummaryRow => ({ id: o.id, name: o.name, slug: o.slug, kind: o.kind, visibility: o.visibility, created_at: o.created_at, members: o.members });
/** Newest first, ties by id (descending). */
const newestFirst = (a: { created_at: number; id: string }, b: { created_at: number; id: string }) => b.created_at - a.created_at || compareText(b.id, a.id);

/** Workspaces and communities, newest first, a page at a time ([after]: the previous page's last row). */
export function searchOrgs(rows: RowReader, opts: { q?: string; kind?: OrgKind; after?: { createdAt: number; id: string }; limit: number }): OrgSummaryRow[] {
  const q = opts.q;
  const after = opts.after;
  return rows
    .all<OrgRow>("orgs", { where: opts.kind ? { kind: opts.kind } : {} })
    .filter((o) => !q || likeContains(o.name, q) || foldAscii(o.slug).startsWith(foldAscii(q)) || o.id === q)
    .filter((o) => !after || o.created_at < after.createdAt || (o.created_at === after.createdAt && o.id < after.id))
    .sort(newestFirst)
    .slice(0, opts.limit)
    .map((o) => summary(withMembers(rows, o)));
}

export function orgRecord(rows: RowReader, orgId: string): OrgRecordRow | undefined {
  const o = rows.get<OrgRow>("orgs", { id: orgId });
  if (!o) return undefined;
  const { synthetic: _synthetic, ...record } = withMembers(rows, o);
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    kind: record.kind,
    visibility: record.visibility,
    join_policy: record.join_policy,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
    invites_paused_until: record.invites_paused_until,
    dms_paused_until: record.dms_paused_until,
    guests_allowed: record.guests_allowed,
    activity_alerts: record.activity_alerts,
    raid_alert_at: record.raid_alert_at,
    members: record.members,
  };
}

/** Members per base role, custom roles, bans and live invitations: counts only. */
export function orgComposition(rows: RowReader, orgId: string, t: number) {
  const members = rows.all<{ user_id: string; role: string; joined_at: number }>("org_members", { where: { org_id: orgId } });
  const byRole: Record<string, number> = {};
  for (const m of members) byRole[m.role] = (byRole[m.role] ?? 0) + 1;
  const invites = rows.all<{ expires_at: number | null; uses: number; max_uses: number }>("invitations", { where: { org_id: orgId, revoked_at: null } });
  return {
    byRole,
    customRoles: rows.count("org_roles", { org_id: orgId }),
    bans: rows.count("org_bans", { org_id: orgId }),
    activeInvites: invites.filter((i) => (i.expires_at === null || i.expires_at > t) && i.uses < i.max_uses).length,
    owners: members
      .filter((m) => m.role === "OWNER")
      .sort((a, b) => a.joined_at - b.joined_at)
      .slice(0, 10)
      .map((m) => m.user_id),
  };
}

/** [userId]'s memberships with their base role and the names of their custom roles. */
export function membershipsOf(rows: RowReader, userId: string): MembershipRow[] {
  const memberships = rows.all<{ org_id: string; role: string; joined_at: number }>("org_members", { where: { user_id: userId }, orderBy: [["joined_at", "desc"]], limit: 200 });
  return memberships.flatMap((m) => {
    const o = rows.get<{ name: string; kind: OrgKind }>("orgs", { id: m.org_id });
    if (!o) return [];
    const roleIds = rows.all<{ role_id: string }>("org_role_members", { where: { org_id: m.org_id, user_id: userId } }).map((r) => r.role_id);
    const names = rows.all<{ name: string }>("org_roles", { where: { id: { in: roleIds } } }).map((r) => r.name);
    return [{ org_id: m.org_id, name: o.name, kind: o.kind, role: m.role, joined_at: m.joined_at, custom_roles: names.length ? names.join("\u001f") : null }];
  });
}

/** The UTC day of [ms], as SQLite's strftime('%Y-%m-%d', ms / 1000, 'unixepoch') wrote it. */
const utcDayOf = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 10);

export function orgCounts(rows: RowReader, t: number, days: number) {
  const orgs = rows.all<{ kind: string; created_at: number }>("orgs");
  const perDay = new Map<string, number>();
  for (const o of orgs) if (o.created_at > t - days * DAY_MS) perDay.set(utcDayOf(o.created_at), (perDay.get(utcDayOf(o.created_at)) ?? 0) + 1);
  return {
    total: orgs.length,
    teams: orgs.filter((o) => o.kind === "team").length,
    communities: orgs.filter((o) => o.kind === "community").length,
    newPerDay: [...perDay].sort(([a], [b]) => compareText(a, b)).map(([day, count]) => ({ day, count })),
  };
}

/**
 * Sign-in and device events of a person from the security audit trail (account.*, device.*, user.*): what happened and
 * when, without the free-text detail. [ids]: their user id and account id.
 */
export function securityEvents(rows: RowReader, ids: string[], limit: number): { at: number; action: string }[] {
  if (ids.length === 0) return [];
  return rows
    .all<{ at: number; action: string }>("audit_log", { where: { $or: [{ actor_id: { in: ids } }, { target: { in: ids } }] }, orderBy: [["id", "desc"]] })
    .filter((e) => ["account.", "device.", "user."].some((p) => foldAscii(e.action).startsWith(p)))
    .slice(0, limit)
    .map((e) => ({ at: e.at, action: e.action }));
}

/** Names of organizations [ids] (pages that list ids from other tables). */
export function orgNames(rows: RowReader, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(rows.all<{ id: string; name: string }>("orgs", { where: { id: { in: ids } } }).map((r) => [r.id, r.name]));
}

/** How many audit_log entries with [action] were written since [since] (alert rules: failed sign-ins). */
export function auditActionCount(rows: RowReader, action: string, since: number): number {
  return rows.count("audit_log", { action, at: { gt: since } });
}

/**
 * A person's sign-in history from the server's audit log (account.* entries: sign-ins, failed passwords, refresh-token
 * reuse, password changes and resets). Session ids and account ids only; never addresses or tokens.
 */
export function authHistory(rows: RowReader, userId: string, limit: number): { at: number; action: string; target: string | null; detail: string | null }[] {
  return rows
    .all<{ at: number; action: string; target: string | null; detail: string | null }>("audit_log", { where: { actor_id: userId }, orderBy: [["at", "desc"]] })
    .filter((e) => foldAscii(e.action).startsWith("account."))
    .slice(0, limit)
    .map((e) => ({ at: e.at, action: e.action, target: e.target, detail: e.detail }));
}

/** Organizations created in [from, to) (ms); synthetic (load-test) ones left out. */
export function orgsCreatedBetween(rows: RowReader, from: number, to: number): number {
  return rows.all<{ created_at: number }>("orgs", { where: { created_at: { gte: from }, synthetic: 0 } }).filter((o) => o.created_at < to).length;
}

/** The biggest organizations (synthetic ones left out), with their member ids for activity figures. Bounded. */
export function orgsWithMembers(rows: RowReader, limit: number): { id: string; name: string; kind: OrgKind; members: string[] }[] {
  return rows
    .all<OrgRow>("orgs", { where: { synthetic: 0 } })
    .map((o) => withMembers(rows, o))
    .sort((a, b) => b.members - a.members || a.created_at - b.created_at)
    .slice(0, limit)
    .map((o) => ({ id: o.id, name: o.name, kind: o.kind, members: orgMemberIds(rows, o.id) }));
}

/** The member ids of one organization (its activity figures). */
export function orgMemberIds(rows: RowReader, orgId: string): string[] {
  return rows.all<{ user_id: string }>("org_members", { where: { org_id: orgId } }).map((r) => r.user_id);
}
