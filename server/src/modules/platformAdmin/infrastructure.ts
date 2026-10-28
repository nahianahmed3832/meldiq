import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { checkConnector, connectorReport, type HealthReport, healthReport } from "../administration/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";

/** Routes worth a look: any server errors or a slow 95th percentile, then the busiest, at most this many. */
const ROUTES_SHOWN = 15;
const SLOW_MS = 1000;

type Status = "ok" | "failing" | "not_measured" | "off";

function checks(h: HealthReport): { id: string; label: string; status: Status; detail: string | null }[] {
  const { database, mongodb, livekit, storage } = h.checks;
  return [
    database.available
      ? { id: "database", label: "Database (SQLite)", status: database.ok ? "ok" : "failing", detail: `${Math.round(database.sizeBytes / 1_048_576)} MB on disk` }
      : { id: "database", label: "Database (SQLite)", status: "not_measured", detail: database.reason },
    mongodb.available
      ? { id: "mongodb", label: "MongoDB", status: mongodb.ok ? "ok" : "failing", detail: null }
      : { id: "mongodb", label: "MongoDB", status: "off", detail: mongodb.reason },
    livekit.available
      ? { id: "livekit", label: "Calls (LiveKit)", status: livekit.configured ? "ok" : "off", detail: livekit.configured ? "Configured" : "Not configured" }
      : { id: "livekit", label: "Calls (LiveKit)", status: "not_measured", detail: livekit.reason },
    storage.available
      ? { id: "storage", label: "File storage", status: storage.reachable ? "ok" : "failing", detail: `${storage.backend}${storage.errorKind ? ` · ${storage.errorKind}` : ""}` }
      : { id: "storage", label: "File storage", status: "not_measured", detail: storage.reason },
  ];
}

/**
 * Infrastructure and service health (phase 4): the existing health report and connector register (docs/OPERATIONS.md,
 * docs/CONNECTORS.md), as measured values only. Never environment values, secrets or log lines.
 */
export class AdminInfrastructure {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
    private readonly version: string,
  ) {}

  async report() {
    const h = await healthReport(this.ctx, this.version);
    const m = h.metrics;
    const routes = [...m.routes].sort((a, b) => b.serverErrors - a.serverErrors || (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || b.count - a.count);
    const notable = [...routes.filter((r) => r.serverErrors > 0 || (r.p95Ms ?? 0) >= SLOW_MS), ...routes].filter((r, i, all) => all.indexOf(r) === i).slice(0, ROUTES_SHOWN);
    return {
      version: h.version,
      generatedAt: h.generatedAt,
      uptimeSeconds: h.uptimeSeconds,
      checks: checks(h),
      process: h.process,
      onlineDevices: h.realtime.onlineDevices,
      queues: {
        deliveryItems: h.queues.delivery.items,
        deliveryOldestAgeSeconds: h.queues.delivery.oldestAgeSeconds,
        remindersOverdue: h.queues.reminders.overdueUndelivered,
        remindersRetrying: h.queues.reminders.retrying,
      },
      window: { since: m.since, ...m.window },
      routes: notable,
      jobs: m.jobs.map((j) => ({ name: j.name, runs: j.runs, failures: j.failures, lastRunAt: j.lastRunAt, lastFailureAt: j.lastFailureAt, lastErrorKind: j.lastErrorKind })),
      providers: m.providers,
      connectors: (await connectorReport(this.ctx)).map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        state: c.state,
        missing: c.missing,
        detail: c.detail,
        lastOkAt: c.lastOkAt,
        lastFailureAt: c.lastFailureAt,
        lastErrorKind: c.lastErrorKind,
        checkable: c.checkable,
        ownerAction: c.ownerAction,
      })),
      warnings: h.warnings,
    };
  }

  /** A connector check that sends nothing to anyone (sign in to SMTP, list storage, FCM token, Mongo ping). Audited. */
  async check(p: AdminPrincipal, id: string, meta: RequestMeta) {
    const result = await checkConnector(this.ctx, id);
    await this.audit.record({
      action: "connector.check",
      outcome: result.ok ? "success" : "failed",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "connector",
      targetId: id,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail: { errorKind: result.errorKind },
    });
    return result;
  }
}
