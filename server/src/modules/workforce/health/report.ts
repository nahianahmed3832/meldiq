import crypto from "node:crypto";
import type { Database } from "better-sqlite3";

/**
 * The Full System Check's report (docs/implementation/PROGRESS.md phase 2): one item per thing checked, each with the
 * evidence it rests on. An item is "healthy" only when something was actually exercised or measured (a probe, a job
 * record, a heartbeat), never because a setting exists. What can't be checked safely is "not_tested", with why.
 */
export const CHECK_STATUSES = ["healthy", "warning", "failed", "not_configured", "not_tested"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export const CHECK_LEVELS = ["configuration", "runtime", "smoke"] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** Who can fix it: the platform's operators (console), or the community's admins (Manage AI agents). */
export type CheckOwner = "platform_operator" | "community_admin";

export interface CheckItem {
  /** Stable across runs ("agent.<installId>", "runtime.worker"), so history can follow one item. */
  key: string;
  level: CheckLevel;
  title: string;
  status: CheckStatus;
  severity: Severity;
  /** What was observed, with numbers and times. */
  evidence: string;
  at: number;
  /** What doesn't work while this isn't healthy (capability labels). */
  impacts: string[];
  /** The likely cause, when the evidence supports one. */
  cause: string | null;
  /** A safe next step. */
  remediation: string | null;
  owner: CheckOwner | null;
  /** True when the evidence comes from exercising the thing (a probe, a record of real work), not from configuration. */
  verified: boolean;
  /** Affected records, for linking: jobs, tasks, an agent, triggers. */
  links: { jobs?: string[]; tasks?: string[]; installId?: string; triggers?: string[] };
}

export interface CheckReport {
  id: string;
  scope: "community" | "platform";
  orgId: string | null;
  requestedBy: string;
  startedAt: number;
  finishedAt: number;
  worst: CheckStatus;
  summary: Record<CheckStatus, number>;
  items: CheckItem[];
}

/** Worst first: what needs attention leads the report. */
const RANK: Record<CheckStatus, number> = { failed: 0, warning: 1, not_configured: 2, not_tested: 3, healthy: 4 };
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Reports kept per scope (and per community). */
export const HISTORY_KEPT = 50;

export function worstOf(items: readonly CheckItem[]): CheckStatus {
  return items.reduce<CheckStatus>((w, i) => (RANK[i.status] < RANK[w] ? i.status : w), "healthy");
}

export function summarize(items: readonly CheckItem[]): Record<CheckStatus, number> {
  const out = Object.fromEntries(CHECK_STATUSES.map((s) => [s, 0])) as Record<CheckStatus, number>;
  for (const i of items) out[i.status]++;
  return out;
}

export function sortItems(items: readonly CheckItem[]): CheckItem[] {
  return [...items].sort((a, b) => RANK[a.status] - RANK[b.status] || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.key.localeCompare(b.key));
}

/** Builds items with the defaults most checks share. */
export function item(at: number, fields: Pick<CheckItem, "key" | "level" | "title" | "status" | "evidence"> & Partial<CheckItem>): CheckItem {
  return {
    severity: fields.status === "failed" ? "high" : fields.status === "warning" ? "medium" : "info",
    impacts: [],
    cause: null,
    remediation: null,
    owner: null,
    verified: false,
    links: {},
    at,
    ...fields,
  };
}

interface Row {
  id: string;
  scope: "community" | "platform";
  org_id: string | null;
  requested_by: string;
  started_at: number;
  finished_at: number;
  worst: CheckStatus;
  summary: string;
  report: string;
}

const fromRow = (r: Row): CheckReport => ({
  id: r.id,
  scope: r.scope,
  orgId: r.org_id,
  requestedBy: r.requested_by,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  worst: r.worst,
  summary: JSON.parse(r.summary) as Record<CheckStatus, number>,
  items: JSON.parse(r.report) as CheckItem[],
});

/** Stored reports: the history of a scope, newest first, trimmed to HISTORY_KEPT. */
export class CheckReports {
  constructor(private readonly db: Database) {}

  save(r: Omit<CheckReport, "id" | "worst" | "summary">): CheckReport {
    const items = sortItems(r.items);
    const report: CheckReport = { ...r, id: `chk_${crypto.randomBytes(9).toString("base64url")}`, items, worst: worstOf(items), summary: summarize(items) };
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO ai_system_checks (id, scope, org_id, requested_by, started_at, finished_at, worst, summary, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(report.id, report.scope, report.orgId, report.requestedBy, report.startedAt, report.finishedAt, report.worst, JSON.stringify(report.summary), JSON.stringify(items));
      this.db
        .prepare(
          `DELETE FROM ai_system_checks WHERE scope = ? AND org_id IS ? AND id NOT IN
             (SELECT id FROM ai_system_checks WHERE scope = ? AND org_id IS ? ORDER BY started_at DESC, id DESC LIMIT ?)`,
        )
        .run(report.scope, report.orgId, report.scope, report.orgId, HISTORY_KEPT);
    })();
    return report;
  }

  get(id: string): CheckReport | null {
    const r = this.db.prepare("SELECT * FROM ai_system_checks WHERE id = ?").get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  /** The scope's reports, newest first. */
  history(scope: "community" | "platform", orgId: string | null, limit = HISTORY_KEPT): CheckReport[] {
    return (this.db.prepare("SELECT * FROM ai_system_checks WHERE scope = ? AND org_id IS ? ORDER BY started_at DESC, id DESC LIMIT ?").all(scope, orgId, limit) as Row[]).map(fromRow);
  }

  latest(scope: "community" | "platform", orgId: string | null): CheckReport | null {
    return this.history(scope, orgId, 1)[0] ?? null;
  }
}
