import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  AiAnswerBody,
  AiApprovalParams,
  AiChannelBody,
  AiChannelParams,
  AiConversationParams,
  AiDecisionBody,
  AiDeliverablesQuery,
  AiFileParams,
  AiInstallBody,
  AiInstallParams,
  AiInstallPatch,
  AiJobBody,
  AiJobParams,
  AiJobsQuery,
  AiOrgParams,
  AiPostsQuery,
  AiReviseBody,
  AiUploadQuery,
} from "../../shared/contracts/http/aiWorkforce.js";
import { ApiError } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";
import { scopesFor } from "../quotas/index.js";
import { channelRefusal } from "./access.js";
import { findAgent } from "./catalog/index.js";
import { type AiFileRow, INLINE_MIMES, MAX_INPUT_BYTES } from "./files.js";
import type { JobState } from "./jobs.js";
import { mediaEngine } from "./media.js";
import { agentSummary } from "./service.js";
import { TOOL_INFO } from "./toolInfo.js";
import { isToolKey } from "./types.js";
import { approvalView, fileView, installView, jobDetail, jobSummary, postView } from "./views.js";
import type { WorkforceModule } from "./index.js";
import { automationRoutes } from "./automationRoutes.js";
import { skillRoutes } from "./skillRoutes.js";
import { taskRoutes } from "./taskRoutes.js";
import { readerRoutes } from "./reader/routes.js";

/**
 * AI Workforce for communities (docs/AI_WORKFORCE.md): /v1/orgs/:orgId/ai/* and /v1/conversations/:id/ai/*. Who may
 * do what: members with `ai.use` ask agents; `ai.manage` installs and configures them; `ai.approve` approves. Every
 * answer about a job, file or post checks access again; unknown and invisible look the same (404).
 */
export default async function workforceRoutes(app: FastifyInstance, ctx: AppContext, w: WorkforceModule) {
  const auth = { preHandler: requireAuth(ctx) };
  const limited = (max: number) => ({ preHandler: requireAuth(ctx), config: { rateLimit: { max, timeWindow: "1 minute" } } });
  const svc = w.service;

  const member = (orgId: string, userId: string) => {
    if (!ctx.authz.orgRole(orgId, userId)) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
  };
  const manage = (orgId: string, userId: string) => ctx.authz.requirePermission(orgId, userId, "ai.manage", "Managing AI agents needs the \"Manage AI agents\" permission.");
  const perms = (orgId: string, userId: string) => ({
    canUse: ctx.authz.can(orgId, userId, "ai.use"),
    canManage: ctx.authz.can(orgId, userId, "ai.manage"),
    canApprove: ctx.authz.can(orgId, userId, "ai.approve"),
  });
  const installOut = (orgId: string, installId: string) => {
    const i = w.store.install(installId);
    if (!i || i.orgId !== orgId || i.state === "uninstalled") throw new ApiError(404, "not_found", "No such agent in this community.");
    return i;
  };

  app.get("/v1/orgs/:orgId/ai", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    const ent = w.store.entitlement(orgId);
    const media = await mediaEngine();
    return {
      enabled: w.settings.enabled() && ent.enabled,
      paused: w.settings.paused(),
      aiRequestsOn: ctx.ai.enabled,
      approvalFloor: w.settings.approvalFloor(),
      mediaEngine: { available: media.available, detail: media.detail },
      permissions: perms(orgId, userId),
      agents: w.store.installsOf(orgId).map((i) => installView(i, svc.mode(i))),
      notice: "What you send to AI agents and what they make isn't end-to-end encrypted: it's processed on Meldiq's servers and by the AI provider the platform uses.",
    };
  });

  app.get("/v1/orgs/:orgId/ai/catalog", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    return { agents: await svc.catalog(orgId) };
  });

  app.post("/v1/orgs/:orgId/ai/agents", limited(30), async (req, reply) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    manage(orgId, userId);
    const b = parse(AiInstallBody, req.body);
    const i = svc.install(orgId, b.agentId, userId, b);
    reply.code(201);
    return { agent: installView(i, svc.mode(i)) };
  });

  app.get("/v1/orgs/:orgId/ai/agents/:installId", auth, async (req) => {
    const { userId } = me(req);
    const { orgId, installId } = parse(AiInstallParams, req.params);
    member(orgId, userId);
    const i = installOut(orgId, installId);
    const def = findAgent(i.agentId, i.version);
    const latest = findAgent(i.agentId);
    const canManage = ctx.authz.can(orgId, userId, "ai.manage");
    return {
      agent: installView(i, svc.mode(i)),
      definition: def ? agentSummary(def) : null,
      upgrade: latest && def && latest.version > def.version && svc.availability(orgId, latest) === null ? { version: latest.version } : null,
      setup: def ? await svc.setup(orgId, def) : null,
      channels: w.store.channelsOf(i.id).filter((c) => canManage || channelRefusal(ctx, orgId, c.conversationId, userId) === null),
      tools: def
        ? svc.grantable(orgId, def).map((t) => ({ key: t, label: TOOL_INFO[t].label, description: TOOL_INFO[t].description, risk: TOOL_INFO[t].risk, platformMode: w.store.toolPolicies()[t], granted: i.tools.includes(t), required: def.skill.requiredTools.includes(t), connected: TOOL_INFO[t].risk !== "external" }))
        : [],
      permissions: perms(orgId, userId),
    };
  });

  app.patch("/v1/orgs/:orgId/ai/agents/:installId", limited(60), async (req) => {
    const { userId } = me(req);
    const { orgId, installId } = parse(AiInstallParams, req.params);
    manage(orgId, userId);
    const b = parse(AiInstallPatch, req.body);
    const tools = b.tools?.map((t) => {
      if (!isToolKey(t)) throw new ApiError(400, "bad_request", `Unknown tool ${t}.`);
      return t;
    });
    const i = svc.update(orgId, installId, userId, b.rev, { ...b, tools });
    return { agent: installView(i, svc.mode(i)) };
  });

  app.put("/v1/orgs/:orgId/ai/agents/:installId/avatar", limited(10), async (req) => {
    const { userId } = me(req);
    const { orgId, installId } = parse(AiInstallParams, req.params);
    manage(orgId, userId);
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== "function") throw new ApiError(400, "bad_request", "Expected application/octet-stream body");
    const parts: Buffer[] = [];
    let n = 0;
    for await (const c of body) {
      n += (c as Buffer).length;
      if (n > 512 * 1024) throw new ApiError(413, "too_large", "An avatar can be up to 512 KB.");
      parts.push(c as Buffer);
    }
    const i = await svc.setAvatar(orgId, installId, userId, Buffer.concat(parts));
    return { agent: installView(i, svc.mode(i)) };
  });

  app.get("/v1/orgs/:orgId/ai/agents/:installId/avatar", auth, async (req, reply) => {
    const { userId } = me(req);
    const { orgId, installId } = parse(AiInstallParams, req.params);
    member(orgId, userId);
    const f = await svc.avatar(orgId, installId);
    if (!f) throw new ApiError(404, "not_found", "This agent has no avatar.");
    return sendFile(reply, f, false);
  });

  app.delete("/v1/orgs/:orgId/ai/agents/:installId", limited(30), async (req) => {
    const { userId } = me(req);
    const { orgId, installId } = parse(AiInstallParams, req.params);
    manage(orgId, userId);
    svc.uninstall(orgId, installId, userId);
    return { removed: true };
  });

  app.put("/v1/orgs/:orgId/ai/agents/:installId/channels/:conversationId", limited(60), async (req) => {
    const { userId } = me(req);
    const { orgId, installId, conversationId } = parse(AiChannelParams, req.params);
    manage(orgId, userId);
    const { activation } = parse(AiChannelBody, req.body ?? {});
    svc.assign(orgId, installId, conversationId, activation, userId);
    return { channels: w.store.channelsOf(installId) };
  });

  app.delete("/v1/orgs/:orgId/ai/agents/:installId/channels/:conversationId", limited(60), async (req) => {
    const { userId } = me(req);
    const { orgId, installId, conversationId } = parse(AiChannelParams, req.params);
    manage(orgId, userId);
    svc.unassign(orgId, installId, conversationId, userId);
    return { channels: w.store.channelsOf(installId) };
  });

  app.post("/v1/orgs/:orgId/ai/files", limited(30), async (req, reply) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    const q = parse(AiUploadQuery, req.query);
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== "function") throw new ApiError(400, "bad_request", "Expected application/octet-stream body");
    const declared = Number(req.headers["content-length"] ?? Number.NaN);
    const f = await svc.upload(orgId, userId, q.name, q.type, Math.min(declared, MAX_INPUT_BYTES + 1), body);
    reply.code(201);
    return { file: fileView(f) };
  });

  app.post("/v1/orgs/:orgId/ai/jobs", limited(30), async (req, reply) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    const b = parse(AiJobBody, req.body);
    const header = req.headers["idempotency-key"];
    const job = svc.createJob({ orgId, installId: b.installId, userId, input: b.input, conversationId: b.conversationId, threadRoot: b.threadRoot, fileIds: b.fileIds, idempotencyKey: b.idempotencyKey ?? (typeof header === "string" ? header.slice(0, 100) : null), requestText: b.requestText, channelMessages: b.channelMessages });
    reply.code(202);
    return { job: jobDetail(w, job) };
  });

  app.get("/v1/orgs/:orgId/ai/jobs", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    const q = parse(AiJobsQuery, req.query);
    const all = q.scope === "all" && ctx.authz.can(orgId, userId, "ai.manage");
    const rows = w.jobs.list({ orgId, userId: all ? undefined : userId, installId: q.installId, state: q.state as JobState | undefined, rootOnly: true, before: q.before }, q.limit);
    return { jobs: rows.map((j) => jobSummary(w, j)), next: rows.length === q.limit ? rows[rows.length - 1]!.created_at : null };
  });

  app.get("/v1/orgs/:orgId/ai/jobs/:jobId", auth, async (req) => {
    const { userId } = me(req);
    const { orgId, jobId } = parse(AiJobParams, req.params);
    return { job: jobDetail(w, svc.visibleJob(orgId, jobId, userId)) };
  });

  app.post("/v1/orgs/:orgId/ai/jobs/:jobId/cancel", limited(30), async (req) => {
    const { userId } = me(req);
    const { orgId, jobId } = parse(AiJobParams, req.params);
    return { job: jobSummary(w, svc.cancel(orgId, jobId, userId)) };
  });

  app.post("/v1/orgs/:orgId/ai/jobs/:jobId/retry", limited(30), async (req) => {
    const { userId } = me(req);
    const { orgId, jobId } = parse(AiJobParams, req.params);
    return { job: jobSummary(w, svc.retry(orgId, jobId, userId)) };
  });

  app.post("/v1/orgs/:orgId/ai/jobs/:jobId/revise", limited(30), async (req) => {
    const { userId } = me(req);
    const { orgId, jobId } = parse(AiJobParams, req.params);
    const { note } = parse(AiReviseBody, req.body);
    return { job: jobSummary(w, svc.revise(orgId, jobId, userId, note)) };
  });

  app.post("/v1/orgs/:orgId/ai/jobs/:jobId/answer", limited(30), async (req) => {
    const { userId } = me(req);
    const { orgId, jobId } = parse(AiJobParams, req.params);
    const { text } = parse(AiAnswerBody, req.body);
    return { job: jobSummary(w, svc.answer(orgId, jobId, userId, text)) };
  });

  app.get("/v1/orgs/:orgId/ai/approvals", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    const approver = ctx.authz.can(orgId, userId, "ai.approve");
    // Only approvals of jobs this person can see (an approver isn't shown jobs of private channels they aren't in).
    const visible = (jobId: string) => {
      try {
        svc.visibleJob(orgId, jobId, userId);
        return true;
      } catch {
        return false;
      }
    };
    const rows = w.approvals.pending(orgId).filter((a) => (approver || w.jobs.get(a.job_id)?.requested_by === userId) && visible(a.job_id));
    return { approvals: rows.map(approvalView) };
  });

  app.post("/v1/orgs/:orgId/ai/approvals/:approvalId", limited(30), async (req) => {
    const { userId } = me(req);
    const { orgId, approvalId } = parse(AiApprovalParams, req.params);
    const b = parse(AiDecisionBody, req.body);
    return { job: jobSummary(w, svc.decide(orgId, approvalId, userId, b.decision, b.note)) };
  });

  app.get("/v1/orgs/:orgId/ai/deliverables", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    const q = parse(AiDeliverablesQuery, req.query);
    // Files this person can't read are skipped; scanning continues (up to a bound) so a page isn't cut short.
    const rows: AiFileRow[] = [];
    let before = q.before;
    let exhausted = false;
    for (let round = 0; round < 10 && rows.length < q.limit; round++) {
      const batch = w.files.artifacts(orgId, { installId: q.installId, before }, q.limit * 3);
      for (const f of batch) if (rows.length < q.limit && svc.canRead(f, userId)) rows.push(f);
      if (batch.length < q.limit * 3) {
        exhausted = true;
        break;
      }
      before = batch[batch.length - 1]!.created_at;
    }
    const next = rows.length === q.limit ? rows[rows.length - 1]!.created_at : exhausted ? null : (before ?? null);
    return { files: rows.map(fileView), next };
  });

  app.get("/v1/orgs/:orgId/ai/files/:fileId", auth, async (req, reply) => {
    const { userId } = me(req);
    const { orgId, fileId } = parse(AiFileParams, req.params);
    const f = w.files.row(fileId);
    if (!f || f.org_id !== orgId || f.role === "avatar" || !svc.canRead(f, userId)) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
    // The bytes asked for are charged (a video seeking asks for ranges), as for attachments.
    const asked = range ? Math.max(0, (range[2] === "" ? f.size - 1 : Math.min(Number(range[2]), f.size - 1)) - Number(range[1]) + 1) : f.size;
    const charge = ctx.quotas.charge("files.download_bytes", scopesFor(userId, orgId), asked);
    if (!charge.allowed) throw new ApiError(429, "quota_exceeded", "This community's download allowance is used up for now.");
    return sendFile(reply, f, (req.query as { download?: string } | undefined)?.download === "1", range ? { start: Number(range[1]), end: range[2] === "" ? f.size - 1 : Math.min(Number(range[2]), f.size - 1) } : null);
  });

  app.get("/v1/conversations/:id/ai/agents", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(AiConversationParams, req.params);
    const agents = svc.channelAgents(id, userId);
    const orgId = ctx.authz.conversation(id)!.org_id!;
    return { agents: agents.map((a) => ({ ...installView(a.install, svc.mode(a.install)), activation: a.activation, canInvoke: a.canInvoke })), permissions: perms(orgId, userId) };
  });

  app.get("/v1/conversations/:id/ai/posts", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(AiConversationParams, req.params);
    const conv = ctx.authz.conversation(id);
    // A channel the person can see, or their own direct conversation with an agent.
    const direct = conv?.type === "DM" && ctx.authz.isMember(id, userId) && w.readers.of(id).some((r) => r.mode === "direct");
    if (!direct && (!conv?.org_id || channelRefusal(ctx, conv.org_id, id, userId))) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
    const q = parse(AiPostsQuery, req.query);
    return { posts: w.posts.list(id, { since: q.since, before: q.before }, q.limit).map((p) => postView(w, p)) };
  });

  automationRoutes(app, ctx, w);
  skillRoutes(app, ctx, w);
  taskRoutes(app, ctx, w);
  readerRoutes(app, ctx, w);

  async function sendFile(reply: FastifyReply, f: AiFileRow, download: boolean, range: { start: number; end: number } | null = null) {
    reply.header("cache-control", "private, no-store");
    reply.header("x-content-type-options", "nosniff");
    // Files are shown as files, never as pages of this origin.
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    const inline = !download && INLINE_MIMES.has(f.mime);
    reply.header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    reply.header("content-type", inline || f.mime.startsWith("text/") ? f.mime : "application/octet-stream");
    reply.header("accept-ranges", "bytes");
    if (range) {
      if (range.start >= f.size || range.start > range.end) {
        reply.header("content-range", `bytes */${f.size}`);
        return reply.code(416).send({ error: { code: "range_not_satisfiable", message: "Requested range is outside the file" } });
      }
      const part = await w.files.stream(f, range);
      if (!part) throw new ApiError(404, "not_found", "The file's bytes are missing.");
      reply.code(206);
      reply.header("content-range", `bytes ${range.start}-${range.end}/${f.size}`);
      reply.header("content-length", String(range.end - range.start + 1));
      return reply.send(part);
    }
    const s = await w.files.stream(f);
    if (!s) throw new ApiError(404, "not_found", "The file's bytes are missing.");
    reply.header("content-length", String(f.size));
    return reply.send(s);
  }
}
