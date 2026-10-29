import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { OrgParamsNonEmpty } from "../../../shared/contracts/http/community.js";
import { TemplateCodeParams, TemplateCreateBody } from "../../../shared/contracts/http/communityTemplates.js";
import { forbidden } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";

const minute = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });

/**
 * Templates from a community (community parity batch E, feature "template-links", docs/COMMUNITY_PARITY_API.md ›
 * Discovery): made, synced and deleted with Edit community; previewed by anyone signed in.
 */
export default async function communityTemplateRoutes(app: FastifyInstance, ctx: AppContext) {
  const templates = () => ctx.communityTemplates;
  const person = (max: number) => ({ preHandler: requireAuth(ctx), config: minute(max) });

  const editor = (req: FastifyRequest): { orgId: string; userId: string } => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    templates().requireEnabled();
    ctx.authz.requireOrgMember(orgId, userId);
    if (!ctx.authz.can(orgId, userId, "workspace.edit")) throw forbidden("Your role doesn't include making template links for this community");
    return { orgId, userId };
  };

  app.get("/v1/orgs/:orgId/templates", person(60), async (req) => ({ template: templates().get(editor(req).orgId) }));

  app.post("/v1/orgs/:orgId/templates", person(10), async (req, reply) => {
    const body = parse(TemplateCreateBody, req.body ?? {});
    const { orgId, userId } = editor(req);
    const template = await templates().create(orgId, userId, body.name);
    ctx.audit({ actorId: userId, orgId, action: "community.template", target: orgId, detail: `created ${template.code}` });
    return reply.code(201).send({ template });
  });

  app.post("/v1/orgs/:orgId/templates/sync", person(10), async (req) => {
    const { orgId, userId } = editor(req);
    const template = await templates().sync(orgId, userId);
    ctx.audit({ actorId: userId, orgId, action: "community.template", target: orgId, detail: `synced ${template.code}` });
    return { template };
  });

  app.delete("/v1/orgs/:orgId/templates", person(10), async (req) => {
    const { orgId, userId } = editor(req);
    const deleted = await templates().remove(orgId);
    if (deleted) ctx.audit({ actorId: userId, orgId, action: "community.template", target: orgId, detail: "deleted" });
    return { deleted };
  });

  app.get("/v1/templates/:code", person(30), async (req) => {
    templates().requireEnabled();
    return { template: templates().preview(parse(TemplateCodeParams, req.params).code) };
  });
}
