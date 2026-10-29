import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { BotDirectoryQuery, BotListingBody } from "../../../shared/contracts/http/botDirectory.js";
import { BotParams } from "../../../shared/contracts/http/bots.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";

const minute = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });

/**
 * The community bot directory (community parity batch E, feature "bot-directory", docs/COMMUNITY_PARITY_API.md ›
 * Discovery): anyone signed in browses it; bot owners list their own public bots.
 */
export default async function botDirectoryRoutes(app: FastifyInstance, ctx: AppContext) {
  const person = (max: number) => ({ preHandler: requireAuth(ctx), config: minute(max) });

  const directory = () => ctx.botDirectory;

  app.get("/v1/bot-directory", person(60), async (req) => {
    directory().requireEnabled();
    return directory().page(parse(BotDirectoryQuery, req.query));
  });

  app.get("/v2/developer/bots/:id/listing", person(60), async (req) => {
    directory().requireEnabled();
    return { listing: await directory().listing(me(req).userId, parse(BotParams, req.params).id) };
  });

  app.put("/v2/developer/bots/:id/listing", person(20), async (req) => {
    directory().requireEnabled();
    const body = parse(BotListingBody, req.body);
    return { listing: await directory().setListing(me(req).userId, parse(BotParams, req.params).id, body) };
  });
}
