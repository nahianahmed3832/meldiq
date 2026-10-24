import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { AiConversationParams, AiConversationReaderParams, AiInstallParams, AiInstallReaderParams, AiReadScopeBody, AiReaderChoiceBody, AiReaderOffBody, AiReaderOnBody } from "../../../shared/contracts/http/aiWorkforce.js";
import { ApiError } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { namesOf } from "../../accounts/index.js";
import { me, requireAuth } from "../../auth/index.js";
import type { WorkforceModule } from "../index.js";
import { ReaderControl } from "./control.js";
import type { ReaderRow } from "./service.js";

/**
 * Agents reading conversations over HTTP (docs/AI_WORKFORCE_2_PLAN.md phase 5): members see the readers of a
 * conversation and make their own choice; people who manage agents and the channel switch readers on and off; anyone
 * who may use an agent opens a direct conversation with it. Never any content: who, why and when only.
 */
export function readerRoutes(app: FastifyInstance, ctx: AppContext, w: WorkforceModule): void {
  const auth = { preHandler: requireAuth(ctx) };
  const limited = (max: number) => ({ preHandler: requireAuth(ctx), config: { rateLimit: { max, timeWindow: "1 minute" } } });
  const control = new ReaderControl(w);
  const view = (r: ReaderRow) => {
    const by = namesOf(ctx.db, [r.turned_on_by])[0];
    const conv = ctx.authz.conversation(r.conversation_id);
    return {
      readerId: r.id,
      orgId: r.org_id,
      installId: r.install_id,
      agentUserId: w.readers.identity(r.install_id).userId,
      name: w.store.install(r.install_id)?.displayName ?? "AI agent",
      conversationId: r.conversation_id,
      conversationName: conv?.name ?? null,
      mode: r.mode,
      state: r.state,
      since: r.created_at,
      turnedOnBy: { id: r.turned_on_by, name: by?.displayName || by?.username || "someone" },
      reason: r.reason,
    };
  };
  const forMember = (id: string, userId: string) => ({
    readingEnabled: w.readers.enabled,
    readers: w.readers.of(id).map((r) => ({ ...view(r), myChoice: w.readers.choice(r.id, userId) })),
  });
  const member = (id: string, userId: string) => {
    if (!ctx.authz.isMember(id, userId)) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
  };

  app.get("/v1/conversations/:id/ai/readers", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(AiConversationParams, req.params);
    member(id, userId);
    return forMember(id, userId);
  });

  app.put("/v1/conversations/:id/ai/readers/:readerId/choice", limited(60), async (req) => {
    const { userId } = me(req);
    const { id, readerId } = parse(AiConversationReaderParams, req.params);
    member(id, userId);
    const r = w.readers.row(readerId);
    if (!r || r.conversation_id !== id || r.state !== "on") throw new ApiError(404, "not_found", "No such reader here.");
    w.readers.choose(r.id, userId, parse(AiReaderChoiceBody, req.body).choice);
    return forMember(id, userId);
  });

  app.get("/v1/orgs/:orgId/ai/agents/:installId/readers", auth, async (req) => {
    const { userId } = me(req);
    const { orgId, installId } = parse(AiInstallParams, req.params);
    ctx.authz.requirePermission(orgId, userId, "ai.manage", 'Where agents read is for people who "Manage AI agents".');
    const i = w.store.install(installId);
    if (!i || i.orgId !== orgId) throw new ApiError(404, "not_found", "No such agent in this community.");
    return { readingEnabled: w.readers.enabled, readers: w.readers.ofInstall(installId).filter((r) => r.mode === "channel").map(view) };
  });

  app.post("/v1/orgs/:orgId/ai/agents/:installId/readers", limited(30), async (req, reply) => {
    const { userId } = me(req);
    const { orgId, installId } = parse(AiInstallParams, req.params);
    const b = parse(AiReaderOnBody, req.body);
    const r = control.turnOn(orgId, installId, b.conversationId, userId, b.reason);
    reply.code(201);
    return { reader: view(r) };
  });

  app.post("/v1/orgs/:orgId/ai/agents/:installId/read-scope", limited(10), async (req) => {
    const { userId } = me(req);
    const { orgId, installId } = parse(AiInstallParams, req.params);
    const b = parse(AiReadScopeBody, req.body);
    return { readers: control.turnOnScope(orgId, installId, b.scope, userId, b.reason).map(view) };
  });

  app.post("/v1/orgs/:orgId/ai/agents/:installId/readers/:readerId/off", limited(30), async (req) => {
    const { userId } = me(req);
    const { orgId, installId, readerId } = parse(AiInstallReaderParams, req.params);
    const r = w.readers.row(readerId);
    if (!r || r.install_id !== installId) throw new ApiError(404, "not_found", "No such reader.");
    return { reader: view(control.turnOff(orgId, readerId, userId, parse(AiReaderOffBody, req.body).reason)) };
  });

  app.post("/v1/orgs/:orgId/ai/agents/:installId/direct", limited(30), async (req) => {
    const { userId } = me(req);
    const { orgId, installId } = parse(AiInstallParams, req.params);
    if (!ctx.authz.orgRole(orgId, userId)) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
    const d = control.direct(orgId, installId, userId);
    return { conversationId: d.conversationId, reader: view(d.reader) };
  });
}
