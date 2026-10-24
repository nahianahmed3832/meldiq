import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { AiOrgParams, AiTaskActionBody, AiTaskBody, AiTaskParams, AiTaskSettingsBody, AiTasksQuery } from "../../shared/contracts/http/aiWorkforce.js";
import { ApiError } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";
import { type TaskAction, TaskService } from "./taskService.js";
import type { TaskRow } from "./taskStore.js";
import { fileView } from "./views.js";
import type { WorkforceModule } from "./index.js";

/**
 * Human tasks over HTTP (docs/AI_WORKFORCE_2_PLAN.md, phase 4). Everyone sees the tasks assigned to them and the ones
 * they created; people with "Manage AI agents" see all, the workforce report, and who the Agent Manager may assign
 * work to. Each change is checked again by TaskService (who, which state, which version).
 */
const ACTIONS: readonly TaskAction[] = ["accept", "start", "block", "submit", "approve", "return", "cancel", "reassign"];

export function taskRoutes(app: FastifyInstance, ctx: AppContext, w: WorkforceModule): void {
  const auth = { preHandler: requireAuth(ctx) };
  const limited = (max: number) => ({ preHandler: requireAuth(ctx), config: { rateLimit: { max, timeWindow: "1 minute" } } });
  const svc = w.taskService;
  const member = (orgId: string, userId: string) => {
    if (!ctx.authz.orgRole(orgId, userId)) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
  };

  const summary = (t: TaskRow, names: Map<string, string>) => {
    const install = t.install_id ? w.store.install(t.install_id) : null;
    const person = (id: string) => ({ id, name: names.get(id) ?? "someone" });
    return {
      id: t.id,
      title: t.title,
      state: t.state,
      priority: t.priority,
      overdue: TaskService.overdue(t, w.clock()),
      dueAt: t.due_at,
      assignee: person(t.assignee_id),
      createdBy: person(t.created_by),
      agent: install ? { installId: install.id, name: install.displayName } : null,
      jobId: t.job_id,
      updatedAt: t.updated_at,
    };
  };
  const view = (t: TaskRow, userId: string) => {
    const names = svc.names([t.assignee_id, t.created_by, ...(t.done_by ? [t.done_by] : [])]);
    const refs = (JSON.parse(t.reference_files) as string[]).map((id) => w.files.row(id)).filter((f) => f !== null && !f.deleted_at);
    return {
      ...summary(t, names),
      instructions: t.instructions,
      deliverables: t.deliverables,
      conversationId: t.conversation_id,
      blockedReason: t.blocked_reason,
      submissionNote: t.submission_note,
      returnReason: t.return_reason,
      returns: t.returns,
      reminders: t.reminders,
      escalatedAt: t.escalated_at,
      cancelReason: t.cancel_reason,
      rev: t.rev,
      createdAt: t.created_at,
      openedAt: t.opened_at,
      acceptedAt: t.accepted_at,
      submittedAt: t.submitted_at,
      doneAt: t.done_at,
      doneBy: t.done_by ? { id: t.done_by, name: names.get(t.done_by) ?? "someone" } : null,
      files: w.files.ofTasks([t.id]).map(fileView),
      references: refs.map((f) => fileView(f!)),
      can: svc.allowed(t, userId),
    };
  };
  const settingsView = (orgId: string) => {
    const s = w.tasks.settings(orgId);
    const eligible = svc.eligible(orgId);
    const names = svc.names(eligible.map((p) => p.userId));
    return { roles: s.roles, users: s.users, updatedAt: s.updatedAt, eligible: eligible.map((p) => ({ id: p.userId, name: names.get(p.userId) ?? "someone", roles: p.roles })) };
  };

  app.get("/v1/orgs/:orgId/ai/tasks", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    const q = parse(AiTasksQuery, req.query);
    const manages = ctx.authz.can(orgId, userId, "ai.manage");
    if (q.scope === "all" && !manages) throw new ApiError(403, "forbidden", 'Seeing everyone\'s tasks needs the "Manage AI agents" permission.');
    const rows =
      q.scope === "created"
        ? w.tasks.list({ orgId, states: q.state ? [q.state] : undefined, before: q.before }, 500).filter((t) => t.created_by === userId).slice(0, q.limit)
        : w.tasks.list({ orgId, assigneeId: q.scope === "mine" ? userId : undefined, states: q.state ? [q.state] : undefined, before: q.before }, q.limit);
    const names = svc.names(rows.flatMap((t) => [t.assignee_id, t.created_by]));
    let report = null;
    if (q.scope === "all") {
      const r = w.tasks.summary(orgId, w.clock());
      const people = svc.names(r.byAssignee.map((p) => p.userId));
      report = { byState: r.byState, overdue: r.overdue, byAssignee: r.byAssignee.map((p) => ({ person: { id: p.userId, name: people.get(p.userId) ?? "someone" }, active: p.active, overdue: p.overdue })) };
    }
    return { tasks: rows.map((t) => summary(t, names)), next: rows.length === q.limit ? rows[rows.length - 1]!.created_at : null, report };
  });

  app.post("/v1/orgs/:orgId/ai/tasks", limited(30), async (req, reply) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    const t = svc.create(orgId, userId, parse(AiTaskBody, req.body));
    reply.code(201);
    return { task: view(t, userId) };
  });

  app.get("/v1/orgs/:orgId/ai/tasks/settings", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    ctx.authz.requirePermission(orgId, userId, "ai.manage", 'Who agents may assign work to is for people who "Manage AI agents".');
    return { settings: settingsView(orgId) };
  });

  app.put("/v1/orgs/:orgId/ai/tasks/settings", limited(30), async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    const b = parse(AiTaskSettingsBody, req.body);
    svc.setSettings(orgId, userId, b.roles, b.users);
    return { settings: settingsView(orgId) };
  });

  app.get("/v1/orgs/:orgId/ai/tasks/:taskId", auth, async (req) => {
    const { userId } = me(req);
    const { orgId, taskId } = parse(AiTaskParams, req.params);
    const t = svc.visible(orgId, taskId, userId);
    const events = w.tasks.events(t.id);
    const names = svc.names(events.flatMap((e) => (e.actorId ? [e.actorId] : [])));
    return { task: view(t, userId), events: events.map((e) => ({ at: e.at, actor: e.actorId ? { id: e.actorId, name: names.get(e.actorId) ?? "someone" } : null, kind: e.kind, detail: e.detail })) };
  });

  for (const action of ACTIONS) {
    app.post(`/v1/orgs/:orgId/ai/tasks/:taskId/${action}`, limited(60), async (req) => {
      const { userId } = me(req);
      const { orgId, taskId } = parse(AiTaskParams, req.params);
      return { task: view(svc.act(orgId, taskId, userId, action, parse(AiTaskActionBody, req.body)), userId) };
    });
  }
}
