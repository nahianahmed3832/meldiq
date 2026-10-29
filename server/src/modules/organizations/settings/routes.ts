import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { OrgParamsNonEmpty } from "../../../shared/contracts/http/community.js";
import { CommunitySettingsBody } from "../../../shared/contracts/http/communitySettings.js";
import { forbidden } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { parse } from "../../../shared/validation/index.js";
import { requireStanding } from "../../accounts/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { notifyOrg } from "../orgsRoutes.js";
import { standardInvite } from "./standardInvite.js";

/**
 * A community's settings (community parity A3, feature "community-settings", docs/COMMUNITY_SETTINGS_API.md): people
 * who can edit the community read and change them in one place; members get their standard invite link and finish
 * onboarding here.
 */
export default async function communitySettingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { authz } = ctx;
  const auth = { preHandler: requireAuth(ctx) };

  /** The feature is on and [userId] may edit [orgId]. */
  const requireEditor = (orgId: string, userId: string) => {
    ctx.communitySettings.requireEnabled();
    authz.requireOrgMember(orgId, userId);
    if (!authz.can(orgId, userId, "workspace.edit")) throw forbidden("Your role doesn't include changing the community's settings");
  };

  app.get("/v1/orgs/:orgId/settings", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    requireEditor(orgId, me(req).userId);
    return ctx.communitySettings.view(orgId);
  });

  app.put("/v1/orgs/:orgId/settings", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    const body = parse(CommunitySettingsBody, req.body);
    requireEditor(orgId, userId);
    const { changed, slug } = await ctx.communitySettings.update(orgId, userId, body);
    if (changed.length > 0) {
      ctx.audit({ actorId: userId, orgId, action: "community.settings", target: orgId, detail: changed.join(", ") });
      if (slug !== undefined) ctx.audit({ actorId: userId, orgId, action: "community.invite_slug", target: orgId, detail: slug ?? "removed" });
      notifyOrg(ctx, orgId);
    }
    return ctx.communitySettings.view(orgId);
  });

  app.post("/v1/orgs/:orgId/invites/standard", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    ctx.communitySettings.requireEnabled();
    requireStanding(ctx.safety, userId, "invite");
    authz.requireOrgMember(orgId, userId);
    if (!authz.canIssueInvite(orgId, userId, "MEMBER")) throw forbidden("Your role doesn't include inviting people");
    const { invite, created } = await standardInvite(ctx, orgId, userId, now());
    if (created) ctx.audit({ actorId: userId, orgId, action: "invite.create", target: invite.id, detail: "MEMBER, standard link" });
    return { invite };
  });

  app.post("/v1/orgs/:orgId/onboarding/finish", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    ctx.communitySettings.requireEnabled();
    authz.requireOrgMember(orgId, userId);
    await ctx.communitySettings.finish(orgId, userId);
    ctx.audit({ actorId: userId, orgId, action: "community.onboarding_finished", target: userId });
    // Their own devices refresh the community (the composer opens up).
    ctx.hub.sendToUser(userId, { t: "org.updated", orgId });
    return ctx.communitySettings.status(orgId, userId);
  });
}
