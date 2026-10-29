import type { FastifyInstance } from "fastify";
import { OrgParamsNonEmpty } from "../../../shared/contracts/http/community.js";
import { RulesBody } from "../../../shared/contracts/http/communityRules.js";
import type { AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { parse } from "../../../shared/validation/index.js";
import { forbidden } from "../../../shared/errors.js";
import { notifyConversation, notifyOrg } from "../orgsRoutes.js";

/**
 * The rules channel and the community's rules (API 0.65.0, feature "rules-channel", docs/SETTINGS_PARITY_API.md):
 * every member reads them, people who can edit the community set them, and members agree to them.
 */
export default async function communityRulesRoutes(app: FastifyInstance, ctx: AppContext) {
  const { authz } = ctx;
  const auth = { preHandler: requireAuth(ctx) };

  app.get("/v1/orgs/:orgId/rules", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    ctx.communityRules.requireEnabled();
    authz.requireOrgMember(orgId, userId);
    return ctx.communityRules.view(orgId, userId);
  });

  app.put("/v1/orgs/:orgId/rules", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    const body = parse(RulesBody, req.body);
    ctx.communityRules.requireEnabled();
    authz.requireOrgMember(orgId, userId);
    if (!authz.can(orgId, userId, "workspace.edit")) throw forbidden("Your role doesn't include changing the community's rules");
    const { before, after } = await ctx.communityRules.set(orgId, userId, body);
    ctx.audit({ actorId: userId, orgId, action: "community.rules", target: orgId, detail: `${after.rules.length} rules${after.required ? ", agreement required" : ""}` });
    notifyOrg(ctx, orgId);
    // Who may post there changed for the old and the new rules channel.
    if (before?.channelId !== after.channelId) {
      for (const c of [before?.channelId, after.channelId]) if (c) notifyConversation(ctx, c);
    }
    return ctx.communityRules.view(orgId, userId);
  });

  app.post("/v1/orgs/:orgId/rules/agree", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    ctx.communityRules.requireEnabled();
    authz.requireOrgMember(orgId, userId);
    if (await ctx.communityRules.agree(orgId, userId)) {
      ctx.audit({ actorId: userId, orgId, action: "community.rules_agreed", target: userId });
      // Their own devices refresh the community (the composer opens up).
      ctx.hub.sendToUser(userId, { t: "org.updated", orgId });
    }
    return ctx.communityRules.view(orgId, userId);
  });
}
