import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { OfficialBotBody, OfficialBotParams } from "../../shared/contracts/http/officialBots.js";
import { AlertWatchBody, AlertWatchParams, AlertWatchPatch, WordyGuessBody } from "../../shared/contracts/http/officialBotTools.js";
import { OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";
import { AlertWatchManager } from "./alerts.js";
import { catalog } from "./catalog.js";
import { BotManager } from "./manage.js";
import { gameView, guessPrivately } from "./wordy.js";

/** Official bots (community parity batch D, docs/COMMUNITY_PARITY_API.md › Official bots). */
export default async function officialBotRoutes(app: FastifyInstance, ctx: AppContext) {
  const bots = new BotManager(ctx.officialBots);
  const alerts = new AlertWatchManager(ctx.officialBots);
  const auth = { preHandler: requireAuth(ctx) };
  const few = { ...auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.get("/v1/official-bots", auth, async () => {
    ctx.officialBots.requireEnabled();
    return catalog((key) => ctx.officialBots.unavailableReason(key));
  });
  // Part 2: the YouTube channels Alerts follows, and Wordy played privately from the apps (/wordy).
  app.get("/v1/orgs/:orgId/official-bots/alerts/watches", auth, async (req) => alerts.list(parse(OrgParamsNonEmpty, req.params).orgId, me(req).userId));
  app.post("/v1/orgs/:orgId/official-bots/alerts/watches", few, async (req, reply) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    return reply.code(201).send(await alerts.add(orgId, me(req).userId, parse(AlertWatchBody, req.body)));
  });
  app.patch("/v1/orgs/:orgId/official-bots/alerts/watches/:watchId", auth, async (req) => {
    const p = parse(AlertWatchParams, req.params);
    return alerts.change(p.orgId, p.watchId, me(req).userId, parse(AlertWatchPatch, req.body));
  });
  app.delete("/v1/orgs/:orgId/official-bots/alerts/watches/:watchId", auth, async (req) => {
    const p = parse(AlertWatchParams, req.params);
    return alerts.remove(p.orgId, p.watchId, me(req).userId);
  });
  app.get("/v1/orgs/:orgId/official-bots/wordy/game", auth, async (req) => gameView(ctx.officialBots, parse(OrgParamsNonEmpty, req.params).orgId, me(req).userId, ctx.officialBots.clock()));
  app.post("/v1/orgs/:orgId/official-bots/wordy/game", { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) =>
    guessPrivately(ctx.officialBots, parse(OrgParamsNonEmpty, req.params).orgId, me(req).userId, parse(WordyGuessBody, req.body).guess),
  );
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
