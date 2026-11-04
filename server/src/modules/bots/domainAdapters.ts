import type { FastifyInstance, FastifyRequest, RouteOptions } from "fastify";
import type { AppContext } from "../../app/context.js";
import { BOT_DOMAIN_ADAPTERS, type BotDomainAdapter } from "../../shared/contracts/http/botDomainAdapters.js";
import { isSessionAuthenticationHook } from "../auth/index.js";
import { notFound } from "../../shared/errors.js";
import { perBot, requireBot, theBot } from "./auth.js";

function resourceOrg(ctx: AppContext, adapter: BotDomainAdapter, req: FastifyRequest): string | null {
  const p = req.params as Record<string, string>;
  if (adapter.resource === "self") return null;
  if (adapter.resource === "org") return p.orgId;
  const table = { conversation: "conversations", role: "org_roles", category: "channel_categories", expression: "community_expressions", meeting: "meetings" }[adapter.resource];
  const row = ctx.ws.get<{ org_id: string | null; type?: string }>(table, { id: p.roleId ?? p.id });
  // Community adapters cannot enter a person's DMs/groups, including through a guessed resource id.
  if (!row?.org_id || (adapter.resource === "conversation" && row.type !== "CHANNEL")) throw notFound("Resource not found");
  return row.org_id;
}

/**
 * Register allowlisted bot adapters in the SAME encapsulation as their native controller. Keep every domain hook,
 * schema and handler; replace only the explicitly marked person-session credential hook with bot authentication.
 * There is no internal HTTP request, human access token or parallel implementation of community authorization.
 */
export function installBotDomainAdapters(app: FastifyInstance, ctx: AppContext): void {
  // One transient wake-up for successful authoritative writes; replay remains durable across restarts.
  app.addHook("onResponse", async (req, reply) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && reply.statusCode < 400) ctx.bots?.events.notify();
  });
  app.addHook("onRoute", function (options) {
    if (options.url.startsWith("/v2/bot/")) return;
    const methods = Array.isArray(options.method) ? options.method : [options.method];
    for (const adapter of BOT_DOMAIN_ADAPTERS.filter((item) => item.source === options.url && methods.includes(item.method))) {
      const hooks = options.preHandler ? (Array.isArray(options.preHandler) ? options.preHandler : [options.preHandler]) : [];
      if (!hooks.some(isSessionAuthenticationHook)) throw new Error(`Bot adapter requires an explicit session gate: ${adapter.source}`);
      const allowed = async (req: FastifyRequest) => {
        const bot = theBot(req);
        const orgId = resourceOrg(ctx, adapter, req);
        if (orgId && adapter.scope) ctx.bots.permissions.require(bot, orgId, adapter.scope);
        // This identity exists only on this bot route. It is never a device/session credential or user WS grant.
        req.auth = { userId: bot.id, deviceId: `bot-${bot.id}` };
      };
      this.route({
        ...options,
        method: adapter.method,
        url: adapter.url,
        path: adapter.url,
        prefix: undefined,
        config: { ...options.config, rateLimit: perBot(ctx, 60).rateLimit },
        preHandler: [requireBot(ctx), allowed, ...hooks.filter((hook) => !isSessionAuthenticationHook(hook))],
      } as RouteOptions);
    }
  });
}
