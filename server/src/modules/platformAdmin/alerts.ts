import type { AppContext } from "../../app/context.js";
import { ApiError } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { signupsSince } from "../accounts/index.js";
import { auditActionCount } from "../organizations/index.js";
import { analytics } from "../telemetry/index.js";
import { platformSetting } from "./settings.js";
import type { PlatformAdminStore } from "./store.js";

/**
 * Alert rules (docs/ALERTS.md): thresholds over measured series, evaluated once a minute. A rule breaches when its
 * value over the evaluation window passes the threshold, and clears only once the value is back under 90 % of it
 * (hysteresis, so a value hovering at the line doesn't flap). A breach opens one incident per rule (deduplicated by
 * rule); later evaluations update that incident's last-seen time and add a note only when the state changes. People
 * resolve incidents; rules never do.
 *
 * Rules with no data (a series not measured here, too few requests) are "no data", never a made-up value.
 */

type Severity = "sev1" | "sev2" | "sev3" | "sev4";

export interface RuleDef {
  key: string;
  label: string;
  service: string;
  unit: string;
  description: string;
  threshold: number;
  windowMinutes: number;
  severity: Severity;
  measure(ctx: AppContext, windowMinutes: number, t: number): number | null;
}

const since = (t: number, windowMinutes: number) => Math.floor(t / 60_000) - windowMinutes;
const ratio = (a: number | null, b: number | null) => (a === null || b === null || b <= 0 ? null : (a / b) * 100);

export const RULES: readonly RuleDef[] = [
  {
    key: "api.error_rate",
    label: "API server errors",
    service: "API",
    unit: "% of requests",
    description: "Share of requests answered with a 5xx status over the window (at least 20 requests).",
    threshold: 5,
    windowMinutes: 5,
    severity: "sev2",
    measure(ctx, w, t) {
      const req = analytics.windowStats(ctx.db, "api.requests", since(t, w)).sum ?? 0;
      if (req < 20) return null;
      return ratio(analytics.windowStats(ctx.db, "api.errors_5xx", since(t, w)).sum ?? 0, req);
    },
  },
  {
    key: "api.latency_p95",
    label: "Slow API responses",
    service: "API",
    unit: "ms (p95, bucket bound)",
    description: "Average of the per-minute 95th-percentile response time over the window.",
    threshold: 1500,
    windowMinutes: 10,
    severity: "sev3",
    measure: (ctx, w, t) => analytics.windowStats(ctx.db, "api.latency.p95_ms", since(t, w)).avg,
  },
  {
    key: "api.memory",
    label: "API memory near its limit",
    service: "API",
    unit: "% of container limit",
    description: "The API container's memory against its limit (cgroup), averaged over the window.",
    threshold: 90,
    windowMinutes: 10,
    severity: "sev2",
    measure: (ctx, w, t) => ratio(analytics.windowStats(ctx.db, "api.mem.cgroup_bytes", since(t, w)).avg, analytics.windowStats(ctx.db, "api.mem.limit_bytes", since(t, w)).avg),
  },
  {
    key: "host.cpu",
    label: "Host CPU busy",
    service: "Host",
    unit: "%",
    description: "The whole host's CPU use (shared with other workloads), averaged over the window.",
    threshold: 90,
    windowMinutes: 10,
    severity: "sev3",
    measure: (ctx, w, t) => analytics.windowStats(ctx.db, "host.cpu.pct", since(t, w)).avg,
  },
  {
    key: "host.memory",
    label: "Host memory low",
    service: "Host",
    unit: "% used",
    description: "The host's memory in use (total minus available), averaged over the window.",
    threshold: 90,
    windowMinutes: 10,
    severity: "sev3",
    measure: (ctx, w, t) => ratio(analytics.windowStats(ctx.db, "host.mem.used_bytes", since(t, w)).avg, analytics.windowStats(ctx.db, "host.mem.total_bytes", since(t, w)).avg),
  },
  {
    key: "host.disk",
    label: "Disk filling up",
    service: "Host",
    unit: "% used",
    description: "The data volume's disk in use.",
    threshold: 85,
    windowMinutes: 5,
    severity: "sev2",
    measure: (ctx, w, t) => ratio(analytics.windowStats(ctx.db, "host.disk.used_bytes", since(t, w)).avg, analytics.windowStats(ctx.db, "host.disk.total_bytes", since(t, w)).avg),
  },
  {
    key: "host.egress",
    label: "High outbound traffic",
    service: "Network",
    unit: "MB/s",
    description: "The host's outbound traffic (host collector), averaged over the window.",
    threshold: 20,
    windowMinutes: 15,
    severity: "sev3",
    measure: (ctx, w, t) => {
      const v = analytics.windowStats(ctx.db, "host.net.tx_bps", since(t, w)).avg;
      return v === null ? null : v / 1e6;
    },
  },
  {
    key: "egress.anomaly",
    label: "Outbound traffic far above normal",
    service: "Network",
    unit: "× the 7-day average",
    description: "The API's outbound traffic over the window against its hourly average for the previous 7 days (needs a day of history; ignored under 1 MB/s).",
    threshold: 3,
    windowMinutes: 30,
    severity: "sev3",
    measure(ctx, w, t) {
      const now = analytics.windowStats(ctx.db, "api.net.tx_bps", since(t, w)).avg;
      const hour = Math.floor(t / 3_600_000);
      const base = analytics.hourlyBaseline(ctx.db, "api.net.tx_bps", hour - 7 * 24, hour - 1);
      if (now === null || base.avg === null || base.hours < 24 || base.avg <= 0 || now < 1e6) return null;
      return now / base.avg;
    },
  },
  {
    key: "auth.failures",
    label: "Many failed sign-ins",
    service: "Authentication",
    unit: "failures",
    description: "Wrong passwords for existing accounts plus realtime connections refused for bad credentials, over the window.",
    threshold: 200,
    windowMinutes: 15,
    severity: "sev3",
    measure: (ctx, w, t) => auditActionCount(ctx.db, "account.login_failed", t - w * 60_000) + analytics.presenceWindow(ctx.db, since(t, w)).authFailures,
  },
  {
    key: "ws.abnormal",
    label: "Realtime connections dropping",
    service: "Realtime",
    unit: "drops",
    description: "Sockets closed without a close frame or by the heartbeat over the window.",
    threshold: 200,
    windowMinutes: 15,
    severity: "sev3",
    measure: (ctx, w, t) => {
      const p = analytics.presenceWindow(ctx.db, since(t, w));
      return p.samples ? p.abnormal : null;
    },
  },
  {
    key: "signups.spike",
    label: "Unusual number of sign-ups",
    service: "Accounts",
    unit: "accounts",
    description: "New accounts (load-test ones left out) over the window.",
    threshold: 100,
    windowMinutes: 60,
    severity: "sev3",
    measure: (ctx, w, t) => signupsSince(ctx.db, t - w * 60_000),
  },
  {
    key: "jobs.failing",
    label: "Background job failing",
    service: "Background jobs",
    unit: "jobs",
    description: "Background jobs whose last run failed within the window.",
    threshold: 0,
    windowMinutes: 15,
    severity: "sev3",
    measure: (ctx, w, t) => ctx.metrics.snapshot().jobs.filter((j) => j.lastFailureAt !== null && j.lastFailureAt === j.lastRunAt && t - j.lastFailureAt < w * 60_000).length,
  },
  {
    key: "quota.blocked",
    label: "Requests refused by quotas",
    service: "Quotas",
    unit: "refusals (deduplicated)",
    description: "Quota blocks and throttles recorded over the window.",
    threshold: 50,
    windowMinutes: 60,
    severity: "sev4",
    measure: (ctx, w, t) => ctx.quotas.eventCount(["blocked", "throttled"], t - w * 60_000),
  },
  {
    key: "collector.down",
    label: "Host collector not reporting",
    service: "Monitoring",
    unit: "",
    description: "The host collector is configured but its file hasn't been written for 3 minutes (host network and container figures stop).",
    threshold: 0,
    windowMinutes: 5,
    severity: "sev4",
    measure: (ctx) => {
      const c = ctx.telemetry.resources.collectorStatus();
      return c.configured ? (c.reporting ? 0 : 1) : null;
    },
  },
];

export const ruleByKey = (key: string) => RULES.find((r) => r.key === key);

/** Hysteresis: a breaching rule clears below this share of its threshold. */
const CLEAR_RATIO = 0.9;
export const ALERT_ACTOR = "system:alerts";

interface RuleRow {
  key: string;
  enabled: number;
  threshold: number;
  window_minutes: number;
  severity: Severity;
  updated_by: string;
  updated_at: number;
}

interface StateRow {
  key: string;
  breaching: number;
  since: number | null;
  last_value: number | null;
  last_eval_at: number;
  incident_id: string | null;
}

export interface RuleView {
  key: string;
  label: string;
  service: string;
  unit: string;
  description: string;
  enabled: boolean;
  threshold: number;
  windowMinutes: number;
  severity: Severity;
  isDefault: boolean;
  state: { breaching: boolean; since: number | null; lastValue: number | null; lastEvalAt: number | null; incidentId: string | null };
}

export class AlertEngine {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly store: PlatformAdminStore,
  ) {}

  start(intervalMs: number): void {
    if (intervalMs <= 0) return;
    this.timer = setInterval(() => void this.ctx.metrics.timeJob("alerts.evaluate", async () => this.evaluate()).catch((e) => this.ctx.log.error({ err: e }, "alert evaluation failed")), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private overrides(): Map<string, RuleRow> {
    return new Map((this.ctx.db.prepare("SELECT * FROM alert_rules").all() as RuleRow[]).map((r) => [r.key, r]));
  }

  private config(def: RuleDef, o: RuleRow | undefined) {
    return { enabled: o ? !!o.enabled : true, threshold: o?.threshold ?? def.threshold, windowMinutes: o?.window_minutes ?? def.windowMinutes, severity: o?.severity ?? def.severity };
  }

  rules(): RuleView[] {
    const o = this.overrides();
    const states = new Map((this.ctx.db.prepare("SELECT * FROM alert_state").all() as StateRow[]).map((s) => [s.key, s]));
    return RULES.map((def) => {
      const c = this.config(def, o.get(def.key));
      const s = states.get(def.key);
      return {
        key: def.key,
        label: def.label,
        service: def.service,
        unit: def.unit,
        description: def.description,
        ...c,
        isDefault: !o.has(def.key),
        state: { breaching: !!s?.breaching, since: s?.since ?? null, lastValue: s?.last_value ?? null, lastEvalAt: s?.last_eval_at ?? null, incidentId: s?.incident_id ?? null },
      };
    });
  }

  /** Changes a rule's settings (the caller audits it). */
  setRule(key: string, patch: { enabled: boolean; threshold: number; windowMinutes: number; severity: Severity }, actor: string): RuleView {
    const def = ruleByKey(key);
    if (!def) throw new ApiError(404, "not_found", "No such alert rule.");
    if (!Number.isFinite(patch.threshold) || patch.threshold < 0) throw new ApiError(400, "invalid_policy", "The threshold is a number, 0 or more.");
    if (!Number.isInteger(patch.windowMinutes) || patch.windowMinutes < 1 || patch.windowMinutes > 1440) throw new ApiError(400, "invalid_policy", "The window is 1–1440 minutes.");
    this.ctx.db
      .prepare(
        `INSERT INTO alert_rules (key, enabled, threshold, window_minutes, severity, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled, threshold = excluded.threshold, window_minutes = excluded.window_minutes,
           severity = excluded.severity, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(key, patch.enabled ? 1 : 0, patch.threshold, patch.windowMinutes, patch.severity, actor, now());
    return this.rules().find((r) => r.key === key)!;
  }

  /** One evaluation of every enabled rule. Returns the keys whose state changed. */
  async evaluate(t = now()): Promise<string[]> {
    const o = this.overrides();
    const changed: string[] = [];
    for (const def of RULES) {
      const c = this.config(def, o.get(def.key));
      if (!c.enabled) continue;
      let value: number | null;
      try {
        value = def.measure(this.ctx, c.windowMinutes, t);
      } catch (e) {
        this.ctx.log.warn({ err: e, rule: def.key }, "alert rule could not be measured");
        value = null;
      }
      const prev = this.ctx.db.prepare("SELECT * FROM alert_state WHERE key = ?").get(def.key) as StateRow | undefined;
      const wasBreaching = !!prev?.breaching;
      let breaching = wasBreaching;
      if (value !== null) {
        if (!wasBreaching && value > c.threshold) breaching = true;
        else if (wasBreaching && value <= c.threshold * CLEAR_RATIO) breaching = false;
      }
      let incidentId = prev?.incident_id ?? null;
      if (breaching && !wasBreaching) {
        incidentId = await this.open(def, c, value!, t);
        changed.push(def.key);
      } else if (!breaching && wasBreaching) {
        if (incidentId) this.note(incidentId, `Condition cleared: ${fmt(value)} ${def.unit} (threshold ${c.threshold}).`, t);
        changed.push(def.key);
      } else if (breaching && incidentId) {
        this.ctx.db.prepare("UPDATE platform_incidents SET last_seen_at = ? WHERE id = ?").run(t, incidentId);
      }
      this.ctx.db
        .prepare(
          `INSERT INTO alert_state (key, breaching, since, last_value, last_eval_at, incident_id) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET breaching = excluded.breaching, since = excluded.since, last_value = excluded.last_value,
             last_eval_at = excluded.last_eval_at, incident_id = excluded.incident_id`,
        )
        .run(def.key, breaching ? 1 : 0, breaching ? (wasBreaching ? (prev?.since ?? t) : t) : null, value, t, incidentId);
    }
    return changed;
  }

  private note(incidentId: string, body: string, t: number): void {
    this.ctx.db.prepare("INSERT INTO platform_incident_events (incident_id, at, actor_account_id, kind, body) VALUES (?, ?, ?, 'note', ?)").run(incidentId, t, ALERT_ACTOR, body);
    this.ctx.db.prepare("UPDATE platform_incidents SET updated_at = ? WHERE id = ?").run(t, incidentId);
  }

  /** Opens an incident for [def] or, while one from this rule is still unresolved, adds the new breach to it. */
  private async open(def: RuleDef, c: { threshold: number; windowMinutes: number; severity: Severity }, value: number, t: number): Promise<string> {
    const dedupe = `rule:${def.key}`;
    const existing = this.ctx.db.prepare("SELECT id FROM platform_incidents WHERE dedupe_key = ? AND status != 'resolved' ORDER BY created_at DESC LIMIT 1").get(dedupe) as { id: string } | undefined;
    const body = `${def.label}: ${fmt(value)} ${def.unit} over ${c.windowMinutes} min (threshold ${c.threshold}).`;
    if (existing) {
      this.note(existing.id, `Breached again. ${body}`, t);
      this.ctx.db.prepare("UPDATE platform_incidents SET last_seen_at = ? WHERE id = ?").run(t, existing.id);
      return existing.id;
    }
    const id = newId("inc");
    this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare(
          `INSERT INTO platform_incidents (id, title, severity, status, kind, created_by, created_at, updated_at, service, source, dedupe_key, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, 'open', 'incident', ?, ?, ?, ?, 'rule', ?, ?, ?)`,
        )
        .run(id, def.label, c.severity, ALERT_ACTOR, t, t, def.service, dedupe, t, t);
      this.ctx.db.prepare("INSERT INTO platform_incident_events (incident_id, at, actor_account_id, kind, body) VALUES (?, ?, ?, 'created', ?)").run(id, t, ALERT_ACTOR, body);
    })();
    await this.deliver(id, def, body, t);
    return id;
  }

  /** Emails the operators when the setting is on; records the real outcome of each send. */
  private async deliver(incidentId: string, def: RuleDef, body: string, t: number): Promise<void> {
    const record = (outcome: "sent" | "failed" | "not_configured", detail: string | null) =>
      this.ctx.db.prepare("INSERT INTO alert_deliveries (at, incident_id, channel, outcome, detail) VALUES (?, ?, 'email', ?, ?)").run(t, incidentId, outcome, detail);
    if (!platformSetting(this.ctx.db, "alerts.email")) {
      record("not_configured", "email alerts are off (platform setting)");
      return;
    }
    const mailer = this.ctx.accounts.mailer;
    if (!mailer.available) {
      record("not_configured", "the server has no mail transport");
      return;
    }
    const recipients = this.store.grants().filter((g) => g.revoked_at === null && (g.role === "super_admin" || g.role === "operations_admin"));
    for (const g of recipients) {
      const a = await this.ctx.accounts.store.accountById(g.account_id);
      if (!a) continue;
      try {
        await mailer.send({ to: a.email, subject: `[Meldiq alert] ${def.label}`, text: `${body}\n\nService: ${def.service}\nOpen the console's Support & Incidents page for incident ${incidentId}.` });
        record("sent", `to ${g.role}`);
      } catch (e) {
        record("failed", (e as { code?: string }).code ?? "send failed");
      }
    }
  }
}

const fmt = (v: number | null) => (v === null ? "no data" : Number.isInteger(v) ? String(v) : v.toFixed(2));
