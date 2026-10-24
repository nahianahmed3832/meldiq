import type { DB } from "../../infrastructure/database/db.js";
import { ApiError } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";

/**
 * Durable jobs (docs/AI_WORKFORCE.md §5) in SQLite. A worker claims a due job with a lease and renews it while it
 * works; a lease that runs out (crash, restart) puts the job back in the queue until its attempts are used up. Every
 * transition names the state it expects and, while running, the worker holding the lease, so a stale worker can't
 * overwrite a newer outcome.
 */
export const JOB_STATES = ["queued", "planning", "running", "awaiting_input", "awaiting_approval", "completed", "failed", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const TERMINAL: ReadonlySet<JobState> = new Set(["completed", "failed", "cancelled"]);
/** Jobs that count as active for quotas: everything not finished. */
export const ACTIVE_STATES = ["queued", "planning", "running", "awaiting_input", "awaiting_approval"] as const;

export const MAX_DEPTH = 2;

/**
 * Why a job was cancelled. Only the requester's own cancel (and an expired wait) leave it retryable by them; a cancel by
 * an operator, a rejected approval or the agent's removal is final.
 */
export type CancelReason = "cancelled_by_requester" | "cancelled_by_manager" | "cancelled_by_operator" | "approval_rejected" | "agent_disabled" | "agent_removed";
const FINAL_CANCELS = ["expired", "cancelled_by_operator", "approval_rejected", "agent_disabled", "agent_removed"];
/** Jobs (including delegated ones) one request may create. */
export const MAX_JOBS_PER_ROOT = 12;
const BACKOFF_MS = [5_000, 30_000, 120_000];

export interface JobRow {
  id: string;
  org_id: string;
  install_id: string;
  agent_id: string;
  version: number;
  skill_id: string;
  requested_by: string;
  conversation_id: string | null;
  thread_root: string | null;
  parent_job_id: string | null;
  root_job_id: string;
  depth: number;
  depends_on: string;
  waiting_on: string | null;
  state: JobState;
  input: string;
  output: string | null;
  checkpoint: string | null;
  revision: number;
  progress: number;
  progress_note: string | null;
  attempts: number;
  max_attempts: number;
  next_at: number;
  lease_until: number | null;
  worker: string | null;
  deadline_at: number;
  idempotency_key: string | null;
  cancel_requested: number;
  error_code: string | null;
  error_detail: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  expires_at: number;
  /** What started it besides a person (migration 051): its trigger, the job whose result it hands on, handoffs deep. */
  trigger_id: string | null;
  source_job_id: string | null;
  chain: number;
}

export interface NewJob {
  orgId: string;
  installId: string;
  agentId: string;
  version: number;
  skillId: string;
  requestedBy: string;
  conversationId: string | null;
  threadRoot: string | null;
  input: unknown;
  parentJobId: string | null;
  rootJobId: string | null;
  depth: number;
  dependsOn: string[];
  maxAttempts: number;
  idempotencyKey: string | null;
  /** Until when the job may wait for people (approvals, answers) before it's closed. */
  deadlineAt: number;
  expiresAt: number;
  triggerId?: string | null;
  sourceJobId?: string | null;
  chain?: number;
}

export class JobStore {
  constructor(
    private readonly db: DB,
    private readonly clock: () => number,
  ) {}

  get(id: string): JobRow | null {
    return (this.db.prepare("SELECT * FROM ai_jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null;
  }

  byIdempotency(orgId: string, userId: string, key: string): JobRow | null {
    return (this.db.prepare("SELECT * FROM ai_jobs WHERE org_id = ? AND requested_by = ? AND idempotency_key = ?").get(orgId, userId, key) as JobRow | undefined) ?? null;
  }

  /** Inserts a queued job. The caller runs it inside its own transaction with the checks that admit it. */
  insert(j: NewJob): JobRow {
    const t = this.clock();
    const id = newId("job");
    this.db
      .prepare(
        `INSERT INTO ai_jobs (id, org_id, install_id, agent_id, version, skill_id, requested_by, conversation_id, thread_root, parent_job_id, root_job_id, depth,
                              depends_on, state, input, max_attempts, next_at, deadline_at, idempotency_key, created_at, updated_at, expires_at,
                              trigger_id, source_job_id, chain)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        j.orgId,
        j.installId,
        j.agentId,
        j.version,
        j.skillId,
        j.requestedBy,
        j.conversationId,
        j.threadRoot,
        j.parentJobId,
        j.rootJobId ?? id,
        j.depth,
        JSON.stringify(j.dependsOn),
        JSON.stringify(j.input),
        j.maxAttempts,
        t,
        j.deadlineAt,
        j.idempotencyKey,
        t,
        t,
        j.expiresAt,
        j.triggerId ?? null,
        j.sourceJobId ?? null,
        j.chain ?? 0,
      );
    this.event(id, "created", { depth: j.depth, parent: j.parentJobId, ...(j.triggerId ? { trigger: j.triggerId, chain: j.chain ?? 0 } : {}) });
    return this.get(id)!;
  }

  event(jobId: string, kind: string, detail: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO ai_job_events (job_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(jobId, this.clock(), kind, JSON.stringify(detail));
  }

  events(jobId: string, limit = 200): { id: number; at: number; kind: string; detail: Record<string, unknown> }[] {
    return (this.db.prepare("SELECT id, at, kind, detail FROM ai_job_events WHERE job_id = ? ORDER BY id LIMIT ?").all(jobId, limit) as { id: number; at: number; kind: string; detail: string }[]).map((e) => ({
      ...e,
      detail: JSON.parse(e.detail) as Record<string, unknown>,
    }));
  }

  countInRoot(rootJobId: string): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE root_job_id = ?").get(rootJobId) as { n: number }).n;
  }

  children(parentJobId: string): JobRow[] {
    return this.db.prepare("SELECT * FROM ai_jobs WHERE parent_job_id = ? ORDER BY created_at").all(parentJobId) as JobRow[];
  }

  /** Active jobs (not finished) of a community, a person, an installation, or everyone. */
  activeCount(filter: { orgId?: string; userId?: string; installId?: string }): number {
    const where = ["state IN ('queued','planning','running','awaiting_input','awaiting_approval')"];
    const args: string[] = [];
    if (filter.orgId) (where.push("org_id = ?"), args.push(filter.orgId));
    if (filter.userId) (where.push("requested_by = ?"), args.push(filter.userId));
    if (filter.installId) (where.push("install_id = ?"), args.push(filter.installId));
    return (this.db.prepare(`SELECT COUNT(*) n FROM ai_jobs WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n;
  }

  /** Jobs holding a lease right now (being worked on), overall and per community and installation. */
  runningCounts(): { total: number; byOrg: Map<string, number>; byInstall: Map<string, number> } {
    const rows = this.db.prepare("SELECT org_id, install_id FROM ai_jobs WHERE state IN ('planning','running') AND lease_until IS NOT NULL").all() as { org_id: string; install_id: string }[];
    const byOrg = new Map<string, number>();
    const byInstall = new Map<string, number>();
    for (const r of rows) {
      byOrg.set(r.org_id, (byOrg.get(r.org_id) ?? 0) + 1);
      byInstall.set(r.install_id, (byInstall.get(r.install_id) ?? 0) + 1);
    }
    return { total: rows.length, byOrg, byInstall };
  }

  /**
   * Claims up to [limit] due jobs for [worker]: queued jobs whose dependencies completed, and coordinators whose
   * delegated jobs all finished. [admit] can refuse one (a community or installation at its concurrency limit).
   * A queued job with a failed or cancelled dependency fails here instead.
   */
  claim(worker: string, limit: number, leaseMs: number, admit: (row: JobRow) => boolean): JobRow[] {
    if (limit <= 0) return [];
    const t = this.clock();
    return this.db.transaction(() => {
      const claimed: JobRow[] = [];
      const due = this.db
        .prepare(
          `SELECT * FROM ai_jobs
            WHERE (state = 'queued' AND next_at <= ?)
               OR (state = 'running' AND lease_until IS NULL AND waiting_on IS NOT NULL AND next_at <= ?)
            ORDER BY next_at, created_at LIMIT ?`,
        )
        .all(t, t, limit * 10) as JobRow[];
      for (const row of due) {
        if (claimed.length >= limit) break;
        const waitFor = row.state === "queued" ? (JSON.parse(row.depends_on) as string[]) : (JSON.parse(row.waiting_on ?? "[]") as string[]);
        if (waitFor.length) {
          const states = this.dependencyStates(waitFor);
          if (row.state === "queued" && states.some((s) => s.state === "failed" || s.state === "cancelled")) {
            this.failNow(row.id, "dependency_failed", "A step this one depends on failed or was cancelled.");
            continue;
          }
          const done = row.state === "queued" ? (s: JobState) => s === "completed" : (s: JobState) => TERMINAL.has(s);
          if (states.length < waitFor.length || !states.every((s) => done(s.state))) continue;
        }
        if (!admit(row)) continue;
        const changes = this.db
          .prepare(
            `UPDATE ai_jobs SET state = 'running', lease_until = ?, worker = ?, attempts = attempts + ?, started_at = COALESCE(started_at, ?), waiting_on = NULL, updated_at = ?
              WHERE id = ? AND state = ? AND lease_until IS NULL`,
          )
          .run(t + leaseMs, worker, row.state === "queued" ? 1 : 0, t, t, row.id, row.state).changes;
        if (changes) {
          this.event(row.id, row.state === "queued" ? "claimed" : "resumed", { worker, attempt: row.state === "queued" ? row.attempts + 1 : row.attempts });
          claimed.push(this.get(row.id)!);
        }
      }
      return claimed;
    })();
  }

  /**
   * The states of what a job waits for: jobs, and human tasks (ids "tsk_…", migration 052), whose done counts as
   * completed and cancelled as cancelled; any other task state is still running.
   */
  private dependencyStates(ids: string[]): { id: string; state: JobState }[] {
    const jobs = ids.filter((i) => !i.startsWith("tsk_"));
    const tasks = ids.filter((i) => i.startsWith("tsk_"));
    const q = (table: string, list: string[]) => (list.length ? (this.db.prepare(`SELECT id, state FROM ${table} WHERE id IN (${list.map(() => "?").join(",")})`).all(...list) as { id: string; state: string }[]) : []);
    const taskState = (s: string): JobState => (s === "done" ? "completed" : s === "cancelled" ? "cancelled" : "running");
    return [...(q("ai_jobs", jobs) as { id: string; state: JobState }[]), ...q("ai_tasks", tasks).map((t) => ({ id: t.id, state: taskState(t.state) }))];
  }

  /** Renews the lease; returns false when the job is no longer this worker's (then the worker must stop). */
  heartbeat(id: string, worker: string, leaseMs: number): { held: boolean; cancel: boolean } {
    const t = this.clock();
    const held = this.db.prepare("UPDATE ai_jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND worker = ? AND lease_until IS NOT NULL AND state IN ('planning','running')").run(t + leaseMs, t, id, worker).changes > 0;
    const cancel = (this.db.prepare("SELECT cancel_requested c FROM ai_jobs WHERE id = ?").get(id) as { c: number } | undefined)?.c === 1;
    return { held, cancel };
  }

  setProgress(id: string, worker: string, percent: number, note: string): void {
    this.db
      .prepare("UPDATE ai_jobs SET progress = ?, progress_note = ?, updated_at = ? WHERE id = ? AND worker = ? AND state IN ('planning','running')")
      .run(Math.max(0, Math.min(100, Math.round(percent))), note.slice(0, 200), this.clock(), id, worker);
  }

  setState(id: string, worker: string, state: "planning" | "running"): void {
    this.db.prepare("UPDATE ai_jobs SET state = ?, updated_at = ? WHERE id = ? AND worker = ? AND state IN ('planning','running')").run(state, this.clock(), id, worker);
  }

  /** Jobs whose lease ran out (the worker died): back in the queue while attempts remain, failed otherwise. */
  recoverExpired(): { requeued: string[]; failed: string[] } {
    const t = this.clock();
    const rows = this.db.prepare("SELECT * FROM ai_jobs WHERE state IN ('planning','running') AND lease_until IS NOT NULL AND lease_until < ?").all(t) as JobRow[];
    const requeued: string[] = [];
    const failed: string[] = [];
    for (const r of rows) {
      if (r.cancel_requested) {
        this.db.prepare("UPDATE ai_jobs SET state = 'cancelled', lease_until = NULL, worker = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND lease_until = ?").run(t, t, r.id, r.lease_until);
        this.event(r.id, "cancelled", { during: "recovery" });
        failed.push(r.id);
      } else if (r.attempts < r.max_attempts) {
        const ok = this.db
          .prepare("UPDATE ai_jobs SET state = 'queued', lease_until = NULL, worker = NULL, next_at = ?, updated_at = ? WHERE id = ? AND lease_until = ?")
          .run(t + BACKOFF_MS[0]!, t, r.id, r.lease_until).changes;
        if (ok) {
          this.event(r.id, "recovered", { previousWorker: r.worker, attempt: r.attempts });
          requeued.push(r.id);
        }
      } else {
        const ok = this.db
          .prepare("UPDATE ai_jobs SET state = 'failed', lease_until = NULL, worker = NULL, error_code = 'worker_lost', error_detail = ?, finished_at = ?, updated_at = ? WHERE id = ? AND lease_until = ?")
          .run("The worker stopped during every attempt.", t, t, r.id, r.lease_until).changes;
        if (ok) {
          this.event(r.id, "failed", { code: "worker_lost" });
          failed.push(r.id);
        }
      }
    }
    return { requeued, failed };
  }

  /** People's waiting time ran out: jobs awaiting approval or input past their deadline are closed. */
  expireWaiting(): string[] {
    const t = this.clock();
    const ids = (this.db.prepare("SELECT id FROM ai_jobs WHERE state IN ('awaiting_input','awaiting_approval') AND deadline_at < ?").all(t) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      this.db.prepare("UPDATE ai_jobs SET state = 'cancelled', error_code = 'expired', error_detail = 'Nobody answered in time.', finished_at = ?, updated_at = ? WHERE id = ?").run(t, t, id);
      this.event(id, "cancelled", { reason: "expired" });
    }
    return ids;
  }

  /**
   * Ends a running job's lease with [sets]. Unless [evenIfCancelled], a pending cancel wins: the transition doesn't
   * happen (the caller then cancels), so a cancel that arrives while the skill finishes isn't lost.
   */
  private release(id: string, worker: string, sets: string, args: unknown[], event: [string, Record<string, unknown>], evenIfCancelled = false): boolean {
    const t = this.clock();
    const ok =
      this.db
        .prepare(`UPDATE ai_jobs SET ${sets}, lease_until = NULL, updated_at = ? WHERE id = ? AND worker = ? AND state IN ('planning','running') AND lease_until IS NOT NULL${evenIfCancelled ? "" : " AND cancel_requested = 0"}`)
        .run(...args, t, id, worker).changes > 0;
    if (ok) this.event(id, ...event);
    return ok;
  }

  complete(id: string, worker: string, output: unknown, summary: string): boolean {
    return this.release(id, worker, "state = 'completed', output = ?, progress = 100, progress_note = ?, finished_at = ?, worker = NULL", [JSON.stringify(output), summary.slice(0, 200), this.clock()], ["completed", {}]);
  }

  fail(id: string, worker: string, code: string, detail: string): boolean {
    return this.release(id, worker, "state = 'failed', error_code = ?, error_detail = ?, finished_at = ?, worker = NULL", [code, detail.slice(0, 500), this.clock()], ["failed", { code }], true);
  }

  /** A transient failure: back in the queue with backoff, if attempts remain; failed otherwise. */
  retryLater(id: string, worker: string, code: string, detail: string): "retry" | "failed" {
    const r = this.get(id);
    if (!r) return "failed";
    if (r.attempts >= r.max_attempts) {
      this.fail(id, worker, code, detail);
      return "failed";
    }
    const at = this.clock() + BACKOFF_MS[Math.min(r.attempts - 1, BACKOFF_MS.length - 1)]!;
    if (!this.release(id, worker, "state = 'queued', next_at = ?, error_code = ?, error_detail = ?, worker = NULL", [at, code, detail.slice(0, 500)], ["retry_scheduled", { code, at }])) {
      this.cancelled(id, worker);
      return "failed";
    }
    return "retry";
  }

  cancelled(id: string, worker: string): boolean {
    return this.release(id, worker, "state = 'cancelled', error_code = COALESCE(error_code, 'cancelled_by_requester'), finished_at = ?, worker = NULL", [this.clock()], ["cancelled", {}], true);
  }

  awaitApproval(id: string, worker: string, checkpoint: unknown, summary: string): boolean {
    return this.release(id, worker, "state = 'awaiting_approval', checkpoint = ?, progress_note = ?, worker = NULL", [JSON.stringify(checkpoint ?? null), summary.slice(0, 200)], ["awaiting_approval", {}]);
  }

  awaitInput(id: string, worker: string, checkpoint: unknown, question: string): boolean {
    return this.release(id, worker, "state = 'awaiting_input', checkpoint = ?, progress_note = ?, worker = NULL", [JSON.stringify(checkpoint ?? null), question.slice(0, 200)], ["awaiting_input", {}]);
  }

  waitChildren(id: string, worker: string, jobIds: string[], checkpoint: unknown): boolean {
    return this.release(id, worker, "state = 'running', waiting_on = ?, checkpoint = ?, next_at = ?, worker = NULL", [JSON.stringify(jobIds), JSON.stringify(checkpoint ?? null), this.clock()], ["waiting", { on: jobIds.length }]);
  }

  /** People acted (approved, answered, asked for a revision): the job goes back to the queue with its checkpoint. */
  resume(id: string, from: "awaiting_approval" | "awaiting_input", patch: { revision?: boolean; checkpoint?: unknown }): JobRow {
    const t = this.clock();
    const ok = this.db
      .prepare(
        `UPDATE ai_jobs SET state = 'queued', next_at = ?, attempts = 0, revision = revision + ?, checkpoint = CASE WHEN ? THEN ? ELSE checkpoint END,
           error_code = NULL, error_detail = NULL, updated_at = ? WHERE id = ? AND state = ?`,
      )
      .run(t, patch.revision ? 1 : 0, patch.checkpoint !== undefined ? 1 : 0, JSON.stringify(patch.checkpoint ?? null), t, id, from).changes;
    if (!ok) throw new ApiError(409, "job_not_retryable", "This job isn't waiting for that anymore.");
    this.event(id, "resumed_by_person", { from, revision: !!patch.revision });
    return this.get(id)!;
  }

  /**
   * Cancels at once when nobody is working on it; otherwise flags it so the worker aborts. Records [reason]. Cancels its
   * delegated jobs too.
   */
  requestCancel(id: string, reason: CancelReason): JobRow {
    const t = this.clock();
    const r = this.get(id);
    if (!r || TERMINAL.has(r.state)) throw new ApiError(409, "job_not_retryable", "This job has already finished.");
    this.db.transaction(() => {
      const now = this.db
        .prepare(
          `UPDATE ai_jobs SET state = 'cancelled', error_code = ?, error_detail = NULL, finished_at = ?, updated_at = ?, waiting_on = NULL
            WHERE id = ? AND (state IN ('queued','awaiting_input','awaiting_approval') OR (state = 'running' AND lease_until IS NULL))`,
        )
        .run(reason, t, t, id).changes;
      if (now) this.event(id, "cancelled", { reason });
      else {
        this.db.prepare("UPDATE ai_jobs SET cancel_requested = 1, error_code = ?, updated_at = ? WHERE id = ?").run(reason, t, id);
        this.event(id, "cancel_requested", { reason });
      }
      for (const c of this.children(id)) if (!TERMINAL.has(c.state)) this.requestCancel(c.id, reason);
    })();
    return this.get(id)!;
  }

  /** Every job of an installation that hasn't finished (to cancel when the agent is disabled or removed). */
  activeIdsOfInstall(installId: string): string[] {
    return (this.db.prepare("SELECT id FROM ai_jobs WHERE install_id = ? AND state IN ('queued','planning','running','awaiting_input','awaiting_approval')").all(installId) as { id: string }[]).map((r) => r.id);
  }

  /** Whether the requester may retry [row]: failed, or cancelled by themself (not by an operator, a rejection or removal). */
  static retryable(row: Pick<JobRow, "state" | "error_code">): boolean {
    return (row.state === "failed" || row.state === "cancelled") && !FINAL_CANCELS.includes(row.error_code ?? "");
  }

  /** A failed or cancelled job back in the queue as a new attempt (its checkpoint kept). */
  retry(id: string): JobRow {
    const t = this.clock();
    const ok = this.db
      .prepare(
        `UPDATE ai_jobs SET state = 'queued', attempts = 0, next_at = ?, cancel_requested = 0, error_code = NULL, error_detail = NULL, finished_at = NULL, updated_at = ?
          WHERE id = ? AND state IN ('failed','cancelled') AND (error_code IS NULL OR error_code NOT IN (${FINAL_CANCELS.map(() => "?").join(",")}))`,
      )
      .run(t, t, id, ...FINAL_CANCELS).changes;
    if (!ok) throw new ApiError(409, "job_not_retryable", "Only a failed job, or one you cancelled yourself, can be retried.");
    this.event(id, "retried", {});
    return this.get(id)!;
  }

  private failNow(id: string, code: string, detail: string): void {
    const t = this.clock();
    this.db.prepare("UPDATE ai_jobs SET state = 'failed', error_code = ?, error_detail = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'").run(code, detail, t, t, id);
    this.event(id, "failed", { code });
  }

  list(filter: { orgId?: string; userId?: string; installId?: string; state?: JobState; rootOnly?: boolean; before?: number }, limit: number): JobRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.orgId) (where.push("org_id = ?"), args.push(filter.orgId));
    if (filter.userId) (where.push("requested_by = ?"), args.push(filter.userId));
    if (filter.installId) (where.push("install_id = ?"), args.push(filter.installId));
    if (filter.state) (where.push("state = ?"), args.push(filter.state));
    if (filter.rootOnly) where.push("parent_job_id IS NULL");
    if (filter.before) (where.push("created_at < ?"), args.push(filter.before));
    return this.db.prepare(`SELECT * FROM ai_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...args, limit) as JobRow[];
  }

  /** Finished jobs past their retention, with their events (files and posts are removed by their own stores). */
  purgeExpired(): string[] {
    const t = this.clock();
    const ids = (this.db.prepare("SELECT id FROM ai_jobs WHERE expires_at < ? AND state IN ('completed','failed','cancelled') LIMIT 500").all(t) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      this.db.prepare("DELETE FROM ai_job_events WHERE job_id = ?").run(id);
      this.db.prepare("DELETE FROM ai_jobs WHERE id = ?").run(id);
    }
    return ids;
  }
}
