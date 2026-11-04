import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  BotCreateBody,
  BotEditBody,
  BotIdParams,
  BotMessageBody,
  BotParams,
  BotPatch,
  ChannelParams,
  CommandsBody,
  InstallBody,
  InteractionBody,
  InteractionParams,
  InteractionsQuery,
  MessageParams,
  OrgBotParams,
  OrgCommandsQuery,
  ReplyBody,
} from "../../shared/contracts/http/bots.js";
import { OrgParams } from "../../shared/contracts/http/orgs.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";
import { perBot, requireBot, theBot } from "./auth.js";
import {
  BotEventsQuery,
  BotManifestUpdate,
  BotInstallationApproval,
} from "../../shared/contracts/http/botPlatform.js";
import { requireBotManager } from "../organizations/index.js";
import { registerBotGateway } from "./gateway.js";

const minute = (max: number) => ({
  rateLimit: { max, timeWindow: "1 minute" },
});

/**
 * Bots (API 0.65.0, docs/SETTINGS_PARITY_API.md): owners manage theirs under /v2/developer/bots, community managers
 * add them, members run their slash commands, and the bots themselves use /v2/bot/… with `Authorization: Bot <token>`
 * (no other route accepts a bot token, and /v2/bot/… accepts nothing else). Bot routes are rate limited per bot.
 */
export default async function botRoutes(app: FastifyInstance, ctx: AppContext) {
  const svc = ctx.bots;
  registerBotGateway(app, svc);
  const person = { preHandler: requireAuth(ctx), config: minute(60) };
  const bot = (max: number) => ({
    preHandler: requireBot(ctx),
    config: perBot(ctx, max),
  });

  // A long poll in progress ends at once when the server shuts down.
  app.addHook("preClose", (done) => {
    svc.waiters.wakeAll();
    done();
  });

  app.get("/v2/developer/bots", person, async (req) =>
    svc.list(me(req).userId),
  );
  app.post(
    "/v2/developer/bots",
    { ...person, config: minute(10) },
    async (req, reply) =>
      reply
        .code(201)
        .send(await svc.create(me(req).userId, parse(BotCreateBody, req.body))),
  );
  app.patch("/v2/developer/bots/:id", person, async (req) =>
    svc.update(
      me(req).userId,
      parse(BotParams, req.params).id,
      parse(BotPatch, req.body),
    ),
  );
  app.delete(
    "/v2/developer/bots/:id",
    { ...person, config: minute(10) },
    async (req) => svc.remove(me(req).userId, parse(BotParams, req.params).id),
  );
  app.post(
    "/v2/developer/bots/:id/token",
    { ...person, config: minute(10) },
    async (req) =>
      svc.rotateToken(me(req).userId, parse(BotParams, req.params).id),
  );
  app.get("/v2/bots/:botId", person, async (req) =>
    svc.lookup(me(req).userId, parse(BotIdParams, req.params).botId),
  );
  app.get("/v2/bots/:botId/permissions", person, async (req) => {
    const botId = parse(BotIdParams, req.params).botId;
    await svc.lookup(me(req).userId, botId);
    return svc.permissions.manifest(botId);
  });
  app.put("/v2/developer/bots/:id/permissions", person, async (req) =>
    svc.permissions.update(
      me(req).userId,
      parse(BotParams, req.params).id,
      parse(BotManifestUpdate, req.body),
    ),
  );
  app.get("/v1/orgs/:orgId/bots/:botId/permissions", person, async (req) => {
    const { orgId, botId } = parse(OrgBotParams, req.params);
    requireBotManager(ctx, orgId, me(req).userId);
    return svc.permissions.installation(orgId, botId);
  });
  app.put("/v1/orgs/:orgId/bots/:botId/permissions", person, async (req) => {
    const { orgId, botId } = parse(OrgBotParams, req.params);
    return svc.permissions.approve(
      me(req).userId,
      orgId,
      botId,
      parse(BotInstallationApproval, req.body),
    );
  });

  app.post(
    "/v1/orgs/:orgId/bots",
    { ...person, config: minute(20) },
    async (req) =>
      svc.install(
        me(req).userId,
        parse(OrgParams, req.params).orgId,
        parse(InstallBody, req.body).botId,
      ),
  );
  app.delete(
    "/v1/orgs/:orgId/bots/:botId",
    { ...person, config: minute(20) },
    async (req) => {
      const { orgId, botId } = parse(OrgBotParams, req.params);
      return svc.uninstall(me(req).userId, orgId, botId);
    },
  );
  app.get("/v1/orgs/:orgId/commands", person, async (req) =>
    svc.interactions.orgCommands(
      me(req).userId,
      parse(OrgParams, req.params).orgId,
      parse(OrgCommandsQuery, req.query).channelId,
    ),
  );
  app.post(
    "/v2/interactions",
    { ...person, config: minute(30) },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await svc.interactions.run(
            me(req).userId,
            parse(InteractionBody, req.body),
          ),
        ),
  );

  app.get("/v2/bot/me", bot(120), async (req) => svc.api.self(theBot(req)));
  app.get("/v2/bot/events", bot(120), async (req) => {
    const query = parse(BotEventsQuery, req.query);
    return svc.events.page(theBot(req), query.cursor, query.limit);
  });
  app.get("/v2/bot/communities", bot(60), async (req) =>
    svc.api.communities(theBot(req)),
  );
  app.post("/v2/bot/channels/:channelId/messages", bot(60), async (req) =>
    svc.api.send(
      theBot(req),
      parse(ChannelParams, req.params).channelId,
      parse(BotMessageBody, req.body),
      req.log,
    ),
  );
  app.patch("/v2/bot/messages/:messageId", bot(60), async (req) =>
    svc.api.edit(
      theBot(req),
      parse(MessageParams, req.params).messageId,
      parse(BotEditBody, req.body),
      req.log,
    ),
  );
  app.delete("/v2/bot/messages/:messageId", bot(60), async (req) =>
    svc.api.delete(
      theBot(req),
      parse(MessageParams, req.params).messageId,
      req.log,
    ),
  );
  app.get("/v2/bot/commands", bot(60), async (req) => ({
    commands: theBot(req).commands,
  }));
  app.put("/v2/bot/commands", bot(10), async (req) =>
    svc.interactions.setCommands(
      theBot(req),
      parse(CommandsBody, req.body).commands,
    ),
  );
  app.get("/v2/bot/interactions", bot(120), async (req, reply) =>
    svc.interactions.poll(
      theBot(req),
      parse(InteractionsQuery, req.query).wait,
      reply.raw,
    ),
  );
  app.post("/v2/bot/interactions/:id/reply", bot(120), async (req) =>
    svc.interactions.reply(
      theBot(req),
      parse(InteractionParams, req.params).id,
      parse(ReplyBody, req.body),
      req.log,
    ),
  );
}
