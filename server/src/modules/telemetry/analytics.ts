import type { RowReader, Where } from "../../infrastructure/database/rows/index.js";
import { utcDay } from "./activity.js";

/**
 * Analytics over the telemetry tables (docs/ANALYTICS_DEFINITIONS.md). Every read is bounded by a date range (an
 * index where one helps); [excluded] are the user ids left out (load-test accounts, the operator's list, optionally
 * console admins), applied at read time so changing the list changes past figures too. The figures are computed here
 * from rows, the same in SQLite and MongoDB; days are "YYYY-MM-DD" text, compared in text order.
 */

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Where the telemetry tables live: daily and hourly rollups in the platform rows, minute samples in the short-lived rows. */
export interface TelemetryRows {
  platform: RowReader;
  ephemeral: RowReader;
}

const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: string, n: number) => utcDay(dayStart(day) + n * DAY_MS);

/** The UTC days from [from] to [to], inclusive (at most [max]). */
export function daysBetween(from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}

interface ActivityRow {
  day: string;
  user_id: string;
  platform: string;
  client_version: string;
  first_at: number;
  last_at: number;
  requests: number;
  actions: number;
  first_action_at: number | null;
  signup_at: number | null;
}

interface TrafficRow {
  day: string;
  user_id: string;
  metric: string;
  value: number;
}

interface PresenceSample {
  minute: number;
  users: number;
  active_users: number;
  sockets: number;
  connects: number;
  disconnects: number;
  abnormal: number;
  auth_failures: number;
}

interface PresenceHour {
  hour: number;
  peak_users: number;
  avg_users: number;
  peak_sockets: number;
  connects: number;
  disconnects: number;
  abnormal: number;
  auth_failures: number;
}

interface ResourceSample {
  series: string;
  minute: number;
  value: number;
}

interface ResourceHour {
  series: string;
  hour: number;
  avg: number;
  min: number;
  max: number;
  samples: number;
}

const notExcluded = (excluded: readonly string[]): Where => (excluded.length ? { user_id: { notIn: [...excluded] } } : {});
const distinctUsers = (rows: { user_id: string }[]) => new Set(rows.map((r) => r.user_id)).size;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

/** Rows grouped by [key], in first-seen order. */
function groupBy<R>(rows: R[], key: (r: R) => string): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** Rows of a daily table on the days [from]..[to] (inclusive), with [where]. */
function daily<R extends { day: string }>(rows: RowReader, table: string, from: string, to: string, where: Where): R[] {
  return rows.all<R>(table, { where: { ...where, day: { gte: from } } }).filter((r) => r.day <= to);
}

const activity = (r: TelemetryRows, from: string, to: string, excluded: readonly string[], where: Where = {}) =>
  daily<ActivityRow>(r.platform, "activity_daily", from, to, { ...notExcluded(excluded), ...where });

const traffic = (r: TelemetryRows, from: string, to: string, where: Where) => daily<TrafficRow>(r.platform, "traffic_user_daily", from, to, where);

export interface ActiveUsersPoint {
  day: string;
  dau: number;
  wau: number;
  mau: number;
  newActive: number;
  returningActive: number;
}

/**
 * DAU, WAU and MAU for each day in [from, to]: distinct people with qualifying activity on the day, and over the 7 and
 * 30 UTC days ending with it. New: their identity was created that UTC day. Days before collection began are left out
 * by the caller (they'd read as zero, which isn't true).
 */
export function activeUsers(r: TelemetryRows, from: string, to: string, excluded: readonly string[]): ActiveUsersPoint[] {
  const rows = activity(r, addDays(from, -29), to, excluded);
  const within = (f: string, t: string) => distinctUsers(rows.filter((x) => x.day >= f && x.day <= t));
  return daysBetween(from, to, 120).map((day) => {
    const today = rows.filter((x) => x.day === day);
    const total = distinctUsers(today);
    const fresh = distinctUsers(today.filter((x) => x.signup_at !== null && utcDay(x.signup_at) === day));
    return { day, dau: total, wau: within(addDays(day, -6), day), mau: within(addDays(day, -29), day), newActive: fresh, returningActive: total - fresh };
  });
}

/** Distinct active people over [from, to] (inclusive UTC days). */
export function distinctActive(r: TelemetryRows, from: string, to: string, excluded: readonly string[]): number {
  return distinctUsers(activity(r, from, to, excluded));
}

/** Distinct active people per platform and per client version over [from, to]. A person on two platforms counts in both. */
export function activeByClient(r: TelemetryRows, from: string, to: string, excluded: readonly string[]) {
  const rows = activity(r, from, to, excluded);
  const platforms = [...groupBy(rows, (x) => x.platform).entries()]
    .map(([platform, xs]) => ({ platform, users: distinctUsers(xs), requests: sum(xs.map((x) => x.requests)) }))
    .sort((a, b) => b.users - a.users);
  const versions = [...groupBy(rows, (x) => `${x.platform}\n${x.client_version}`).values()]
    .map((xs) => ({ platform: xs[0]!.platform, version: xs[0]!.client_version, users: distinctUsers(xs) }))
    .sort((a, b) => b.users - a.users)
    .slice(0, 50);
  return { platforms, versions };
}

/** Active people over [from, to] by account age on their last active day: under a day, a week, a month, older. */
export function activeByAccountAge(r: TelemetryRows, from: string, to: string, excluded: readonly string[]): { bucket: string; users: number }[] {
  const ages = new Map<string, number>();
  for (const x of activity(r, from, to, excluded, { signup_at: { ne: null } })) {
    const age = (dayStart(x.day) - dayStart(utcDay(x.signup_at!))) / DAY_MS;
    ages.set(x.user_id, Math.max(ages.get(x.user_id) ?? -Infinity, age));
  }
  const buckets = [
    { bucket: "Signed up that day", max: 0 },
    { bucket: "1–7 days", max: 7 },
    { bucket: "8–30 days", max: 30 },
    { bucket: "31–90 days", max: 90 },
    { bucket: "Older", max: Infinity },
  ];
  const all = [...ages.values()];
  return buckets.map((b, i) => ({ bucket: b.bucket, users: all.filter((age) => age <= b.max && (i === 0 || age > buckets[i - 1]!.max)).length }));
}

/**
 * Retention cohorts: people who signed up on each UTC day in [from, to], and how many of them had qualifying activity
 * exactly 1, 7 and 30 days later. [signups] (per day, from the accounts module) are the denominators. A cohort whose
 * day N hasn't finished yet, or began before collection started, has null for that day (not yet measurable).
 */
export function retention(
  r: TelemetryRows,
  signups: { day: string; count: number }[],
  excluded: readonly string[],
  today: string,
  collectingSince: string | null,
): { day: string; size: number; d1: number | null; d7: number | null; d30: number | null }[] {
  return signups.map(({ day, count }) => {
    const at = (offset: number) => {
      const target = addDays(day, offset);
      if (target >= today) return null; // the day isn't over
      if (!collectingSince || target < collectingSince) return null; // nothing was collected then
      const rows = r.platform.all<ActivityRow>("activity_daily", { where: { ...notExcluded(excluded), day: target, signup_at: { gte: dayStart(day) } } });
      return distinctUsers(rows.filter((x) => x.signup_at! < dayStart(day) + DAY_MS));
    };
    return { day, size: count, d1: at(1), d7: at(7), d30: at(30) };
  });
}

/**
 * Activation: of people who signed up in [from, to] (and since collection began), how many made a meaningful action
 * within 7 days of signing up, and the median time to that first action.
 */
export function activation(r: TelemetryRows, from: number, to: number, excluded: readonly string[]): { activated: number; medianMsToFirstAction: number | null } {
  const rows = r.platform
    .all<ActivityRow>("activity_daily", { where: { ...notExcluded(excluded), signup_at: { gte: from }, first_action_at: { ne: null } } })
    .filter((x) => x.signup_at! < to && x.first_action_at! < x.signup_at! + 7 * DAY_MS);
  const ms = [...groupBy(rows, (x) => x.user_id).values()].map((xs) => Math.min(...xs.map((x) => x.first_action_at!)) - Math.min(...xs.map((x) => x.signup_at!)));
  const sorted = ms.map((m) => Math.max(0, m)).sort((a, b) => a - b);
  const median = sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]!;
  return { activated: ms.length, medianMsToFirstAction: median };
}

/** Distinct active people among [memberIds] (an organization's members) over [from, to]. */
export function activeAmong(r: TelemetryRows, memberIds: readonly string[], from: string, to: string, excluded: readonly string[]): { users: number; lastAt: number | null } {
  const rows = activity(r, from, to, [], { user_id: { in: memberIds.filter((id) => !excluded.includes(id)) } });
  return { users: distinctUsers(rows), lastAt: rows.length ? Math.max(...rows.map((x) => x.last_at)) : null };
}

/** One person's activity by day (the user detail page). */
export function userActivity(r: TelemetryRows, userId: string, from: string): { day: string; platform: string; version: string; requests: number; actions: number; firstAt: number; lastAt: number }[] {
  return r.platform
    .all<ActivityRow>("activity_daily", { where: { user_id: userId, day: { gte: from } }, orderBy: [["day", "desc"], ["last_at", "desc"]], limit: 400 })
    .map((x) => ({ day: x.day, platform: x.platform, version: x.client_version, requests: x.requests, actions: x.actions, firstAt: x.first_at, lastAt: x.last_at }));
}

/** One person's last qualifying activity and platforms ever seen (bounded). */
export function userLastActive(r: TelemetryRows, userIds: string[]): Map<string, { lastAt: number; platforms: string[] }> {
  const out = new Map<string, { lastAt: number; platforms: string[] }>();
  if (userIds.length === 0) return out;
  for (const [userId, xs] of groupBy(r.platform.all<ActivityRow>("activity_daily", { where: { user_id: { in: userIds } } }), (x) => x.user_id)) {
    out.set(userId, { lastAt: Math.max(...xs.map((x) => x.last_at)), platforms: [...new Set(xs.map((x) => x.platform))].filter(Boolean) });
  }
  return out;
}

// ───────────── Traffic ─────────────

/** Bytes per metric and UTC day over [from, to], [excluded] left out. */
export function trafficDays(r: TelemetryRows, from: string, to: string, excluded: readonly string[]): { day: string; metric: string; value: number }[] {
  return [...groupBy(traffic(r, from, to, notExcluded(excluded)), (x) => `${x.day}\n${x.metric}`).values()]
    .map((xs) => ({ day: xs[0]!.day, metric: xs[0]!.metric, value: sum(xs.map((x) => x.value)) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0));
}

/** The people who moved the most bytes over [from, to] (ids only; the caller adds names it may show). */
export function topTraffic(r: TelemetryRows, from: string, to: string, excluded: readonly string[], limit: number): { userId: string; total: number; byMetric: Record<string, number> }[] {
  const by = new Map<string, Record<string, number>>();
  for (const x of traffic(r, from, to, notExcluded(excluded))) {
    const m = by.get(x.user_id) ?? {};
    by.set(x.user_id, { ...m, [x.metric]: (m[x.metric] ?? 0) + x.value });
  }
  return [...by.entries()]
    .map(([userId, byMetric]) => ({ userId, byMetric, total: sum(Object.values(byMetric)) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** One person's bytes per metric over [from, to]. */
export function userTraffic(r: TelemetryRows, userId: string, from: string, to: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of traffic(r, from, to, { user_id: userId })) out[x.metric] = (out[x.metric] ?? 0) + x.value;
  return out;
}

// ───────────── Presence and resources ─────────────

export interface PresencePoint {
  at: number;
  users: number;
  activeUsers: number;
  sockets: number;
  connects: number;
  disconnects: number;
  abnormal: number;
  authFailures: number;
}

/** Rows of a per-minute table with minute in [fromMinute, toMinute], in minute order. */
function minutes<R extends { minute: number }>(rows: RowReader, table: string, fromMinute: number, toMinute: number, where: Where = {}): R[] {
  return rows.all<R>(table, { where: { ...where, minute: { gte: fromMinute } }, orderBy: [["minute", "asc"]] }).filter((x) => x.minute <= toMinute);
}

/** Rows of an hourly table with hour in [fromHour, toHour], in hour order. */
function hours<R extends { hour: number }>(rows: RowReader, table: string, fromHour: number, toHour: number, where: Where = {}): R[] {
  return rows.all<R>(table, { where: { ...where, hour: { gte: fromHour } }, orderBy: [["hour", "asc"]] }).filter((x) => x.hour <= toHour);
}

/** Minute samples per hour, in hour order (the hours not rolled up yet). */
function byHour<R extends { minute: number }>(rows: R[]): [number, R[]][] {
  return [...groupBy(rows, (x) => String(Math.floor(x.minute / 60))).entries()].map(([h, xs]): [number, R[]] => [Number(h), xs]).sort(([a], [b]) => a - b);
}

const peakOf = (points: PresencePoint[]) => points.reduce<PresencePoint | null>((a, p) => (!a || p.users > a.users ? p : a), null);

/**
 * Concurrency over [from, to] (ms): per-minute samples for up to 2 days, hourly rollups beyond. Peak is the highest
 * sample in the range.
 */
export function presenceSeries(r: TelemetryRows, from: number, to: number): { resolution: "minute" | "hour"; points: PresencePoint[]; peakUsers: number | null; peakAt: number | null } {
  if (to - from <= 2 * DAY_MS) {
    const points = minutes<PresenceSample>(r.ephemeral, "presence_samples", Math.floor(from / MINUTE_MS), Math.floor(to / MINUTE_MS)).map((x) => ({
      at: x.minute * MINUTE_MS,
      users: x.users,
      activeUsers: x.active_users,
      sockets: x.sockets,
      connects: x.connects,
      disconnects: x.disconnects,
      abnormal: x.abnormal,
      authFailures: x.auth_failures,
    }));
    const peak = peakOf(points);
    return { resolution: "minute", points, peakUsers: peak?.users ?? null, peakAt: peak?.at ?? null };
  }
  const rows = hours<PresenceHour>(r.platform, "presence_hourly", Math.floor(from / HOUR_MS), Math.floor(to / HOUR_MS));
  const points = rows.map((x) => ({
    at: x.hour * HOUR_MS,
    users: x.peak_users,
    activeUsers: Math.round(x.avg_users),
    sockets: x.peak_sockets,
    connects: x.connects,
    disconnects: x.disconnects,
    abnormal: x.abnormal,
    authFailures: x.auth_failures,
  }));
  // The hours not rolled up yet (the current one, at least), from their minute samples.
  const after = (rows.length ? rows[rows.length - 1]!.hour + 1 : Math.floor(from / HOUR_MS)) * 60;
  for (const [hour, xs] of byHour(minutes<PresenceSample>(r.ephemeral, "presence_samples", after, Math.floor(to / MINUTE_MS)))) {
    points.push({
      at: hour * HOUR_MS,
      users: Math.max(...xs.map((x) => x.users)),
      activeUsers: Math.round(avg(xs.map((x) => x.active_users))!),
      sockets: Math.max(...xs.map((x) => x.sockets)),
      connects: sum(xs.map((x) => x.connects)),
      disconnects: sum(xs.map((x) => x.disconnects)),
      abnormal: sum(xs.map((x) => x.abnormal)),
      authFailures: sum(xs.map((x) => x.auth_failures)),
    });
  }
  const peak = peakOf(points);
  return { resolution: "hour", points, peakUsers: peak?.users ?? null, peakAt: peak?.at ?? null };
}

export interface SeriesStats {
  series: string;
  resolution: "minute" | "hour";
  points: { at: number; value: number; min?: number; max?: number }[];
  latest: number | null;
  latestAt: number | null;
  min: number | null;
  avg: number | null;
  max: number | null;
  p95: number | null;
}

/** [series] over [from, to] (ms): per minute for up to 2 days (at most 1440 points, downsampled), hourly beyond. */
export function resourceSeries(r: TelemetryRows, series: string[], from: number, to: number): SeriesStats[] {
  const minuteRange = to - from <= 2 * DAY_MS;
  return series.map((name) => {
    let points: { at: number; value: number; min?: number; max?: number }[];
    if (minuteRange) {
      points = minutes<ResourceSample>(r.ephemeral, "resource_samples", Math.floor(from / MINUTE_MS), Math.floor(to / MINUTE_MS), { series: name }).map((x) => ({ at: x.minute * MINUTE_MS, value: x.value }));
    } else {
      const rows = hours<ResourceHour>(r.platform, "resource_hourly", Math.floor(from / HOUR_MS), Math.floor(to / HOUR_MS), { series: name });
      points = rows.map((x) => ({ at: x.hour * HOUR_MS, value: x.avg, min: x.min, max: x.max }));
      // Hours not rolled up yet, from their minute samples.
      const after = (rows.length ? rows[rows.length - 1]!.hour + 1 : Math.floor(from / HOUR_MS)) * 60;
      for (const [hour, xs] of byHour(minutes<ResourceSample>(r.ephemeral, "resource_samples", after, Math.floor(to / MINUTE_MS), { series: name }))) {
        const values = xs.map((x) => x.value);
        points.push({ at: hour * HOUR_MS, value: avg(values)!, min: Math.min(...values), max: Math.max(...values) });
      }
    }
    const values = points.map((p) => p.value);
    const sorted = [...values].sort((a, b) => a - b);
    const last = points[points.length - 1];
    return {
      series: name,
      resolution: minuteRange ? "minute" : "hour",
      points: downsample(points, 720),
      latest: last?.value ?? null,
      latestAt: last?.at ?? null,
      min: sorted.length ? Math.min(...points.map((p) => p.min ?? p.value)) : null,
      avg: avg(values),
      max: sorted.length ? Math.max(...points.map((p) => p.max ?? p.value)) : null,
      p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]! : null,
    };
  });
}

/** Keeps at most [max] points, averaging neighbours (and keeping their min and max). */
function downsample(points: { at: number; value: number; min?: number; max?: number }[], max: number) {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out: { at: number; value: number; min?: number; max?: number }[] = [];
  for (let i = 0; i < points.length; i += step) {
    const chunk = points.slice(i, i + step);
    out.push({
      at: chunk[0]!.at,
      value: chunk.reduce((a, p) => a + p.value, 0) / chunk.length,
      min: Math.min(...chunk.map((p) => p.min ?? p.value)),
      max: Math.max(...chunk.map((p) => p.max ?? p.value)),
    });
  }
  return out;
}

/** The newest value of every series measured in the last [withinMs] (the inventory's "now"). */
export function latestResources(r: TelemetryRows, now: number, withinMs: number): Map<string, { value: number; at: number }> {
  const out = new Map<string, { value: number; at: number }>();
  for (const x of minutes<ResourceSample>(r.ephemeral, "resource_samples", Math.floor((now - withinMs) / MINUTE_MS), Number.MAX_SAFE_INTEGER)) {
    out.set(x.series, { value: x.value, at: x.minute * MINUTE_MS });
  }
  return out;
}

/** Average, max, sum and sample count of [series] since [sinceMinute] (alert rules). */
export function windowStats(r: TelemetryRows, series: string, sinceMinute: number): { avg: number | null; max: number | null; sum: number | null; samples: number } {
  const values = r.ephemeral.all<ResourceSample>("resource_samples", { where: { series, minute: { gt: sinceMinute } } }).map((x) => x.value);
  return { avg: avg(values), max: values.length ? Math.max(...values) : null, sum: values.length ? sum(values) : null, samples: values.length };
}

/** Connection events summed since [sinceMinute] (alert rules). */
export function presenceWindow(r: TelemetryRows, sinceMinute: number): { samples: number; abnormal: number; authFailures: number; connects: number; peakUsers: number | null } {
  const xs = r.ephemeral.all<PresenceSample>("presence_samples", { where: { minute: { gt: sinceMinute } } });
  return {
    samples: xs.length,
    abnormal: sum(xs.map((x) => x.abnormal)),
    authFailures: sum(xs.map((x) => x.auth_failures)),
    connects: sum(xs.map((x) => x.connects)),
    peakUsers: xs.length ? Math.max(...xs.map((x) => x.users)) : null,
  };
}

/** The hourly average of [series] over [fromHour, toHour] (a baseline for anomaly rules), with how many hours it covers. */
export function hourlyBaseline(r: TelemetryRows, series: string, fromHour: number, toHour: number): { avg: number | null; hours: number } {
  const xs = hours<ResourceHour>(r.platform, "resource_hourly", fromHour, toHour, { series });
  return { avg: avg(xs.map((x) => x.avg)), hours: xs.length };
}

/** The people with qualifying activity over [from, to] (inclusive UTC days), at most [limit] (filters in the console). */
export function activeUserIds(r: TelemetryRows, from: string, to: string, limit: number): string[] {
  return [...new Set(activity(r, from, to, []).map((x) => x.user_id))].slice(0, limit);
}

/** The client each of [sessionIds] was last seen with. */
export function sessionClients(r: TelemetryRows, sessionIds: string[]): Map<string, { platform: string; client: string; version: string; os: string; lastSeenAt: number }> {
  if (sessionIds.length === 0) return new Map();
  const rows = r.platform.all<{ session_id: string; platform: string; client: string; client_version: string; os: string; last_seen_at: number }>("session_clients", {
    where: { session_id: { in: sessionIds } },
  });
  return new Map(rows.map((x) => [x.session_id, { platform: x.platform, client: x.client, version: x.client_version, os: x.os, lastSeenAt: x.last_seen_at }]));
}

/** Device ids whose latest session was seen on [platform] (inventory filter), from the sessions telemetry knows. */
export function sessionsOnPlatform(r: TelemetryRows, platform: string, limit: number): string[] {
  return r.platform.all<{ session_id: string }>("session_clients", { where: { platform }, orderBy: [["last_seen_at", "desc"]], limit }).map((x) => x.session_id);
}

/** Every server version this database has run, with its first start (telemetry_epochs "version:*"). */
export function versions(r: TelemetryRows): { version: string; firstStartedAt: number }[] {
  return r.platform
    .all<{ kind: string; started_at: number }>("telemetry_epochs", { orderBy: [["started_at", "desc"]] })
    .filter((x) => x.kind.startsWith("version:"))
    .slice(0, 50)
    .map((x) => ({ version: x.kind.slice(8), firstStartedAt: x.started_at }));
}

const minuteValues = (r: TelemetryRows, series: string, from: number, to: number) =>
  minutes<ResourceSample>(r.ephemeral, "resource_samples", Math.floor(from / MINUTE_MS), Math.floor(to / MINUTE_MS), { series }).map((x) => x.value);
const hourRows = (r: TelemetryRows, series: string, from: number, to: number) => hours<ResourceHour>(r.platform, "resource_hourly", Math.floor(from / HOUR_MS), Math.floor(to / HOUR_MS), { series });

/** The total of a per-second rate series over [from, to] (bytes from bytes-per-second samples), or null with no samples. */
export function seriesTotal(r: TelemetryRows, series: string, from: number, to: number): number | null {
  if (to - from <= 2 * DAY_MS) {
    const values = minuteValues(r, series, from, to);
    return values.length ? sum(values) * 60 : null;
  }
  const rows = hourRows(r, series, from, to);
  return rows.length ? sum(rows.map((h) => h.avg * h.samples * 60)) : null;
}

/** Sum of a per-minute count series over [from, to] (requests, errors), or null with no samples. */
export function seriesSum(r: TelemetryRows, series: string, from: number, to: number): number | null {
  const values = minuteValues(r, series, from, to);
  if (values.length) return sum(values);
  const rows = hourRows(r, series, from, to);
  return rows.length ? sum(rows.map((h) => h.avg * h.samples)) : null;
}

/** Average of a series over [from, to] (minute samples, or hourly averages beyond 2 days), or null. */
export function seriesAvg(r: TelemetryRows, series: string, from: number, to: number): number | null {
  if (to - from <= 2 * DAY_MS) return avg(minuteValues(r, series, from, to));
  const rows = hourRows(r, series, from, to);
  const samples = sum(rows.map((h) => h.samples));
  return samples ? sum(rows.map((h) => h.avg * h.samples)) / samples : null;
}

/** Distinct people with qualifying activity whose activity that day overlaps [from, to] (exact when [to] is now). */
export function activeBetween(r: TelemetryRows, from: number, to: number, excluded: readonly string[]): number {
  return distinctUsers(activity(r, utcDay(from), utcDay(to), excluded, { last_at: { gte: from }, first_at: { lte: to } }));
}

/** The trend of a gauge series over the last [days] days of hourly rollups: value per day (least squares), or null. */
export function dailySlope(r: TelemetryRows, series: string, now: number, days: number): number | null {
  const rows = r.platform.all<ResourceHour>("resource_hourly", { where: { series, hour: { gte: Math.floor((now - days * DAY_MS) / HOUR_MS) } }, orderBy: [["hour", "asc"]] });
  if (rows.length < 24) return null;
  const xs = rows.map((x) => x.hour / 24);
  const ys = rows.map((x) => x.avg);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den === 0 ? null : num / den;
}
