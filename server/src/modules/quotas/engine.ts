import type { DB } from "../../infrastructure/database/db.js";
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
 * Accounting: counters per scope, key and period (quota_counters); a check and its reservation happen in one
 * immediate SQLite transaction, so two requests can't both take the last of an allowance. Gauges (stored bytes, open
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
    private readonly db: DB,
    private readonly clock: () => number = Date.now,
    /** The quota plan a granting subscription puts a person or organization on (billing), after operator assignments. */
    private readonly subscribedPlan: (scope: Scope, t: number) => string | null = () => null,
  ) {}

  /** Whether [id] is a quota plan that can still be assigned (not archived). */
  planExists(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM quota_plans WHERE id = ? AND archived_at IS NULL").get(id);
  }

  private policies(key: string): PolicyRow[] {
    if (!this.cache) {
      const rows = this.db.prepare("SELECT * FROM quota_policies WHERE superseded_at IS NULL").all() as PolicyRow[];
      this.cache = new Map();
      for (const r of rows) this.cache.set(r.quota_key, [...(this.cache.get(r.quota_key) ?? []), r]);
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
    const row = this.db.prepare("SELECT plan_id FROM quota_plan_members WHERE scope_type = ? AND scope_id = ?").get(scope.type, scope.id) as { plan_id: string } | undefined;
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

  private counter(scope: Scope, key: QuotaKey, period: string): { used: number; reserved: number } {
    const row = this.db.prepare("SELECT used, reserved FROM quota_counters WHERE scope_type = ? AND scope_id = ? AND quota_key = ? AND period_start = ?").get(scope.type, scope.id, key, period) as
      | { used: number; reserved: number }
      | undefined;
    return row ?? { used: 0, reserved: 0 };
  }

  private bump(scope: Scope, key: QuotaKey, period: string, used: number, reserved: number, t: number): void {
    this.db
      .prepare(
        `INSERT INTO quota_counters (scope_type, scope_id, quota_key, period_start, used, reserved, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_type, scope_id, quota_key, period_start) DO UPDATE SET
           used = MAX(0, used + excluded.used), reserved = MAX(0, reserved + excluded.reserved), updated_at = excluded.updated_at`,
      )
      .run(scope.type, scope.id, key, period, used, reserved, t);
  }

  private event(key: QuotaKey, d: ScopeDecision, amount: number, t: number, detail: string | null = null): void {
    if (d.outcome === "ok") return;
    const k = `${key}|${d.scope.type}|${d.scope.id}|${d.outcome}`;
    if (t - (this.recent.get(k) ?? 0) < EVENT_EVERY_MS) return;
    this.recent.set(k, t);
    if (this.recent.size > 10_000) this.recent.clear();
    this.db
      .prepare("INSERT INTO quota_events (at, quota_key, scope_type, scope_id, outcome, amount, used, limit_value, policy_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t, key, d.scope.type, d.scope.id, d.outcome, Math.round(amount), Math.round(d.used + d.reserved), d.limit, d.policy?.id ?? null, detail);
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
   * transaction (settle with [commit] or [release]). Counters: the engine's own usage. Gauges: [measured] per scope
   * type, plus open reservations. Throws nothing; the caller decides how to refuse ([refusal]).
   */
  check(key: QuotaKey, scopes: Scope[], amount: number, opts: { measured?: Measured; reserve?: boolean; idempotencyKey?: string; detail?: string; ttlMs?: number } = {}): Decision {
    // Nothing governs this key: nothing to check, measure or write (the default for every key).
    if (!this.hasPolicies(key)) return { key, allowed: true, scopes: [], reservationId: null, retryAt: null };
    const def = QUOTA_KEYS[key];
    const t = this.clock();
    const period = periodOf(def.period, t);
    const applicable = scopes.filter((s) => (def.scopes as readonly string[]).includes(s.type));
    const run = () => {
      if (opts.idempotencyKey) {
        const prior = this.db.prepare("SELECT id, state FROM quota_reservations WHERE idempotency_key = ?").get(opts.idempotencyKey) as { id: string; state: string } | undefined;
        if (prior) return { key, allowed: prior.state !== "released", scopes: [], reservationId: prior.id, retryAt: null } satisfies Decision;
      }
      const decisions = applicable.map((scope) => {
        const e = this.effective(key, scope, t);
        const c = this.counter(scope, key, period);
        const used = def.kind === "gauge" ? (opts.measured?.[scope.type] ?? 0) : c.used;
        return this.judge(e, used, def.kind === "per_request" ? 0 : c.reserved, amount, def.kind === "per_request");
      });
      const refused = decisions.find((d) => d.outcome === "blocked" || d.outcome === "throttled");
      for (const d of decisions) this.event(key, d, amount, t, opts.detail ?? null);
      let reservationId: string | null = null;
      if (!refused && opts.reserve && def.kind !== "per_request" && amount > 0) {
        reservationId = newId("qr");
        for (const scope of applicable) this.bump(scope, key, period, 0, amount, t);
        this.db
          .prepare("INSERT INTO quota_reservations (id, idempotency_key, quota_key, scopes, amount, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)")
          .run(reservationId, opts.idempotencyKey ?? null, key, JSON.stringify(applicable.map((s) => ({ ...s, period }))), Math.round(amount), t, t + (opts.ttlMs ?? RESERVATION_TTL_MS));
      }
      const retryAt = refused ? (periodEnd(def.period, t) ?? null) : null;
      return { key, allowed: !refused, scopes: decisions, reservationId, retryAt } satisfies Decision;
    };
    return this.db.transaction(run).immediate();
  }

  /**
   * Settles a reservation with what was really used ([actual], default the reserved amount): counters move it from
   * reserved to used; gauges just drop the reservation (the source now measures it). Idempotent.
   */
  commit(reservationId: string, actual?: number): void {
    this.settle(reservationId, "committed", actual);
  }

  /** Gives a reservation back (the operation failed or was refused later). Idempotent. */
  release(reservationId: string): void {
    this.settle(reservationId, "released", 0);
  }

  /** [commit] / [release] by the idempotency key a reservation was made with (an upload's id); no-op if none. */
  settleByKey(idempotencyKey: string, outcome: "commit" | "release", actual?: number): void {
    const r = this.db.prepare("SELECT id FROM quota_reservations WHERE idempotency_key = ? AND state = 'reserved'").get(idempotencyKey) as { id: string } | undefined;
    if (!r) return;
    if (outcome === "commit") this.commit(r.id, actual);
    else this.release(r.id);
  }

  private settle(id: string, state: "committed" | "released" | "expired", actual?: number): void {
    const t = this.clock();
    this.db
      .transaction(() => {
        const r = this.db.prepare("SELECT * FROM quota_reservations WHERE id = ? AND state = 'reserved'").get(id) as
          | { quota_key: string; scopes: string; amount: number }
          | undefined;
        if (!r || !isQuotaKey(r.quota_key)) return;
        const key = r.quota_key;
        const used = state === "committed" && QUOTA_KEYS[key].kind === "counter" ? Math.max(0, Math.round(actual ?? r.amount)) : 0;
        for (const s of JSON.parse(r.scopes) as (Scope & { period: string })[]) this.bump(s, key, s.period, used, -r.amount, t);
        this.db.prepare("UPDATE quota_reservations SET state = ?, settled_amount = ?, settled_at = ? WHERE id = ?").run(state, used, t, id);
      })
      .immediate();
  }

  /**
   * Charges [amount] of a counter key directly (an operation already allowed, like a download's bytes), after
   * checking. Returns the decision; a refusal charges nothing.
   */
  charge(key: QuotaKey, scopes: Scope[], amount: number, detail?: string): Decision {
    const d = this.check(key, scopes, amount, { reserve: true, detail });
    if (d.reservationId) this.commit(d.reservationId, amount);
    return d;
  }

  /** Releases reservations older than their time to live (a request that died part-way); returns how many. */
  expireReservations(): number {
    const t = this.clock();
    const stale = this.db.prepare("SELECT id, quota_key, scopes, amount FROM quota_reservations WHERE state = 'reserved' AND expires_at <= ? LIMIT 500").all(t) as {
      id: string;
      quota_key: string;
      scopes: string;
      amount: number;
    }[];
    for (const r of stale) {
      this.settle(r.id, "expired", 0);
      const first = (JSON.parse(r.scopes) as Scope[])[0];
      if (first && isQuotaKey(r.quota_key)) {
        this.db
          .prepare("INSERT INTO quota_events (at, quota_key, scope_type, scope_id, outcome, amount, used, limit_value, policy_id, detail) VALUES (?, ?, ?, ?, 'expired_reservation', ?, 0, NULL, NULL, NULL)")
          .run(t, r.quota_key, first.type, first.id, r.amount);
      }
    }
    return stale.length;
  }

  // ───────────── Policies (the console writes these; every change is audited by the caller) ─────────────

  /** Writes a new version of the policy for (scope, key, override?), superseding the current one. Returns its id. */
  setPolicy(input: PolicyInput, actor: string): PolicyRow {
    const def = QUOTA_KEYS[input.key];
    validatePolicy(input);
    if (!["observe", "warn"].includes(input.mode) && !(def.enforceable as readonly string[]).includes(input.mode)) {
      throw new ApiError(400, "mode_not_supported", `${def.label} can only be observed or warned about (${def.enforcedAt}).`);
    }
    const t = this.clock();
    const id = newId("qp");
    this.db
      .transaction(() => {
        const current = this.db
          .prepare("SELECT id FROM quota_policies WHERE scope_type = ? AND scope_id = ? AND quota_key = ? AND override = ? AND superseded_at IS NULL")
          .all(input.scopeType, input.scopeId, input.key, input.override ? 1 : 0) as { id: string }[];
        for (const c of current) this.db.prepare("UPDATE quota_policies SET superseded_at = ?, superseded_by = ? WHERE id = ?").run(t, id, c.id);
        this.db
          .prepare(
            `INSERT INTO quota_policies (id, scope_type, scope_id, quota_key, limit_value, mode, hard, warn_pct, grace_pct, override, expires_at, reason, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.scopeType,
            input.scopeId,
            input.key,
            input.limit,
            input.mode,
            input.hard ? 1 : 0,
            input.warnPct ?? 80,
            input.gracePct ?? 0,
            input.override ? 1 : 0,
            input.expiresAt ?? null,
            input.reason,
            actor,
            t,
          );
      })
      .immediate();
    this.cache = null;
    return this.db.prepare("SELECT * FROM quota_policies WHERE id = ?").get(id) as PolicyRow;
  }

  /** Ends a policy (superseded by nothing): the next level of the resolution applies again. */
  removePolicy(id: string): PolicyRow | null {
    const t = this.clock();
    const row = this.db.prepare("SELECT * FROM quota_policies WHERE id = ? AND superseded_at IS NULL").get(id) as PolicyRow | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE quota_policies SET superseded_at = ? WHERE id = ?").run(t, id);
    this.cache = null;
    return row;
  }

  /** Records an operator's correction of a counter (a credit is negative), with the reason, never deleting history. */
  adjust(key: QuotaKey, scope: Scope, delta: number, actor: string, reason: string): void {
    const t = this.clock();
    const period = periodOf(QUOTA_KEYS[key].period, t);
    this.db
      .transaction(() => {
        this.bump(scope, key, period, Math.round(delta), 0, t);
        const c = this.counter(scope, key, period);
        this.db
          .prepare("INSERT INTO quota_events (at, quota_key, scope_type, scope_id, outcome, amount, used, limit_value, policy_id, actor, detail) VALUES (?, ?, ?, ?, 'adjusted', ?, ?, NULL, NULL, ?, ?)")
          .run(t, key, scope.type, scope.id, Math.round(delta), c.used, actor, reason);
      })
      .immediate();
  }

  /** Usage of a counter key for [scope] in the current period. */
  usage(key: QuotaKey, scope: Scope): { period: string; used: number; reserved: number; resetsAt: number | null } {
    const def = QUOTA_KEYS[key];
    const t = this.clock();
    const period = periodOf(def.period, t);
    return { period, ...this.counter(scope, key, period), resetsAt: periodEnd(def.period, t) };
  }

  invalidate(): void {
    this.cache = null;
  }

  /** How many decisions with one of [outcomes] were recorded since [since] (alert rules; recording is deduplicated). */
  eventCount(outcomes: string[], since: number): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM quota_events WHERE at > ? AND outcome IN (SELECT value FROM json_each(?))").get(since, JSON.stringify(outcomes)) as { n: number }).n;
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
