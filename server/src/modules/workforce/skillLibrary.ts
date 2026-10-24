import { z } from "zod/v4";
import { ROUTING_CATEGORIES, type RoutingCategory } from "../ai/index.js";
import { CAPABILITY_SPECS, type CapabilityId, type CapabilitySpec, type Discovered, type Provider, SKILL_PROVIDES } from "./capabilityCatalog.js";
import { invokeRefusal, type Deps } from "./access.js";
import { AGENTS } from "./catalog/index.js";
import { readiness, routedModel } from "./readiness.js";
import { TOOL_INFO } from "./toolInfo.js";
import type { AgentDef, ToolKey } from "./types.js";

/**
 * The shared skill library (docs/AI_WORKFORCE_2_PLAN.md, phase 1): one machine-readable list of what every skill on
 * this platform can do, built from the skills' own definitions, and discovery: for the capabilities a request needs,
 * which of a community's agents can do each one right now, and the precise blocker when none can. A capability is
 * "ready" only when a request using it would pass the same checks a job runs under. The capabilities themselves are in
 * capabilityCatalog.ts.
 */

export { CAPABILITY_IDS, CAPABILITY_SPECS, type CapabilityId, type Discovered, isCapabilityId, missingLines, type Provider, SKILL_PROVIDES } from "./capabilityCatalog.js";

/** A JSON Schema of [schema] for the library, or null when it can't be expressed (a transform). */
function jsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { unrepresentable: "any" });
  } catch {
    return null;
  }
}

export interface SkillCard {
  id: string;
  version: number;
  source: "platform";
  /** Agents in the catalog that carry this skill. */
  agents: { id: string; name: string }[];
  provides: { id: CapabilityId; label: string }[];
  input: unknown;
  output: unknown;
  tools: { key: ToolKey; label: string; risk: string; required: boolean }[];
  models: { category: RoutingCategory; label: string; required: boolean }[];
  files: AgentDef["skill"]["files"];
  limits: AgentDef["skill"]["limits"];
  approvals: readonly string[];
  errors: readonly string[];
  tests: readonly string[];
}

let cards: SkillCard[] | null = null;

/** Every skill on this platform as a card (computed once: skills are code). */
export function skillLibrary(): SkillCard[] {
  if (cards) return cards;
  const bySkill = new Map<string, AgentDef[]>();
  for (const a of AGENTS) bySkill.set(a.skill.id, [...(bySkill.get(a.skill.id) ?? []), a]);
  cards = [...bySkill.entries()].map(([id, agents]) => {
    const s = agents[0]!.skill;
    return {
      id,
      version: s.version,
      source: "platform" as const,
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
      provides: (SKILL_PROVIDES[id] ?? []).map((c) => ({ id: c, label: CAPABILITY_SPECS[c].label })),
      input: jsonSchema(s.input),
      output: jsonSchema(s.output),
      tools: s.tools.map((t) => ({ key: t, label: TOOL_INFO[t].label, risk: TOOL_INFO[t].risk, required: s.requiredTools.includes(t) })),
      models: s.categories.map((c) => ({ category: c, label: ROUTING_CATEGORIES[c].label, required: s.requiredCategories.includes(c) })),
      files: s.files,
      limits: s.limits,
      approvals: s.approvals,
      errors: s.errors,
      tests: s.tests,
    };
  });
  return cards;
}

/** Why a capability's own tool can't be used by [install] now; null when it can. */
function toolBlocker(d: Deps, tool: ToolKey, granted: readonly ToolKey[]): string | null {
  const info = TOOL_INFO[tool];
  if (info.hard) return `${info.label}: never allowed for agents on this platform.`;
  if (d.store.toolPolicies()[tool] === "disabled") return `${info.label}: turned off on this platform (AI Control Center › Tools).`;
  if (info.risk === "external") return `${info.label}: needs a ${info.integration ?? "connection"}, which isn't connected yet.`;
  if (!granted.includes(tool)) return `${info.label}: not allowed for this agent (its Permissions step).`;
  return null;
}

/**
 * For each capability in [needs]: the community's installed agents that provide it, whether each can do it now for
 * [userId] (the install's readiness, who may use it, the capability's own tool and model routes), and what to install
 * when none is there. [exclude] leaves out the asking agent itself.
 */
export async function discover(d: Deps, orgId: string, userId: string, needs: readonly CapabilityId[], exclude: string | null = null): Promise<Discovered[]> {
  const installs = d.store.installsOf(orgId).filter((i) => i.state !== "uninstalled" && i.id !== exclude);
  const base = new Map<string, Awaited<ReturnType<typeof readiness>>>();
  const ready = async (id: string) => base.get(id) ?? base.set(id, await readiness(d, installs.find((i) => i.id === id)!)).get(id)!;
  const out: Discovered[] = [];
  for (const capability of [...new Set(needs)]) {
    const spec: CapabilitySpec = CAPABILITY_SPECS[capability];
    const providers: Provider[] = [];
    for (const i of installs) {
      const def = AGENTS.find((a) => a.id === i.agentId && a.version === i.version);
      if (!def || !(SKILL_PROVIDES[def.skill.id] ?? []).includes(capability)) continue;
      const r = await ready(i.id);
      const blockers = r.checks.filter((c) => c.status === "missing").map((c) => `${c.label}: ${c.detail}`);
      const refusal = invokeRefusal(d.ctx, i, userId);
      if (refusal) blockers.push(refusal);
      if (spec.tool && !def.skill.requiredTools.includes(spec.tool)) {
        const why = def.skill.tools.includes(spec.tool) ? toolBlocker(d, spec.tool, i.tools) : `${TOOL_INFO[spec.tool].label}: this agent's skill can't use it.`;
        if (why) blockers.push(why);
      }
      for (const c of spec.categories ?? []) {
        if (!routedModel(d, orgId, c)) blockers.push(`No verified model for ${ROUTING_CATEGORIES[c].label.toLowerCase()} (a platform operator sets it up in the AI Control Center).`);
      }
      providers.push({ installId: i.id, agentId: def.id, name: i.displayName, ready: blockers.length === 0, blockers });
    }
    const installedAgents = new Set(installs.map((i) => i.agentId));
    const installable = AGENTS.filter((a) => (SKILL_PROVIDES[a.skill.id] ?? []).includes(capability) && !installedAgents.has(a.id)).map((a) => ({ agentId: a.id, name: a.name }));
    const status = providers.some((p) => p.ready) ? "ready" : providers.length ? "blocked" : installable.length ? "not_installed" : "unavailable";
    out.push({ capability, label: spec.label, status, providers, installable });
  }
  return out;
}
