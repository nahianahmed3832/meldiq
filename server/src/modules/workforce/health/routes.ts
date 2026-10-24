import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { AiCheckParams, AiOrgParams } from "../../../shared/contracts/http/aiWorkforce.js";
import { ApiError } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import type { WorkforceModule } from "../index.js";
import type { CheckReport } from "./report.js";

/**
 * Run Full System Check for a community, over HTTP: people with "Manage AI agents" run it and read its history. It
 * works while AI agents are switched off (that's one of the things it reports). The report is also the export: ids,
 * counts and statuses, no content.
 */
const HISTORY_SHOWN = 20;

export function systemCheckRoutes(app: FastifyInstance, ctx: AppContext, w: WorkforceModule): void {
  const auth = { preHandler: requireAuth(ctx) };
  const limited = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 6, timeWindow: "1 minute" } } };
  const manager = (orgId: string, userId: string) => ctx.authz.requirePermission(orgId, userId, "ai.manage", 'The System Check is for people who "Manage AI agents".');
  const summary = ({ items: _items, orgId: _orgId, ...s }: CheckReport) => s;

  app.post("/v1/orgs/:orgId/ai/system-check", limited, async (req, reply) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    manager(orgId, userId);
    const report = await w.health.community(orgId, userId);
    reply.code(201);
    return { report };
  });

  app.get("/v1/orgs/:orgId/ai/system-check", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    manager(orgId, userId);
    const history = w.health.reports.history("community", orgId, HISTORY_SHOWN);
    return { latest: history[0] ?? null, history: history.map(summary) };
  });

  app.get("/v1/orgs/:orgId/ai/system-check/:checkId", auth, async (req) => {
    const { userId } = me(req);
    const { orgId, checkId } = parse(AiCheckParams, req.params);
    manager(orgId, userId);
    const report = w.health.reports.get(checkId);
    if (!report || report.scope !== "community" || report.orgId !== orgId) throw new ApiError(404, "not_found", "No such report in this community.");
    return { report };
  });
}
