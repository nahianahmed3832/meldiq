import type { AppContext } from "../../app/context.js";
import { badRequest } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { analytics } from "../telemetry/index.js";
import { RANGE_MS, type Range } from "./analyticsView.js";

/** Series a client may ask for (everything the samplers write; anything else is refused). */
const SERIES = /^(host|api|db|svc|storage)\.[a-z0-9_.]{1,60}$/;
const MAX_SERIES = 12;

const SERVICE_LABELS: Record<string, string> = {
  api: "API (messaging, realtime, files, accounts)",
  livekit: "LiveKit (calls and voice rooms)",
  ntfy: "ntfy (UnifiedPush wake-ups)",
  other: "Other workloads on this shared host (summed, not Meldiq's)",
};

/**
 * Resources and capacity (docs/RESOURCE_MONITORING.md). One server is provisioned for Meldiq: the deployment's VPS. This
 * process can read it from inside its container; the optional host collector adds the host's network and per-service
 * figures. Capacity projections are linear trends over the last 7 days of hourly averages: estimates, labelled so.
 */
export class AdminResources {
  constructor(
    private readonly ctx: AppContext,
    private readonly version: string,
  ) {}

  private readonly startedAt = Date.now();

  series(seriesParam: string, range: Range) {
    const names = seriesParam.split(",").filter(Boolean);
    if (names.length === 0 || names.length > MAX_SERIES || names.some((n) => !SERIES.test(n))) throw badRequest(`Ask for 1–${MAX_SERIES} measured series.`);
    const t = now();
    return { range, series: analytics.resourceSeries(this.ctx, names, t - RANGE_MS[range], t) };
  }

  report() {
    const t = now();
    const latest = analytics.latestResources(this.ctx, t, 5 * 60_000);
    // Stored file bytes are measured hourly.
    const hourly = analytics.latestResources(this.ctx, t, 2 * 3_600_000);
    const v = (s: string) => latest.get(s)?.value ?? null;
    const collector = this.ctx.telemetry.resources.collectorStatus();
    const services = ["api", "livekit", "ntfy", "other"].map((s) => ({
      service: s,
      label: SERVICE_LABELS[s]!,
      cpuPct: s === "api" ? (v("svc.api.cpu_pct") ?? v("api.cpu.pct")) : v(`svc.${s}.cpu_pct`),
      memBytes: s === "api" ? (v("svc.api.mem_bytes") ?? v("api.mem.cgroup_bytes")) : v(`svc.${s}.mem_bytes`),
      memLimitBytes: s === "api" ? (v("svc.api.mem_limit_bytes") ?? v("api.mem.limit_bytes")) : v(`svc.${s}.mem_limit_bytes`),
      netRxBps: s === "api" ? (v("svc.api.net_rx_bps") ?? v("api.net.rx_bps")) : v(`svc.${s}.net_rx_bps`),
      netTxBps: s === "api" ? (v("svc.api.net_tx_bps") ?? v("api.net.tx_bps")) : v(`svc.${s}.net_tx_bps`),
      ioReadBps: v(`svc.${s}.io_read_bps`),
      ioWriteBps: v(`svc.${s}.io_write_bps`),
      source: s === "api" && !latest.has("svc.api.cpu_pct") ? "this process (cgroup and network namespace)" : collector.reporting ? "host collector" : "not reporting",
    }));
    const pct = (a: number | null, b: number | null) => (a === null || b === null || b <= 0 ? null : Math.round((a / b) * 1000) / 10);
    const daysUntil = (used: number | null, total: number | null, perDay: number | null) => {
      if (used === null || total === null || perDay === null) return null;
      if (perDay <= 0) return "Not growing over the last 7 days.";
      const days = (total - used) / perDay;
      return `At the last 7 days' trend, full in about ${days > 3650 ? "more than 10 years" : `${Math.round(days)} days`} (estimate).`;
    };
    const diskSlope = analytics.dailySlope(this.ctx, "host.disk.used_bytes", t, 7);
    const dbSlope = analytics.dailySlope(this.ctx, "db.size_bytes", t, 7);
    const capacity = [
      { resource: "Host disk (data volume)", used: v("host.disk.used_bytes"), total: v("host.disk.total_bytes"), pct: pct(v("host.disk.used_bytes"), v("host.disk.total_bytes")), projection: daysUntil(v("host.disk.used_bytes"), v("host.disk.total_bytes"), diskSlope) },
      { resource: "Host memory", used: v("host.mem.used_bytes"), total: v("host.mem.total_bytes"), pct: pct(v("host.mem.used_bytes"), v("host.mem.total_bytes")), projection: null },
      { resource: "API memory (container limit)", used: v("api.mem.cgroup_bytes"), total: v("api.mem.limit_bytes"), pct: pct(v("api.mem.cgroup_bytes"), v("api.mem.limit_bytes")), projection: null },
      { resource: "API CPU (container limit)", used: v("api.cpu.limit_pct"), total: 100, pct: v("api.cpu.limit_pct"), projection: null },
      { resource: "Host CPU", used: v("host.cpu.pct"), total: 100, pct: v("host.cpu.pct"), projection: null },
    ];
    const uptime = v("host.uptime_s");
    return {
      generatedAt: t,
      server: {
        name: collector.hostname,
        provider: "Hostinger VPS (from the deployment configuration)",
        environment: process.env.NODE_ENV === "production" ? "production" : (process.env.NODE_ENV ?? "development"),
        os: collector.os,
        kernel: collector.kernel,
        cpus: collector.cpus,
        uptimeSeconds: uptime,
        coverage: {
          processMetrics: latest.has("api.mem.rss_bytes"),
          hostMetrics: latest.has("host.cpu.pct") || latest.has("host.mem.used_bytes"),
          collector: !collector.configured ? ("not_configured" as const) : collector.reporting ? ("reporting" as const) : ("stale" as const),
          lastCollectorAt: collector.lastAt,
        },
        version: this.version,
        startedAt: this.startedAt,
        versions: analytics.versions(this.ctx),
      },
      now: Object.fromEntries(latest),
      services,
      capacity,
      files: { storedBytes: hourly.get("storage.files_bytes")?.value ?? null, storedCount: hourly.get("storage.files_count")?.value ?? null },
      database: { sizeBytes: v("db.size_bytes"), walBytes: v("db.wal_bytes"), growthPerDayBytes: dbSlope === null ? null : Math.round(dbSlope), engine: this.ctx.mongo ? "SQLite + MongoDB" : "SQLite (in-process, WAL)" },
      unavailable: [
        { what: "Database query latency", why: "SQLite runs inside the API process: its time is part of each request's latency, shown under API latency." },
        { what: "Cache", why: "There is no cache service in this deployment." },
        { what: "MongoDB pool", why: this.ctx.mongo ? "Shown under connectors." : "MongoDB isn't used in this deployment." },
        { what: "File storage provider metrics and bill", why: "Needs read access to the storage provider's metrics and billing (the server's key can only read and write its bucket)." },
        { what: "LiveKit media metrics (SFU)", why: "LiveKit's metrics endpoint isn't enabled; calls are measured from the server's own call records." },
        { what: "Screen sharing", why: "Not recorded by the server (it happens inside LiveKit media)." },
        { what: "Hosting provider metrics and invoices", why: "Needs a hosting provider API token on the server; enter the plan's price and allowance in Settings for estimates." },
        ...(collector.configured ? [] : [{ what: "Host network and per-service figures", why: "The host collector isn't installed (HOST_METRICS_FILE unset)." }]),
      ],
    };
  }
}
