import type { FastifyInstance } from "fastify";
import { AdminOrgParams } from "../../shared/contracts/http/platformAdmin.js";
import {
  AdminAgentSetupBody,
  AdminCapabilitiesBody,
  AdminCatalogBody,
  AdminCatalogParams,
  AdminJobCancelBody,
  AdminJobParams,
  AdminJobsQuery,
  AdminModelPath,
  AdminOrgAiBody,
  AdminRoutingBody,
  AdminRouteSetupBody,
  AdminRoutingParams,
  AdminToolBody,
  AdminToolParams,
  AdminVerifyBody,
  AdminWorkforceControlsBody,
  AdminSystemCheckParams,
  AdminWorkforceQuery,
} from "../../shared/contracts/http/platformAdminWorkforce.js";
import { ApiError } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import type { AdminDeps } from "./dataRoutes.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import type { Permission } from "./permissions.js";
import { AdminWorkforce } from "./workforceAdmin.js";

/** How many System Check runs the console lists. */
const SYSTEM_CHECKS_SHOWN = 20;

/** The AI Control Center (docs/AI_WORKFORCE.md). Reads need ai.view; every change needs ai.manage (a fresh passkey and a reason). */
export default async function adminWorkforceRoutes(
  app: FastifyInstance,
  d: AdminDeps,
) {
  const needs = (permission: Permission) => ({
    preHandler: requirePermission(d.auth, d.audit, permission),
  });
  const w = new AdminWorkforce(d.ctx, d.audit);

  app.get("/admin/v1/ai/workforce", needs("ai.view"), async (req) =>
    w.overview(parse(AdminWorkforceQuery, req.query).days),
  );
  app.put("/admin/v1/ai/workforce/controls", needs("ai.manage"), async (req) =>
    w.setControls(
      principal(req),
      parse(AdminWorkforceControlsBody, req.body),
      metaOf(req),
    ),
  );

  app.get("/admin/v1/ai/models", needs("ai.view"), async () => w.models());
  app.put(
    "/admin/v1/ai/providers/:providerId/models/:model/capabilities",
    needs("ai.manage"),
    async (req) => {
      const { providerId, model } = parse(AdminModelPath, req.params);
      return w.setCapabilities(
        principal(req),
        providerId,
        model,
        parse(AdminCapabilitiesBody, req.body),
        metaOf(req),
      );
    },
  );
  app.post(
    "/admin/v1/ai/providers/:providerId/models/:model/verify",
    needs("ai.manage"),
    async (req) => {
      const { providerId, model } = parse(AdminModelPath, req.params);
      const b = parse(AdminVerifyBody, req.body);
      return w.verify(
        principal(req),
        providerId,
        model,
        b.capability,
        b.reason,
        metaOf(req),
      );
    },
  );
  app.post(
    "/admin/v1/ai/providers/:providerId/models/:model/agent-setup",
    needs("ai.manage"),
    async (req) => {
      const { providerId, model } = parse(AdminModelPath, req.params);
      return w.agentSetup(
        principal(req),
        providerId,
        model,
        parse(AdminAgentSetupBody, req.body).reason,
        metaOf(req),
      );
    },
  );
  app.post(
    "/admin/v1/ai/routing/:category/setup",
    needs("ai.manage"),
    async (req) =>
      w.setupRoute(
        principal(req),
        parse(AdminRoutingParams, req.params).category,
        parse(AdminRouteSetupBody, req.body),
        metaOf(req),
      ),
  );
  app.put("/admin/v1/ai/routing/:category", needs("ai.manage"), async (req) =>
    w.setRouting(
      principal(req),
      parse(AdminRoutingParams, req.params).category,
      parse(AdminRoutingBody, req.body),
      metaOf(req),
    ),
  );

  app.get("/admin/v1/ai/catalog", needs("ai.view"), async () => w.catalog());
  app.put(
    "/admin/v1/ai/catalog/:agentId/:version",
    needs("ai.manage"),
    async (req) => {
      const { agentId, version } = parse(AdminCatalogParams, req.params);
      return w.setTemplate(
        principal(req),
        agentId,
        version,
        parse(AdminCatalogBody, req.body),
        metaOf(req),
      );
    },
  );

  app.get("/admin/v1/ai/tools", needs("ai.view"), async () => w.tools());
  app.put("/admin/v1/ai/tools/:tool", needs("ai.manage"), async (req) => {
    const b = parse(AdminToolBody, req.body);
    return w.setTool(
      principal(req),
      parse(AdminToolParams, req.params).tool,
      b.mode,
      b.reason,
      metaOf(req),
    );
  });

  app.get("/admin/v1/ai/entitlements", needs("ai.view"), async () =>
    w.entitlements(),
  );
  app.get("/admin/v1/orgs/:orgId/ai", needs("ai.view"), async (req) =>
    w.orgAi(parse(AdminOrgParams, req.params).orgId),
  );
  app.put("/admin/v1/orgs/:orgId/ai", needs("ai.manage"), async (req) => {
    const b = parse(AdminOrgAiBody, req.body);
    return w.setOrgAi(
      principal(req),
      parse(AdminOrgParams, req.params).orgId,
      b.entitlement,
      b.rev,
      b.reason,
      metaOf(req),
    );
  });

  // Run Full System Check: safe to run (it changes nothing but its own history), so ai.view.
  app.post("/admin/v1/ai/system-check", needs("ai.view"), async (req, reply) => {
    const report = await d.ctx.workforce.console.runSystemCheck(principal(req).account.id);
    reply.code(201);
    return { report };
  });
  app.get("/admin/v1/ai/system-check", needs("ai.view"), async () => d.ctx.workforce.console.systemChecks(SYSTEM_CHECKS_SHOWN));
  app.get("/admin/v1/ai/system-check/:checkId", needs("ai.view"), async (req) => {
    const report = d.ctx.workforce.console.systemCheck(parse(AdminSystemCheckParams, req.params).checkId);
    if (!report) throw new ApiError(404, "not_found", "No such report.");
    return { report };
  });

  app.get("/admin/v1/ai/jobs", needs("ai.view"), async (req) =>
    w.jobs(parse(AdminJobsQuery, req.query)),
  );
  app.get("/admin/v1/ai/jobs/:jobId", needs("ai.view"), async (req) =>
    w.job(parse(AdminJobParams, req.params).jobId),
  );
  app.post("/admin/v1/ai/jobs/:jobId/cancel", needs("ai.manage"), async (req) =>
    w.cancelJob(
      principal(req),
      parse(AdminJobParams, req.params).jobId,
      parse(AdminJobCancelBody, req.body).reason,
      metaOf(req),
    ),
  );
}
