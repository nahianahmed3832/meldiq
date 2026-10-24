import { ApiError } from "../../shared/errors.js";
import { namesOf } from "../accounts/index.js";
import { orgMemberIds } from "../organizations/index.js";
import type { Deps } from "./access.js";
import type { JobRow } from "./jobs.js";
import { TASK_TERMINAL, type TaskMove, type TaskPriority, type TaskRow, type TaskState, type TaskStore } from "./taskStore.js";
import type { TaskAssignArgs } from "./types.js";

/**
 * Human tasks (docs/AI_WORKFORCE_2_PLAN.md, phase 4): who may do what to a task, the Agent Manager's assignments, and
 * the worker's part (opening tasks whose agent steps finished, reminders, escalation). Only the assignee accepts,
 * starts, blocks or submits; only the creator or someone with "Manage AI agents" (never the assignee) approves,
 * returns, cancels or reassigns. Nothing is ever marked done without a person's submission and a reviewer's approval.
 */
export type TaskDeps = Deps & { tasks: TaskStore };

const HOUR_MS = 3_600_000;
/** Reminders start this long before a task is due, and repeat at most this often. */
const REMIND_AHEAD_MS = 24 * HOUR_MS;
const REMIND_EVERY_MS = 24 * HOUR_MS;
/** After this many reminders on an overdue task, its creator is told once. */
const REMINDERS_BEFORE_ESCALATION = 2;
/** A plan's task is due at most this far ahead (the Manager's own request waits that long at most). */
export const MAX_DUE_HOURS = 168;

export type TaskAction = TaskMove | "cancel" | "reassign";

export interface TaskActionBody {
  rev: number;
  reason?: string;
  note?: string;
  fileIds?: string[];
  assigneeId?: string;
}

export class TaskService {
  constructor(private readonly d: TaskDeps) {}

  private get ctx() {
    return this.d.ctx;
  }

  private manages(orgId: string, userId: string): boolean {
    return this.ctx.authz.can(orgId, userId, "ai.manage");
  }

  /** The task if [userId] may see it: its assignee, its creator, or someone with "Manage AI agents". */
  visible(orgId: string, taskId: string, userId: string): TaskRow {
    const t = this.d.tasks.get(taskId);
    const ok = t !== null && t.org_id === orgId && this.ctx.authz.orgRole(orgId, userId) !== null && (t.assignee_id === userId || t.created_by === userId || this.manages(orgId, userId));
    if (!ok) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
    return t;
  }

  /** What [userId] may do to [t] now (the client shows only these; the server checks them again). */
  allowed(t: TaskRow, userId: string): Record<TaskAction, boolean> {
    const assignee = t.assignee_id === userId;
    const reviewer = !assignee && (t.created_by === userId || this.manages(t.org_id, userId));
    const s = t.state;
    return {
      accept: assignee && s === "open",
      start: assignee && (s === "open" || s === "accepted" || s === "blocked"),
      block: assignee && (s === "open" || s === "accepted" || s === "in_progress"),
      submit: assignee && (s === "accepted" || s === "in_progress" || s === "blocked"),
      approve: reviewer && s === "submitted",
      return: reviewer && s === "submitted",
      cancel: (t.created_by === userId || this.manages(t.org_id, userId)) && !TASK_TERMINAL.has(s),
      reassign: (t.created_by === userId || this.manages(t.org_id, userId)) && !TASK_TERMINAL.has(s) && s !== "submitted",
    };
  }

  private requireMember(orgId: string, userId: string, what: string): void {
    if (this.ctx.authz.orgRole(orgId, userId) === null || this.ctx.authz.isBanned(orgId, userId)) throw new ApiError(400, "bad_request", `${what} isn't a member of this community.`);
  }

  /** A task a person with "Manage AI agents" creates by hand. */
  create(orgId: string, userId: string, b: { title: string; instructions: string; deliverables: string; assigneeId: string; dueAt: number | null; priority: TaskPriority; conversationId: string | null }): TaskRow {
    this.ctx.authz.requirePermission(orgId, userId, "ai.manage", 'Assigning work needs the "Manage AI agents" permission.');
    this.requireMember(orgId, b.assigneeId, "The person");
    if (b.dueAt !== null && b.dueAt <= this.d.clock()) throw new ApiError(400, "bad_request", "The due time has to be in the future.");
    if (b.conversationId) {
      const conv = this.ctx.authz.conversation(b.conversationId);
      if (!conv || conv.org_id !== orgId) throw new ApiError(400, "bad_request", "That channel isn't in this community.");
    }
    const t = this.d.tasks.insert({ ...b, orgId, createdBy: userId, installId: null, jobId: null, dependsOn: [], referenceFiles: [] });
    this.notify(t, [t.assignee_id]);
    return t;
  }

  act(orgId: string, taskId: string, userId: string, action: TaskAction, b: TaskActionBody): TaskRow {
    const t = this.visible(orgId, taskId, userId);
    if (!this.allowed(t, userId)[action]) {
      const assigneeOnly = action === "accept" || action === "start" || action === "block" || action === "submit";
      throw new ApiError(assigneeOnly ? 403 : t.assignee_id === userId ? 403 : 409, assigneeOnly || t.assignee_id === userId ? "forbidden" : "conflict", assigneeOnly ? "Only the person it's assigned to can do that." : t.assignee_id === userId ? "Someone else reviews your own work." : `This task is ${t.state.replace("_", " ")}: that isn't possible now.`);
    }
    let next: TaskRow;
    if (action === "cancel") {
      next = this.d.tasks.cancel(t.id, userId, b.reason ?? "Cancelled.") ?? t;
    } else if (action === "reassign") {
      if (!b.assigneeId) throw new ApiError(400, "bad_request", "Name the person to reassign it to.");
      this.requireMember(orgId, b.assigneeId, "The person");
      next = this.d.tasks.reassign(t.id, b.rev, userId, b.assigneeId);
    } else {
      if ((action === "block" || action === "return") && !b.reason?.trim()) throw new ApiError(400, "bad_request", action === "block" ? "Say what's blocking it." : "Say what needs changing.");
      if (action === "submit") this.attachSubmission(t, userId, b);
      next = this.d.tasks.move(t.id, b.rev, action, userId, { reason: b.reason?.trim(), note: b.note?.trim() });
    }
    // The assignee hears about decisions on their work; the creator hears about progress on theirs.
    const toAssignee = action === "approve" || action === "return" || action === "cancel" || action === "reassign";
    this.notify(next, toAssignee ? [next.assignee_id, ...(action === "reassign" ? [t.assignee_id] : [])] : [next.created_by]);
    if (action === "submit" || action === "block" || action === "approve") this.announce(next, this.line(next, action));
    return next;
  }

  /** A submission is evidence: a note, files, or both; files are the assignee's own uploads, not used anywhere yet. */
  private attachSubmission(t: TaskRow, userId: string, b: TaskActionBody): void {
    const fileIds = [...new Set(b.fileIds ?? [])];
    if (!b.note?.trim() && fileIds.length === 0) throw new ApiError(400, "bad_request", "Hand in what you did: a note, files, or both.");
    const attach = this.ctx.db.prepare("UPDATE ai_files SET task_id = ? WHERE id = ? AND org_id = ? AND uploaded_by = ? AND role = 'input' AND job_id IS NULL AND task_id IS NULL AND deleted_at IS NULL");
    this.ctx.db.transaction(() => {
      for (const id of fileIds) {
        if (!attach.run(t.id, id, t.org_id, userId).changes) throw new ApiError(400, "bad_request", "A file isn't yours, is already used elsewhere, or is gone. Upload it again.");
      }
    })();
  }

  // ───────────── The Agent Manager ─────────────

  /** People the Manager may assign work to in [orgId] (members named in the settings or holding a named role). */
  eligible(orgId: string): { userId: string; roles: string[] }[] {
    const s = this.d.tasks.settings(orgId);
    if (!s.roles.length && !s.users.length) return [];
    const named = new Set(s.users);
    const roles = new Set(s.roles);
    return orgMemberIds(this.ctx.db, orgId)
      .filter((u) => !this.ctx.authz.isBanned(orgId, u))
      .map((u) => ({ userId: u, assigned: this.ctx.authz.assignedRoles(orgId, u) }))
      .filter((p) => named.has(p.userId) || p.assigned.some((r) => roles.has(r.id)))
      .map((p) => ({ userId: p.userId, roles: p.assigned.filter((r) => roles.has(r.id)).map((r) => r.name) }));
  }

  /** What the Manager may know before planning: null when the person asking can't assign work. */
  people(job: JobRow): { eligible: number; roles: string[] } | null {
    if (!this.manages(job.org_id, job.requested_by)) return null;
    const people = this.eligible(job.org_id);
    return { eligible: people.length, roles: [...new Set(people.flatMap((p) => p.roles))].sort() };
  }

  /**
   * A plan's person step: the requester must be allowed to assign work; the assignee is chosen here (preferring the
   * role named, then the least active tasks), never by a model. Steps it depends on must be the same plan's.
   */
  createForJob(job: JobRow, installId: string, a: TaskAssignArgs): { task: TaskRow; assigneeName: string } {
    if (!this.manages(job.org_id, job.requested_by)) throw new ApiError(403, "forbidden", 'Only someone who may "Manage AI agents" can have the Agent Manager assign work to people.');
    const people = this.eligible(job.org_id);
    if (!people.length) throw new ApiError(409, "agent_unavailable", "Nobody may be assigned work by the Agent Manager yet: choose people or roles in AI agents › Tasks.");
    const hint = a.role?.trim().toLowerCase() ?? "";
    const preferred = hint ? people.filter((p) => p.roles.some((r) => r.toLowerCase() === hint)) : [];
    const pool = preferred.length ? preferred : people;
    const load = this.d.tasks.load(job.org_id, pool.map((p) => p.userId));
    const chosen = [...pool].sort((x, y) => (load.get(x.userId) ?? 0) - (load.get(y.userId) ?? 0) || x.userId.localeCompare(y.userId))[0]!;
    const siblings = new Set(this.d.jobs.children(job.id).map((c) => c.id));
    if (!a.dependsOn.every((id) => siblings.has(id))) throw new ApiError(400, "bad_request", "A task can only wait for steps of the same plan.");
    const hours = Math.min(Math.max(1, Math.round(a.dueInHours)), MAX_DUE_HOURS);
    const task = this.d.tasks.insert({
      orgId: job.org_id,
      title: a.title.slice(0, 120),
      instructions: a.instructions.slice(0, 4000),
      deliverables: a.deliverables.slice(0, 1000),
      assigneeId: chosen.userId,
      createdBy: job.requested_by,
      installId,
      jobId: job.id,
      conversationId: job.conversation_id,
      priority: a.priority,
      dueAt: this.d.clock() + hours * HOUR_MS,
      dependsOn: a.dependsOn,
      referenceFiles: [],
    });
    const name = this.name(chosen.userId);
    if (task.state === "open") this.opened(task);
    return { task, assigneeName: name };
  }

  /** The tasks [job] created, as the Manager may read them: state, who, and what they handed in. */
  ofJob(job: JobRow): { taskId: string; title: string; state: string; assignee: string; note: string | null; fileIds: string[] }[] {
    return this.d.tasks.list({ orgId: job.org_id, jobId: job.id }, 50).map((t) => ({
      taskId: t.id,
      title: t.title,
      state: t.state,
      assignee: this.name(t.assignee_id),
      note: t.state === "done" ? t.submission_note : null,
      fileIds: t.state === "done" ? this.d.files.ofTasks([t.id]).map((f) => f.id) : [],
    }));
  }

  // ───────────── The worker ─────────────

  /** Opens waiting tasks whose agent steps completed (cancels those whose steps failed); sends reminders. */
  tick(): void {
    for (const t of this.d.tasks.waiting()) {
      const deps = JSON.parse(t.depends_on) as string[];
      const states = deps.map((id) => this.d.jobs.get(id)?.state ?? "missing");
      if (states.some((s) => s === "failed" || s === "cancelled" || s === "missing")) {
        const c = this.d.tasks.cancel(t.id, null, "An agent step it waited for didn't finish.");
        if (c) this.notify(c, [c.created_by]);
      } else if (states.every((s) => s === "completed")) {
        const refs = this.d.files.ofJobs(deps, "artifact").filter((f) => f.approval_state !== "superseded" && f.approval_state !== "rejected").map((f) => f.id);
        const o = this.d.tasks.open(t.id, refs);
        if (o) this.opened(o);
      }
    }
    const now = this.d.clock();
    for (const t of this.d.tasks.dueForReminder(now + REMIND_AHEAD_MS, now - REMIND_EVERY_MS)) {
      const overdue = t.due_at !== null && t.due_at < now;
      const escalate = overdue && t.reminders >= REMINDERS_BEFORE_ESCALATION && t.escalated_at === null;
      this.d.tasks.reminded(t.id, escalate);
      this.notify(t, escalate ? [t.assignee_id, t.created_by] : [t.assignee_id]);
      this.announce(t, escalate ? `${this.name(t.assignee_id)}'s task "${t.title}" is overdue; ${this.name(t.created_by)} has been told.` : `Reminder for ${this.name(t.assignee_id)}: "${t.title}" is ${overdue ? "overdue" : "due soon"}.`);
    }
  }

  private opened(t: TaskRow): void {
    this.notify(t, [t.assignee_id]);
    this.announce(t, `New task for ${this.name(t.assignee_id)}: "${t.title}"${t.due_at ? `, due ${new Date(t.due_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}.`);
  }

  private line(t: TaskRow, action: TaskAction): string {
    const who = this.name(t.assignee_id);
    if (action === "submit") return `${who} handed in "${t.title}" for review.`;
    if (action === "block") return `${who} is blocked on "${t.title}": ${t.blocked_reason ?? ""}`;
    return `"${t.title}" is done (accepted by ${this.name(t.done_by ?? "")}).`;
  }

  /** In the request's channel, as the agent that created the task (only Agent Manager tasks have a channel voice). */
  private announce(t: TaskRow, body: string): void {
    if (!t.conversation_id || !t.install_id || !this.d.store.assignment(t.install_id, t.conversation_id)) return;
    this.d.posts.add({ orgId: t.org_id, conversationId: t.conversation_id, threadRoot: null, installId: t.install_id, jobId: t.job_id, kind: "progress", body });
  }

  private notify(t: TaskRow, users: string[]): void {
    this.ctx.hub.sendToUsers(new Set(users.filter(Boolean)), { t: "ai.task", orgId: t.org_id, taskId: t.id });
  }

  private name(userId: string): string {
    const n = namesOf(this.ctx.db, [userId])[0];
    return n?.displayName || n?.username || "someone";
  }

  names(userIds: string[]): Map<string, string> {
    return new Map(namesOf(this.ctx.db, [...new Set(userIds)]).map((n) => [n.id, n.displayName || n.username]));
  }

  // ───────────── Settings ─────────────

  setSettings(orgId: string, userId: string, roles: string[], users: string[]): void {
    this.ctx.authz.requirePermission(orgId, userId, "ai.manage", 'Changing who agents may assign work to needs the "Manage AI agents" permission.');
    for (const r of roles) if (!this.ctx.authz.roleGrant(r, orgId)) throw new ApiError(400, "bad_request", "A role isn't one of this community's.");
    for (const u of users) this.requireMember(orgId, u, "A person");
    this.d.tasks.setSettings(orgId, [...new Set(roles)], [...new Set(users)], userId);
    this.ctx.audit({ actorId: userId, orgId, action: "ai.task_settings", target: orgId, detail: `${roles.length} roles, ${users.length} people` });
  }

  /** Overdue: due and not handed in (a submitted task waits for its reviewer, not its assignee). */
  static overdue(t: TaskRow, now: number): boolean {
    const owed: readonly TaskState[] = ["open", "accepted", "in_progress", "blocked"];
    return t.due_at !== null && t.due_at < now && owed.includes(t.state);
  }
}
