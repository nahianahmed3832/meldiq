import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { BoostCheckoutBody, DiscoverListQuery, DiscoverySettingsBody, PromotedCheckoutBody } from "../../../shared/contracts/http/discovery.js";
import { OrgParamsNonEmpty } from "../../../shared/contracts/http/community.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { notifyOrg } from "../orgsRoutes.js";

const minute = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });

/**
 * Discover, a community's Discovery settings and Promote (community parity batch E, features "discovery-listing"
 * and "discovery-promote", docs/COMMUNITY_PARITY_API.md › Discovery). Settings and Promote need Edit community.
 */
export default async function discoveryRoutes(app: FastifyInstance, ctx: AppContext) {
  const discovery = () => ctx.discovery;
  const person = (max: number) => ({ preHandler: requireAuth(ctx), config: minute(max) });

  /** The community and the editor after the feature and permission checks. */
  const editor = (req: FastifyRequest, what: string): { orgId: string; userId: string } => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    discovery().requireEnabled();
    discovery().requireEditor(orgId, userId, what);
    return { orgId, userId };
  };

  app.get("/v1/discover", person(60), async (req) => {
    discovery().requireEnabled();
    return discovery().discover(me(req).userId, parse(DiscoverListQuery, req.query));
  });

  app.post("/v1/discover/:orgId/click", person(60), async (req) => {
    discovery().requireEnabled();
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    return { recorded: await discovery().click(orgId, me(req).userId) };
  });

  app.get("/v1/orgs/:orgId/discovery", person(60), async (req) => discovery().settingsView(editor(req, "Discovery settings").orgId));

  app.put("/v1/orgs/:orgId/discovery", person(30), async (req) => {
    const body = parse(DiscoverySettingsBody, req.body);
    const { orgId, userId } = editor(req, "Discovery settings");
    const changed = await discovery().update(orgId, userId, body);
    if (changed.length > 0) {
      ctx.audit({ actorId: userId, orgId, action: "community.discovery", target: orgId, detail: changed.join(", ") });
      notifyOrg(ctx, orgId);
    }
    return discovery().settingsView(orgId);
  });

  // ── Promote ──

  const promoter = (req: FastifyRequest) => {
    const who = editor(req, "promotion");
    discovery().promote.requireEnabled();
    return who;
  };

  app.get("/v1/orgs/:orgId/promote", person(60), async (req) => discovery().promote.view(promoter(req).orgId));

  app.post("/v1/orgs/:orgId/promote/boost", person(10), async (req) => {
    const body = parse(BoostCheckoutBody, req.body);
    const { orgId, userId } = promoter(req);
    return discovery().promote.buyBoost(orgId, userId, body.tier);
  });

  app.post("/v1/orgs/:orgId/promote/promoted", person(10), async (req) => {
    const body = parse(PromotedCheckoutBody, req.body ?? {});
    const { orgId, userId } = promoter(req);
    return discovery().promote.buyPromoted(orgId, userId, body.weekStart);
  });
}
