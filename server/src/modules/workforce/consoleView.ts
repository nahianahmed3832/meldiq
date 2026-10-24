import type { DB } from "../../infrastructure/database/db.js";
import { ROUTING_CATEGORIES, type RoutingCategory } from "../ai/index.js";
import type { JobRow, JobState } from "./jobs.js";
import type { Entitlement, TemplatePolicy, TemplateStatus } from "./store.js";
import type { ToolKey, ToolMode } from "./types.js";
import type { WorkforceModule } from "./index.js";

/** Steps of failed requests checked for model use per overview (well under SQLite's bound-parameter limit). */
const MAX_FAILED_STEPS = 5000;

/**
 * What the Platform Admin Console reads about AI Workforce (modules/platformAdmin): counts, states, durations, sizes
 * and error kinds. Nothing here returns a brief, a file name, a file or an output.
 */
export function jobStats(w: WorkforceModule, from: number) {
  const db = w.ctx.db;
  const totals = db
    .prepare(
      `SELECT COUNT(*) created, SUM(state = 'completed') completed, SUM(state = 'failed') failed, SUM(state = 'cancelled') cancelled,
              SUM(state IN ('queued','planning','running','awaiting_input','awaiting_approval')) active
         FROM ai_jobs WHERE created_at >= ?`,
    )
    .get(from) as Record<string, number | null>;
  const n = (k: string) => Number(totals[k] ?? 0);
  const runtimes = (db.prepare("SELECT finished_at - started_at d FROM ai_jobs WHERE state = 'completed' AND finished_at IS NOT NULL AND started_at IS NOT NULL AND created_at >= ? ORDER BY d").all(from) as { d: number }[]).map((r) => r.d);
  const pct = (q: number) => (runtimes.length ? runtimes[Math.min(runtimes.length - 1, Math.ceil(runtimes.length * q) - 1)]! : null);
  const byAgent = db
    .prepare("SELECT agent_id agentId, COUNT(*) created, SUM(state = 'completed') completed, SUM(state = 'failed') failed FROM ai_jobs WHERE created_at >= ? GROUP BY agent_id ORDER BY created DESC")
    .all(from) as { agentId: string; created: number; completed: number; failed: number }[];
  const byOrg = db
    .prepare("SELECT org_id orgId, COUNT(*) created, SUM(state = 'completed') completed, SUM(state = 'failed') failed FROM ai_jobs WHERE created_at >= ? GROUP BY org_id ORDER BY created DESC LIMIT 20")
    .all(from) as { orgId: string; created: number; completed: number; failed: number }[];
  const failures = db.prepare("SELECT error_code code, COUNT(*) count FROM ai_jobs WHERE state = 'failed' AND created_at >= ? AND error_code IS NOT NULL GROUP BY error_code ORDER BY count DESC LIMIT 20").all(from) as { code: string; count: number }[];
  const queue = db.prepare("SELECT state, COUNT(*) count FROM ai_jobs WHERE state IN ('queued','planning','running','awaiting_input','awaiting_approval') GROUP BY state").all() as { state: JobState; count: number }[];
  const oldest = db.prepare("SELECT MIN(created_at) t FROM ai_jobs WHERE state = 'queued'").get() as { t: number | null };
  // Failed requests whose whole tree never sent a model request (refused by routing, quotas or checks before that).
  const failedTrees = db
    .prepare(
      `SELECT j.id root, s.id step FROM ai_jobs j JOIN ai_jobs s ON s.root_job_id = j.id
        WHERE j.state = 'failed' AND j.parent_job_id IS NULL AND j.created_at >= ? ORDER BY j.created_at DESC LIMIT ?`,
    )
    .all(from, MAX_FAILED_STEPS) as { root: string; step: string }[];
  const used = w.ctx.ai.jobUsage(failedTrees.map((r) => r.step));
  const reached = new Set(failedTrees.filter((r) => used.has(r.step)).map((r) => r.root));
  const beforeModel = { n: new Set(failedTrees.map((r) => r.root).filter((root) => !reached.has(root))).size };
  return {
    created: n("created"),
    completed: n("completed"),
    failed: n("failed"),
    cancelled: n("cancelled"),
    active: n("active"),
    runtimeP50Ms: pct(0.5),
    runtimeP95Ms: pct(0.95),
    byAgent: byAgent.map((r) => ({ ...r, completed: r.completed ?? 0, failed: r.failed ?? 0 })),
    byOrg: byOrg.map((r) => ({ ...r, completed: r.completed ?? 0, failed: r.failed ?? 0 })),
    failures,
    failedBeforeModel: beforeModel.n,
    queue,
    oldestQueuedAt: oldest.t,
  };
}

/** Jobs by state, everywhere (the operator CLI's status). */
export function jobStateCounts(db: DB): { state: string; jobs: number }[] {
  return db.prepare("SELECT state, COUNT(*) jobs FROM ai_jobs GROUP BY state ORDER BY state").all() as { state: string; jobs: number }[];
}

export function mediaSecondsSince(w: WorkforceModule, from: number): number {
  const rows = w.ctx.db.prepare("SELECT detail FROM ai_job_events WHERE kind = 'media_rendered' AND at >= ?").all(from) as { detail: string }[];
  return rows.reduce((n, r) => n + Number((JSON.parse(r.detail) as { seconds?: number }).seconds ?? 0), 0);
}

export function agentJobCounts(w: WorkforceModule, agentId: string, version: number): { completed: number; failed: number } {
  const r = w.ctx.db.prepare("SELECT SUM(state = 'completed') completed, SUM(state = 'failed') failed FROM ai_jobs WHERE agent_id = ? AND version = ?").get(agentId, version) as { completed: number | null; failed: number | null };
  return { completed: r.completed ?? 0, failed: r.failed ?? 0 };
}

export function toolEventCounts(w: WorkforceModule, from: number): Map<string, { used: number; denied: number }> {
  const rows = w.ctx.db.prepare("SELECT detail FROM ai_job_events WHERE kind = 'tool' AND at >= ?").all(from) as { detail: string }[];
  const m = new Map<string, { used: number; denied: number }>();
  for (const r of rows) {
    const d = JSON.parse(r.detail) as { tool?: string; outcome?: string };
    if (!d.tool) continue;
    const cur = m.get(d.tool) ?? { used: 0, denied: 0 };
    m.set(d.tool, { used: cur.used + (d.outcome === "allowed" ? 1 : 0), denied: cur.denied + (d.outcome === "denied" ? 1 : 0) });
  }
  return m;
}

export function orgJobCounts(w: WorkforceModule, orgId: string, from: number): { jobs: number; failed: number; active: number } {
  const r = w.ctx.db
    .prepare("SELECT COUNT(*) jobs, SUM(state = 'failed') failed, SUM(state IN ('queued','planning','running','awaiting_input','awaiting_approval')) active FROM ai_jobs WHERE org_id = ? AND created_at >= ?")
    .get(orgId, from) as { jobs: number; failed: number | null; active: number | null };
  return { jobs: r.jobs, failed: r.failed ?? 0, active: w.jobs.activeCount({ orgId }) };
}

/** Explicit community entitlements (rows only). */
export function entitlementRows(w: WorkforceModule): { orgId: string; doc: string; updatedAt: number }[] {
  return (w.ctx.db.prepare("SELECT org_id, doc, updated_at FROM ai_org_entitlements ORDER BY updated_at DESC LIMIT 500").all() as { org_id: string; doc: string; updated_at: number }[]).map((r) => ({ orgId: r.org_id, doc: r.doc, updatedAt: r.updated_at }));
}

/** A job as operators see it: metadata, with file counts and sizes but no names. Never input, output or notes. */
export interface JobMeta {
  id: string;
  orgId: string;
  agentId: string;
  version: number;
  skillId: string;
  state: JobState;
  progress: number;
  depth: number;
  parentJobId: string | null;
  attempts: number;
  maxAttempts: number;
  revision: number;
  inChannel: boolean;
  error: { code: string } | null;
  files: number;
  fileBytes: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

function jobMeta(w: WorkforceModule, j: JobRow): JobMeta {
  const files = w.files.ofJobs([j.id]);
  return {
    id: j.id,
    orgId: j.org_id,
    agentId: j.agent_id,
    version: j.version,
    skillId: j.skill_id,
    state: j.state,
    progress: j.progress,
    depth: j.depth,
    parentJobId: j.parent_job_id,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    revision: j.revision,
    inChannel: j.conversation_id !== null,
    error: j.error_code ? { code: j.error_code } : null,
    files: files.length,
    fileBytes: files.reduce((n, f) => n + f.size, 0),
    createdAt: j.created_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
  };
}

/** Job rows for operators' lists (module-internal: the console gets them as JobMeta). */
function adminJobRows(w: WorkforceModule, f: { state?: JobState; orgId?: string; agentId?: string; before?: number }, limit: number): JobRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.state) (where.push("state = ?"), args.push(f.state));
  if (f.orgId) (where.push("org_id = ?"), args.push(f.orgId));
  if (f.agentId) (where.push("agent_id = ?"), args.push(f.agentId));
  if (f.before) (where.push("created_at < ?"), args.push(f.before));
  return w.ctx.db.prepare(`SELECT * FROM ai_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...args, limit) as JobRow[];
}

/**
 * The only part of AI Workforce the Platform Admin Console uses (ctx.workforce.console; test/platform_admin_permissions
 * checks it): settings, worker state, counts, catalog and tool state, entitlements, job metadata, and the operations
 * an operator may take. No method returns a brief, a file, a file name, an output or a channel post.
 */
export class WorkforceConsoleView {
  constructor(private readonly w: WorkforceModule) {}

  controls() {
    const s = this.w.settings;
    return { workforceEnabled: s.enabled(), paused: s.paused(), maxConcurrency: s.maxConcurrency(), approvalFloor: s.approvalFloor() };
  }

  worker() {
    return this.w.runtime.status();
  }

  /** Run Full System Check for the platform (health/): statuses, counts and ids, never content. */
  runSystemCheck(accountId: string) {
    return this.w.health.platform(accountId);
  }

  systemChecks(limit: number) {
    const history = this.w.health.reports.history("platform", null, limit);
    return { latest: history[0] ?? null, history: history.map(({ items: _items, orgId: _orgId, ...s }) => s) };
  }

  /** One platform report, or null (community reports stay with their community). */
  systemCheck(id: string) {
    const r = this.w.health.reports.get(id);
    return r?.scope === "platform" ? r : null;
  }

  jobStats(from: number) {
    return jobStats(this.w, from);
  }

  mediaSeconds(from: number) {
    return mediaSecondsSince(this.w, from);
  }

  storage() {
    return this.w.files.totals();
  }

  fileBytes(orgId: string) {
    return this.w.files.bytesUsed(orgId);
  }

  installCounts() {
    return this.w.store.installCounts();
  }

  communitiesWithAgents() {
    return this.w.store.communitiesWithAgents();
  }

  templateStates() {
    return this.w.store.templateStates();
  }

  templateState(agentId: string, version: number) {
    return this.w.store.templateState(agentId, version);
  }

  setTemplateState(agentId: string, version: number, patch: { status?: TemplateStatus; availability?: "all" | "entitled"; policy?: TemplatePolicy }, actor: string) {
    return this.w.store.setTemplateState(agentId, version, patch, actor);
  }

  agentJobs(agentId: string, version: number) {
    return agentJobCounts(this.w, agentId, version);
  }

  toolPolicies() {
    return this.w.store.toolPolicies();
  }

  setToolPolicy(tool: ToolKey, mode: ToolMode, actor: string) {
    this.w.store.setToolPolicy(tool, mode, actor);
  }

  toolUse(from: number) {
    return toolEventCounts(this.w, from);
  }

  entitlementRows() {
    return entitlementRows(this.w);
  }

  entitlement(orgId: string) {
    return this.w.store.entitlement(orgId);
  }

  setEntitlement(orgId: string, doc: Entitlement, rev: number, actor: string) {
    return this.w.store.setEntitlement(orgId, doc, rev, actor);
  }

  /** A community's installed agents: names, versions, states and channel counts (no instructions or content). */
  installs(orgId: string) {
    return this.w.store.installsOf(orgId).map((i) => ({ installId: i.id, agentId: i.agentId, version: i.version, state: i.state, displayName: i.displayName, channels: this.w.store.channelsOf(i.id).length, createdAt: i.createdAt }));
  }

  orgJobs(orgId: string, from: number) {
    return orgJobCounts(this.w, orgId, from);
  }

  jobs(f: { state?: JobState; orgId?: string; agentId?: string; before?: number }, limit: number): JobMeta[] {
    return adminJobRows(this.w, f, limit).map((j) => jobMeta(this.w, j));
  }

  job(jobId: string): JobMeta | null {
    const j = this.w.jobs.get(jobId);
    return j ? jobMeta(this.w, j) : null;
  }

  steps(jobId: string): JobMeta[] {
    return this.w.jobs.children(jobId).map((j) => jobMeta(this.w, j));
  }

  /** For a job that failed for want of a model, the kind of work no model served (read from its error); else null. */
  failedRoute(jobId: string): RoutingCategory | null {
    const j = this.w.jobs.get(jobId);
    if (!j || j.error_code !== "ai_not_configured" || !j.error_detail) return null;
    const detail = j.error_detail.toLowerCase();
    return (Object.keys(ROUTING_CATEGORIES) as RoutingCategory[]).find((c) => detail.includes(ROUTING_CATEGORIES[c].label.toLowerCase())) ?? null;
  }

  /** Kinds and numbers only: events never hold content (docs/AI_WORKFORCE.md §8). */
  events(jobId: string) {
    return this.w.jobs.events(jobId).map((e) => ({ at: e.at, kind: e.kind, detail: e.detail }));
  }

  /** An operator's emergency cancel: the job stops and its approvals are void. */
  cancel(jobId: string) {
    this.w.jobs.requestCancel(jobId, "cancelled_by_operator");
    this.w.approvals.invalidateJob(jobId);
  }
}
