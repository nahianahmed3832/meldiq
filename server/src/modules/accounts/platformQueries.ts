import type { RowReader, Rows, Where } from "../../infrastructure/database/rows/index.js";
import { likeContains, likeStarts } from "../../shared/utilities/sqlText.js";

/**
 * What the Platform Admin Console (modules/platformAdmin) may read about people: identity metadata, devices and
 * counts. Never keys, certificates, profile fields people restrict with privacy settings, or anything they wrote.
 * Federated shadows of other servers' users are left out.
 */
export type UserStatus = "active" | "suspended" | "deleted";

export interface UserSummaryRow {
  id: string;
  username: string;
  display_name: string;
  created_at: number;
  disabled_at: number | null;
  deleted_at: number | null;
  limited_until: number | null;
  active_devices: number;
  last_seen_at: number | null;
}

export interface DeviceSummaryRow {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface UserCounts {
  total: number;
  suspended: number;
  deleted: number;
  seen24h: number;
  seen30d: number;
  newPerDay: { day: string; count: number }[];
}

const DAY_MS = 86_400_000;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  created_at: number;
  disabled_at: number | null;
  deleted_at: number | null;
  limited_until: number | null;
}

interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const STATUS_WHERE: Record<UserStatus, Where> = {
  active: { disabled_at: null, deleted_at: null },
  suspended: { disabled_at: { ne: null }, deleted_at: null },
  deleted: { deleted_at: { ne: null } },
};

/** The UTC day of [ms] ("2026-10-28"), as SQLite's strftime('%Y-%m-%d', ms / 1000, 'unixepoch'). */
const utcDay = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 10);

/** Newest first, then by id (keyset order); [after] the previous page's last row. Ids compare as text here. */
function newestFirst<R extends { created_at: number; id: string }>(rows: R[], after?: { createdAt: number; id: string }): R[] {
  return rows
    .filter((r) => !after || r.created_at < after.createdAt || (r.created_at === after.createdAt && r.id < after.id))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function summarize(identity: RowReader, u: UserRow): UserSummaryRow {
  const devices = identity.all<DeviceRow>("devices", { where: { user_id: u.id } });
  const seen = devices.map((d) => d.last_seen_at).filter((x): x is number => x !== null);
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    created_at: u.created_at,
    disabled_at: u.disabled_at,
    deleted_at: u.deleted_at,
    limited_until: u.limited_until,
    active_devices: devices.filter((d) => d.revoked_at === null).length,
    last_seen_at: seen.length ? Math.max(...seen) : null,
  };
}

/** Per UTC day, in day order. */
function perDay(times: number[]): { day: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of times) counts.set(utcDay(t), (counts.get(utcDay(t)) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, count]) => ({ day, count }));
}

/**
 * People, newest first, a page at a time. [q]: the start of a username, part of a display name, or an exact user id.
 * [after]: the last row of the previous page (keyset pagination: stable while people sign up).
 */
export function searchUsers(
  identity: RowReader,
  opts: { q?: string; status?: UserStatus; after?: { createdAt: number; id: string }; limit: number; ids?: string[]; notIds?: string[]; createdFrom?: number; createdTo?: number },
): UserSummaryRow[] {
  if (opts.ids && opts.ids.length === 0) return [];
  const where: Where = { home_server_id: null, ...(opts.status ? STATUS_WHERE[opts.status] : {}) };
  if (opts.ids) where.id = { in: opts.ids };
  if (opts.notIds?.length) where.id = opts.ids ? { in: opts.ids.filter((id) => !opts.notIds!.includes(id)) } : { notIn: opts.notIds };
  const { q, createdFrom, createdTo } = opts;
  const rows = identity
    .all<UserRow>("users", { where })
    .filter((u) => (createdFrom === undefined || u.created_at >= createdFrom) && (createdTo === undefined || u.created_at < createdTo))
    .filter((u) => !q || likeStarts(u.username, q) || likeContains(u.display_name, q) || u.id === q);
  return newestFirst(rows, opts.after)
    .slice(0, opts.limit)
    .map((u) => summarize(identity, u));
}

export function userSummary(identity: RowReader, userId: string): UserSummaryRow | undefined {
  const u = identity.get<UserRow>("users", { id: userId, home_server_id: null });
  return u ? summarize(identity, u) : undefined;
}

/** The person's devices, newest first: names they chose, when they were added and last seen, and revocations. */
export function userDevices(identity: RowReader, userId: string): DeviceSummaryRow[] {
  return identity
    .all<DeviceRow>("devices", { where: { user_id: userId }, orderBy: [["created_at", "desc"]], limit: 50 })
    .map((d) => ({ id: d.id, name: d.name, created_at: d.created_at, last_seen_at: d.last_seen_at, revoked_at: d.revoked_at }));
}

/** Usernames for [ids] (owners of a community, an incident's person). */
export function usernames(identity: RowReader, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(identity.all<{ id: string; username: string }>("users", { where: { id: { in: ids } } }).map((r) => [r.id, r.username]));
}

/** "Seen" is a device's last sign-in or connection (devices.last_seen_at): an approximate activity signal. */
export function userCounts(identity: RowReader, t: number, days: number): UserCounts {
  const local = { home_server_id: null, deleted_at: null };
  const seen = (since: number) => {
    const users = new Set(identity.all<{ user_id: string }>("devices", { where: { revoked_at: null, last_seen_at: { gt: since } } }).map((d) => d.user_id));
    return identity.count("users", { ...local, id: { in: [...users] } });
  };
  const from = t - days * DAY_MS;
  return {
    total: identity.count("users", local),
    suspended: identity.count("users", { ...local, disabled_at: { ne: null } }),
    deleted: identity.count("users", { home_server_id: null, deleted_at: { ne: null } }),
    seen24h: seen(t - DAY_MS),
    seen30d: seen(t - 30 * DAY_MS),
    newPerDay: perDay(identity.all<{ created_at: number }>("users", { where: { created_at: { gt: from }, home_server_id: null } }).map((u) => u.created_at)),
  };
}

/** Sets or clears ([at] null) an identity's suspension (the same column `admin.js disable` sets); true when it changed. */
export function setIdentitySuspended(identity: Rows, userId: string, at: number | null): Promise<boolean> {
  return identity.write((w) =>
    at === null
      ? w.update("users", { id: userId, disabled_at: { ne: null }, deleted_at: null }, { disabled_at: null }) > 0
      : w.update("users", { id: userId, disabled_at: null, deleted_at: null }, { disabled_at: at }) > 0,
  );
}

/** When each identity in [ids] was created (telemetry stores it with activity rows, for cohorts). */
export function signupTimes(identity: RowReader, ids: string[]): Map<string, number> {
  if (ids.length === 0) return new Map();
  return new Map(identity.all<{ id: string; created_at: number }>("users", { where: { id: { in: ids } } }).map((r) => [r.id, r.created_at]));
}

/** Synthetic (load-test) identities: always left out of analytics. */
export function syntheticUserIds(identity: RowReader): string[] {
  return identity.all<{ id: string }>("users", { where: { synthetic: 1 } }).map((r) => r.id);
}

/**
 * Sign-ups per UTC day in [from, to) (ms), [excluded] left out: the denominators of activation and retention. Deleted
 * accounts count: they signed up.
 */
export function signupsPerDay(identity: RowReader, from: number, to: number, excluded: readonly string[]): { day: string; count: number }[] {
  const rows = identity.all<{ created_at: number }>("users", { where: { created_at: { gte: from }, home_server_id: null, id: { notIn: [...excluded] } } });
  return perDay(rows.filter((u) => u.created_at < to).map((u) => u.created_at));
}

/**
 * Identities that can be used now (not suspended, deleted or synthetic), synthetic ones, and new accounts still under
 * the new-account limits (limited_until).
 */
export function accountStateCounts(identity: RowReader, t: number): { usable: number; synthetic: number; newAccountLimited: number } {
  const local = { home_server_id: null, deleted_at: null };
  return {
    usable: identity.count("users", { ...local, disabled_at: null, synthetic: 0 }),
    synthetic: identity.count("users", { ...local, synthetic: 1 }),
    newAccountLimited: identity.count("users", { ...local, limited_until: { gt: t } }),
  };
}

/** Identities created since [since] (ms), synthetic ones left out (alert rules: a sign-up spike). */
export function signupsSince(identity: RowReader, since: number): number {
  return identity.count("users", { created_at: { gt: since }, home_server_id: null, synthetic: 0 });
}

export interface DeviceInventoryRow {
  id: string;
  user_id: string;
  username: string | null;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

/** Local identities' usernames by id; federated shadows (home_server_id set) are left out. */
function localUsernames(identity: RowReader, userIds: string[]): Map<string, string> {
  return new Map(identity.all<{ id: string; username: string }>("users", { where: { id: { in: [...new Set(userIds)] }, home_server_id: null } }).map((u) => [u.id, u.username]));
}

/**
 * Devices across everyone, newest first, a page at a time ([after]: the previous page's last row). [staleBefore]:
 * only devices not seen since then. Federated shadows are left out.
 */
export function devicesPage(
  identity: RowReader,
  opts: { status?: "active" | "revoked"; staleBefore?: number; ids?: string[]; after?: { createdAt: number; id: string }; limit: number },
): DeviceInventoryRow[] {
  const where: Where = {};
  if (opts.status === "active" || opts.staleBefore !== undefined) where.revoked_at = null;
  if (opts.status === "revoked") where.revoked_at = opts.staleBefore !== undefined ? { in: [] } : { ne: null };
  if (opts.ids) where.id = { in: opts.ids };
  const stale = opts.staleBefore;
  const devices = identity.all<DeviceRow>("devices", { where }).filter((d) => stale === undefined || (d.last_seen_at ?? d.created_at) < stale);
  const names = localUsernames(identity, devices.map((d) => d.user_id));
  const page: DeviceInventoryRow[] = [];
  for (const d of newestFirst(devices, opts.after)) {
    if (page.length >= opts.limit) break;
    const username = names.get(d.user_id);
    if (username !== undefined) page.push({ ...d, username });
  }
  return page;
}

export function deviceCounts(identity: RowReader): { active: number; revoked: number } {
  return { active: identity.count("devices", { revoked_at: null }), revoked: identity.count("devices", { revoked_at: { ne: null } }) };
}

/** A device of [userId], if it is one of theirs. */
export function deviceOf(identity: RowReader, userId: string, deviceId: string): DeviceInventoryRow | undefined {
  const d = identity.get<DeviceRow>("devices", { id: deviceId, user_id: userId });
  const u = d && identity.get<{ username: string }>("users", { id: userId });
  return d && u ? { ...d, username: u.username } : undefined;
}

/** Identities created in [from, to) (ms), synthetic ones left out. */
export function signupsBetween(identity: RowReader, from: number, to: number): number {
  return identity.all<{ created_at: number }>("users", { where: { created_at: { gte: from }, home_server_id: null, synthetic: 0 } }).filter((u) => u.created_at < to).length;
}

/**
 * Display names and usernames of [userIds] (AI Workforce's impersonation check: an agent can't be named like a member
 * of its community). Names only.
 */
export function namesOf(identity: RowReader, userIds: readonly string[]): { id: string; username: string; displayName: string }[] {
  if (userIds.length === 0) return [];
  return identity
    .all<{ id: string; username: string; display_name: string }>("users", { where: { id: { in: [...userIds] } } })
    .map((r) => ({ id: r.id, username: r.username, displayName: r.display_name }));
}
