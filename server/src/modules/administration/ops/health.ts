import { monitorEventLoopDelay } from "node:perf_hooks";
import type { AppContext } from "../../../app/context.js";
import { now } from "../../../shared/utilities/util.js";
import { type MetricsSnapshot } from "./metrics.js";

/**
 * The platform health report (docs/OPERATIONS.md, round 7 slice C1): measured values only. Anything this process
 * can't measure is reported as `{ available: false, reason }`, never as a made-up number. No content, user ids,
 * conversation ids, addresses or secrets.
 */
export type Measured<T> = ({ available: true } & T) | { available: false; reason: string };

export interface HealthReport {
  version: string;
  generatedAt: number;
  uptimeSeconds: number;
  checks: {
    database: Measured<{ ok: boolean; sizeBytes: number }>;
    mongodb: Measured<{ ok: boolean }>;
    livekit: Measured<{ configured: boolean }>;
    storage: Measured<{ backend: string; reachable: boolean; errorKind?: string }>;
  };
  process: { rssBytes: number; heapUsedBytes: number; eventLoopDelayP99Ms: number | null };
  realtime: { onlineDevices: number };
  queues: {
    delivery: { items: number; oldestAgeSeconds: number | null };
    reminders: { overdueUndelivered: number; retrying: number };
    /** Always unavailable since the community rebuild removed apps; kept because Android 0.3.0 and older require it. */
    integrations: Measured<{ jobsQueued: number; jobsDead: number; deliveriesFailed24h: number }>;
  };
  metrics: MetricsSnapshot;
  /** Plain-language problems worth a look, derived from the values above with the thresholds in [THRESHOLDS]. */
  warnings: string[];
}

export const THRESHOLDS = {
  /** Share of requests answered 5xx in the window. */
  errorRate: 0.05,
  eventLoopDelayMs: 200,
  /** A queued delivery older than this means a device is gone or a backlog is stuck. */
  oldestQueuedSeconds: 6 * 3600,
  /** A reminder this far past due and not delivered. */
  reminderLateMs: 5 * 60_000,
  /** Provider and job failures this recent are warned about. */
  recentFailureMs: 15 * 60_000,
} as const;

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const started = Date.now();


async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export async function storageCheck(ctx: AppContext): Promise<HealthReport["checks"]["storage"]> {
  try {
    await withTimeout(
      (async () => {
        for await (const _ of ctx.blobs.listIds("attachments")) break;
      })(),
      3000,
    );
    return { available: true, backend: ctx.blobs.backend, reachable: true };
  } catch (e) {
    const code = (e as { code?: unknown; name?: unknown }).code ?? (e as { name?: unknown }).name;
    return { available: true, backend: ctx.blobs.backend, reachable: false, errorKind: typeof code === "string" ? code.slice(0, 40) : "error" };
  }
}

export async function healthReport(ctx: AppContext, version: string): Promise<HealthReport> {
  const t = now();
  const { db } = ctx;
  const pageCount = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
  const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const relay = await ctx.relay.stats();
  const oldest = relay.oldestCreatedAt;
  const mem = process.memoryUsage();
  const p99 = loop.count > 0 ? Math.round(loop.percentile(99) / 1e6) : null;
  const report: HealthReport = {
    version,
    generatedAt: t,
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    checks: {
      database: { available: true, ok: true, sizeBytes: pageCount * pageSize },
      mongodb: ctx.mongo ? { available: true, ok: await ctx.mongo.ping() } : { available: false, reason: "not configured" },
      livekit: { available: true, configured: !!ctx.livekit },
      storage: await storageCheck(ctx),
    },
    process: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, eventLoopDelayP99Ms: p99 },
    realtime: { onlineDevices: ctx.hub.onlineDeviceCount() },
    queues: {
      delivery: { items: relay.envelopes + relay.receipts, oldestAgeSeconds: oldest === null ? null : Math.round((t - oldest) / 1000) },
      reminders: {
        overdueUndelivered: ctx.identity.count("reminders", { state: { in: ["scheduled", "fired"] }, due_at: { lt: t - THRESHOLDS.reminderLateMs }, delivered_at: null }),
        retrying: ctx.identity.count("reminders", { attempts: { gt: 0 }, state: { in: ["scheduled", "fired"] } }),
      },
      integrations: { available: false, reason: "apps were removed from this server" },
    },
    metrics: ctx.metrics.snapshot(),
    warnings: [],
  };
  return { ...report, warnings: warningsFor(report, t) };
}

/** The report's problems in plain words (pure: unit-tested). */
export function warningsFor(r: HealthReport, t: number): string[] {
  const w: string[] = [];
  const c = r.checks;
  if (c.mongodb.available && !c.mongodb.ok) w.push("MongoDB isn't answering: accounts or preferences kept there can't be served.");
  if (c.storage.available && !c.storage.reachable) w.push(`File storage (${c.storage.backend}) isn't reachable (${c.storage.errorKind}): uploads and downloads fail.`);
  if (!c.livekit.available || !c.livekit.configured) w.push("Calling isn't configured on this server.");
  const win = r.metrics.window;
  if (win.errorRate !== null && win.requests >= 20 && win.errorRate > THRESHOLDS.errorRate) {
    w.push(`${(win.errorRate * 100).toFixed(1)} % of requests failed with a server error in the last ${win.minutes} minutes.`);
  }
  if (r.process.eventLoopDelayP99Ms !== null && r.process.eventLoopDelayP99Ms > THRESHOLDS.eventLoopDelayMs) {
    w.push(`The server is slow to respond (event-loop delay ${r.process.eventLoopDelayP99Ms} ms at the 99th percentile).`);
  }
  if (r.queues.delivery.oldestAgeSeconds !== null && r.queues.delivery.oldestAgeSeconds > THRESHOLDS.oldestQueuedSeconds) {
    w.push(`The oldest undelivered item has waited ${Math.round(r.queues.delivery.oldestAgeSeconds / 3600)} h (a device offline that long, or a stuck backlog).`);
  }
  if (r.queues.reminders.overdueUndelivered > 0) w.push(`${r.queues.reminders.overdueUndelivered} reminders are more than 5 minutes late and not delivered.`);
  for (const p of r.metrics.providers) {
    if (p.lastFailureAt !== null && t - p.lastFailureAt < THRESHOLDS.recentFailureMs && (p.lastOkAt === null || p.lastFailureAt > p.lastOkAt)) {
      w.push(`${p.name} is failing (${p.lastErrorKind ?? "error"}); last success ${p.lastOkAt === null ? "never since start" : `${Math.round((t - p.lastOkAt) / 60_000)} min ago`}.`);
    }
  }
  for (const j of r.metrics.jobs) {
    if (j.lastFailureAt !== null && j.lastFailureAt === j.lastRunAt && t - j.lastFailureAt < THRESHOLDS.recentFailureMs) {
      w.push(`Background job ${j.name} failed on its last run (${j.lastErrorKind ?? "error"}).`);
    }
  }
  return w;
}
