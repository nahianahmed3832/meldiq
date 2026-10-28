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
    const where: Where = {};
    const set = (col: string, v: string | number | undefined) => {
      if (v !== undefined && v !== "") where[col] = v;
    };
    set("actor_account_id", q.actor);
    set("target_type", q.targetType);
    set("target_id", q.targetId);
    set("outcome", q.outcome);
    if (q.from !== undefined) where.at = { gte: q.from };
    if (q.cursor !== undefined) where.id = { lt: q.cursor };
    const rows = this.ctx.platform
      .all<AuditRow>("platform_audit", { where, orderBy: [["id", "desc"]] })
      .filter((r) => (q.to === undefined || r.at <= q.to) && (!q.action || likeStarts(r.action, q.action)))
      .slice(0, q.limit + 1);
    const shown = rows.slice(0, q.limit);
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
      nextCursor: rows.length > q.limit ? String(shown[shown.length - 1].id) : null,
    };
  }

  verify() {
    return { ...this.audit.verify(), verifiedAt: now() };
  }
}
