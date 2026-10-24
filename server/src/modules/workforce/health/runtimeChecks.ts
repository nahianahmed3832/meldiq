import { QUOTA_KEYS, type QuotaKey, type Scope } from "../../quotas/index.js";
import type { Deps } from "../access.js";
import { type CheckItem, item } from "./report.js";

/**
 * Runtime checks shared by a community's System Check (orgId) and the platform's (orgId null): the job worker's
 * heartbeat, the queue, jobs whose worker vanished, recent failures, approvals and tasks waiting on people. Counts and
 * ids from the records only; never content.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A queued, due job older than these is late, then stuck. */
const QUEUE_LATE_MS = 5 * MIN;
const QUEUE_STUCK_MS = 30 * MIN;
/** A running job whose lease ran out this long ago should have been recovered already. */
const LEASE_GRACE_MS = 2 * MIN;
const APPROVAL_WAIT_MS = DAY;
/** At least this many failures, and at least this share of finished jobs, fail the check (fewer only warn). */
const FAILURES_FAIL_COUNT = 3;
const FAILURES_FAIL_SHARE = 0.5;
const MAX_LINKS = 10;

/** What to do about a job error code, for the failures check. */
const ERROR_HELP: Record<string, { cause: string; remediation: string; owner: CheckItem["owner"] }> = {
  ai_not_configured: { cause: "No verified model serves a kind of work an agent needed.", remediation: "Set up and verify the route in AI Control Center › Models & routing.", owner: "platform_operator" },
  provider_error: { cause: "The AI provider refused or failed requests.", remediation: "Check the provider's key and status in AI Control Center › Providers & keys, then retry the jobs.", owner: "platform_operator" },
  quota_exceeded: { cause: "A usage limit was reached.", remediation: "Wait for the period to reset, or raise the limit (console › Quotas).", owner: "platform_operator" },
  integration_not_configured: { cause: "An agent needed an outside connection that isn't set up.", remediation: "Connect the integration the agent names, or take that step out of its work.", owner: "community_admin" },
  tool_not_allowed: { cause: "An agent tried a tool it isn't allowed.", remediation: "Allow the tool under the agent's Permissions if it should use it.", owner: "community_admin" },
  agent_unavailable: { cause: "The agent was turned off or removed while work was waiting.", remediation: "Turn the agent back on, or cancel its waiting work.", owner: "community_admin" },
  worker_lost: { cause: "The worker running a job stopped (restart or crash) and retries ran out.", remediation: "Retry the job; if it repeats, check the server's logs around that time.", owner: "platform_operator" },
  invalid_output: { cause: "The model's answer didn't match what the skill must return, every attempt.", remediation: "Retry; if it repeats, try a stronger model for that route.", owner: "platform_operator" },
  deliverable_unverified: { cause: "An agent's file didn't pass its checks (format, length, size).", remediation: "Open the job to see which check failed, adjust the request and retry.", owner: "community_admin" },
};

const scoped = (orgId: string | null) => (orgId ? { where: " AND org_id = ?", args: [orgId] } : { where: "", args: [] as string[] });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ago = (ms: number) => (ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} min` : ms < 2 * DAY ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / DAY)} days`);

/** The job worker: its last tick, from the running process. */
export function workerCheck(tickMs: number, s: { lastTickAt: number | null; lastError: string | null }, now: number): CheckItem {
  const base = { key: "runtime.worker", level: "runtime" as const, title: "Job worker", impacts: ["Every agent's work"], owner: "platform_operator" as const };
  if (tickMs <= 0) return item(now, { ...base, status: "not_tested", evidence: "The worker's timer is off on this server (AI_WORKFORCE_TICK_MS=0): jobs run only when driven by hand." });
  const last = s.lastTickAt;
  const late = Math.max(3 * tickMs, 30_000);
  if (last === null || now - last > late)
    return item(now, {
      ...base,
      status: "failed",
      severity: "critical",
      evidence: last === null ? "The worker hasn't ticked since the server started." : `Last tick ${ago(now - last)} ago (expected every ${tickMs} ms).`,
      cause: s.lastError ? `Last error: ${s.lastError}` : null,
      remediation: "Restart the API service; if it repeats, check its logs for the worker's error.",
      verified: true,
    });
  return item(now, { ...base, status: "healthy", evidence: `Ticked ${Math.round((now - last) / 1000)} s ago${s.lastError ? `; last error seen: ${s.lastError}` : ""}.`, verified: true });
}

/** Due jobs nobody has picked up. */
export function queueCheck(d: Deps, orgId: string | null, now: number): CheckItem {
  const q = scoped(orgId);
  const rows = d.ctx.db.prepare(`SELECT id, next_at FROM ai_jobs WHERE state = 'queued' AND next_at <= ?${q.where} ORDER BY next_at LIMIT ${MAX_LINKS}`).all(now, ...q.args) as { id: string; next_at: number }[];
  const count = (d.ctx.db.prepare(`SELECT COUNT(*) n FROM ai_jobs WHERE state = 'queued' AND next_at <= ?${q.where}`).get(now, ...q.args) as { n: number }).n;
  const oldest = rows[0] ? now - rows[0].next_at : 0;
  const base = { key: "runtime.queue", level: "runtime" as const, title: "Job queue", impacts: ["Every agent's work"], verified: true, links: { jobs: rows.map((r) => r.id) } };
  if (count === 0) return item(now, { ...base, status: "healthy", evidence: "No due job is waiting.", links: {} });
  const status = oldest > QUEUE_STUCK_MS ? "failed" : oldest > QUEUE_LATE_MS ? "warning" : "healthy";
  return item(now, {
    ...base,
    status,
    evidence: `${plural(count, "due job")} waiting; the oldest for ${ago(oldest)}.`,
    cause: status === "healthy" ? null : "The worker is behind, at its concurrency limit, or not running.",
    remediation: status === "healthy" ? null : "Check the job worker above and the concurrency limit (AI Control Center › Overview).",
    owner: status === "healthy" ? null : "platform_operator",
  });
}

/** Jobs marked running whose worker's lease ran out: the runtime should have recovered them. */
export function staleJobsCheck(d: Deps, orgId: string | null, now: number): CheckItem {
  const q = scoped(orgId);
  const rows = d.ctx.db
    .prepare(`SELECT id FROM ai_jobs WHERE state IN ('planning', 'running') AND lease_until IS NOT NULL AND lease_until < ?${q.where} LIMIT ${MAX_LINKS}`)
    .all(now - LEASE_GRACE_MS, ...q.args) as { id: string }[];
  const base = { key: "runtime.stale_jobs", level: "runtime" as const, title: "Jobs left without a worker", verified: true };
  if (!rows.length) return item(now, { ...base, status: "healthy", evidence: "No running job has lost its worker." });
  return item(now, {
    ...base,
    status: "warning",
    evidence: `${plural(rows.length, "job")} marked running, with ${rows.length === 1 ? "its" : "their"} worker's lease expired over ${ago(LEASE_GRACE_MS)} ago.`,
    cause: "The worker stopped mid-job and recovery hasn't run (it runs on each tick).",
    remediation: "Check the job worker; recovery requeues these on the next tick.",
    owner: "platform_operator",
    impacts: ["The affected requests"],
    links: { jobs: rows.map((r) => r.id) },
  });
}

/** Jobs that failed in the last 24 hours, by error code, with what to do about the most common. */
export function failuresCheck(d: Deps, orgId: string | null, now: number): CheckItem {
  const q = scoped(orgId);
  const since = now - DAY;
  const byCode = d.ctx.db
    .prepare(`SELECT COALESCE(error_code, 'unknown') code, COUNT(*) n FROM ai_jobs WHERE state = 'failed' AND finished_at >= ?${q.where} GROUP BY code ORDER BY n DESC`)
    .all(since, ...q.args) as { code: string; n: number }[];
  const failed = byCode.reduce((n, r) => n + r.n, 0);
  const finished = (d.ctx.db.prepare(`SELECT COUNT(*) n FROM ai_jobs WHERE state IN ('completed', 'failed') AND finished_at >= ?${q.where}`).get(since, ...q.args) as { n: number }).n;
  const base = { key: "runtime.failures", level: "runtime" as const, title: "Failed jobs (24 hours)", verified: true };
  if (!failed) return item(now, { ...base, status: "healthy", evidence: finished ? `${plural(finished, "job")} finished, none failed.` : "No job finished in the last 24 hours." });
  const ids = (d.ctx.db.prepare(`SELECT id FROM ai_jobs WHERE state = 'failed' AND finished_at >= ?${q.where} ORDER BY finished_at DESC LIMIT ${MAX_LINKS}`).all(since, ...q.args) as { id: string }[]).map((r) => r.id);
  const top = byCode[0]!;
  const help = ERROR_HELP[top.code];
  const bad = failed >= FAILURES_FAIL_COUNT && failed / Math.max(finished, 1) >= FAILURES_FAIL_SHARE;
  return item(now, {
    ...base,
    status: bad ? "failed" : "warning",
    evidence: `${failed} of ${plural(finished, "finished job")} failed: ${byCode
      .slice(0, 3)
      .map((r) => `${r.code} ×${r.n}`)
      .join(", ")}.`,
    cause: help?.cause ?? `Most failures were "${top.code}".`,
    remediation: help?.remediation ?? "Open the failed jobs to see each error, then retry.",
    owner: help?.owner ?? null,
    impacts: ["The affected requests"],
    links: { jobs: ids },
  });
}

/** Steps waiting for someone's approval for over a day. */
export function approvalsCheck(d: Deps, orgId: string | null, now: number): CheckItem {
  const q = scoped(orgId);
  const rows = d.ctx.db
    .prepare(`SELECT id FROM ai_jobs WHERE state = 'awaiting_approval' AND updated_at < ?${q.where} ORDER BY updated_at LIMIT ${MAX_LINKS}`)
    .all(now - APPROVAL_WAIT_MS, ...q.args) as { id: string }[];
  const base = { key: "runtime.approvals", level: "runtime" as const, title: "Approvals waiting", verified: true };
  if (!rows.length) return item(now, { ...base, status: "healthy", evidence: "No approval has waited over a day." });
  return item(now, {
    ...base,
    status: "warning",
    severity: "low",
    evidence: `${plural(rows.length, "job")} waiting over a day for approval.`,
    remediation: "People with “Approve AI actions” approve or reject them under AI agents › Approvals.",
    owner: "community_admin",
    impacts: ["The waiting requests"],
    links: { jobs: rows.map((r) => r.id) },
  });
}

/** Tasks for people past their due date, or blocked. */
export function tasksCheck(d: Deps, orgId: string | null, now: number): CheckItem {
  const q = scoped(orgId);
  const overdue = d.ctx.db
    .prepare(`SELECT id FROM ai_tasks WHERE state IN ('open', 'accepted', 'in_progress', 'blocked') AND due_at IS NOT NULL AND due_at < ?${q.where} ORDER BY due_at LIMIT ${MAX_LINKS}`)
    .all(now, ...q.args) as { id: string }[];
  const blocked = (d.ctx.db.prepare(`SELECT COUNT(*) n FROM ai_tasks WHERE state = 'blocked'${q.where}`).get(...q.args) as { n: number }).n;
  const base = { key: "runtime.tasks", level: "runtime" as const, title: "Tasks for people", verified: true };
  if (!overdue.length && !blocked) return item(now, { ...base, status: "healthy", evidence: "No task is overdue or blocked." });
  return item(now, {
    ...base,
    status: "warning",
    severity: "low",
    evidence: [overdue.length && `${plural(overdue.length, "task")} overdue`, blocked && `${plural(blocked, "task")} blocked`].filter(Boolean).join("; ") + ".",
    remediation: "Open Tasks: follow up with the people named, reassign, or change the due date.",
    owner: "community_admin",
    impacts: ["Requests waiting on people's work"],
    links: { tasks: overdue.map((r) => r.id) },
  });
}

/** The latest real job that completed: evidence the whole path (queue → worker → model → output) works. */
export function lastSuccessCheck(d: Deps, orgId: string | null, now: number): CheckItem {
  const q = scoped(orgId);
  const r = d.ctx.db.prepare(`SELECT id, finished_at FROM ai_jobs WHERE state = 'completed'${q.where} ORDER BY finished_at DESC LIMIT 1`).get(...q.args) as { id: string; finished_at: number } | undefined;
  const base = { key: "smoke.job_path", level: "smoke" as const, title: "A request runs end to end", impacts: ["Every agent's work"] };
  if (r && now - r.finished_at <= 7 * DAY)
    return item(now, { ...base, status: "healthy", evidence: `The latest request completed ${ago(now - r.finished_at)} ago (queued, run, answer stored).`, verified: true, links: { jobs: [r.id] } });
  return item(now, {
    ...base,
    status: "not_tested",
    evidence: r ? `The latest completed request was ${ago(now - r.finished_at)} ago.` : "No request has completed yet.",
    cause: "A live test calls the AI model (it costs tokens) and posts an answer, so the check doesn't run one by itself.",
    remediation: "Run Configure › Test on an agent to prove the path now.",
  });
}

/** AI counters with a limit at [scope]: used this period against the limit. */
const AI_COUNTERS: readonly QuotaKey[] = ["ai.jobs", "ai.requests", "ai.tokens", "ai.cost_micro", "ai.media_seconds"];
/** Used at or above this share of a limit warns. */
const NEAR_LIMIT = 0.8;

export function limitsCheck(d: Deps, scope: Scope, now: number): CheckItem {
  const rows = AI_COUNTERS.flatMap((key) => {
    if (!(QUOTA_KEYS[key].scopes as readonly string[]).includes(scope.type)) return [];
    const eff = d.ctx.quotas.effective(key, scope, now);
    if (eff.limit === null || eff.limit <= 0) return [];
    const used = d.ctx.quotas.usage(key, scope).used;
    return [{ key, label: QUOTA_KEYS[key].label, used, limit: eff.limit, share: used / eff.limit, blocks: eff.mode === "block" || eff.mode === "throttle" }];
  });
  const base = { key: "runtime.limits", level: "runtime" as const, title: "AI usage limits", verified: true };
  if (!rows.length) return item(now, { ...base, status: "healthy", evidence: "No AI usage limit applies here." });
  const over = rows.filter((r) => r.share >= 1);
  const near = rows.filter((r) => r.share >= NEAR_LIMIT && r.share < 1);
  const line = (r: (typeof rows)[number]) => `${r.label}: ${r.used} of ${r.limit}`;
  const status = over.some((r) => r.blocks) ? "failed" : over.length || near.length ? "warning" : "healthy";
  return item(now, {
    ...base,
    status,
    evidence: (over.length || near.length ? [...over, ...near] : rows).map(line).join("; ") + ".",
    cause: over.length ? "A limit is used up for this period: new work is refused or slowed until it resets." : null,
    remediation: status === "healthy" ? null : "Wait for the period to reset, or raise the limit (console › Quotas).",
    owner: status === "healthy" ? null : "platform_operator",
    impacts: status === "healthy" ? [] : ["New AI work"],
  });
}
