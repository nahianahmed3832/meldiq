import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { ReactionRolesBody, ReactionRolesParams } from "../../../shared/contracts/http/reactionRoles.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";

/** Reaction roles on a community message (community parity batch C, docs/COMMUNITY_PARITY_API.md › Posting tools). */
export default async function reactionRoleRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const url = "/v1/orgs/:orgId/channels/:channelId/messages/:messageId/reaction-roles";

  app.get(url, auth, async (req) => {
    const p = parse(ReactionRolesParams, req.params);
    return ctx.reactionRoles.get(p.orgId, p.channelId, p.messageId, me(req).userId);
  });
  app.put(url, { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const p = parse(ReactionRolesParams, req.params);
    return ctx.reactionRoles.set(p.orgId, p.channelId, p.messageId, me(req).userId, parse(ReactionRolesBody, req.body));
  });
  app.delete(url, auth, async (req) => {
    const p = parse(ReactionRolesParams, req.params);
    return ctx.reactionRoles.remove(p.orgId, p.channelId, p.messageId, me(req).userId);
  });
}
