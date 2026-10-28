import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../app/context.js";
import { signupTimes } from "../accounts/index.js";
import { ACTIVE_NOW_MS, ActivityTracker, requestKind } from "./activity.js";
import { type ClientInfo, classifyClient } from "./client.js";
import { hostMetricsFile, ResourceSampler, type Sample } from "./resources.js";

/**
 * Platform telemetry (docs/ANALYTICS_DEFINITIONS.md, docs/RESOURCE_MONITORING.md): activity, traffic, concurrency and
 * resources, gathered by this process and written once a minute. Nothing here can fail a request: every hook catches
 * its own errors, and the minute job reports failures as the job "telemetry.minute" in the health view.
 */

/** Per-minute rows kept this long; hourly rollups longer. */
export const RETENTION = {
  presenceMinutesDays: 30,
  resourceMinutesDays: 7,
  hourlyDays: 400,
  activityDays: 400,
  trafficDays: 400,
} as const;

type RealtimeStats = AppContext["hub"]["stats"];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export class Telemetry {
  readonly activity = new ActivityTracker();
  readonly resources: ResourceSampler;
  private timer: NodeJS.Timeout | null = null;
  private last: RealtimeStats | null = null;
  private excluded = new Set<string>();
  private lastRollupHour = 0;
  private lastRetentionAt = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly clock: () => number = Date.now,
  ) {
    this.resources = new ResourceSampler({
      dataDir: ctx.config.dataDir,
      databasePath: ctx.config.databasePath,
      hostMetricsFile: hostMetricsFile(process.env),
      clock,
    });
    ctx.hub.onBytesOut = (userId, bytes) => this.activity.addTraffic(userId, "ws.out", bytes, this.clock());
  }

  /** Records when collection began (kept from the first start): figures before it are never shown as zero. */
  init(): Promise<void> {
    return this.epochs(["activity", "presence", "resources", "traffic"]);
  }

  private epochs(kinds: string[]): Promise<void> {
    const t = this.clock();
    return this.ctx.platform.write((w) => {
      for (const kind of kinds) w.insert("telemetry_epochs", { kind, started_at: t }, { orIgnore: true });
    });
  }

  classify(headers: Record<string, string | string[] | undefined>): ClientInfo {
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    return classifyClient(one(headers["user-agent"]), one(headers["x-meldiq-client"]));
  }

  /** The people left out of live counts (load-test accounts, the operator's list); set by the platform console. */
  setExcluded(ids: Iterable<string>): void {
    this.excluded = new Set(ids);
  }

  /** Called for every finished request (server.ts onResponse): app requests only, never the console's. */
  onResponse(req: FastifyRequest, reply: FastifyReply): void {
    try {
      const auth = req.auth;
      if (!auth) return;
      const t = this.clock();
      const inBytes = Number(req.headers["content-length"] ?? 0);
      const outBytes = Number(reply.getHeader("content-length") ?? 0);
      if (inBytes > 0) this.activity.addTraffic(auth.userId, "api.in", inBytes, t);
      if (outBytes > 0) this.activity.addTraffic(auth.userId, "api.out", outBytes, t);
      if (reply.statusCode >= 400) return;
      const route = req.routeOptions?.url;
      if (!route) return;
      const kind = requestKind(req.method, route, req.body);
      const client = this.classify(req.headers);
      if (auth.sessionId) this.activity.noteSession(auth.sessionId, client, t);
      if (kind === "passive") return;
      this.activity.record(auth.userId, client, t, kind === "action");
      if (kind === "action" && route === "/v1/messages") this.activity.addTraffic(auth.userId, "messages", 1, t);
    } catch (e) {
      this.ctx.log.warn({ err: e }, "telemetry request hook failed");
    }
  }

  /** Records that this server version started (the console's version history: the first start of each version). */
  recordVersion(version: string): Promise<void> {
    return this.epochs([`version:${version}`]);
  }

  /** When collection of [kind] began on this server (first start with this version), or null. */
  since(kind: "activity" | "presence" | "resources" | "traffic"): number | null {
    return this.ctx.platform.get<{ started_at: number }>("telemetry_epochs", { kind })?.started_at ?? null;
  }

  start(intervalMs = 60_000): void {
    this.resources.sample(); // the base reading for rates
    this.last = { ...this.ctx.hub.stats };
    this.timer = setInterval(() => void this.minute(), intervalMs);
    this.timer.unref();
  }

  /** Stops sampling and writes what was gathered (before the stores close). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.resources.stop();
    try {
      await this.flush();
    } catch (e) {
      this.ctx.log.warn({ err: e }, "telemetry final flush failed");
    }
  }

  /** Writes the counters gathered so far (also on shutdown). */
  flush(): Promise<number> {
    return this.activity.flush(this.ctx.platform, (ids) => signupTimes(this.ctx.identity, ids));
  }

  /** The once-a-minute job: flush, sample presence and resources, roll up finished hours, and trim old rows. */
  async minute(): Promise<void> {
    if (!this.ctx.db.open) return;
    await this.ctx.metrics
      .timeJob("telemetry.minute", async () => {
        const t = this.clock();
        await this.flush();
        await this.samplePresence(t);
        await this.sampleResources(t);
        await this.rollup(t);
        if (t - this.lastRetentionAt > HOUR_MS) {
          await this.trim(t);
          this.lastRetentionAt = t;
        }
      })
      .catch((e) => this.ctx.log.error({ err: e }, "telemetry minute job failed"));
  }

  /** Live counts now (the console's concurrency card), without writing anything. */
  async live(t = this.clock()) {
    const conns = this.ctx.hub.connections();
    const people = new Set<string>();
    const platforms: Record<string, Set<string>> = {};
    for (const c of conns) {
      if (this.excluded.has(c.userId)) continue;
      people.add(c.userId);
      (platforms[c.platform] ??= new Set()).add(c.userId);
    }
    const active = this.activity.activeSince(t - ACTIVE_NOW_MS);
    let activeUsers = active.users;
    for (const id of this.excluded) if (this.activity.isActiveSince(id, t - ACTIVE_NOW_MS)) activeUsers -= 1;
    return {
      users: people.size,
      activeUsers: Math.max(0, activeUsers),
      devices: this.ctx.hub.onlineDeviceCount(),
      sockets: conns.length,
      platforms: Object.fromEntries(Object.entries(platforms).map(([p, s]) => [p, s.size])),
      calls: await this.ctx.calls.activeCounts(),
    };
  }

  private async samplePresence(t: number): Promise<void> {
    const now = await this.live(t);
    const s = this.ctx.hub.stats;
    const prev = this.last ?? s;
    const delta = (k: keyof RealtimeStats) => Math.max(0, s[k] - prev[k]);
    const sample = {
      minute: Math.floor(t / 60_000),
      users: now.users,
      active_users: now.activeUsers,
      devices: now.devices,
      sockets: now.sockets,
      connects: delta("connects"),
      disconnects: delta("disconnects"),
      abnormal: delta("abnormal"),
      auth_failures: delta("authFailures"),
      calls: now.calls.calls,
      call_people: now.calls.participants,
      platforms: JSON.stringify(now.platforms),
    };
    await this.ctx.ephemeral.write((w) => w.upsert("presence_samples", sample, "replace"));
    this.last = { ...s };
  }

  /** Total stored file bytes (all attachments, live), measured once an hour: the storage growth series. */
  private lastStoredAt = 0;

  private async storedBytes(t: number): Promise<Sample[]> {
    if (t - this.lastStoredAt < HOUR_MS) return [];
    this.lastStoredAt = t;
    try {
      const u = await this.ctx.files.storedUsage({ liveAt: t });
      return [
        { series: "storage.files_bytes", value: u.bytes },
        { series: "storage.files_count", value: u.count },
      ];
    } catch (e) {
      this.ctx.log.warn({ err: e }, "stored file bytes could not be measured");
      return [];
    }
  }

  private async sampleResources(t: number): Promise<void> {
    const minute = Math.floor(t / 60_000);
    const samples: Sample[] = [...this.resources.sample(), ...(await this.storedBytes(t))];
    // The minute that just finished, from the request metrics (requests and latency percentiles).
    const m = this.ctx.metrics.minute(minute - 1);
    samples.push({ series: "api.requests", value: m?.requests ?? 0 }, { series: "api.errors_5xx", value: m?.serverErrors ?? 0 }, { series: "api.errors_4xx", value: m?.clientErrors ?? 0 });
    if (m?.p50Ms !== null && m?.p50Ms !== undefined) samples.push({ series: "api.latency.p50_ms", value: m.p50Ms });
    if (m?.p95Ms !== null && m?.p95Ms !== undefined) samples.push({ series: "api.latency.p95_ms", value: m.p95Ms });
    if (m?.p99Ms !== null && m?.p99Ms !== undefined) samples.push({ series: "api.latency.p99_ms", value: m.p99Ms });
    await this.ctx.ephemeral.write((w) => {
      for (const s of samples) w.upsert("resource_samples", { minute, series: s.series, value: s.value }, "replace");
    });
  }

  /** Hourly rollups for every finished hour not yet rolled up (idempotent): minute samples into the platform rows. */
  async rollup(t: number): Promise<void> {
    const hour = Math.floor(t / HOUR_MS) - 1;
    if (hour <= this.lastRollupHour) return;
    const first = Math.max(this.lastRollupHour ? this.lastRollupHour + 1 : hour - 1, hour - 48);
    const { ephemeral } = this.ctx;
    const resources = ephemeral.all<{ minute: number; series: string; value: number }>("resource_samples", { where: { minute: { gte: first * 60 } } }).filter((r) => r.minute <= hour * 60 + 59);
    const presence = ephemeral.all<PresenceRow>("presence_samples", { where: { minute: { gte: first * 60 } } }).filter((r) => r.minute <= hour * 60 + 59);
    await this.ctx.platform.write((w) => {
      for (let h = first; h <= hour; h++) {
        const inHour = (r: { minute: number }) => Math.floor(r.minute / 60) === h;
        const bySeries = new Map<string, number[]>();
        for (const r of resources.filter(inHour)) bySeries.set(r.series, [...(bySeries.get(r.series) ?? []), r.value]);
        for (const [series, values] of bySeries) {
          w.upsert("resource_hourly", { hour: h, series, avg: sum(values) / values.length, min: Math.min(...values), max: Math.max(...values), samples: values.length }, "replace");
        }
        const p = presence.filter(inHour);
        if (p.length === 0) continue;
        w.upsert(
          "presence_hourly",
          {
            hour: h,
            peak_users: Math.max(...p.map((x) => x.users)),
            avg_users: sum(p.map((x) => x.users)) / p.length,
            peak_sockets: Math.max(...p.map((x) => x.sockets)),
            connects: sum(p.map((x) => x.connects)),
            disconnects: sum(p.map((x) => x.disconnects)),
            abnormal: sum(p.map((x) => x.abnormal)),
            auth_failures: sum(p.map((x) => x.auth_failures)),
            samples: p.length,
          },
          "replace",
        );
      }
    });
    this.lastRollupHour = hour;
  }

  /** Deletes rows past their retention (counts only; the hourly rollups keep the long view). */
  async trim(t: number): Promise<void> {
    const day = (days: number) => new Date(t - days * DAY_MS).toISOString().slice(0, 10);
    await this.ctx.ephemeral.write((w) => {
      w.delete("presence_samples", { minute: { lt: Math.floor((t - RETENTION.presenceMinutesDays * DAY_MS) / 60_000) } });
      w.delete("resource_samples", { minute: { lt: Math.floor((t - RETENTION.resourceMinutesDays * DAY_MS) / 60_000) } });
    });
    await this.ctx.platform.write((w) => {
      w.delete("presence_hourly", { hour: { lt: Math.floor((t - RETENTION.hourlyDays * DAY_MS) / HOUR_MS) } });
      w.delete("resource_hourly", { hour: { lt: Math.floor((t - RETENTION.hourlyDays * DAY_MS) / HOUR_MS) } });
      w.delete("activity_daily", { day: { lt: day(RETENTION.activityDays) } });
      w.delete("traffic_user_daily", { day: { lt: day(RETENTION.trafficDays) } });
      w.delete("session_clients", { last_seen_at: { lt: t - RETENTION.activityDays * DAY_MS } });
    });
  }
}

interface PresenceRow {
  minute: number;
  users: number;
  sockets: number;
  connects: number;
  disconnects: number;
  abnormal: number;
  auth_failures: number;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
