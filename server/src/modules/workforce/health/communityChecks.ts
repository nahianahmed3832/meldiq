import { ROUTING_CATEGORIES, type RoutingCategory } from "../../ai/index.js";
import type { Deps } from "../access.js";
import { CAPABILITY_SPECS, SKILL_PROVIDES } from "../capabilityCatalog.js";
import { findAgent } from "../catalog/index.js";
import type { CallableAgent } from "../invocation.js";
import { mediaEngineAnswers } from "../media.js";
import { readiness } from "../readiness.js";
import type { Install } from "../store.js";
import { invocationProblems } from "./probes.js";
import { type CheckItem, item } from "./report.js";

/**
 * A community's own checks: its switches, each agent's readiness (the same rules jobs run under), channel assignments,
 * triggers, the models its agents need, readers, and the deterministic smoke tests (invocation in each channel, the
 * media engine where an agent edits video).
 */
const MAX_LINKS = 10;
/** Consecutive trigger failures that fail the check (5 switch a trigger off: triggers.ts). */
const TRIGGER_FAILING = 3;
/** A schedule this late hasn't been fired by the worker. */
const SCHEDULE_LATE_MS = 10 * 60_000;
/** Reader queue items past this mean a reader is falling behind. */
const READER_BACKLOG = 200;

const capabilitiesOf = (install: Install): string[] => {
  const def = findAgent(install.agentId, install.version);
  return def ? (SKILL_PROVIDES[def.skill.id] ?? []).map((c) => CAPABILITY_SPECS[c].label) : [];
};

export function switchesCheck(d: Deps, orgId: string, now: number): CheckItem {
  const ent = d.store.entitlement(orgId);
  const off = [
    !d.ctx.ai.enabled && "AI requests are switched off on this server",
    !d.settings.enabled() && "AI Workforce is switched off on this platform",
    d.settings.paused() && "the platform's operators paused new AI work",
    !ent.enabled && "AI agents aren't included for this community",
  ].filter((x): x is string => !!x);
  const base = { key: "config.switches", level: "configuration" as const, title: "AI agents switched on", impacts: off.length ? ["Every agent's work"] : [] };
  if (!off.length) return item(now, { ...base, status: "healthy", evidence: "On for the platform and this community, not paused." });
  return item(now, { ...base, status: "failed", severity: "critical", evidence: `Off: ${off.join("; ")}.`, remediation: "Ask the platform's operators to switch it on (AI Control Center).", owner: "platform_operator" });
}

/** Each installed agent, against the rules its jobs run under (readiness.ts). */
export async function agentChecks(d: Deps, installs: readonly Install[], now: number): Promise<CheckItem[]> {
  const out: CheckItem[] = [];
  for (const install of installs) {
    const r = await readiness(d, install);
    const base = { key: `agent.${install.id}`, level: "configuration" as const, title: install.displayName, impacts: capabilitiesOf(install), links: { installId: install.id } };
    if (install.state !== "active") {
      out.push(item(now, { ...base, status: "not_configured", severity: "low", evidence: "Turned off in this community.", remediation: "Turn it on under AI agents if it should work.", owner: "community_admin" }));
      continue;
    }
    const missing = r.checks.filter((c) => c.status === "missing");
    const advice = r.checks.filter((c) => c.status === "advice");
    if (missing.length) {
      const operator = missing.some((c) => c.fixBy === "operator");
      out.push(
        item(now, {
          ...base,
          status: "failed",
          evidence: missing.map((c) => `${c.label}: ${c.detail}`).join(" "),
          cause: "It can't run work until these are fixed.",
          remediation: operator ? "Ask the platform's operators about the items they fix; fix the rest under Configure." : "Fix these under the agent's Configure.",
          owner: operator ? "platform_operator" : "community_admin",
        }),
      );
    } else if (advice.length) {
      out.push(item(now, { ...base, status: "warning", severity: "low", evidence: advice.map((c) => `${c.label}: ${c.detail}`).join(" "), remediation: "Optional: see Configure.", owner: "community_admin" }));
    } else out.push(item(now, { ...base, status: "healthy", evidence: `Ready: ${r.checks.length} checks pass.` }));
  }
  return out;
}

/** Assignments to channels that were deleted or archived. */
export function assignmentsCheck(d: Deps, installs: readonly Install[], now: number): CheckItem {
  const gone: string[] = [];
  for (const i of installs) {
    for (const c of d.store.channelsOf(i.id)) {
      const conv = d.ctx.authz.conversation(c.conversationId);
      if (!conv || conv.archived_at !== null) gone.push(`${i.displayName} in ${conv?.name ? `#${conv.name}` : "a removed channel"}`);
    }
  }
  const base = { key: "config.channels", level: "configuration" as const, title: "Channel assignments" };
  if (!gone.length) return item(now, { ...base, status: "healthy", evidence: "Every assignment is to a live channel." });
  return item(now, { ...base, status: "warning", severity: "low", evidence: `Assigned to archived or removed channels: ${gone.slice(0, MAX_LINKS).join(", ")}.`, remediation: "Remove these assignments under each agent's Channels.", owner: "community_admin" });
}

/** Triggers that failed, were switched off by failures, or whose schedule wasn't fired. */
export function triggersCheck(d: Deps, orgId: string, now: number): CheckItem {
  const all = d.triggers.ofOrg(orgId);
  const failing = all.filter((t) => t.failures > 0 || (t.enabled === 1 && t.last_error));
  const late = all.filter((t) => t.enabled === 1 && t.kind === "schedule" && t.next_run_at !== null && t.next_run_at < now - SCHEDULE_LATE_MS);
  const base = { key: "config.triggers", level: "configuration" as const, title: "Triggers", verified: true };
  if (!all.length) return item(now, { ...base, status: "healthy", evidence: "No triggers are set up.", verified: false });
  if (!failing.length && !late.length) return item(now, { ...base, status: "healthy", evidence: `${all.filter((t) => t.enabled === 1).length} of ${all.length} on; none failing.` });
  const bad = failing.some((t) => t.failures >= TRIGGER_FAILING) || late.length > 0;
  return item(now, {
    ...base,
    status: bad ? "failed" : "warning",
    evidence: [
      failing.length && `failing: ${failing.map((t) => `${t.label} (${t.failures} in a row${t.enabled ? "" : ", switched off"}${t.last_error ? `: ${t.last_error.slice(0, 120)}` : ""})`).join("; ")}`,
      late.length && `schedules not fired on time: ${late.map((t) => t.label).join(", ")}`,
    ]
      .filter(Boolean)
      .join(". ") + ".",
    cause: late.length ? "The job worker isn't firing schedules (see Job worker)." : "The work these triggers start keeps failing.",
    remediation: "Open the agent's Triggers to see the error, fix it, then switch the trigger back on.",
    owner: late.length ? "platform_operator" : "community_admin",
    impacts: ["Work that runs on its own"],
    links: { triggers: [...failing, ...late].map((t) => t.id).slice(0, MAX_LINKS) },
  });
}

/** The models the installed agents need: each route's state (from its verification), and its last real request. */
export function modelChecks(d: Deps, installs: readonly Install[], now: number): CheckItem[] {
  const needed = new Map<RoutingCategory, string[]>();
  for (const i of installs.filter((x) => x.state === "active")) {
    const def = findAgent(i.agentId, i.version);
    for (const c of def?.skill.requiredCategories ?? []) needed.set(c, [...(needed.get(c) ?? []), i.displayName]);
  }
  return [...needed].map(([c, agents]) => routeCheck(d, c, now, agents));
}

/** One model route: "ready" rests on its verification test; the last real request through it says whether it still works. */
export function routeCheck(d: Deps, category: RoutingCategory, now: number, agents: readonly string[] = []): CheckItem {
  const st = d.ctx.ai.routing.status(category, d.ctx.ai.enabled);
  const last = d.ctx.ai.routing.lastExecution(category);
  const label = ROUTING_CATEGORIES[category].label;
  const base = { key: `model.${category}`, level: "configuration" as const, title: `Model for ${label.toLowerCase()}`, impacts: agents.length ? agents.map((a) => `${a}'s work`) : [label], owner: "platform_operator" as const };
  const lastLine = last ? ` Last request ${new Date(last.at).toISOString()}: ${last.outcome}${last.errorKind ? ` (${last.errorKind})` : ""}.` : "";
  if (st.status === "ready") {
    // "blocked" is a usage limit, not the provider failing (limits have their own check).
    const broken = last !== null && (last.outcome === "error" || last.outcome === "timeout");
    return item(now, {
      ...base,
      status: broken ? "warning" : "healthy",
      evidence: `${st.detail}${lastLine}`,
      cause: broken ? "The route is verified, but its latest real request failed." : null,
      remediation: broken ? "Watch the next requests; verify the model again if failures continue." : null,
      verified: true,
    });
  }
  const status = st.status === "not_configured" ? "not_configured" : st.status === "untested" ? "not_tested" : "failed";
  return item(now, { ...base, status, severity: status === "failed" ? "critical" : "high", evidence: `${st.detail}${lastLine}`, remediation: "Set up and verify a model in AI Control Center › Models & routing." });
}

/** Readers in this community's channels: switched on while reading is off on the platform, or falling behind. */
export async function readersCheck(d: Deps, installs: readonly Install[], now: number): Promise<CheckItem> {
  const readers = installs.flatMap((i) => d.readers.ofInstall(i.id)).filter((r) => r.state === "on");
  const base = { key: "runtime.readers", level: "runtime" as const, title: "Agents reading channels" };
  if (!readers.length) return item(now, { ...base, status: "healthy", evidence: "No agent reads a channel here." });
  if (!d.settings.channelReading())
    return item(now, { ...base, status: "warning", severity: "low", evidence: `${readers.length} reader(s) switched on, but reading channels is off on this platform: they read nothing.`, remediation: "Ask the platform's operators, or switch these readers off.", owner: "platform_operator" });
  const behind: string[] = [];
  for (const r of readers) if ((await d.ctx.relay.backlog(r.device_id, now, READER_BACKLOG + 1)).length > READER_BACKLOG) behind.push(r.id);
  if (behind.length)
    return item(now, { ...base, status: "warning", evidence: `${behind.length} reader(s) have over ${READER_BACKLOG} messages waiting.`, cause: "The worker drains readers on each tick; it's behind or stopped.", remediation: "Check the job worker.", owner: "platform_operator", verified: true });
  return item(now, { ...base, status: "healthy", evidence: `${readers.length} reader(s) on and keeping up.`, verified: true });
}

/** Smoke: in each channel, every assigned agent's "@Name" and "/command" reach it under the shared rule. */
export function invocationCheck(d: Deps, installs: readonly Install[], now: number): CheckItem {
  const names = new Map(installs.map((i) => [i.id, i.displayName]));
  const channels = new Set(installs.flatMap((i) => d.store.channelsOf(i.id).map((c) => c.conversationId)));
  const problems: string[] = [];
  for (const conv of channels) {
    const agents: CallableAgent[] = d.store.agentsInChannel(conv).map((a) => ({ id: a.installId, displayName: names.get(a.installId) ?? "", activation: a.activation }));
    const name = d.ctx.authz.conversation(conv)?.name;
    for (const p of invocationProblems(agents)) problems.push(`${name ? `#${name}` : "a channel"}: ${p}`);
  }
  const base = { key: "smoke.invocation", level: "smoke" as const, title: "Calling agents in channels", impacts: ["@mentions and commands"], verified: true };
  if (!channels.size) return item(now, { ...base, status: "not_tested", evidence: "No agent is assigned to a channel.", verified: false });
  if (!problems.length) return item(now, { ...base, status: "healthy", evidence: `In ${channels.size} channel(s), every agent's @mention and command reach it (the shared rule, ADR 0008).` });
  return item(now, { ...base, status: "warning", evidence: problems.slice(0, MAX_LINKS).join("; ") + ".", remediation: "Give agents in the same channel different names.", owner: "community_admin" });
}

/** Smoke: the media engine starts, where an agent here edits media. */
export async function mediaCheck(installs: readonly Install[], now: number): Promise<CheckItem | null> {
  const media = installs.filter((i) => i.state === "active" && findAgent(i.agentId, i.version)?.skill.requiredTools.some((t) => t.startsWith("media.")));
  if (!media.length) return null;
  const r = await mediaEngineAnswers();
  const base = { key: "smoke.media", level: "smoke" as const, title: "Media engine", impacts: media.map((i) => `${i.displayName}'s work`), verified: true };
  return r.ok
    ? item(now, { ...base, status: "healthy", evidence: `${r.detail}.` })
    : item(now, { ...base, status: "failed", evidence: r.detail, remediation: "Install ffmpeg with libx264 and aac on the server (or set FFMPEG_PATH).", owner: "platform_operator" });
}
