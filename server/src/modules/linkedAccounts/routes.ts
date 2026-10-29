import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ConnectionCallbackQuery, ConnectionVisibilityBody, ProviderParams } from "../../shared/contracts/http/linkedAccounts.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";

/** Linked accounts: Steam, AniList, Last.fm and Trakt (API 0.65.0 batch B, feature `connections-v2`). */
export default async function linkedAccountRoutes(app: FastifyInstance, ctx: AppContext) {
  const limited = (max: number) => ({ preHandler: requireAuth(ctx), config: { rateLimit: { max, timeWindow: "1 minute" } } });
  const linked = ctx.linkedAccounts;

  app.get("/v2/connections", limited(60), async (req) => linked.list(me(req).userId));

  app.post("/v2/connections/:provider/start", limited(10), async (req) => {
    const { provider } = parse(ProviderParams, req.params);
    return { url: await linked.start(me(req).userId, provider) };
  });

  // The browser coming back from the provider: no session here, the signed state says whose connection it is.
  app.get("/v2/connections/:provider/callback", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { provider } = parse(ProviderParams, req.params);
    const query = ConnectionCallbackQuery.safeParse(req.query);
    const to = query.success ? await linked.finish(provider, query.data) : linked.returnTo({ error: "failed", provider });
    return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").redirect(to, 302);
  });

  app.put("/v2/connections/:provider", limited(60), async (req) => {
    const { provider } = parse(ProviderParams, req.params);
    const { visible } = parse(ConnectionVisibilityBody, req.body);
    return linked.setVisible(me(req).userId, provider, visible);
  });

  app.delete("/v2/connections/:provider", limited(30), async (req) => {
    const { provider } = parse(ProviderParams, req.params);
    return linked.disconnect(me(req).userId, provider);
  });
}
