import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";

/** Points, quests and levels (API 0.65.0, docs/SETTINGS_PARITY_API.md). Nothing here buys, sells or sends points. */
export default async function pointsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const auth = {
    preHandler: requireAuth(ctx),
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  };

  app.get("/v2/points", auth, async (req) => ctx.points.view(me(req).userId));

  app.post("/v2/points/checkin", auth, async (req) =>
    ctx.points.checkin(me(req).userId),
  );

  app.post(
    "/v2/points/level-up",
    {
      preHandler: requireAuth(ctx),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req) => ctx.points.levelUp(me(req).userId),
  );
}
