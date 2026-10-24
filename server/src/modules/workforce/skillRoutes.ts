import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { AiDiscoverQuery, AiOrgParams } from "../../shared/contracts/http/aiWorkforce.js";
import { ApiError } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";
import { CAPABILITY_IDS, discover, isCapabilityId, skillLibrary } from "./skillLibrary.js";
import type { WorkforceModule } from "./index.js";

/** At most this many capabilities per discovery request. */
const MAX_DISCOVER = 20;

/**
 * The skill library for a community's members (docs/AI_WORKFORCE_2_PLAN.md, phase 1): every skill's card, and which
 * capabilities the community's agents can do now for the person asking, with the exact blocker otherwise.
 */
export function skillRoutes(app: FastifyInstance, ctx: AppContext, w: WorkforceModule): void {
  const auth = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const member = (orgId: string, userId: string) => {
    if (!ctx.authz.orgRole(orgId, userId)) throw new ApiError(404, "not_found", "Not found, or not visible to you.");
  };

  app.get("/v1/orgs/:orgId/ai/skills", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    return { skills: skillLibrary(), capabilities: await discover(w, orgId, userId, CAPABILITY_IDS) };
  });

  app.get("/v1/orgs/:orgId/ai/skills/discover", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(AiOrgParams, req.params);
    member(orgId, userId);
    const asked = [...new Set(parse(AiDiscoverQuery, req.query).capabilities.split(",").map((c) => c.trim()).filter(Boolean))];
    const unknown = asked.filter((c) => !isCapabilityId(c));
    if (unknown.length) throw new ApiError(400, "bad_request", `Unknown capabilities: ${unknown.slice(0, 5).join(", ")}. The library lists them at GET /v1/orgs/:orgId/ai/skills.`);
    if (asked.length > MAX_DISCOVER) throw new ApiError(400, "bad_request", `At most ${MAX_DISCOVER} capabilities at a time.`);
    return { capabilities: await discover(w, orgId, userId, asked.filter(isCapabilityId)) };
  });
}
