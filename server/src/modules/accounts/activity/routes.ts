import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { ActivityBody } from "../../../shared/contracts/http/activity.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";

/**
 * Activity status (API 0.56.0, docs/ACTIVITY_STATUS.md): the person's Android app reports the game they're playing
 * (only after they opted in) and refreshes it every few minutes; null clears it.
 */
export default async function activityRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };

  // A refresh every few minutes plus a change when a game opens or closes: far below this.
  app.put("/v2/me/activity", { ...auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { userId } = me(req);
    const { activity } = parse(ActivityBody, req.body);
    if (!activity) {
      await ctx.activity.clear(userId);
      return { activity: null };
    }
    return { activity: await ctx.activity.set(userId, activity) };
  });

  app.get("/v2/me/activity", auth, async (req) => ({ activity: ctx.activity.current(me(req).userId) }));
}
