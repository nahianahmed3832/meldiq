import type { FastifyRequest } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ApiError } from "../../shared/errors.js";
import type { Bot } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The bot a /v2/bot/… request authenticated as (Authorization: Bot <token>). */
    bot?: Bot;
  }
}

/** Worked out once per request: the rate limiter's key and the route's preHandler both need it. */
const botOfRequest = new WeakMap<FastifyRequest, Promise<Bot | null>>();

/** The bot behind `Authorization: Bot <token>`, or null. A person's bearer token is never a bot token. */
export function authenticateBot(ctx: AppContext, req: FastifyRequest): Promise<Bot | null> {
  let p = botOfRequest.get(req);
  if (!p) {
    const h = req.headers.authorization;
    const token = h?.startsWith("Bot ") ? h.slice(4).trim() : undefined;
    p = token ? ctx.bots.authenticate(token) : Promise.resolve(null);
    botOfRequest.set(req, p);
  }
  return p;
}

export function requireBot(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const bot = await authenticateBot(ctx, req);
    if (!bot) throw new ApiError(401, "unauthorized", "Send the bot's token as Authorization: Bot <token>");
    req.bot = bot;
  };
}

export function theBot(req: FastifyRequest): Bot {
  if (!req.bot) throw new ApiError(401, "unauthorized", "Send the bot's token as Authorization: Bot <token>");
  return req.bot;
}

/** A per-bot rate limit (requests without a valid bot token share one per network address). */
export function perBot(ctx: AppContext, max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: "1 minute",
      keyGenerator: async (req: FastifyRequest) => {
        const bot = await authenticateBot(ctx, req).catch(() => null);
        return bot ? `bot:${bot.id}` : `bot-ip:${req.ip}`;
      },
    },
  };
}
