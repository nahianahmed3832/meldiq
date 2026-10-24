import { ROUTING_CATEGORIES, type RoutingCategory } from "../../ai/index.js";
import type { Deps } from "../access.js";
import { agentCall } from "../invocation.js";
import { mediaEngineAnswers } from "../media.js";
import { routeCheck } from "./communityChecks.js";
import { diskSpace } from "./probes.js";
import { type CheckItem, item } from "./report.js";

/**
 * The platform's own checks, for the console's operators: the switches, every model route, the catalog, the secrets
 * key, channel reading, disk space, the media engine and the invocation rule itself. Runtime checks across all
 * communities come from runtimeChecks.ts.
 */
/** Free disk below these shares warns, then fails. */
const DISK_WARN = 0.15;
const DISK_FAIL = 0.05;
const GB = 1024 ** 3;

export function platformSwitchesCheck(d: Deps, now: number): CheckItem {
  const off = [!d.ctx.ai.enabled && "AI requests are switched off (ai.enabled kill switch)", !d.settings.enabled() && "AI Workforce is switched off", d.settings.paused() && "new AI work is paused"].filter(
    (x): x is string => !!x,
  );
  const base = { key: "config.switches", level: "configuration" as const, title: "AI switched on", owner: "platform_operator" as const };
  if (!off.length) return item(now, { ...base, status: "healthy", evidence: "AI requests and AI Workforce are on, not paused.", owner: null });
  return item(now, { ...base, status: "warning", severity: "high", evidence: `${off.join("; ")}.`, impacts: ["Every agent's work"], remediation: "Switch it back on in AI Control Center › Overview when it's safe." });
}

export function allRouteChecks(d: Deps, now: number): CheckItem[] {
  return (Object.keys(ROUTING_CATEGORIES) as RoutingCategory[]).map((c) => routeCheck(d, c, now));
}

export function catalogCheck(d: Deps, now: number): CheckItem {
  const published = [...d.store.templateStates().values()].filter((t) => t.status === "published").length;
  const base = { key: "config.catalog", level: "configuration" as const, title: "Agent catalog" };
  if (published) return item(now, { ...base, status: "healthy", evidence: `${published} agent version(s) published.` });
  return item(now, { ...base, status: "not_configured", severity: "high", evidence: "No agent is published: communities can't install any.", remediation: "Publish agents in AI Control Center › Agent catalog.", owner: "platform_operator" });
}

export function secretsCheck(d: Deps, now: number): CheckItem {
  const set = d.ctx.config.platformSecretsKey !== null;
  const reading = d.settings.channelReading();
  const base = { key: "config.secrets_key", level: "configuration" as const, title: "Platform secrets key" };
  if (set) return item(now, { ...base, status: "healthy", evidence: "PLATFORM_SECRETS_KEY is set (its value is never shown)." });
  return item(now, {
    ...base,
    status: reading ? "failed" : "not_configured",
    severity: reading ? "critical" : "medium",
    evidence: "PLATFORM_SECRETS_KEY isn't set.",
    impacts: ["Stored provider keys", "Agents reading channels"],
    remediation: "Set PLATFORM_SECRETS_KEY in the server's environment (32 random bytes) and restart; this needs the owner's go-ahead.",
    owner: "platform_operator",
  });
}

export function readingSettingCheck(d: Deps, now: number): CheckItem {
  const on = d.settings.channelReading();
  const readers = d.readers.active().length;
  return item(now, {
    key: "config.channel_reading",
    level: "configuration",
    title: "Agents reading channels",
    status: "healthy",
    evidence: on ? `On; ${readers} reader(s) switched on.` : `Off on this platform${readers ? `; ${readers} reader(s) are switched on but read nothing` : ""}.`,
  });
}

export function diskCheck(dir: string, now: number): CheckItem {
  const s = diskSpace(dir);
  const base = { key: "runtime.disk", level: "runtime" as const, title: "Disk space for data", owner: "platform_operator" as const };
  if (!s) return item(now, { ...base, status: "not_tested", evidence: `Couldn't read free space for ${dir}.` });
  const share = s.freeBytes / s.totalBytes;
  const evidence = `${(s.freeBytes / GB).toFixed(1)} GB free of ${(s.totalBytes / GB).toFixed(1)} GB (${Math.round(share * 100)}%).`;
  if (share < DISK_FAIL) return item(now, { ...base, status: "failed", severity: "critical", evidence, impacts: ["Uploads", "Agent files", "The database"], remediation: "Free space or grow the disk now.", verified: true });
  if (share < DISK_WARN) return item(now, { ...base, status: "warning", evidence, impacts: ["Uploads", "Agent files"], remediation: "Plan to free space or grow the disk.", verified: true });
  return item(now, { ...base, status: "healthy", evidence, owner: null, verified: true });
}

export async function platformMediaCheck(now: number): Promise<CheckItem> {
  const r = await mediaEngineAnswers();
  const base = { key: "smoke.media", level: "smoke" as const, title: "Media engine", impacts: ["Video and audio editing"], verified: true };
  return r.ok
    ? item(now, { ...base, status: "healthy", evidence: `${r.detail}.` })
    : item(now, { ...base, status: "failed", evidence: r.detail, remediation: "Install ffmpeg with libx264 and aac on the server (or set FFMPEG_PATH).", owner: "platform_operator" });
}

/** The invocation rule this server runs, on a few fixed messages (the full cases run in the test suites). */
export function invocationRuleCheck(now: number): CheckItem {
  const agents = [
    { id: "m", displayName: "Agent Manager", activation: "mention" as const },
    { id: "c", displayName: "Data Desk", activation: "command" as const },
  ];
  const cases: [string, string | null][] = [
    ["what's late? @Agent Manager", "m"],
    ["@agent manager, plan it", "m"],
    ["/data-desk revenue", "c"],
    ["@Data Desk revenue", null],
    ["hello there", null],
  ];
  const wrong = cases.filter(([text, want]) => (agentCall(text, agents)?.installId ?? null) !== want).map(([text]) => `"${text}"`);
  const base = { key: "smoke.invocation", level: "smoke" as const, title: "Calling agents from messages", impacts: ["@mentions and commands"], verified: true };
  if (!wrong.length) return item(now, { ...base, status: "healthy", evidence: `${cases.length} fixed messages called the right agent, or none (ADR 0008).` });
  return item(now, { ...base, status: "failed", evidence: `Wrong answer for ${wrong.join(", ")}.`, remediation: "A broken build: roll the API back to the previous release.", owner: "platform_operator" });
}
