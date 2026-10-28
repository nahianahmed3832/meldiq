import type { DB } from "../../../infrastructure/database/db.js";
import type { Rows, RowWriter } from "../../../infrastructure/database/rows/index.js";
import { rowsByIds } from "../../../infrastructure/database/byIds.js";
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
    /** Communities, their conversations and the usage rows (the workspace domain). */
    private readonly rows: Rows,
    /** Stored file sizes live with the files module (SQLite or MongoDB). */
    private readonly files: FileStore,
    /** Call minutes live with the calls module (SQLite or MongoDB). */
    private readonly calls: CallStore,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Adds [n] to a counter for today (no-op without a workspace). Never throws into the caller. */
  async add(orgId: string | null | undefined, metric: Counter, n = 1): Promise<void> {
    if (!orgId || n <= 0 || !this.db.open) return;
    const key = { org_id: orgId, day: utcDay(this.clock()), metric };
    await this.rows
      .write((w) => {
        const before = w.get<{ value: number }>("usage_daily", key)?.value ?? 0;
        w.upsert("usage_daily", { ...key, value: before + Math.round(n) }, "replace");
      })
      .catch(() => {
        // metering must never break the action being metered
      });
  }

  private setGauge(w: RowWriter, orgId: string, day: string, metric: Gauge, value: number): void {
    w.upsert("usage_daily", { org_id: orgId, day, metric, value: Math.round(value) }, "replace");
  }

  /** Recomputes today's gauges for every workspace (and yesterday's call minutes, for calls that ended overnight). */
  async snapshot(force = false): Promise<number> {
    const t = this.clock();
    if (!force && t - this.lastSnapshot < SNAPSHOT_EVERY_MS) return 0;
    this.lastSnapshot = t;
    const today = utcDay(t);
    const orgs = this.rows.all<{ id: string }>("orgs");
    // Read first (the files store may not be SQLite), then every gauge is written in one unit.
    const conversationsOf = (orgId: string) => this.rows.all<{ id: string }>("conversations", { where: { org_id: orgId } });
    const stored = new Map<string, number>();
    const days = [Date.parse(`${today}T00:00:00Z`) - DAY_MS, Date.parse(`${today}T00:00:00Z`)];
    const callMinutes = new Map<string, number[]>();
    for (const { id } of orgs) {
      const conversations = conversationsOf(id).map((r) => r.id);
      stored.set(id, (await this.files.storedUsage({ conversations, liveAt: t })).bytes);
      const minutes: number[] = [];
      for (const dayStart of days) minutes.push(await this.calls.participantMinutes(conversations, dayStart, dayStart + DAY_MS, t));
      callMinutes.set(id, minutes);
    }
    // People seen on a device in the last 30 days (devices are in SQLite), per community.
    const activeSince = t - 30 * DAY_MS;
    const seats = new Map<string, { members: number; active: number }>();
    for (const { id } of orgs) {
      const members = this.rows.all<{ user_id: string }>("org_members", { where: { org_id: id } }).map((m) => m.user_id);
      const seen = new Set(
        rowsByIds<{ user_id: string; last_seen_at: number | null }>(this.db, "devices", "user_id", members, "user_id, last_seen_at")
          .filter((d) => d.last_seen_at !== null && d.last_seen_at > activeSince)
          .map((d) => d.user_id),
      );
      seats.set(id, { members: members.length, active: seen.size });
    }
    await this.rows.write((w) => {
      for (const { id } of orgs) {
        this.setGauge(w, id, today, "seats.members", seats.get(id)!.members);
        this.setGauge(w, id, today, "seats.active_30d", seats.get(id)!.active);
        this.setGauge(w, id, today, "storage.bytes", stored.get(id) ?? 0);
        days.forEach((dayStart, i) => this.setGauge(w, id, utcDay(dayStart), "calls.participant_minutes", Math.max(0, callMinutes.get(id)![i])));
      }
    });
    return orgs.length;
  }

  /** The last [days] days for one workspace, every metric (missing days are zero; gauges keep their latest value). */
  series(orgId: string, days: number): MetricSeries[] {
    const t = this.clock();
    const from = utcDay(t - (days - 1) * DAY_MS);
    const rows = this.rows.all<{ day: string; metric: Metric; value: number }>("usage_daily", { where: { org_id: orgId }, orderBy: [["day", "asc"]] }).filter((r) => r.day >= from);
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
    const orgs = [...new Set(this.rows.all<{ org_id: string; day: string }>("usage_daily").filter((r) => r.day >= from).map((r) => r.org_id))].map((org_id) => ({ org_id }));
    return orgs.map(({ org_id }) => ({ orgId: org_id, metrics: Object.fromEntries(this.series(org_id, days).map((s) => [s.metric, s.total])) }));
  }
}
