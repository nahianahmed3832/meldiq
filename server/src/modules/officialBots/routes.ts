import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { OfficialBotBody, OfficialBotParams } from "../../shared/contracts/http/officialBots.js";
import { OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";
import { catalog } from "./catalog.js";
import { BotManager } from "./manage.js";

/** Official bots (community parity batch D, docs/COMMUNITY_PARITY_API.md › Official bots). */
export default async function officialBotRoutes(app: FastifyInstance, ctx: AppContext) {
  const bots = new BotManager(ctx.officialBots);
  const auth = { preHandler: requireAuth(ctx) };
  const few = { ...auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.get("/v1/official-bots", auth, async () => {
    ctx.officialBots.requireEnabled();
    return catalog();
  });
  app.get("/v1/orgs/:orgId/official-bots", auth, async (req) => bots.list(parse(OrgParamsNonEmpty, req.params).orgId, me(req).userId));
  app.post("/v1/orgs/:orgId/official-bots/welcomer/test", few, async (req) => bots.testWelcome(parse(OrgParamsNonEmpty, req.params).orgId, me(req).userId));
  app.get("/v1/orgs/:orgId/official-bots/:key", auth, async (req) => {
    const p = parse(OfficialBotParams, req.params);
    return bots.one(p.orgId, p.key, me(req).userId);
  });
  app.put("/v1/orgs/:orgId/official-bots/:key", auth, async (req) => {
    const p = parse(OfficialBotParams, req.params);
    return bots.update(p.orgId, p.key, me(req).userId, parse(OfficialBotBody, req.body));
  });
  app.put("/v1/orgs/:orgId/official-bots/:key/avatar", few, async (req) => {
    const p = parse(OfficialBotParams, req.params);
    return bots.setAvatar(p.orgId, p.key, me(req).userId, req);
  });
  app.delete("/v1/orgs/:orgId/official-bots/:key/avatar", auth, async (req) => {
    const p = parse(OfficialBotParams, req.params);
    return bots.setAvatar(p.orgId, p.key, me(req).userId, null);
  });
}
