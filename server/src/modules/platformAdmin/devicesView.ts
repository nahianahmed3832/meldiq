import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { forbidden, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { deviceCounts, deviceOf, type DeviceInventoryRow, devicesPage, latestSessionOfDevices, userDevices, userSummary, usernames } from "../accounts/index.js";
import { legacySessionCount, revokeUserDevice } from "../auth/index.js";
import { pushStatus } from "../notifications/index.js";
import { authHistory } from "../organizations/index.js";
import { ACTIVE_NOW_MS, analytics } from "../telemetry/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { decodeCursor, page } from "./pagination.js";
import type { Exclusions } from "./exclusions.js";
import type { PlatformAdminStore } from "./store.js";

const DAY_MS = 86_400_000;
/** Live connections listed at once (the hub holds them all; the table shows the most recent). */
const CONNECTIONS_SHOWN = 500;
const SESSIONS_SHOWN = 50;
const AUTH_EVENTS_SHOWN = 50;
/** Sessions that ended within this long are still listed (with why they ended). */
const RECENT_ENDED_MS = 30 * DAY_MS;

/** A session id with its middle hidden: enough to tell sessions apart, useless as a credential (it isn't one anyway). */
export const maskId = (id: string) => (id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`);

const AUTH_LABELS: Record<string, string> = {
  "account.login": "Signed in",
  "account.login_failed": "Wrong password",
  "account.refresh_reuse": "Old refresh token reused (session revoked)",
  "account.password_change": "Password changed",
  "account.password_reset": "Password reset by email",
  "account.delete": "Account deleted",
};

/**
 * Devices, sessions and live connections (docs/DEVICES_AND_SESSIONS.md). What the server really holds: device names
 * people chose, when they were added and last seen, the client kind seen on each session, wake-up registration state
 * (never the token), sessions with their expiry and how they ended, and the sockets open now. Revoking ends the
 * server-side session or device: access tokens of a revoked session are refused at once (every request reads the
 * session), and open sockets are closed and re-checked on every frame.
 */
export class AdminDevices {
  constructor(
    private readonly ctx: AppContext,
    private readonly store: PlatformAdminStore,
    private readonly audit: PlatformAudit,
    private readonly exclusions: Exclusions,
  ) {}

  private rows(devices: DeviceInventoryRow[]) {
    const ids = devices.map((d) => d.id);
    const push = pushStatus(this.ctx.db, ids);
    const latest = latestSessionOfDevices(this.ctx.db, ids);
    const clients = analytics.sessionClients(this.ctx.db, [...latest.values()]);
    return devices.map((d) => {
      const c = latest.has(d.id) ? clients.get(latest.get(d.id)!) : undefined;
      return {
        id: d.id,
        userId: d.user_id,
        username: d.username,
        name: d.name,
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        revokedAt: d.revoked_at,
        platform: c?.platform ?? null,
        client: c?.client ?? null,
        version: c?.version || null,
        os: c?.os || null,
        online: this.ctx.hub.isDeviceOnline(d.id),
        push: push.get(d.id) ?? { fcm: "none" as const, unifiedPush: "none" as const, lastWakeAt: null },
      };
    });
  }

  inventory(q: { platform?: string; staleDays?: number; status?: "active" | "revoked"; cursor?: string; limit: number }) {
    const after = decodeCursor(q.cursor);
    let ids: string[] | undefined;
    if (q.platform) {
      // Devices whose latest session was seen on that platform (only devices with a v2 session are classified).
      const sessions = new Set(analytics.sessionsOnPlatform(this.ctx.db, q.platform, 50_000));
      const candidates = devicesPage(this.ctx.db, { status: q.status, limit: 50_000 });
      const latest = latestSessionOfDevices(this.ctx.db, candidates.map((d) => d.id));
      ids = candidates.filter((d) => sessions.has(latest.get(d.id) ?? "")).map((d) => d.id);
    }
    const rows = devicesPage(this.ctx.db, { status: q.status, staleBefore: q.staleDays ? now() - q.staleDays * DAY_MS : undefined, ids, after, limit: q.limit + 1 });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    const counts = deviceCounts(this.ctx.db);
    return { devices: this.rows(shown), nextCursor, counts: { active: counts.active, revoked: counts.revoked, online: this.ctx.hub.onlineDeviceCount() } };
  }

  async ofUser(userId: string) {
    const u = userSummary(this.ctx.db, userId);
    if (!u) throw notFound("No such person");
    const t = now();
    const own = devicesPage(this.ctx.db, { ids: userDevices(this.ctx.db, userId).map((d) => d.id), limit: 100 });
    const account = await this.ctx.accounts.store.accountByUserId(userId);
    const sessions = account ? await this.ctx.accounts.store.recentSessions(account.id, t - RECENT_ENDED_MS, SESSIONS_SHOWN) : [];
    const clients = analytics.sessionClients(this.ctx.db, sessions.map((s) => s.id));
    const conns = this.ctx.hub.connections().filter((c) => c.userId === userId);
    const connectedSessions = new Set(conns.map((c) => c.sessionId).filter(Boolean));
    const sessionViews = sessions.map((s) => {
      const state = s.revoked_at !== null ? ("revoked" as const) : s.expires_at <= t || s.refresh_expires_at <= t ? ("expired" as const) : ("active" as const);
      const c = clients.get(s.id);
      return {
        id: s.id,
        masked: maskId(s.id),
        label: s.label,
        deviceId: s.device_id,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
        expiresAt: s.expires_at,
        idleExpiresAt: s.refresh_expires_at,
        revokedAt: s.revoked_at,
        revokeReason: s.revoke_reason,
        state,
        client: c?.client ?? null,
        platform: c?.platform ?? null,
        connected: connectedSessions.has(s.id),
      };
    });
    const history = authHistory(this.ctx.ws, userId, AUTH_EVENTS_SHOWN).map((e) => ({
      at: e.at,
      event: AUTH_LABELS[e.action] ?? e.action.replace(/^account\./, ""),
      detail: e.action === "account.login" ? (e.detail ?? "password") : null,
    }));
    // Things worth a look, from what's measured (never guesses).
    const findings: string[] = [];
    const active = sessionViews.filter((s) => s.state === "active");
    const byDevice = new Map<string, number>();
    for (const s of active) if (s.deviceId) byDevice.set(s.deviceId, (byDevice.get(s.deviceId) ?? 0) + 1);
    for (const [d, n] of byDevice) if (n > 1) findings.push(`Device ${maskId(d)} has ${n} active sessions.`);
    const stale = own.filter((d) => d.revoked_at === null && (d.last_seen_at ?? d.created_at) < t - 90 * DAY_MS);
    if (stale.length) findings.push(`${stale.length} device(s) not seen for 90 days or more.`);
    const unbound = active.filter((s) => !s.deviceId).length;
    if (unbound) findings.push(`${unbound} active session(s) without an encryption device (sign-in finished, setup not).`);
    const failed = history.filter((h) => h.event === "Wrong password" && h.at > t - DAY_MS).length;
    if (failed >= 5) findings.push(`${failed} wrong passwords in the last 24 hours.`);
    if (history.some((h) => h.event.startsWith("Old refresh token"))) findings.push("A refresh token was reused: a copied token may exist (that session was revoked).");
    return {
      devices: this.rows(own),
      sessions: sessionViews,
      legacySessions: legacySessionCount(this.ctx, userId),
      connections: conns.map((c) => ({ deviceId: c.deviceId, platform: c.platform, client: c.client, openedAt: c.openedAt, lastFrameAt: c.lastFrameAt })),
      authHistory: history,
      findings,
    };
  }

  /** Refuses acting on oneself or (unless super admin) another platform admin, like the people actions. */
  private async guard(p: AdminPrincipal, userId: string, action: string, reason: string, meta: RequestMeta) {
    const account = await this.ctx.accounts.store.accountByUserId(userId);
    const why = p.account.user_id === userId ? "self" : account && this.store.activeGrant(account.id) && p.grant.role !== "super_admin" ? "platform_admin" : null;
    if (why) {
      this.audit.record({ action, outcome: "denied", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "user", targetId: userId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { why } });
      throw forbidden(why === "self" ? "You can't do that to your own account." : "Only a super admin can do that to a platform admin.");
    }
    return account;
  }

  async revokeSession(p: AdminPrincipal, userId: string, sessionId: string, reason: string, meta: RequestMeta) {
    const account = await this.guard(p, userId, "user.session_revoke", reason, meta);
    const s = account ? await this.ctx.accounts.store.sessionById(sessionId) : undefined;
    if (!account || !s || s.account_id !== account.id) throw notFound("No such session for this person.");
    const changed = await this.ctx.accounts.store.revokeSession(sessionId, "admin_revoked", now());
    if (s.device_id) this.ctx.hub.disconnectDevice(s.device_id, "session revoked");
    this.audit.record({ action: "user.session_revoke", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "user", targetId: userId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { session: maskId(sessionId), changed } });
    return { ok: true as const };
  }

  async revokeDevice(p: AdminPrincipal, userId: string, deviceId: string, reason: string, meta: RequestMeta) {
    await this.guard(p, userId, "user.device_revoke", reason, meta);
    if (!deviceOf(this.ctx.db, userId, deviceId)) throw notFound("No such device for this person.");
    const changed = await revokeUserDevice(this.ctx, userId, deviceId, "platform_admin");
    this.audit.record({ action: "user.device_revoke", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "user", targetId: userId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { device: deviceId, changed } });
    return { ok: true as const };
  }

  /** Closes sockets without ending sessions: the app reconnects if its session is still valid (a stuck connection). */
  async disconnect(p: AdminPrincipal, userId: string, deviceId: string | undefined, reason: string, meta: RequestMeta) {
    await this.guard(p, userId, "user.disconnect", reason, meta);
    const before = this.ctx.hub.connections().filter((c) => c.userId === userId && (!deviceId || c.deviceId === deviceId)).length;
    if (deviceId) this.ctx.hub.disconnectDevice(deviceId, "closed by an operator");
    else this.ctx.hub.disconnectUser(userId, "closed by an operator");
    this.audit.record({ action: "user.disconnect", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "user", targetId: userId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { device: deviceId ?? null, sockets: before } });
    return { sockets: before };
  }

  /** The sockets open now, most recently opened first (bounded). */
  connections() {
    const all = this.ctx.hub.connections().sort((a, b) => b.openedAt - a.openedAt);
    const shown = all.slice(0, CONNECTIONS_SHOWN);
    const names = usernames(this.ctx.db, [...new Set(shown.map((c) => c.userId))]);
    return {
      connections: shown.map((c) => ({
        userId: c.userId,
        username: names.get(c.userId) ?? null,
        deviceId: c.deviceId,
        session: c.sessionId ? maskId(c.sessionId) : null,
        platform: c.platform,
        client: c.client,
        version: c.version,
        openedAt: c.openedAt,
        lastFrameAt: c.lastFrameAt,
      })),
      truncated: all.length > shown.length,
    };
  }

  /** Concurrency now and over [range] (minute samples, hourly rollups past 2 days). */
  async presence(range: "1h" | "24h" | "7d" | "30d" | "90d") {
    const t = now();
    await this.exclusions.get(t);
    const ms = { "1h": 3_600_000, "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, "90d": 90 * DAY_MS }[range];
    const live = await this.ctx.telemetry.live(t);
    const series = analytics.presenceSeries(this.ctx.db, t - ms, t);
    const totals = series.points.reduce((a, p) => ({ connects: a.connects + p.connects, disconnects: a.disconnects + p.disconnects, abnormal: a.abnormal + p.abnormal, authFailures: a.authFailures + p.authFailures }), {
      connects: 0,
      disconnects: 0,
      abnormal: 0,
      authFailures: 0,
    });
    const open = this.ctx.hub.connections();
    const avg = open.length ? open.reduce((a, c) => a + (t - c.openedAt), 0) / open.length / 60_000 : null;
    return {
      generatedAt: t,
      range,
      now: { users: live.users, activeUsers: live.activeUsers, devices: live.devices, sockets: live.sockets, platforms: live.platforms, calls: live.calls.calls, callParticipants: live.calls.participants },
      resolution: series.resolution,
      points: series.points,
      peakUsers: series.peakUsers,
      peakAt: series.peakAt,
      totals,
      avgConnectionMinutes: avg === null ? null : Math.round(avg * 10) / 10,
      definitions: {
        users: "Distinct people with at least one authenticated realtime connection open now (exact for this API instance; load-test and excluded accounts left out).",
        activeUsers: `Distinct people with qualifying activity (an app request that isn't background traffic) in the last ${ACTIVE_NOW_MS / 60_000} minutes.`,
        devices: "Devices with at least one open connection.",
        sockets: "Individual WebSocket connections (a device can hold several, e.g. browser tabs).",
        abnormal: "Connections closed without a close frame (network loss) or ended by the 30-second heartbeat.",
        authFailures: "Connections refused for missing, wrong or expired credentials.",
        avgConnectionMinutes: "Average age of the connections open now.",
        history: "Sampled once a minute; hourly rollups keep the peak and average beyond 2 days.",
      },
      screenSharing: { available: false as const, why: "The server doesn't record screen sharing: it happens inside LiveKit media, which only tells the server who is in a call." },
    };
  }
}
