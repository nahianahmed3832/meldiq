import type { WorkforceModule } from "./index.js";
import type { JobRow } from "./jobs.js";
import { TaskService } from "./taskService.js";
import type { TaskRow } from "./taskStore.js";

/**
 * The work overview (docs/implementation/PROGRESS.md phase 3): in one answer, what needs this person's action, what the
 * workforce (agents and people) is doing, what finished and what failed in the last 7 days, the cost of the agents'
 * work, and the latest System Check. Everyone sees their own requests and tasks; people who manage agents see the
 * whole community. Each item links to its job, task or approval, so the person goes straight to the record.
 */
const DAY = 86_400_000;
const WINDOW_DAYS = 7;
const SHOWN = 20;
/** Requests counted for the cost line: the newest this many in the window. */
const COSTED_ROOTS = 500;
const TITLE_CHARS = 120;
const ACTIVE_JOB = ["queued", "planning", "running", "awaiting_input", "awaiting_approval"];
const ACTIVE_TASK = ["waiting", "open", "accepted", "in_progress", "blocked", "submitted"];

export type WorkAction = "approve" | "answer" | "do" | "review" | "open";

export interface WorkItem {
  kind: "job" | "task";
  id: string;
  title: string;
  /** Who does the work: an agent (installation) or a person. */
  owner: { kind: "agent" | "person"; id: string; name: string };
  requestedBy: { id: string; name: string };
  state: string;
  at: number;
  /** Why it needs this person (attention only). */
  reason: string | null;
  action: WorkAction;
  jobId: string | null;
  taskId: string | null;
  approvalId: string | null;
  dueAt: number | null;
  progress: number | null;
  /** Files the agents made for this request. */
  deliverables: number | null;
  /** Estimated cost of the request's model calls (all its steps), micro-USD. */
  costMicro: number | null;
  error: string | null;
}

export interface WorkOverview {
  scope: "mine" | "all";
  attention: WorkItem[];
  active: WorkItem[];
  finished: WorkItem[];
  failed: WorkItem[];
  totals: { attention: number; active: number; finished: number; failed: number; requests: number; modelRequests: number; costMicro: number };
  health: { id: string; worst: string; at: number; failed: number; warning: number } | null;
  days: number;
}

/** The brief a job was asked, shortened: what the person called the work. */
function titleOf(j: JobRow, agentName: string): string {
  try {
    const input = JSON.parse(j.input) as { brief?: unknown; question?: unknown };
    const text = typeof input.brief === "string" ? input.brief : typeof input.question === "string" ? input.question : "";
    const line = text.trim().split("\n")[0] ?? "";
    if (line) return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
  } catch {
    // A malformed input is shown by the agent's name instead.
  }
  return `Request to ${agentName}`;
}

export class WorkCenter {
  constructor(private readonly w: WorkforceModule) {}

  overview(orgId: string, userId: string): WorkOverview {
    const now = this.w.clock();
    const manages = this.w.ctx.authz.can(orgId, userId, "ai.manage");
    const approver = this.w.ctx.authz.can(orgId, userId, "ai.approve");
    const since = now - WINDOW_DAYS * DAY;
    const jobs = this.rootJobs(orgId, manages ? null : userId, since);
    const tasks = this.w.tasks.list({ orgId, before: undefined }, 1000).filter((t) => manages || t.assignee_id === userId || t.created_by === userId);
    const usage = this.usage(jobs.map((j) => j.id));
    const files = this.deliverables(jobs.map((j) => j.id));
    const names = this.w.taskService.names([...jobs.map((j) => j.requested_by), ...tasks.flatMap((t) => [t.assignee_id, t.created_by])]);
    const job = (j: JobRow, extra: Partial<WorkItem> = {}) => this.jobItem(j, names, usage.byRoot.get(j.id) ?? null, files.get(j.id) ?? 0, extra);
    const task = (t: TaskRow, extra: Partial<WorkItem> = {}) => this.taskItem(t, names, extra);

    const attention = this.attention(orgId, userId, { manages, approver, now }, jobs, tasks, job, task);
    const flagged = new Set(attention.map((i) => i.taskId ?? i.jobId));
    const active = [
      ...jobs.filter((j) => ACTIVE_JOB.includes(j.state) && !flagged.has(j.id)).map((j) => job(j)),
      ...tasks.filter((t) => ACTIVE_TASK.includes(t.state) && !flagged.has(t.id)).map((t) => task(t)),
    ].sort((a, b) => b.at - a.at);
    const finished = [
      ...jobs.filter((j) => j.state === "completed" && (j.finished_at ?? 0) >= since).map((j) => job(j)),
      ...tasks.filter((t) => t.state === "done" && t.updated_at >= since).map((t) => task(t)),
    ].sort((a, b) => b.at - a.at);
    const failed = jobs.filter((j) => j.state === "failed" && (j.finished_at ?? 0) >= since).map((j) => job(j));
    const latest = manages ? this.w.health.reports.latest("community", orgId) : null;
    return {
      scope: manages ? "all" : "mine",
      attention: attention.sort((a, b) => b.at - a.at).slice(0, SHOWN),
      active: active.slice(0, SHOWN),
      finished: finished.slice(0, SHOWN),
      failed: failed.slice(0, SHOWN),
      totals: { attention: attention.length, active: active.length, finished: finished.length, failed: failed.length, requests: usage.requests, modelRequests: usage.modelRequests, costMicro: usage.costMicro },
      health: latest ? { id: latest.id, worst: latest.worst, at: latest.startedAt, failed: latest.summary.failed, warning: latest.summary.warning } : null,
      days: WINDOW_DAYS,
    };
  }

  /** What waits on this person: approvals they may give, questions agents asked them, their new or overdue tasks, work handed in to review. */
  private attention(
    orgId: string,
    userId: string,
    who: { manages: boolean; approver: boolean; now: number },
    jobs: readonly JobRow[],
    tasks: readonly TaskRow[],
    job: (j: JobRow, extra?: Partial<WorkItem>) => WorkItem,
    task: (t: TaskRow, extra?: Partial<WorkItem>) => WorkItem,
  ): WorkItem[] {
    const out: WorkItem[] = [];
    if (who.approver) {
      for (const a of this.w.approvals.pending(orgId)) {
        const step = this.w.jobs.get(a.job_id);
        if (!step || !this.visible(orgId, step.root_job_id, userId)) continue;
        const root = this.w.jobs.get(step.root_job_id)!;
        out.push(job(root, { reason: `Approve: ${a.summary}`.slice(0, 300), action: "approve", approvalId: a.id, at: a.requested_at }));
      }
    }
    for (const j of jobs) if (j.state === "awaiting_input" && j.requested_by === userId) out.push(job(j, { reason: "The agent asked you a question", action: "answer" }));
    for (const t of tasks) {
      if (t.assignee_id === userId && t.state === "open") out.push(task(t, { reason: "A new task for you", action: "do" }));
      else if (t.assignee_id === userId && TaskService.overdue(t, who.now)) out.push(task(t, { reason: "Overdue", action: "do" }));
      else if (t.state === "submitted" && (t.created_by === userId || who.manages)) out.push(task(t, { reason: "Handed in: review it", action: "review" }));
    }
    return out;
  }

  /** The Approvals tab's rule: a job this person may see (their own, any if they manage agents, or in a channel they see). */
  private visible(orgId: string, jobId: string, userId: string): boolean {
    try {
      this.w.service.visibleJob(orgId, jobId, userId);
      return true;
    } catch {
      return false;
    }
  }

  /** Top-level requests in scope: all active ones, and those that finished or were created in the window. */
  private rootJobs(orgId: string, userId: string | null, since: number): JobRow[] {
    return this.w.ctx.db
      .prepare(
        `SELECT * FROM ai_jobs WHERE org_id = ? AND parent_job_id IS NULL ${userId ? "AND requested_by = ?" : ""}
           AND (state IN (${ACTIVE_JOB.map(() => "?").join(",")}) OR finished_at >= ? OR created_at >= ?)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(orgId, ...(userId ? [userId] : []), ...ACTIVE_JOB, since, since, COSTED_ROOTS) as JobRow[];
  }

  /** Model requests and estimated cost per request (summed over its delegated steps), and in total. */
  private usage(rootIds: string[]): { byRoot: Map<string, number>; requests: number; modelRequests: number; costMicro: number } {
    const byRoot = new Map<string, number>();
    if (!rootIds.length) return { byRoot, requests: 0, modelRequests: 0, costMicro: 0 };
    const steps = this.w.ctx.db.prepare(`SELECT id, root_job_id FROM ai_jobs WHERE root_job_id IN (${rootIds.map(() => "?").join(",")})`).all(...rootIds) as { id: string; root_job_id: string }[];
    const used = this.w.ctx.ai.jobUsage(steps.map((s) => s.id));
    let modelRequests = 0;
    for (const s of steps) {
      const u = used.get(s.id);
      if (!u) continue;
      modelRequests += u.requests;
      byRoot.set(s.root_job_id, (byRoot.get(s.root_job_id) ?? 0) + u.costMicro);
    }
    return { byRoot, requests: rootIds.length, modelRequests, costMicro: [...byRoot.values()].reduce((a, b) => a + b, 0) };
  }

  /** Files the agents made, per request (over all its steps). */
  private deliverables(rootIds: string[]): Map<string, number> {
    if (!rootIds.length) return new Map();
    const rows = this.w.ctx.db
      .prepare(
        `SELECT j.root_job_id root, COUNT(*) n FROM ai_files f JOIN ai_jobs j ON j.id = f.job_id
          WHERE f.role = 'artifact' AND f.deleted_at IS NULL AND j.root_job_id IN (${rootIds.map(() => "?").join(",")}) GROUP BY j.root_job_id`,
      )
      .all(...rootIds) as { root: string; n: number }[];
    return new Map(rows.map((r) => [r.root, r.n]));
  }

  private jobItem(j: JobRow, names: Map<string, string>, costMicro: number | null, deliverables: number, extra: Partial<WorkItem>): WorkItem {
    const agent = this.w.store.install(j.install_id)?.displayName ?? j.agent_id;
    return {
      kind: "job",
      id: j.id,
      title: titleOf(j, agent),
      owner: { kind: "agent", id: j.install_id, name: agent },
      requestedBy: { id: j.requested_by, name: names.get(j.requested_by) ?? "someone" },
      state: j.state,
      at: j.finished_at ?? j.updated_at,
      reason: null,
      action: "open",
      jobId: j.id,
      taskId: null,
      approvalId: null,
      dueAt: null,
      progress: j.progress,
      deliverables,
      costMicro,
      error: j.error_code,
      ...extra,
    };
  }

  private taskItem(t: TaskRow, names: Map<string, string>, extra: Partial<WorkItem>): WorkItem {
    return {
      kind: "task",
      id: t.id,
      title: t.title,
      owner: { kind: "person", id: t.assignee_id, name: names.get(t.assignee_id) ?? "someone" },
      requestedBy: { id: t.created_by, name: names.get(t.created_by) ?? "someone" },
      state: t.state,
      at: t.updated_at,
      reason: null,
      action: "open",
      jobId: t.job_id,
      taskId: t.id,
      approvalId: null,
      dueAt: t.due_at,
      progress: null,
      deliverables: null,
      costMicro: null,
      error: null,
      ...extra,
    };
  }
}
