import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { LeaderboardQuery } from "../../shared/contracts/http/leaderboards.js";
import { parse } from "../../shared/validation/index.js";
import { leaderboard } from "./service.js";

export default async function leaderboardRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  app.get(
    "/v2/leaderboards",
    {
      preHandler: requireAuth(ctx),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const { metric } = parse(LeaderboardQuery, req.query);
      return leaderboard(ctx, me(req).userId, metric);
    },
  );
}
