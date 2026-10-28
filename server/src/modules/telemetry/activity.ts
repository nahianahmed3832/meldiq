import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import type { ClientInfo, Platform } from "./client.js";

/**
 * Activity and traffic counters (docs/ANALYTICS_DEFINITIONS.md). The API's own request handling feeds them (a trusted,
 * server-side signal: clients can't report activity for anyone else). They're kept in memory and written once a minute
 * in one write unit, so a request never waits on them; at most a minute of counts is lost if the process dies.
 */

/** Background traffic: refreshing tokens, fetching or acknowledging the queue, push registration, feature probes. */
const PASSIVE = new Set([
  "POST /v2/auth/refresh",
  "GET /v1/queue",
  "POST /v1/queue/ack",
  "PUT /v1/devices/current/fcm",
  "DELETE /v1/devices/current/fcm",
  "PUT /v1/devices/current/push",
  "DELETE /v1/devices/current/push",
  "GET /v1/experiments",
  "POST /v1/analytics/events",
  "GET /v1/platform/me",
  "GET /v1/presence",
  "POST /v1/reminders/:id/ack",
  "POST /v1/calls/:id/alerted",
  "GET /v1/ws",
]);

/** Server-verified meaningful actions (a message, an upload, a call, joining or creating a space). */
const ACTIONS = new Set([
  "POST /v1/attachments",
  "POST /v1/attachments/uploads/:id/complete",
  "POST /v1/calls",
  "POST /v1/calls/:id/join",
  "POST /v1/orgs",
  "POST /v1/orgs/:orgId/channels",
  "POST /v1/communities/:id/join",
  "POST /v1/invites/accept",
  "POST /v1/conversations/:id/join",
  "POST /v1/conversations/dm",
  "POST /v1/conversations/group",
]);

export type RequestKind = "passive" | "activity" | "action";

/** How a successful authenticated request counts (pure; unit-tested). Messages count only when they're messages. */
export function requestKind(method: string, route: string, body?: unknown): RequestKind {
  const key = `${method} ${route}`;
  if (PASSIVE.has(key)) return "passive";
  if (key === "POST /v1/messages") return (body as { cls?: unknown } | undefined)?.cls === "message" ? "action" : "activity";
  return ACTIONS.has(key) ? "action" : "activity";
}

/** Bytes per person and day, plus one count: "messages", message envelopes accepted (cls "message"; never their content). */
export const TRAFFIC_METRICS = ["api.in", "api.out", "ws.in", "ws.out", "files.upload", "files.download", "messages"] as const;
export type TrafficMetric = (typeof TRAFFIC_METRICS)[number];

/** People counted as "actively using" when their last qualifying request is this recent. */
export const ACTIVE_NOW_MS = 5 * 60_000;

interface DayEntry {
  day: string;
  userId: string;
  platform: Platform;
  version: string;
  firstAt: number;
  lastAt: number;
  requests: number;
  actions: number;
  firstActionAt: number | null;
}

interface SessionSeen {
  sessionId: string;
  client: ClientInfo;
  firstAt: number;
  lastAt: number;
}

export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export class ActivityTracker {
  private days = new Map<string, DayEntry>();
  private traffic = new Map<string, { day: string; userId: string; metric: TrafficMetric; bytes: number }>();
  private sessions = new Map<string, SessionSeen>();
  private lastActive = new Map<string, number>();
  private lastPlatform = new Map<string, Platform>();

  /** One qualifying request (or action) by [userId] from [client] at [t]. */
  record(userId: string, client: ClientInfo, t: number, action: boolean): void {
    const day = utcDay(t);
    const key = `${day}|${userId}|${client.platform}|${client.version}`;
    const e = this.days.get(key) ?? { day, userId, platform: client.platform, version: client.version, firstAt: t, lastAt: t, requests: 0, actions: 0, firstActionAt: null };
    this.days.set(key, {
      ...e,
      lastAt: Math.max(e.lastAt, t),
      firstAt: Math.min(e.firstAt, t),
      requests: e.requests + 1,
      actions: e.actions + (action ? 1 : 0),
      firstActionAt: action ? Math.min(e.firstActionAt ?? t, t) : e.firstActionAt,
    });
    if (t >= (this.lastActive.get(userId) ?? 0)) {
      this.lastActive.set(userId, t);
      this.lastPlatform.set(userId, client.platform);
    }
  }

  addTraffic(userId: string, metric: TrafficMetric, bytes: number, t: number): void {
    if (!(bytes > 0)) return;
    const day = utcDay(t);
    const key = `${day}|${userId}|${metric}`;
    const prev = this.traffic.get(key)?.bytes ?? 0;
    this.traffic.set(key, { day, userId, metric, bytes: prev + Math.round(bytes) });
  }

  /** The client an app session was seen with (for the device inventory). */
  noteSession(sessionId: string, client: ClientInfo, t: number): void {
    const prev = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { sessionId, client, firstAt: prev?.firstAt ?? t, lastAt: t });
  }

  /** People with qualifying activity since [since], overall and per platform (also prunes older entries). */
  activeSince(since: number): { users: number; platforms: Record<string, number> } {
    const platforms: Record<string, number> = {};
    let users = 0;
    for (const [userId, at] of this.lastActive) {
      if (at < since) {
        this.lastActive.delete(userId);
        this.lastPlatform.delete(userId);
        continue;
      }
      users += 1;
      const p = this.lastPlatform.get(userId) ?? "unknown";
      platforms[p] = (platforms[p] ?? 0) + 1;
    }
    return { users, platforms };
  }

  /** Whether [userId] had qualifying activity since [since]. */
  isActiveSince(userId: string, since: number): boolean {
    return (this.lastActive.get(userId) ?? 0) >= since;
  }

  /**
   * Writes everything gathered since the last flush (one unit of the platform rows). Returns rows written.
   * [signupAt]: the identities' creation times (the accounts module's), stored with each row for cohorts. What is
   * written is taken out first; if the unit fails it is merged back, so counts arriving meanwhile aren't lost.
   */
  async flush(rows: Rows, signupAt: (userIds: string[]) => Map<string, number> = () => new Map()): Promise<number> {
    const days = this.days;
    const traffic = this.traffic;
    const sessions = this.sessions;
    const n = days.size + traffic.size + sessions.size;
    if (n === 0) return 0;
    this.days = new Map();
    this.traffic = new Map();
    this.sessions = new Map();
    try {
      const signups = days.size ? signupAt([...new Set([...days.values()].map((d) => d.userId))]) : new Map<string, number>();
      await rows.write((w) => {
        for (const d of days.values()) upsertDay(w, d, signups.get(d.userId) ?? null);
        for (const x of traffic.values()) upsertTraffic(w, x);
        for (const s of sessions.values()) upsertSession(w, s);
      });
    } catch (e) {
      for (const [k, d] of days) this.days.set(k, mergeDays(d, this.days.get(k)));
      for (const [k, x] of traffic) this.traffic.set(k, { ...x, bytes: x.bytes + (this.traffic.get(k)?.bytes ?? 0) });
      for (const [k, s] of sessions) {
        const later = this.sessions.get(k);
        this.sessions.set(k, later ? { ...later, firstAt: Math.min(s.firstAt, later.firstAt) } : s);
      }
      throw e;
    }
    return n;
  }
}

const minOrNull = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** Two counts of the same day, person and client, as one. */
function mergeDays(a: DayEntry, b: DayEntry | undefined): DayEntry {
  if (!b) return a;
  return {
    ...a,
    firstAt: Math.min(a.firstAt, b.firstAt),
    lastAt: Math.max(a.lastAt, b.lastAt),
    requests: a.requests + b.requests,
    actions: a.actions + b.actions,
    firstActionAt: minOrNull(a.firstActionAt, b.firstActionAt),
  };
}

function upsertDay(w: RowWriter, d: DayEntry, signupAt: number | null): void {
  const key = { day: d.day, user_id: d.userId, platform: d.platform, client_version: d.version };
  const prev = w.get<{ first_at: number; last_at: number; requests: number; actions: number; first_action_at: number | null; signup_at: number | null }>("activity_daily", key);
  if (!prev) {
    w.insert("activity_daily", { ...key, first_at: d.firstAt, last_at: d.lastAt, requests: d.requests, actions: d.actions, first_action_at: d.firstActionAt, signup_at: signupAt });
    return;
  }
  w.update("activity_daily", key, {
    first_at: Math.min(prev.first_at, d.firstAt),
    last_at: Math.max(prev.last_at, d.lastAt),
    requests: prev.requests + d.requests,
    actions: prev.actions + d.actions,
    first_action_at: minOrNull(prev.first_action_at, d.firstActionAt),
    signup_at: prev.signup_at ?? signupAt,
  });
}

function upsertTraffic(w: RowWriter, x: { day: string; userId: string; metric: TrafficMetric; bytes: number }): void {
  const key = { day: x.day, user_id: x.userId, metric: x.metric };
  const prev = w.get<{ value: number }>("traffic_user_daily", key);
  if (prev) w.update("traffic_user_daily", key, { value: prev.value + x.bytes });
  else w.insert("traffic_user_daily", { ...key, value: x.bytes });
}

function upsertSession(w: RowWriter, s: SessionSeen): void {
  const client = { platform: s.client.platform, client: s.client.client, client_version: s.client.version, os: s.client.os };
  const prev = w.get<{ last_seen_at: number }>("session_clients", { session_id: s.sessionId });
  if (prev) w.update("session_clients", { session_id: s.sessionId }, { ...client, last_seen_at: Math.max(prev.last_seen_at, s.lastAt) });
  else w.insert("session_clients", { session_id: s.sessionId, ...client, first_seen_at: s.firstAt, last_seen_at: s.lastAt });
}
