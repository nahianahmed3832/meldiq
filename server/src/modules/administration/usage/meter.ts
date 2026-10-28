import type { DB } from "../../../infrastructure/database/db.js";
import type { CallStore } from "../../calls/index.js";
import type { FileStore } from "../../files/index.js";

/**
 * Usage metering (docs/USAGE_AND_PLANS.md, round 7 slice C7): privacy-respecting counts per workspace and UTC day, for
 * future plans and for operators. Never message content, names, or who did what: only how much.
 *
 * - Counters are added to as things happen (file transfer). Counters of removed modules (API requests, webhooks,
 *   workflows, AI, inbox) are no longer produced or reported; their old rows stay in usage_daily.
 * - Gauges are recomputed from the database and replace the day's value (members, active seats, stored file bytes,
 *   call participant minutes), so recomputing is always safe.
 */
export const COUNTERS = ["files.upload_bytes", "files.download_bytes"] as const;
export const GAUGES = ["seats.members", "seats.active_30d", "storage.bytes", "calls.participant_minutes"] as const;
export type Counter = (typeof COUNTERS)[number];
export type Gauge = (typeof GAUGES)[number];
export type Metric = Counter | Gauge;

export const METRIC_LABELS: Record<Metric, string> = {
  "files.upload_bytes": "Files uploaded (bytes)",
  "files.download_bytes": "Files downloaded (bytes)",
  "seats.members": "Members",
  "seats.active_30d": "Active members (30 days)",
  "storage.bytes": "Stored files (bytes)",
  "calls.participant_minutes": "Call participant minutes",
};

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;
/** Gauges are recomputed at most this often (the retention job runs every minute). */
const SNAPSHOT_EVERY_MS = 10 * 60_000;

export interface MetricSeries {
  metric: Metric;
  label: string;
  kind: "counter" | "gauge";
  /** Counters: the sum over the period. Gauges: the latest value. */
  total: number;
  daily: { day: string; value: number }[];
}

export class UsageMeter {
  private lastSnapshot = 0;

  constructor(
    private readonly db: DB,
    /** Stored file sizes live with the files module (SQLite or MongoDB). */
    private readonly files: FileStore,
    /** Call minutes live with the calls module (SQLite or MongoDB). */
    private readonly calls: CallStore,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Adds [n] to a counter for today (no-op without a workspace). Never throws into the caller. */
  add(orgId: string | null | undefined, metric: Counter, n = 1): void {
    if (!orgId || n <= 0 || !this.db.open) return;
    try {
      this.db
        .prepare("INSERT INTO usage_daily (org_id, day, metric, value) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, day, metric) DO UPDATE SET value = value + excluded.value")
        .run(orgId, utcDay(this.clock()), metric, Math.round(n));
    } catch {
      // metering must never break the action being metered
    }
  }

  private setGauge(orgId: string, day: string, metric: Gauge, value: number): void {
    this.db
      .prepare("INSERT INTO usage_daily (org_id, day, metric, value) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, day, metric) DO UPDATE SET value = excluded.value")
      .run(orgId, day, metric, Math.round(value));
  }

  /** Recomputes today's gauges for every workspace (and yesterday's call minutes, for calls that ended overnight). */
  async snapshot(force = false): Promise<number> {
    const t = this.clock();
    if (!force && t - this.lastSnapshot < SNAPSHOT_EVERY_MS) return 0;
    this.lastSnapshot = t;
    const today = utcDay(t);
    const orgs = this.db.prepare("SELECT id FROM orgs").all() as { id: string }[];
    const one = (sql: string, ...p: unknown[]) => (this.db.prepare(sql).get(...p) as { n: number | null }).n ?? 0;
    // Read first (the files store may not be SQLite), then every gauge is written in one transaction.
    const conversationsOf = this.db.prepare("SELECT id FROM conversations WHERE org_id = ?");
    const stored = new Map<string, number>();
    const days = [Date.parse(`${today}T00:00:00Z`) - DAY_MS, Date.parse(`${today}T00:00:00Z`)];
    const callMinutes = new Map<string, number[]>();
    for (const { id } of orgs) {
      const conversations = (conversationsOf.all(id) as { id: string }[]).map((r) => r.id);
      stored.set(id, (await this.files.storedUsage({ conversations, liveAt: t })).bytes);
      const minutes: number[] = [];
      for (const dayStart of days) minutes.push(await this.calls.participantMinutes(conversations, dayStart, dayStart + DAY_MS, t));
      callMinutes.set(id, minutes);
    }
    this.db.transaction(() => {
      for (const { id } of orgs) {
        this.setGauge(id, today, "seats.members", one("SELECT COUNT(*) n FROM org_members WHERE org_id = ?", id));
        this.setGauge(
          id, today, "seats.active_30d",
          one("SELECT COUNT(DISTINCT m.user_id) n FROM org_members m JOIN devices d ON d.user_id = m.user_id WHERE m.org_id = ? AND d.last_seen_at > ?", id, t - 30 * DAY_MS),
        );
        this.setGauge(id, today, "storage.bytes", stored.get(id) ?? 0);
        days.forEach((dayStart, i) => this.setGauge(id, utcDay(dayStart), "calls.participant_minutes", Math.max(0, callMinutes.get(id)![i])));
      }
    })();
    return orgs.length;
  }

  /** The last [days] days for one workspace, every metric (missing days are zero; gauges keep their latest value). */
  series(orgId: string, days: number): MetricSeries[] {
    const t = this.clock();
    const from = utcDay(t - (days - 1) * DAY_MS);
    const rows = this.db.prepare("SELECT day, metric, value FROM usage_daily WHERE org_id = ? AND day >= ? ORDER BY day").all(orgId, from) as { day: string; metric: Metric; value: number }[];
    const allDays = Array.from({ length: days }, (_, i) => utcDay(t - (days - 1 - i) * DAY_MS));
    return [...COUNTERS, ...GAUGES].map((metric) => {
      const byDay = new Map(rows.filter((r) => r.metric === metric).map((r) => [r.day, r.value]));
      const daily = allDays.map((day) => ({ day, value: byDay.get(day) ?? 0 }));
      const gauge = (GAUGES as readonly string[]).includes(metric);
      const latest = [...rows].reverse().find((r) => r.metric === metric)?.value ?? 0;
      return { metric, label: METRIC_LABELS[metric], kind: gauge ? "gauge" : "counter", total: gauge ? latest : daily.reduce((a, d) => a + d.value, 0), daily };
    });
  }

  /** Totals per workspace over [days] (platform admins). */
  totals(days: number): { orgId: string; metrics: Record<string, number> }[] {
    const from = utcDay(this.clock() - (days - 1) * DAY_MS);
    const orgs = this.db.prepare("SELECT DISTINCT org_id FROM usage_daily WHERE day >= ?").all(from) as { org_id: string }[];
    return orgs.map(({ org_id }) => ({ orgId: org_id, metrics: Object.fromEntries(this.series(org_id, days).map((s) => [s.metric, s.total])) }));
  }
}
