import type { DB } from "../../infrastructure/database/db.js";
import { ApiError } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";

/**
 * Human tasks (migration 052; docs/AI_WORKFORCE_2_PLAN.md, phase 4): the records and their state changes, each with an
 * event. Who may make a change is decided by TaskService; this store only refuses changes that don't fit the state.
 */
export const TASK_STATES = ["waiting", "open", "accepted", "in_progress", "blocked", "submitted", "done", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Finished: nothing more happens to it. */
export const TASK_TERMINAL: ReadonlySet<TaskState> = new Set(["done", "cancelled"]);
/** Work the assignee still owes (counted as their load). */
export const TASK_ACTIVE: readonly TaskState[] = ["open", "accepted", "in_progress", "blocked", "submitted"];

export interface TaskRow {
  id: string;
  org_id: string;
  title: string;
  instructions: string;
  deliverables: string;
  assignee_id: string;
  created_by: string;
  install_id: string | null;
  job_id: string | null;
  conversation_id: string | null;
  priority: TaskPriority;
  state: TaskState;
  depends_on: string;
  reference_files: string;
  due_at: number | null;
  blocked_reason: string | null;
  submission_note: string | null;
  return_reason: string | null;
  returns: number;
  reminders: number;
  last_reminder_at: number | null;
  escalated_at: number | null;
  cancel_reason: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
  opened_at: number | null;
  accepted_at: number | null;
  submitted_at: number | null;
  done_at: number | null;
  done_by: string | null;
}

export interface TaskEvent {
  at: number;
  actorId: string | null;
  kind: string;
  detail: Record<string, unknown>;
}

export interface NewTask {
  orgId: string;
  title: string;
  instructions: string;
  deliverables: string;
  assigneeId: string;
  createdBy: string;
  installId: string | null;
  jobId: string | null;
  conversationId: string | null;
  priority: TaskPriority;
  dueAt: number | null;
  dependsOn: string[];
  referenceFiles: string[];
}

/** Which states each change may start from, and the state it leads to. */
const MOVES = {
  accept: { from: ["open"], to: "accepted" },
  start: { from: ["open", "accepted", "blocked"], to: "in_progress" },
  block: { from: ["open", "accepted", "in_progress"], to: "blocked" },
  submit: { from: ["accepted", "in_progress", "blocked"], to: "submitted" },
  approve: { from: ["submitted"], to: "done" },
  return: { from: ["submitted"], to: "in_progress" },
} as const satisfies Record<string, { from: readonly TaskState[]; to: TaskState }>;
export type TaskMove = keyof typeof MOVES;
/** Each change as its event, and in "can't be …" messages. */
const PAST: Record<TaskMove, string> = { accept: "accepted", start: "started", block: "blocked", submit: "submitted", approve: "approved", return: "returned" };

export class TaskStore {
  constructor(
    private readonly db: DB,
    private readonly clock: () => number,
  ) {}

  get(id: string): TaskRow | null {
    return (this.db.prepare("SELECT * FROM ai_tasks WHERE id = ?").get(id) as TaskRow | undefined) ?? null;
  }

  insert(t: NewTask): TaskRow {
    const id = newId("tsk");
    const now = this.clock();
    const waiting = t.dependsOn.length > 0;
    this.db
      .prepare(
        `INSERT INTO ai_tasks (id, org_id, title, instructions, deliverables, assignee_id, created_by, install_id, job_id, conversation_id, priority, state,
                               depends_on, reference_files, due_at, created_at, updated_at, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.orgId,
        t.title,
        t.instructions,
        t.deliverables,
        t.assigneeId,
        t.createdBy,
        t.installId,
        t.jobId,
        t.conversationId,
        t.priority,
        waiting ? "waiting" : "open",
        JSON.stringify(t.dependsOn),
        JSON.stringify(t.referenceFiles),
        t.dueAt,
        now,
        now,
        waiting ? null : now,
      );
    this.event(id, t.createdBy, "created", { assignee: t.assigneeId, by: t.installId ? "agent" : "person", waitingOn: t.dependsOn.length });
    return this.get(id)!;
  }

  /** A state change by [actor], if the task is still at [rev] and in a state the change may start from. */
  move(id: string, rev: number, move: TaskMove, actor: string, patch: { reason?: string; note?: string } = {}): TaskRow {
    const m = MOVES[move];
    const now = this.clock();
    const sets: Record<TaskMove, string> = {
      accept: "accepted_at = ?",
      start: "blocked_reason = NULL, accepted_at = COALESCE(accepted_at, ?)",
      block: "blocked_reason = ?",
      submit: "submission_note = ?, submitted_at = ?",
      approve: "done_at = ?, done_by = ?",
      return: "return_reason = ?, returns = returns + 1",
    };
    const args: Record<TaskMove, unknown[]> = {
      accept: [now],
      start: [now],
      block: [patch.reason ?? null],
      submit: [patch.note ?? null, now],
      approve: [now, actor],
      return: [patch.reason ?? null],
    };
    const changes = this.db
      .prepare(`UPDATE ai_tasks SET state = ?, ${sets[move]}, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ? AND state IN (${m.from.map(() => "?").join(",")})`)
      .run(m.to, ...args[move], now, id, rev, ...m.from).changes;
    if (!changes) {
      const cur = this.get(id);
      if (cur && cur.rev !== rev) throw new ApiError(409, "conflict", "Someone changed this task meanwhile. Reload and try again.");
      throw new ApiError(409, "conflict", `This task is ${cur?.state.replace("_", " ") ?? "gone"}: it can't be ${PAST[move]} now.`);
    }
    this.event(id, actor, PAST[move], { ...(patch.reason ? { reason: patch.reason } : {}), ...(patch.note ? { note: patch.note } : {}) });
    return this.get(id)!;
  }

  cancel(id: string, actor: string | null, reason: string): TaskRow | null {
    const now = this.clock();
    const changes = this.db
      .prepare("UPDATE ai_tasks SET state = 'cancelled', cancel_reason = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND state NOT IN ('done', 'cancelled')")
      .run(reason, now, id).changes;
    if (!changes) return null;
    this.event(id, actor, "cancelled", { reason });
    return this.get(id);
  }

  reassign(id: string, rev: number, actor: string, assigneeId: string): TaskRow {
    const now = this.clock();
    const changes = this.db
      .prepare(
        `UPDATE ai_tasks SET assignee_id = ?, state = CASE WHEN state = 'waiting' THEN 'waiting' ELSE 'open' END, accepted_at = NULL, blocked_reason = NULL,
           reminders = 0, last_reminder_at = NULL, escalated_at = NULL, rev = rev + 1, updated_at = ?
         WHERE id = ? AND rev = ? AND state NOT IN ('submitted', 'done', 'cancelled')`,
      )
      .run(assigneeId, now, id, rev).changes;
    if (!changes) throw new ApiError(409, "conflict", "This task changed meanwhile, or is submitted or finished: it can't be reassigned now.");
    this.event(id, actor, "reassigned", { assignee: assigneeId });
    return this.get(id)!;
  }

  /** Waiting tasks whose dependencies are now finished or failed (the worker opens or cancels them). */
  waiting(limit = 100): TaskRow[] {
    return this.db.prepare("SELECT * FROM ai_tasks WHERE state = 'waiting' ORDER BY created_at LIMIT ?").all(limit) as TaskRow[];
  }

  open(id: string, referenceFiles: string[]): TaskRow | null {
    const now = this.clock();
    const changes = this.db
      .prepare("UPDATE ai_tasks SET state = 'open', reference_files = ?, opened_at = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND state = 'waiting'")
      .run(JSON.stringify(referenceFiles), now, now, id).changes;
    if (!changes) return null;
    this.event(id, null, "opened", { references: referenceFiles.length });
    return this.get(id);
  }

  /** Active tasks due before [before] (or overdue) not reminded since [remindedBefore]. */
  dueForReminder(before: number, remindedBefore: number, limit = 100): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ai_tasks WHERE state IN ('open', 'accepted', 'in_progress', 'blocked') AND due_at IS NOT NULL AND due_at <= ?
           AND (last_reminder_at IS NULL OR last_reminder_at <= ?) ORDER BY due_at LIMIT ?`,
      )
      .all(before, remindedBefore, limit) as TaskRow[];
  }

  reminded(id: string, escalate: boolean): void {
    const now = this.clock();
    this.db
      .prepare("UPDATE ai_tasks SET reminders = reminders + 1, last_reminder_at = ?, escalated_at = CASE WHEN ? THEN ? ELSE escalated_at END WHERE id = ?")
      .run(now, escalate ? 1 : 0, now, id);
    this.event(id, null, escalate ? "escalated" : "reminded", {});
  }

  list(f: { orgId: string; assigneeId?: string; jobId?: string; states?: readonly TaskState[]; before?: number }, limit: number): TaskRow[] {
    const where = ["org_id = ?"];
    const args: unknown[] = [f.orgId];
    if (f.assigneeId) (where.push("assignee_id = ?"), args.push(f.assigneeId));
    if (f.jobId) (where.push("job_id = ?"), args.push(f.jobId));
    if (f.states?.length) (where.push(`state IN (${f.states.map(() => "?").join(",")})`), args.push(...f.states));
    if (f.before) (where.push("created_at < ?"), args.push(f.before));
    return this.db.prepare(`SELECT * FROM ai_tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...args, limit) as TaskRow[];
  }

  /** Active tasks per person, for choosing who has the least work. */
  load(orgId: string, userIds: readonly string[]): Map<string, number> {
    if (!userIds.length) return new Map();
    const rows = this.db
      .prepare(
        `SELECT assignee_id u, COUNT(*) n FROM ai_tasks WHERE org_id = ? AND state IN (${TASK_ACTIVE.map(() => "?").join(",")})
           AND assignee_id IN (${userIds.map(() => "?").join(",")}) GROUP BY assignee_id`,
      )
      .all(orgId, ...TASK_ACTIVE, ...userIds) as { u: string; n: number }[];
    return new Map(rows.map((r) => [r.u, r.n]));
  }

  /** Counts for the workforce report: by state, overdue, and active per person. */
  summary(orgId: string, now: number): { byState: Record<string, number>; overdue: number; byAssignee: { userId: string; active: number; overdue: number }[] } {
    const byState = Object.fromEntries(
      (this.db.prepare("SELECT state, COUNT(*) n FROM ai_tasks WHERE org_id = ? GROUP BY state").all(orgId) as { state: string; n: number }[]).map((r) => [r.state, r.n]),
    );
    const active = TASK_ACTIVE.filter((s) => s !== "submitted");
    const people = this.db
      .prepare(
        `SELECT assignee_id userId, SUM(state IN (${TASK_ACTIVE.map(() => "?").join(",")})) active,
                SUM(state IN (${active.map(() => "?").join(",")}) AND due_at IS NOT NULL AND due_at < ?) overdue
           FROM ai_tasks WHERE org_id = ? GROUP BY assignee_id HAVING active > 0 ORDER BY overdue DESC, active DESC LIMIT 50`,
      )
      .all(...TASK_ACTIVE, ...active, now, orgId) as { userId: string; active: number; overdue: number }[];
    return { byState, overdue: people.reduce((n, p) => n + p.overdue, 0), byAssignee: people };
  }

  event(taskId: string, actorId: string | null, kind: string, detail: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO ai_task_events (task_id, at, actor_id, kind, detail) VALUES (?, ?, ?, ?, ?)").run(taskId, this.clock(), actorId, kind, JSON.stringify(detail));
  }

  events(taskId: string): TaskEvent[] {
    return (this.db.prepare("SELECT at, actor_id, kind, detail FROM ai_task_events WHERE task_id = ? ORDER BY id").all(taskId) as { at: number; actor_id: string | null; kind: string; detail: string }[]).map((e) => ({
      at: e.at,
      actorId: e.actor_id,
      kind: e.kind,
      detail: JSON.parse(e.detail) as Record<string, unknown>,
    }));
  }

  settings(orgId: string): { roles: string[]; users: string[]; updatedAt: number | null } {
    const r = this.db.prepare("SELECT roles, users, updated_at FROM ai_task_settings WHERE org_id = ?").get(orgId) as { roles: string; users: string; updated_at: number } | undefined;
    return r ? { roles: JSON.parse(r.roles) as string[], users: JSON.parse(r.users) as string[], updatedAt: r.updated_at } : { roles: [], users: [], updatedAt: null };
  }

  setSettings(orgId: string, roles: string[], users: string[], actor: string): void {
    this.db
      .prepare(
        `INSERT INTO ai_task_settings (org_id, roles, users, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id) DO UPDATE SET roles = excluded.roles, users = excluded.users, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(orgId, JSON.stringify(roles), JSON.stringify(users), actor, this.clock());
  }
}
