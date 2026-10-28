import type { RowReader, RowWriter, Where } from "../../infrastructure/database/rows/index.js";
import type { PolicyRow } from "./engine.js";

/** Reads and plan bookkeeping for the Platform Admin Console (modules/platformAdmin), which owns none of these tables. */

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function activePolicies(platform: RowReader): PolicyRow[] {
  return platform.all<PolicyRow>("quota_policies", { where: { superseded_at: null }, orderBy: [["quota_key", "asc"], ["scope_type", "asc"], ["scope_id", "asc"]] });
}

export function currentPolicy(platform: RowReader, scopeType: string, scopeId: string, key: string, override: boolean): PolicyRow | undefined {
  return platform.get<PolicyRow>("quota_policies", { scope_type: scopeType, scope_id: scopeId, quota_key: key, override: override ? 1 : 0, superseded_at: null });
}

export function policiesFor(platform: RowReader, keyPrefix: string): PolicyRow[] {
  // LIKE 'prefix%' in SQLite ignores ASCII case; quota keys are lower case.
  return platform
    .all<PolicyRow>("quota_policies", { where: { superseded_at: null }, orderBy: [["quota_key", "asc"]] })
    .filter((p) => p.quota_key.toLowerCase().startsWith(keyPrefix.toLowerCase()));
}

export interface PlanRow {
  id: string;
  name: string;
  description: string;
  created_at: number;
  members: number;
}

export function plans(platform: RowReader): PlanRow[] {
  return platform
    .all<{ id: string; name: string; description: string; created_at: number }>("quota_plans", { where: { archived_at: null } })
    .sort((a, b) => byText(a.name, b.name))
    .map((p) => ({ id: p.id, name: p.name, description: p.description, created_at: p.created_at, members: platform.count("quota_plan_members", { plan_id: p.id }) }));
}

export function planExists(platform: RowReader, id: string): boolean {
  return !!platform.get("quota_plans", { id, archived_at: null });
}

export function planNameTaken(platform: RowReader, name: string): boolean {
  return !!platform.get("quota_plans", { name });
}

export function createPlan(w: RowWriter, id: string, name: string, description: string, actor: string, at: number): void {
  w.insert("quota_plans", { id, name, description, created_by: actor, created_at: at });
}

export function planOfScope(platform: RowReader, scopeType: string, scopeId: string): string | null {
  return platform.get<{ plan_id: string }>("quota_plan_members", { scope_type: scopeType, scope_id: scopeId })?.plan_id ?? null;
}

export function assignPlan(w: RowWriter, scopeType: string, scopeId: string, planId: string, actor: string, at: number): void {
  const assignment = { plan_id: planId, assigned_by: actor, assigned_at: at };
  w.upsert("quota_plan_members", { scope_type: scopeType, scope_id: scopeId, ...assignment }, assignment);
}

export function unassignPlan(w: RowWriter, scopeType: string, scopeId: string): void {
  w.delete("quota_plan_members", { scope_type: scopeType, scope_id: scopeId });
}

interface CounterRow {
  scope_type: string;
  scope_id: string;
  period_start: string;
  used: number;
  reserved: number;
}

/** This period's busiest counters for [key] (bounded). */
export function topCounters(platform: RowReader, key: string, period: string, limit: number): CounterRow[] {
  return platform
    .all<CounterRow>("quota_counters", { where: { quota_key: key, period_start: period } })
    .sort((a, b) => b.used + b.reserved - (a.used + a.reserved))
    .slice(0, limit)
    .map((c) => ({ scope_type: c.scope_type, scope_id: c.scope_id, period_start: c.period_start, used: c.used, reserved: c.reserved }));
}

/** How many [scopeType] counters (optionally one [scopeId]) for [key] in [period] use more than [limit]. */
export function countersOver(platform: RowReader, key: string, period: string, scopeType: string, scopeId: string | null, limit: number): number {
  const where: Where = { quota_key: key, period_start: period, scope_type: scopeType, ...(scopeId === null ? {} : { scope_id: scopeId }) };
  return platform.all<CounterRow>("quota_counters", { where }).filter((c) => c.used + c.reserved > limit).length;
}

export function eventCounts(platform: RowReader, since: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of platform.all<{ outcome: string }>("quota_events", { where: { at: { gt: since } } })) out[e.outcome] = (out[e.outcome] ?? 0) + 1;
  return out;
}

export interface EventRow {
  id: number;
  at: number;
  quota_key: string;
  scope_type: string;
  scope_id: string;
  outcome: string;
  amount: number;
  used: number;
  limit_value: number | null;
  actor: string | null;
  detail: string | null;
}

export function eventsPage(platform: RowReader, q: { key?: string; scopeType?: string; scopeId?: string; cursor?: number; limit: number; from?: number; to?: number }): EventRow[] {
  const where: Where = {};
  for (const [col, v] of [["quota_key", q.key], ["scope_type", q.scopeType], ["scope_id", q.scopeId]] as const) if (v) where[col] = v;
  if (q.cursor) where.id = { lt: q.cursor };
  if (q.from !== undefined) where.at = { gte: q.from };
  return platform
    .all<EventRow>("quota_events", { where, orderBy: [["id", "desc"]] })
    .filter((e) => q.to === undefined || e.at < q.to)
    .slice(0, q.limit);
}

/** Retention for the decision ledger (180 days); counters, policies and plans are kept. */
export function trimEvents(w: RowWriter, before: number): number {
  return w.delete("quota_events", { at: { lt: before } });
}
