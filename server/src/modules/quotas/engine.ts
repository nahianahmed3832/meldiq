import type { RowReader, Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { ApiError } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { isQuotaKey, type QuotaKey, QUOTA_KEYS, type QuotaMode, periodEnd, periodOf, type ScopeType } from "./keys.js";

/**
 * The unified quota engine (docs/QUOTAS.md). One policy store, one resolution rule, one accounting path.
 *
 * Resolution, per scope a request touches (its person, its organization, the platform total, a capacity pool):
 *   1. a temporary override for that exact scope, while it hasn't expired;
 *   2. the scope's own policy;
 *   3. the policy of the plan the scope is on (people and organizations);
 *   4. the global default for that kind of scope ("default:user", "default:org").
 * A hard global default caps whatever 1–3 say. The platform total and capacity pools are scopes of their own, checked
 * against their own usage, so nothing narrower can raise them. A request passes only if every scope it touches passes.
 *
 * Accounting: counters per scope, key and period (quota_counters); a check and its reservation happen in one write
 * unit of the platform rows, so two requests can't both take the last of an allowance. Gauges (stored bytes, open
 * sockets) are measured by the caller and the engine adds what open reservations hold.
 *
 * Modes: observe (measure, record overages), warn (record crossing the warning level), soft (allow up to the grace
 * percentage over, then block), throttle (refuse with retry-after until the period resets), block (refuse at the
 * limit). Nothing ships enforcing: there are no policies until an operator writes one.
 */

export interface PolicyRow {
  id: string;
  scope_type: ScopeType;
  scope_id: string;
  quota_key: string;
  limit_value: number | null;
  mode: QuotaMode;
  hard: number;
  warn_pct: number;
  grace_pct: number;
  override: number;
  expires_at: number | null;
  reason: string;
  created_by: string;
  created_at: number;
  superseded_at: number | null;
  superseded_by: string | null;
}

/** A scope a request is charged to. */
export interface Scope {
  type: "global" | "pool" | "org" | "user";
  id: string;
}

export interface EffectivePolicy {
  scope: Scope;
  /** The policy that applies and why ("override", "own", "plan", "default", "hard default"); null: no limit. */
  policy: PolicyRow | null;
  source: "override" | "own" | "plan" | "default" | "hard_default" | "none";
  limit: number | null;
  mode: QuotaMode;
  /** Hard ceilings that capped a narrower policy. */
  cappedBy: string | null;
}

export interface ScopeDecision extends EffectivePolicy {
  used: number;
  reserved: number;
  after: number;
  outcome: "ok" | "warned" | "observed_over" | "soft_over" | "throttled" | "blocked";
}

export interface Decision {
  key: QuotaKey;
  allowed: boolean;
  scopes: ScopeDecision[];
  reservationId: string | null;
  /** When the period of the refusing scope resets (throttle and block), or null. */
  retryAt: number | null;
}

/** What a caller measured for gauge keys (stored bytes, open sockets), per scope id. */
export type Measured = Partial<Record<"global" | "pool" | "org" | "user", number>>;

export interface PolicyInput {
  scopeType: ScopeType;
  scopeId: string;
  key: QuotaKey;
  limit: number | null;
  mode: QuotaMode;
  hard?: boolean;
  warnPct?: number;
  gracePct?: number;
  override?: boolean;
  expiresAt?: number | null;
  reason: string;
}

/** Reservations not settled within this long are released by the cleanup job (a request that died part-way). */
export const RESERVATION_TTL_MS = 30 * 60_000;
/** The same scope, key and outcome is recorded at most this often (a busy scope over its limit would flood the log). */
const EVENT_EVERY_MS = 10 * 60_000;

const DEFAULT_SCOPE: Partial<Record<ScopeType, string>> = { user: "default:user", org: "default:org" };

export class QuotaEngine {
  /** Active policies by key, refreshed on every change (a few hundred rows at most). */
  private cache: Map<string, PolicyRow[]> | null = null;
  private recent = new Map<string, number>();

  constructor(
    /** The platform domain's rows: policies, plans, counters, events and reservations. */
    private readonly rows: Rows,
    private readonly clock: () => number = Date.now,
    /** The quota plan a granting subscription puts a person or organization on (billing), after operator assignments. */
    private readonly subscribedPlan: (scope: Scope, t: number) => string | null = () => null,
  ) {}

  /** Whether [id] is a quota plan that can still be assigned (not archived). */
  planExists(id: string): boolean {
    return !!this.rows.get("quota_plans", { id, archived_at: null });
  }

  private policies(key: string): PolicyRow[] {
    if (!this.cache) {
      this.cache = new Map();
      for (const r of this.rows.all<PolicyRow>("quota_policies", { where: { superseded_at: null } })) this.cache.set(r.quota_key, [...(this.cache.get(r.quota_key) ?? []), r]);
    }
    return this.cache.get(key) ?? [];
  }

  /** Whether any policy exists for [key] (callers skip measuring when none does). */
  hasPolicies(key: QuotaKey): boolean {
    return this.policies(key).length > 0;
  }

  /** The plan [scope] is on, if any: an operator's assignment first, else the one its subscription grants. */
  planOf(scope: Scope): string | null {
    if (scope.type !== "org" && scope.type !== "user") return null;
    const row = this.rows.get<{ plan_id: string }>("quota_plan_members", { scope_type: scope.type, scope_id: scope.id });
    return row?.plan_id ?? this.subscribedPlan(scope, this.clock());
  }

  /** The policy that applies to [scope] for [key] at [t], following the resolution order above. */
  effective(key: QuotaKey, scope: Scope, t = this.clock()): EffectivePolicy {
    const all = this.policies(key).filter((p) => p.expires_at === null || p.expires_at > t);
    const at = (type: ScopeType, id: string, override: boolean) => all.find((p) => p.scope_type === type && p.scope_id === id && !!p.override === override) ?? null;
    let found: { policy: PolicyRow; source: EffectivePolicy["source"] } | null = null;
    if (scope.type === "global" || scope.type === "pool") {
      const own = at(scope.type, scope.id, false);
      if (own) found = { policy: own, source: "own" };
    } else {
      const override = at(scope.type, scope.id, true);
      const own = at(scope.type, scope.id, false);
      const plan = this.planOf(scope);
      const planPolicy = plan ? at("plan", plan, false) : null;
      const def = at("global", DEFAULT_SCOPE[scope.type]!, false);
      found = override
        ? { policy: override, source: "override" }
        : own
          ? { policy: own, source: "own" }
          : planPolicy
            ? { policy: planPolicy, source: "plan" }
            : def
              ? { policy: def, source: "default" }
              : null;
      // A hard default caps narrower allocations (they may lower it, never raise it).
      if (found && def && def.hard && found.policy !== def && def.limit_value !== null && (found.policy.limit_value === null || found.policy.limit_value > def.limit_value)) {
        return { scope, policy: def, source: "hard_default", limit: def.limit_value, mode: def.mode, cappedBy: def.id };
      }
    }
    if (!found) return { scope, policy: null, source: "none", limit: null, mode: "observe", cappedBy: null };
    return { scope, policy: found.policy, source: found.source, limit: found.policy.limit_value, mode: found.policy.mode, cappedBy: null };
  }

  private counter(r: RowReader, scope: Scope, key: QuotaKey, period: string): { used: number; reserved: number } {
    const row = r.get<{ used: number; reserved: number }>("quota_counters", { scope_type: scope.type, scope_id: scope.id, quota_key: key, period_start: period });
    return row ? { used: row.used, reserved: row.reserved } : { used: 0, reserved: 0 };
  }

  /** Adds [used] and [reserved] (either may be negative) to a counter, never below zero. */
  private bump(w: RowWriter, scope: Scope, key: QuotaKey, period: string, used: number, reserved: number, t: number): void {
    const where = { scope_type: scope.type, scope_id: scope.id, quota_key: key, period_start: period };
    const c = w.get<{ used: number; reserved: number }>("quota_counters", where);
    if (!c) w.insert("quota_counters", { ...where, used, reserved, updated_at: t });
    else w.update("quota_counters", where, { used: Math.max(0, c.used + used), reserved: Math.max(0, c.reserved + reserved), updated_at: t });
  }

  private event(w: RowWriter, key: QuotaKey, d: ScopeDecision, amount: number, t: number, detail: string | null = null): void {
    if (d.outcome === "ok") return;
    const k = `${key}|${d.scope.type}|${d.scope.id}|${d.outcome}`;
    if (t - (this.recent.get(k) ?? 0) < EVENT_EVERY_MS) return;
    this.recent.set(k, t);
    if (this.recent.size > 10_000) this.recent.clear();
    w.insert("quota_events", {
      at: t,
      quota_key: key,
      scope_type: d.scope.type,
      scope_id: d.scope.id,
      outcome: d.outcome,
      amount: Math.round(amount),
      used: Math.round(d.used + d.reserved),
      limit_value: d.limit,
      policy_id: d.policy?.id ?? null,
      detail,
    });
  }

  /** One scope's verdict for adding [amount] on top of [used] + [reserved]. */
  private judge(e: EffectivePolicy, used: number, reserved: number, amount: number, perRequest: boolean): ScopeDecision {
    const after = perRequest ? amount : used + reserved + amount;
    const base = { ...e, used, reserved, after };
    if (e.limit === null) return { ...base, outcome: "ok" };
    const over = after > e.limit;
    const warnAt = (e.limit * (e.policy?.warn_pct ?? 80)) / 100;
    switch (e.mode) {
      case "observe":
        return { ...base, outcome: over ? "observed_over" : "ok" };
      case "warn":
        return { ...base, outcome: after >= warnAt ? "warned" : "ok" };
      case "soft": {
        const ceiling = e.limit * (1 + (e.policy?.grace_pct ?? 0) / 100);
        return { ...base, outcome: after > ceiling ? "blocked" : over ? "soft_over" : after >= warnAt ? "warned" : "ok" };
      }
      case "throttle":
        return { ...base, outcome: over ? "throttled" : after >= warnAt ? "warned" : "ok" };
      case "block":
        return { ...base, outcome: over ? "blocked" : after >= warnAt ? "warned" : "ok" };
    }
  }

  /**
   * Checks adding [amount] of [key] for [scopes] and, when allowed and [reserve] is set, reserves it in the same
   * write unit (settle with [commit] or [release]). Counters: the engine's own usage. Gauges: [measured] per scope
   * type, plus open reservations. Throws nothing; the caller decides how to refuse ([refusal]).
   */
  async check(key: QuotaKey, scopes: Scope[], amount: number, opts: { measured?: Measured; reserve?: boolean; idempotencyKey?: string; detail?: string; ttlMs?: number } = {}): Promise<Decision> {
    // Nothing governs this key: nothing to check, measure or write (the default for every key).
    if (!this.hasPolicies(key)) return { key, allowed: true, scopes: [], reservationId: null, retryAt: null };
    const def = QUOTA_KEYS[key];
    const t = this.clock();
    const period = periodOf(def.period, t);
    const applicable = scopes.filter((s) => (def.scopes as readonly string[]).includes(s.type));
    // The verdict is read inside the unit, so two requests can't both take the last of an allowance.
    return this.rows.write((w): Decision => {
      if (opts.idempotencyKey) {
        const prior = w.get<{ id: string; state: string }>("quota_reservations", { idempotency_key: opts.idempotencyKey });
        if (prior) return { key, allowed: prior.state !== "released", scopes: [], reservationId: prior.id, retryAt: null };
      }
      const decisions = applicable.map((scope) => {
        const e = this.effective(key, scope, t);
        const c = this.counter(w, scope, key, period);
        const used = def.kind === "gauge" ? (opts.measured?.[scope.type] ?? 0) : c.used;
        return this.judge(e, used, def.kind === "per_request" ? 0 : c.reserved, amount, def.kind === "per_request");
      });
      const refused = decisions.find((d) => d.outcome === "blocked" || d.outcome === "throttled");
      for (const d of decisions) this.event(w, key, d, amount, t, opts.detail ?? null);
      let reservationId: string | null = null;
      if (!refused && opts.reserve && def.kind !== "per_request" && amount > 0) {
        reservationId = newId("qr");
        for (const scope of applicable) this.bump(w, scope, key, period, 0, amount, t);
        w.insert("quota_reservations", {
          id: reservationId,
          idempotency_key: opts.idempotencyKey ?? null,
          quota_key: key,
          scopes: JSON.stringify(applicable.map((s) => ({ ...s, period }))),
          amount: Math.round(amount),
          state: "reserved",
          created_at: t,
          expires_at: t + (opts.ttlMs ?? RESERVATION_TTL_MS),
        });
      }
      const retryAt = refused ? (periodEnd(def.period, t) ?? null) : null;
      return { key, allowed: !refused, scopes: decisions, reservationId, retryAt };
    });
  }

  /**
   * Settles a reservation with what was really used ([actual], default the reserved amount): counters move it from
   * reserved to used; gauges just drop the reservation (the source now measures it). Idempotent.
   */
  commit(reservationId: string, actual?: number): Promise<void> {
    return this.settle(reservationId, "committed", actual);
  }

  /** Gives a reservation back (the operation failed or was refused later). Idempotent. */
  release(reservationId: string): Promise<void> {
    return this.settle(reservationId, "released", 0);
  }

  /** [commit] / [release] by the idempotency key a reservation was made with (an upload's id); no-op if none. */
  async settleByKey(idempotencyKey: string, outcome: "commit" | "release", actual?: number): Promise<void> {
    const r = this.rows.get<{ id: string }>("quota_reservations", { idempotency_key: idempotencyKey, state: "reserved" });
    if (!r) return;
    if (outcome === "commit") await this.commit(r.id, actual);
    else await this.release(r.id);
  }

  private async settle(id: string, state: "committed" | "released" | "expired", actual?: number): Promise<void> {
    const t = this.clock();
    await this.rows.write((w) => this.settleIn(w, id, state, t, actual));
  }

  private settleIn(w: RowWriter, id: string, state: "committed" | "released" | "expired", t: number, actual?: number): boolean {
    const r = w.get<{ quota_key: string; scopes: string; amount: number }>("quota_reservations", { id, state: "reserved" });
    if (!r || !isQuotaKey(r.quota_key)) return false;
    const key = r.quota_key;
    const used = state === "committed" && QUOTA_KEYS[key].kind === "counter" ? Math.max(0, Math.round(actual ?? r.amount)) : 0;
    for (const s of JSON.parse(r.scopes) as (Scope & { period: string })[]) this.bump(w, s, key, s.period, used, -r.amount, t);
    w.update("quota_reservations", { id }, { state, settled_amount: used, settled_at: t });
    return true;
  }

  /**
   * Charges [amount] of a counter key directly (an operation already allowed, like a download's bytes), after
   * checking. Returns the decision; a refusal charges nothing.
   */
  async charge(key: QuotaKey, scopes: Scope[], amount: number, detail?: string): Promise<Decision> {
    const d = await this.check(key, scopes, amount, { reserve: true, detail });
    if (d.reservationId) await this.commit(d.reservationId, amount);
    return d;
  }

  /** Releases reservations older than their time to live (a request that died part-way); returns how many. */
  expireReservations(): Promise<number> {
    const t = this.clock();
    const stale = this.rows
      .all<{ id: string; quota_key: string; scopes: string; amount: number }>("quota_reservations", { where: { state: "reserved", expires_at: { lte: t } } })
      .slice(0, 500);
    if (stale.length === 0) return Promise.resolve(0);
    return this.rows.write((w) => {
      for (const r of stale) {
        if (!this.settleIn(w, r.id, "expired", t, 0)) continue;
        const first = (JSON.parse(r.scopes) as Scope[])[0];
        if (first && isQuotaKey(r.quota_key)) {
          w.insert("quota_events", { at: t, quota_key: r.quota_key, scope_type: first.type, scope_id: first.id, outcome: "expired_reservation", amount: r.amount, used: 0, limit_value: null, policy_id: null, detail: null });
        }
      }
      return stale.length;
    });
  }

  // ───────────── Policies (the console writes these; every change is audited by the caller) ─────────────

  /** Writes a new version of the policy for (scope, key, override?), superseding the current one. Returns its id. */
  async setPolicy(input: PolicyInput, actor: string): Promise<PolicyRow> {
    const def = QUOTA_KEYS[input.key];
    validatePolicy(input);
    if (!["observe", "warn"].includes(input.mode) && !(def.enforceable as readonly string[]).includes(input.mode)) {
      throw new ApiError(400, "mode_not_supported", `${def.label} can only be observed or warned about (${def.enforcedAt}).`);
    }
    const t = this.clock();
    const id = newId("qp");
    const row = await this.rows.write((w) => {
      w.update(
        "quota_policies",
        { scope_type: input.scopeType, scope_id: input.scopeId, quota_key: input.key, override: input.override ? 1 : 0, superseded_at: null },
        { superseded_at: t, superseded_by: id },
      );
      w.insert("quota_policies", {
        id,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        quota_key: input.key,
        limit_value: input.limit,
        mode: input.mode,
        hard: input.hard ? 1 : 0,
        warn_pct: input.warnPct ?? 80,
        grace_pct: input.gracePct ?? 0,
        override: input.override ? 1 : 0,
        expires_at: input.expiresAt ?? null,
        reason: input.reason,
        created_by: actor,
        created_at: t,
      });
      return w.get<PolicyRow>("quota_policies", { id })!;
    });
    this.cache = null;
    return row;
  }

  /** Ends a policy (superseded by nothing): the next level of the resolution applies again. */
  async removePolicy(id: string): Promise<PolicyRow | null> {
    const t = this.clock();
    const row = await this.rows.write((w) => {
      const current = w.get<PolicyRow>("quota_policies", { id, superseded_at: null });
      if (current) w.update("quota_policies", { id }, { superseded_at: t });
      return current ?? null;
    });
    this.cache = null;
    return row;
  }

  /** Records an operator's correction of a counter (a credit is negative), with the reason, never deleting history. */
  adjust(key: QuotaKey, scope: Scope, delta: number, actor: string, reason: string): Promise<void> {
    const t = this.clock();
    const period = periodOf(QUOTA_KEYS[key].period, t);
    return this.rows.write((w) => {
      this.bump(w, scope, key, period, Math.round(delta), 0, t);
      const c = this.counter(w, scope, key, period);
      w.insert("quota_events", {
        at: t,
        quota_key: key,
        scope_type: scope.type,
        scope_id: scope.id,
        outcome: "adjusted",
        amount: Math.round(delta),
        used: c.used,
        limit_value: null,
        policy_id: null,
        actor,
        detail: reason,
      });
    });
  }

  /** Usage of a counter key for [scope] in the current period. */
  usage(key: QuotaKey, scope: Scope): { period: string; used: number; reserved: number; resetsAt: number | null } {
    const def = QUOTA_KEYS[key];
    const t = this.clock();
    const period = periodOf(def.period, t);
    return { period, ...this.counter(this.rows, scope, key, period), resetsAt: periodEnd(def.period, t) };
  }

  invalidate(): void {
    this.cache = null;
  }

  /** How many decisions with one of [outcomes] were recorded since [since] (alert rules; recording is deduplicated). */
  eventCount(outcomes: string[], since: number): number {
    return this.rows.count("quota_events", { at: { gt: since }, outcome: { in: outcomes } });
  }
}

function validatePolicy(p: PolicyInput): void {
  if (p.limit !== null && (!Number.isSafeInteger(p.limit) || p.limit < 0)) throw new ApiError(400, "invalid_policy", "A limit is a whole number, 0 or more.");
  if (p.override && (!p.expiresAt || p.expiresAt <= Date.now())) throw new ApiError(400, "invalid_policy", "A temporary exception needs an end time in the future.");
  if (p.hard && p.scopeType !== "global" && p.scopeType !== "pool") throw new ApiError(400, "invalid_policy", "Only platform-wide and capacity limits can be hard ceilings.");
  if ((p.warnPct ?? 80) < 1 || (p.warnPct ?? 80) > 100) throw new ApiError(400, "invalid_policy", "The warning level is 1–100 % of the limit.");
  if ((p.gracePct ?? 0) < 0 || (p.gracePct ?? 0) > 100) throw new ApiError(400, "invalid_policy", "The grace is 0–100 % over the limit.");
  if (p.scopeType === "global" && !["", "default:user", "default:org"].includes(p.scopeId)) throw new ApiError(400, "invalid_policy", "Platform policies are the total, or the default per person or organization.");
  if (p.reason.trim().length < 3) throw new ApiError(400, "invalid_policy", "Say why.");
}

/** The error a refused request gets: which allowance, how much is left, and when it resets. */
export function refusal(d: Decision): ApiError {
  const s = d.scopes.find((x) => x.outcome === "blocked" || x.outcome === "throttled")!;
  const def = QUOTA_KEYS[d.key];
  const who = s.scope.type === "user" ? "Your" : s.scope.type === "org" ? "This community's" : "The server's";
  const reset = d.retryAt ? ` It resets ${new Date(d.retryAt).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "";
  return new ApiError(
    429,
    "quota_exceeded",
    `${who} allowance for ${def.label.toLowerCase()} is used up.${reset}`,
    { quota: d.key, scope: s.scope.type, limit: s.limit, used: Math.round(s.used + s.reserved), resetsAt: d.retryAt },
  );
}
