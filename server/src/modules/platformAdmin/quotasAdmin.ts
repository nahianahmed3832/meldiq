import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError, badRequest, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { userSummary, usernames } from "../accounts/index.js";
import { orgNames, orgRecord } from "../organizations/index.js";
import { isQuotaKey, periodEnd, periodOf, type PolicyRow, QUOTA_KEYS, quotaAdmin, type QuotaKey, type Scope } from "../quotas/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";

const MiB = 1024 * 1024;
const fmtLimit = (n: number, unit = "bytes") => (n === 0 ? "no limit" : unit === "bytes" ? `${Math.round(n / MiB)} MiB` : String(n));

/**
 * The console's side of the unified quota engine (docs/QUOTAS.md): policies, plans, the effective view for a person
 * or organization (with the server's own limits shown beside it), usage, the decision ledger and corrections. Every
 * change is audited with its before and after.
 */
export class AdminQuotas {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
  ) {}

  private names(rows: { scope_type: string; scope_id: string }[]): Map<string, string> {
    const users = usernames(this.ctx.db, rows.filter((r) => r.scope_type === "user").map((r) => r.scope_id));
    const orgs = orgNames(this.ctx.ws, rows.filter((r) => r.scope_type === "org").map((r) => r.scope_id));
    const plans = new Map(quotaAdmin.plans(this.ctx.db).map((p) => [p.id, p.name]));
    const out = new Map<string, string>();
    for (const r of rows) {
      const name = r.scope_type === "user" ? users.get(r.scope_id) : r.scope_type === "org" ? orgs.get(r.scope_id) : r.scope_type === "plan" ? plans.get(r.scope_id) : null;
      if (name) out.set(`${r.scope_type}:${r.scope_id}`, name);
    }
    return out;
  }

  private async accountNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of new Set(ids)) {
      const a = await this.ctx.accounts.store.accountById(id);
      if (a) out.set(id, a.name);
    }
    return out;
  }

  async policyViewsOf(rows: PolicyRow[]) {
    const n = this.names(rows);
    const people = await this.accountNames(rows.map((r) => r.created_by));
    return rows.map((r) => ({
      id: r.id,
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      scopeName: n.get(`${r.scope_type}:${r.scope_id}`) ?? null,
      key: r.quota_key,
      limit: r.limit_value,
      mode: r.mode,
      hard: !!r.hard,
      warnPct: r.warn_pct,
      gracePct: r.grace_pct,
      override: !!r.override,
      expiresAt: r.expires_at,
      reason: r.reason,
      createdBy: { accountId: r.created_by, name: people.get(r.created_by) ?? null },
      createdAt: r.created_at,
      supersededAt: r.superseded_at,
    }));
  }

  /** The server's own limits (environment), read-only here: the quota engine adds to them, never replaces them. */
  serverLimits(): { name: string; value: string; appliesTo: string }[] {
    const c = this.ctx.config;
    return [
      { name: "FILE_MAX_BYTES", value: fmtLimit(c.attachmentMaxBytes), appliesTo: "files.max_upload_bytes" },
      { name: "ATTACHMENT_USER_DAILY_BYTES", value: fmtLimit(c.attachmentUserDailyBytes), appliesTo: "files.upload_bytes (per day, per person)" },
      { name: "ATTACHMENT_USER_STORED_BYTES", value: fmtLimit(c.attachmentUserStoredBytes), appliesTo: "storage.bytes (person)" },
      { name: "ATTACHMENT_ORG_STORED_BYTES", value: fmtLimit(c.abuse.orgStoredBytes), appliesTo: "storage.bytes (organization)" },
      { name: "ATTACHMENT_TOTAL_BYTES", value: fmtLimit(c.attachmentTotalBytes), appliesTo: "storage.bytes (platform)" },
      { name: "ATTACHMENT_UPLOAD_STARTS_PER_HOUR", value: fmtLimit(c.abuse.uploadStartsPerHour, "count"), appliesTo: "uploads started per person per hour" },
      { name: "NEW_ACCOUNT_DAILY_UPLOAD_BYTES", value: fmtLimit(c.abuse.newAccountDailyBytes), appliesTo: "new accounts' uploads per day" },
      { name: "MAX_DEVICES_PER_USER", value: fmtLimit(c.abuse.maxDevicesPerUser, "count"), appliesTo: "devices per person (sessions.active, ws.connections)" },
      { name: "WS_MAX_SOCKETS_PER_DEVICE", value: String(c.abuse.wsMaxSocketsPerDevice), appliesTo: "ws.connections (per device; the oldest is closed)" },
      { name: "RATE_LIMIT_PER_MINUTE", value: String(c.rateLimitPerMinute), appliesTo: "api.requests (per minute: the throttle)" },
      ...Object.entries(c.entitlements.limits).map(([k, v]) => ({ name: `ENTITLEMENT_LIMITS ${k}`, value: String(v), appliesTo: `${k} (per workspace)` })),
    ];
  }

  private alsoLimitedBy(key: QuotaKey, scope: Scope): string[] {
    const c = this.ctx.config;
    const out: string[] = [];
    const add = (cond: boolean, text: string) => cond && out.push(text);
    if (key === "files.max_upload_bytes") add(true, `FILE_MAX_BYTES ${fmtLimit(c.attachmentMaxBytes)}`);
    if (key === "storage.bytes") {
      add(scope.type === "user" && c.attachmentUserStoredBytes > 0, `ATTACHMENT_USER_STORED_BYTES ${fmtLimit(c.attachmentUserStoredBytes)}`);
      add(scope.type === "org" && c.abuse.orgStoredBytes > 0, `ATTACHMENT_ORG_STORED_BYTES ${fmtLimit(c.abuse.orgStoredBytes)}`);
      if (scope.type === "org") {
        const ent = this.ctx.entitlements.limitFor("storage.bytes", scope.id);
        add(ent.limit !== null, `workspace limit ${fmtLimit(ent.limit ?? 0)} (${ent.source})`);
      }
      add(scope.type === "global" && c.attachmentTotalBytes > 0, `ATTACHMENT_TOTAL_BYTES ${fmtLimit(c.attachmentTotalBytes)}`);
    }
    if (key === "files.upload_bytes") add(scope.type === "user" && c.attachmentUserDailyBytes > 0, `ATTACHMENT_USER_DAILY_BYTES ${fmtLimit(c.attachmentUserDailyBytes)} a day`);
    if (key === "ws.connections") add(true, `${c.abuse.wsMaxSocketsPerDevice} sockets per device`);
    if (key === "sessions.active") add(c.abuse.maxDevicesPerUser > 0, `MAX_DEVICES_PER_USER ${c.abuse.maxDevicesPerUser}`);
    if (key === "api.requests") add(true, `RATE_LIMIT_PER_MINUTE ${c.rateLimitPerMinute}`);
    return out;
  }

  /** Every key's effective policy and current usage for one person or organization. */
  effective(scope: Scope) {
    const q = this.ctx.quotas;
    return (Object.keys(QUOTA_KEYS) as QuotaKey[])
      .filter((key) => (QUOTA_KEYS[key].scopes as readonly string[]).includes(scope.type))
      .map((key) => {
        const def = QUOTA_KEYS[key];
        const e = q.effective(key, scope);
        const u = def.kind === "counter" ? q.usage(key, scope) : null;
        return {
          key,
          label: def.label,
          unit: def.unit,
          scope: { type: scope.type, id: scope.id },
          source: e.source,
          policyId: e.policy?.id ?? null,
          limit: e.limit,
          mode: e.mode,
          used: u?.used ?? null,
          reserved: u?.reserved ?? null,
          period: periodOf(def.period, now()),
          resetsAt: periodEnd(def.period, now()),
          alsoLimitedBy: this.alsoLimitedBy(key, scope),
        };
      });
  }

  async overview() {
    const db = this.ctx.db;
    const t = now();
    const policies = quotaAdmin.activePolicies(db);
    const plans = quotaAdmin.plans(db);
    // This period's busiest counters (bounded), with their limits.
    const counters = (Object.keys(QUOTA_KEYS) as QuotaKey[]).flatMap((key) => {
      const def = QUOTA_KEYS[key];
      return quotaAdmin.topCounters(db, key, periodOf(def.period, t), 20).map((c) => ({ key, ...c }));
    });
    const n = this.names(counters);
    const usage = counters.map((c) => {
      const limit = this.ctx.quotas.effective(c.key, { type: c.scope_type as Scope["type"], id: c.scope_id }).limit;
      return {
        key: c.key,
        scopeType: c.scope_type,
        scopeId: c.scope_id,
        scopeName: n.get(`${c.scope_type}:${c.scope_id}`) ?? null,
        period: c.period_start,
        used: c.used,
        reserved: c.reserved,
        limit,
        pct: limit ? Math.round(((c.used + c.reserved) / limit) * 1000) / 10 : null,
      };
    });
    const events = quotaAdmin.eventCounts(db, t - 86_400_000);
    return {
      keys: (Object.keys(QUOTA_KEYS) as QuotaKey[]).map((key) => {
        const d = QUOTA_KEYS[key];
        return { key, label: d.label, unit: d.unit, kind: d.kind, period: d.period, scopes: [...d.scopes], enforceable: [...d.enforceable], enforcedAt: d.enforcedAt };
      }),
      policies: await this.policyViewsOf(policies),
      plans: plans.map((p) => ({ id: p.id, name: p.name, description: p.description, members: p.members, createdAt: p.created_at })),
      serverLimits: this.serverLimits(),
      usage,
      events: { last24h: events },
      resolution:
        "For each scope a request touches (the person, their organization, the platform, a capacity pool): a temporary exception, else the scope's own policy, else its plan's, else the platform default for that kind of scope. A hard default caps narrower policies. Every scope must pass. The server's own limits (listed) apply as well.",
    };
  }

  private requireScope(scopeType: string, scopeId: string): void {
    if (scopeType === "user" && !userSummary(this.ctx.db, scopeId)) throw notFound("No person has that id.");
    if (scopeType === "org" && !orgRecord(this.ctx.ws, scopeId)) throw notFound("No organization has that id.");
    if (scopeType === "plan" && !quotaAdmin.planExists(this.ctx.db, scopeId)) throw notFound("No such plan.");
    if (scopeType === "pool" && !/^[a-z][a-z0-9_-]{1,30}$/.test(scopeId)) throw badRequest("A capacity pool is named in lower case (for example realtime).");
  }

  private record(p: AdminPrincipal, action: string, targetType: string, targetId: string, reason: string, meta: RequestMeta, detail: Record<string, unknown>): void {
    this.audit.record({ action, outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType, targetId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: flatDetail(detail) });
  }

  /** How many scopes with usage this period are already over [limit] (the change's impact, shown before people rely on it). */
  private overNow(key: QuotaKey, scopeType: string, scopeId: string, limit: number | null): number {
    if (limit === null || QUOTA_KEYS[key].kind !== "counter") return 0;
    const period = periodOf(QUOTA_KEYS[key].period, now());
    if (scopeType === "plan") return 0;
    const target = scopeType === "global" && scopeId.startsWith("default:") ? scopeId.slice(8) : scopeType;
    return quotaAdmin.countersOver(this.ctx.db, key, period, target, scopeId.startsWith("default:") ? null : scopeId, limit);
  }

  async setPolicy(
    p: AdminPrincipal,
    b: { scopeType: Scope["type"] | "plan"; scopeId: string; key: string; limit: number | null; mode: PolicyRow["mode"]; hard: boolean; warnPct: number; gracePct: number; override: boolean; expiresAt: number | null; reason: string },
    meta: RequestMeta,
  ) {
    if (!isQuotaKey(b.key)) throw badRequest("Unknown quota.");
    const def = QUOTA_KEYS[b.key];
    const scopeKind = b.scopeType === "global" && b.scopeId.startsWith("default:") ? b.scopeId.slice(8) : b.scopeType;
    if (b.scopeType !== "plan" && !(def.scopes as readonly string[]).includes(scopeKind)) throw badRequest(`${def.label} can't be limited per ${scopeKind}.`);
    this.requireScope(b.scopeType, b.scopeId);
    const before = quotaAdmin.currentPolicy(this.ctx.db, b.scopeType, b.scopeId, b.key, b.override);
    const row = this.ctx.quotas.setPolicy({ scopeType: b.scopeType, scopeId: b.scopeId, key: b.key, limit: b.limit, mode: b.mode, hard: b.hard, warnPct: b.warnPct, gracePct: b.gracePct, override: b.override, expiresAt: b.expiresAt, reason: b.reason }, p.account.id);
    this.record(p, b.override ? "quota.override" : "quota.policy", "quota_policy", row.id, b.reason, meta, {
      key: b.key,
      scope: `${b.scopeType}:${b.scopeId}`,
      before: before ? { limit: before.limit_value, mode: before.mode } : null,
      after: { limit: b.limit, mode: b.mode, hard: b.hard, expiresAt: b.expiresAt },
    });
    const scopesOverNow = this.overNow(b.key, b.scopeType, b.scopeId, b.limit);
    return {
      policy: (await this.policyViewsOf([row]))[0]!,
      impact: {
        scopesOverNow,
        note:
          b.mode === "observe"
            ? "Observe mode: nothing is refused; overages are recorded."
            : scopesOverNow
              ? `${scopesOverNow} scope(s) already use more than this limit this period: their next ${def.label.toLowerCase()} request will be ${b.mode === "warn" ? "warned about" : "refused"}.`
              : "Nothing is over this limit right now. A policy changes what the server allows; it doesn't add capacity.",
      },
    };
  }

  async removePolicy(p: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    const row = this.ctx.quotas.removePolicy(id);
    if (!row) throw notFound("No such active policy.");
    this.record(p, "quota.policy_remove", "quota_policy", id, reason, meta, { key: row.quota_key, scope: `${row.scope_type}:${row.scope_id}`, before: { limit: row.limit_value, mode: row.mode } });
    return { ok: true as const };
  }

  createPlan(p: AdminPrincipal, b: { name: string; description: string; reason: string }, meta: RequestMeta) {
    if (quotaAdmin.planNameTaken(this.ctx.db, b.name)) throw new ApiError(409, "conflict", "A plan with that name exists.");
    const id = newId("qpl");
    quotaAdmin.createPlan(this.ctx.db, id, b.name, b.description, p.account.id, now());
    this.record(p, "quota.plan_create", "quota_plan", id, b.reason, meta, { name: b.name });
    return { ok: true as const };
  }

  assignPlan(p: AdminPrincipal, planId: string, b: { scopeType: "org" | "user"; scopeId: string; reason: string }, meta: RequestMeta) {
    this.requireScope("plan", planId);
    this.requireScope(b.scopeType, b.scopeId);
    const before = quotaAdmin.planOfScope(this.ctx.db, b.scopeType, b.scopeId);
    quotaAdmin.assignPlan(this.ctx.db, b.scopeType, b.scopeId, planId, p.account.id, now());
    this.record(p, "quota.plan_assign", b.scopeType === "org" ? "org" : "user", b.scopeId, b.reason, meta, { before, after: planId });
    return { ok: true as const };
  }

  unassignPlan(p: AdminPrincipal, b: { scopeType: "org" | "user"; scopeId: string; reason: string }, meta: RequestMeta) {
    const before = quotaAdmin.planOfScope(this.ctx.db, b.scopeType, b.scopeId);
    if (!before) throw notFound("That scope isn't on a plan.");
    quotaAdmin.unassignPlan(this.ctx.db, b.scopeType, b.scopeId);
    this.record(p, "quota.plan_unassign", b.scopeType === "org" ? "org" : "user", b.scopeId, b.reason, meta, { before });
    return { ok: true as const };
  }

  adjust(p: AdminPrincipal, b: { key: string; scopeType: Scope["type"]; scopeId: string; delta: number; reason: string }, meta: RequestMeta) {
    if (!isQuotaKey(b.key) || QUOTA_KEYS[b.key].kind !== "counter") throw badRequest("Only usage counters can be corrected.");
    if (b.delta === 0) throw badRequest("A correction changes the count.");
    this.requireScope(b.scopeType, b.scopeId);
    const before = this.ctx.quotas.usage(b.key, { type: b.scopeType, id: b.scopeId });
    this.ctx.quotas.adjust(b.key, { type: b.scopeType, id: b.scopeId }, b.delta, p.account.id, b.reason);
    this.record(p, "quota.adjust", "quota_counter", `${b.key}:${b.scopeType}:${b.scopeId}`, b.reason, meta, { delta: b.delta, before: before.used, period: before.period });
    return { ok: true as const };
  }

  async events(q: { key?: string; scopeType?: string; scopeId?: string; cursor?: number; limit: number }) {
    const rows = quotaAdmin.eventsPage(this.ctx.db, { ...q, limit: q.limit + 1 });
    const shown = rows.slice(0, q.limit);
    const people = await this.accountNames(shown.map((r) => r.actor).filter((a): a is string => !!a));
    return {
      events: shown.map((r) => ({
        id: r.id,
        at: r.at,
        key: r.quota_key,
        scopeType: r.scope_type,
        scopeId: r.scope_id,
        outcome: r.outcome,
        amount: r.amount,
        used: r.used,
        limit: r.limit_value,
        actor: r.actor ? { accountId: r.actor, name: people.get(r.actor) ?? null } : null,
        detail: r.detail,
      })),
      nextCursor: rows.length > q.limit ? shown[shown.length - 1]!.id : null,
    };
  }
}

/** Audit details are flat: nested before/after values are kept as JSON text. */
export function flatDetail(d: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(d).map(([k, v]) => [k, v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean)]),
  );
}
