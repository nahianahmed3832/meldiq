import type { AppContext } from "../../app/context.js";
import { now } from "../../shared/utilities/util.js";
import { userCounts } from "../accounts/index.js";
import { healthReport } from "../administration/index.js";
import { orgCounts } from "../organizations/index.js";
import type { AdminPrincipal } from "./auth.js";
import { can } from "./permissions.js";

const TREND_DAYS = 30;
const RECENT_ACTIONS = 10;

type Check = { available: true; ok?: boolean; reachable?: boolean } | { available: false };
/** A measured check as true/false, or null when this server can't measure it (never a guess). */
const measured = (c: Check, key: "ok" | "reachable"): boolean | null => (c.available ? (c[key] ?? null) : null);

/**
 * The console's overview (ARCHITECTURE_PROPOSAL.md §7.2): each figure from a named source over a stated window.
 * Health, load and recent admin actions appear only for roles that may see them; billing says it doesn't exist.
 */
export async function overview(ctx: AppContext, p: AdminPrincipal, version: string) {
  const t = now();
  const health = can(p.grant.role, "health.view") ? await healthReport(ctx, version) : null;
  await ctx.usage.snapshot();
  const workspaceBytes = ctx.usage.totals(1).reduce((sum, o) => sum + (o.metrics["storage.bytes"] ?? 0), 0);
  const recent = can(p.grant.role, "audit.view")
    ? (ctx.db.prepare("SELECT at, action, outcome, actor_role, target_type FROM platform_audit ORDER BY id DESC LIMIT ?").all(RECENT_ACTIONS) as {
        at: number;
        action: string;
        outcome: string;
        actor_role: string | null;
        target_type: string | null;
      }[])
    : null;
  const openIncidents = (ctx.db.prepare("SELECT COUNT(*) n FROM platform_incidents WHERE status != 'resolved'").get() as { n: number }).n;
  return {
    generatedAt: t,
    people: userCounts(ctx.db, t, TREND_DAYS),
    organizations: orgCounts(ctx.db, t, TREND_DAYS),
    storage: { workspaceBytes, measuredAt: new Date(t).toISOString().slice(0, 10) },
    requests: health ? { since: health.metrics.since, windowMinutes: health.metrics.window.minutes, requests: health.metrics.window.requests, serverErrors: health.metrics.window.serverErrors, errorRate: health.metrics.window.errorRate, p95Ms: health.metrics.window.p95Ms } : null,
    health: health
      ? {
          version: health.version,
          uptimeSeconds: health.uptimeSeconds,
          database: measured(health.checks.database, "ok"),
          mongodb: measured(health.checks.mongodb, "ok"),
          storage: measured(health.checks.storage, "reachable"),
          onlineDevices: health.realtime.onlineDevices,
          queuedDeliveries: health.queues.delivery.items,
          warnings: health.warnings,
        }
      : null,
    billing: { available: !!ctx.billing.provider, reason: ctx.billing.unavailableReason },
    recentActions: recent ? recent.map((r) => ({ at: r.at, action: r.action, outcome: r.outcome, actorRole: r.actor_role, targetType: r.target_type })) : null,
    openIncidents,
  };
}
