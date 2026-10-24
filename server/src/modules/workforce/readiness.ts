import { ROUTING_CATEGORIES, type RoutingCategory } from "../ai/index.js";
import type { Deps } from "./access.js";
import { BUDGET_NEAR, spentThisMonth, usd } from "./budget.js";
import { findAgent } from "./catalog/index.js";
import { mediaEngine } from "./media.js";
import type { Install } from "./store.js";
import { TOOL_INFO } from "./toolInfo.js";
import { triggerView } from "./triggers.js";
import type { AgentDef } from "./types.js";

/**
 * Whether an installed agent can work, checked against the same rules jobs run under (docs/AI_WORKFORCE.md §5b): the
 * platform and community switches, its catalog version, a verified routable model for each kind of work it needs
 * (within the community's model allowance), the tools it can't work without, the media engine, its channels and, in
 * continuous autonomy, its triggers. Nothing here is decorative: a check is "ok" only when a job would pass it.
 */
export type CheckStatus = "ok" | "missing" | "advice";

export interface ReadinessCheck {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Who can fix a missing one: the platform's operators (AI Control Center) or this community's admins. */
  fixBy: "operator" | "community" | null;
}

export interface Readiness {
  ready: boolean;
  checks: ReadinessCheck[];
}

/** The verified model each kind of work would use now, or null (within the community's allowance). */
export function routedModel(d: Deps, orgId: string, category: RoutingCategory): { providerId: string; model: string } | null {
  const ent = d.store.entitlement(orgId);
  const first = d.ctx.ai.routing.route(category, ent.models ? new Set(ent.models) : null).ordered[0];
  return first ? { providerId: first.candidate.providerId, model: first.candidate.model } : null;
}

/**
 * The kinds of work [def] can't do without that no verified model serves for this community, ignoring a provider
 * that's only failing for the moment (its circuit closes again by itself). Empty: requests may be admitted.
 */
export function unroutedCategories(d: Deps, orgId: string, def: AgentDef): RoutingCategory[] {
  const ent = d.store.entitlement(orgId);
  const allowed = ent.models ? new Set(ent.models) : null;
  return def.skill.requiredCategories.filter((c) => d.ctx.ai.routing.route(c, allowed, { ignoreCircuit: true }).ordered.length === 0);
}

/** Whether every kind of work [def] can't do without has a verified model now (the Agent Manager's check). */
export function modelsReady(d: Deps, orgId: string, def: AgentDef): boolean {
  return d.ctx.ai.enabled && def.skill.requiredCategories.every((c) => routedModel(d, orgId, c) !== null);
}

export async function readiness(d: Deps, install: Install): Promise<Readiness> {
  const def = findAgent(install.agentId, install.version);
  const checks: ReadinessCheck[] = [];
  const add = (key: string, label: string, ok: boolean, detail: string, fixBy: ReadinessCheck["fixBy"], advice = false) =>
    checks.push({ key, label, status: ok ? "ok" : advice ? "advice" : "missing", detail, fixBy: ok ? null : fixBy });

  const ent = d.store.entitlement(install.orgId);
  add("platform", "AI agents switched on", d.settings.enabled() && ent.enabled, d.settings.enabled() ? (ent.enabled ? "On for this community." : "Not included for this community.") : "AI Workforce is switched off on this platform.", "operator");
  add("paused", "New work allowed", !d.settings.paused(), d.settings.paused() ? "The platform's operators paused new AI work." : "Not paused.", "operator");
  add("ai", "AI requests allowed", d.ctx.ai.enabled, d.ctx.ai.enabled ? "On." : "AI is switched off on this server (kill switch).", "operator");
  if (!def) {
    add("version", "Agent version", false, "This agent's version no longer exists on this server.", "community");
    return { ready: false, checks };
  }
  const st = d.store.templateState(def.id, def.version).status;
  add("version", "Published in the catalog", st === "published" || st === "retired", st === "published" ? `${def.name} v${def.version}.` : st === "retired" ? "Retired: it still runs, but update it." : "Not published on this platform.", "operator");
  add("state", "Turned on here", install.state === "active", install.state === "active" ? "On." : "Turned off in this community.", "community");

  for (const c of def.skill.categories) {
    const label = ROUTING_CATEGORIES[c].label;
    const m = d.ctx.ai.enabled ? routedModel(d, install.orgId, c) : null;
    const required = def.skill.requiredCategories.includes(c);
    add(
      `model.${c}`,
      `Model for ${label.toLowerCase()}`,
      m !== null,
      m ? `${m.model}, verified.` : `No verified model for ${label.toLowerCase()} (approved and verified in AI Control Center › Providers & keys).`,
      "operator",
      !required,
    );
  }

  const policies = d.store.toolPolicies();
  for (const t of def.skill.requiredTools) {
    const info = TOOL_INFO[t];
    const granted = install.tools.includes(t);
    const platformOff = policies[t] === "disabled";
    const external = info.risk === "external";
    add(
      `tool.${t}`,
      info.label,
      granted && !platformOff && !external,
      platformOff ? "Turned off on this platform." : external ? `Needs a ${info.integration ?? "connection"}, which isn't available on this platform.` : granted ? "Allowed." : "Not allowed for this agent: allow it under Permissions.",
      platformOff || external ? "operator" : "community",
    );
  }
  if (def.skill.requiredTools.some((t) => t.startsWith("media."))) {
    const m = await mediaEngine();
    add("media", "Media engine", m.available, m.available ? m.detail : `Not available (${m.detail}).`, "operator");
  }

  if (install.maxCostMicroPerMonth !== null) {
    const cap = install.maxCostMicroPerMonth;
    const spent = spentThisMonth(d, install.id);
    const left = spent < cap;
    add(
      "budget",
      "Monthly AI budget",
      left && spent < cap * BUDGET_NEAR,
      `${usd(spent)} of ${usd(cap)} used this month${left ? "" : ": no new work until it resets or is raised"}.`,
      "community",
      left,
    );
  }

  const channels = d.store.channelsOf(install.id);
  add("channels", "Assigned to a channel", channels.length > 0, channels.length ? `${channels.length} channel${channels.length === 1 ? "" : "s"}.` : "Not in any channel yet: it can still be asked from AI agents.", "community", true);

  if (install.autonomy === "continuous") {
    const triggers = d.triggers.ofInstall(install.id);
    const enabled = triggers.filter((t) => t.enabled === 1);
    add(
      "triggers",
      "Triggers to run on its own",
      enabled.length > 0,
      enabled.length ? `${enabled.length} on${enabled.some((t) => t.last_error) ? "; one or more had a problem last time" : ""}.` : "Continuous, but no trigger is on: it only works when asked.",
      "community",
      true,
    );
  }
  return { ready: checks.every((c) => c.status !== "missing"), checks };
}

const DAY = 86_400_000;

/** What an agent did lately, from its job records: counts only, never content. */
export function activity(d: Deps, install: Install) {
  const db = d.ctx.db;
  const since = d.clock() - 7 * DAY;
  const states = db.prepare("SELECT state, COUNT(*) n FROM ai_jobs WHERE install_id = ? GROUP BY state").all(install.id) as { state: string; n: number }[];
  const count = (s: string[]) => states.filter((x) => s.includes(x.state)).reduce((n, x) => n + x.n, 0);
  const week = db
    .prepare(
      `SELECT state, COUNT(*) n, AVG(CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL THEN finished_at - started_at END) ms, SUM(attempts - 1) retries
       FROM ai_jobs WHERE install_id = ? AND created_at >= ? GROUP BY state`,
    )
    .all(install.id, since) as { state: string; n: number; ms: number | null; retries: number | null }[];
  const w = (s: string) => week.find((x) => x.state === s);
  const lastOk = db.prepare("SELECT finished_at FROM ai_jobs WHERE install_id = ? AND state = 'completed' ORDER BY finished_at DESC LIMIT 1").get(install.id) as { finished_at: number } | undefined;
  const lastFail = db.prepare("SELECT finished_at, error_code, error_detail FROM ai_jobs WHERE install_id = ? AND state = 'failed' ORDER BY finished_at DESC LIMIT 1").get(install.id) as
    | { finished_at: number; error_code: string | null; error_detail: string | null }
    | undefined;
  const triggers = d.triggers.ofInstall(install.id).map(triggerView);
  const nextRunAt = install.autonomy === "continuous" ? (triggers.filter((t) => t.enabled && t.nextRunAt !== null).map((t) => t.nextRunAt!).sort((a, b) => a - b)[0] ?? null) : null;
  return {
    now: { running: count(["running", "planning"]), queued: count(["queued"]), waiting: count(["awaiting_input", "awaiting_approval"]) },
    week: {
      completed: w("completed")?.n ?? 0,
      failed: w("failed")?.n ?? 0,
      cancelled: w("cancelled")?.n ?? 0,
      /** null: nothing finished this week (no duration to report), not zero. */
      averageMs: w("completed")?.ms === null || w("completed")?.ms === undefined ? null : Math.round(w("completed")!.ms!),
      retries: week.reduce((n, x) => n + (x.retries ?? 0), 0),
    },
    lastSuccessAt: lastOk?.finished_at ?? null,
    lastFailure: lastFail ? { at: lastFail.finished_at, code: lastFail.error_code, message: lastFail.error_detail ?? "" } : null,
    /** Only when continuous and a schedule is on: otherwise nothing runs by itself. */
    nextRunAt,
    triggers,
  };
}

/** The request "Test this agent" sends: a real job through the real path, asking for nothing but a short reply. */
export const TEST_BRIEF = "This is a setup test from this community's admins. Reply with one short sentence saying you're ready, and nothing else.";
