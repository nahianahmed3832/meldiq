import type { Deps } from "./access.js";
import type { Install } from "./store.js";

/**
 * An agent's monthly AI budget in a community (migration 055): set by people who manage agents, enforced in code when a
 * job is admitted and before every model request it makes. Spend is what the usage records say the installation's
 * requests cost this calendar month (UTC). One request already in flight may finish past the budget; none starts after.
 */
/** Used at or above this share of the budget, readiness advises. */
export const BUDGET_NEAR = 0.8;

export function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function nextMonthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function spentThisMonth(d: Deps, installId: string): number {
  return d.ctx.ai.installCost(installId, monthStart(d.clock()));
}

export const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

/** Why [install] may not spend more this month, or null while it has budget left (or none of its own). */
export function budgetRefusal(d: Deps, install: Install): string | null {
  const cap = install.maxCostMicroPerMonth;
  if (cap === null) return null;
  const spent = spentThisMonth(d, install.id);
  if (spent < cap) return null;
  const resets = new Date(nextMonthStart(d.clock())).toISOString().slice(0, 10);
  return `${install.displayName} has used its monthly AI budget here (${usd(spent)} of ${usd(cap)}); it resets on ${resets}. People who manage agents can raise it.`;
}
