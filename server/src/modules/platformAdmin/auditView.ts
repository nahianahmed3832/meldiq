import type { AppContext } from "../../app/context.js";
import type { Where } from "../../infrastructure/database/rows/index.js";
import { likeStarts } from "../../shared/utilities/sqlText.js";
import { now } from "../../shared/utilities/util.js";
import type { AuditOutcome, AuditRow, PlatformAudit } from "./audit.js";

export interface AuditQuery {
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  from?: number;
  to?: number;
  cursor?: number;
  limit: number;
}

/** Bound each scan even when the action prefix or upper time bound is sparse. The cursor advances through scanned rows. */
export function auditRows(ctx: AppContext, q: AuditQuery) {
  const where: Where = {};
  for (const [column, value] of [["actor_account_id", q.actor], ["target_type", q.targetType], ["target_id", q.targetId], ["outcome", q.outcome]] as const)
    if (value !== undefined && value !== "") where[column] = value;
  if (q.from !== undefined) where.at = { gte: q.from };
  if (q.cursor !== undefined) where.id = { lt: q.cursor };
  const candidates = ctx.platform.all<AuditRow>("platform_audit", { where, orderBy: [["id", "desc"]], limit: 5000 });
  const matches = candidates.filter((r) => (q.to === undefined || r.at <= q.to) && (!q.action || likeStarts(r.action, q.action)));
  const rows = matches.slice(0, q.limit);
  const next = matches.length > q.limit ? rows.at(-1)?.id : candidates.length === 5000 ? candidates.at(-1)?.id : undefined;
  return { rows, nextCursor: next === undefined ? null : String(next) };
}


function parseDetail(text: string | null): Record<string, string | number | boolean | null> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, string | number | boolean | null>;
  } catch {
    return null;
  }
}

/**
 * The platform audit for auditors and super admins (phase 4): filtered, newest first, a page at a time by row id, and
 * the hash chain checked on request. Read-only: nothing can change it from here (or anywhere: triggers refuse).
 */
export class AdminAuditView {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
  ) {}

  async search(q: AuditQuery) {
    const { rows: shown, nextCursor } = auditRows(this.ctx, q);
    const names = new Map<string, string>();
    for (const id of new Set(shown.map((r) => r.actor_account_id).filter((i): i is string => !!i))) {
      const a = await this.ctx.accounts.store.accountById(id);
      if (a) names.set(id, a.name);
    }
    return {
      events: shown.map((r) => ({
        id: r.id,
        at: r.at,
        requestId: r.request_id,
        actor: r.actor_account_id ? { accountId: r.actor_account_id, name: names.get(r.actor_account_id) ?? null } : null,
        actorRole: r.actor_role,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        outcome: r.outcome,
        reason: r.reason,
        network: r.network,
        detail: parseDetail(r.detail),
      })),
      nextCursor,
    };
  }

  verify() {
    return { ...this.audit.verify(), verifiedAt: now() };
  }
}

/** Existing partner-standing policy, evaluated by the audit owner without exposing its rows. */
export function hasRecentOrgSafetyAction(ctx: AppContext, orgId: string, since: number): boolean {
  return ctx.platform.all<{ action: string; detail: string | null }>("platform_audit", { where: {
    target_type: "org", target_id: orgId, at: { gte: since }, outcome: "success", action: { in: ["org.suspend", "discovery.update", "org.warn"] },
  } }).some(row => {
    if (row.action !== "discovery.update") return true;
    try { return JSON.parse(row.detail ?? "{}").removed === true; } catch { return true; }
  });
}
