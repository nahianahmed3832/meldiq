import { communityProfileRoutes } from "./profiles.js";
import type { FastifyInstance } from "fastify";
import { ChannelMemberParams, EveryoneBody, NicknameBody, OrgMemberParams, OrgParams, RoleExtrasBody, RoleOrderBody, RoleParams } from "../../../shared/contracts/http/communityPermissions.js";
import type { AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { parse } from "../../../shared/validation/index.js";
import type { Permission } from "../permissions/catalog.js";
import { setEveryone } from "./everyone.js";
import { setNickname } from "./nicknames.js";
import { setRoleExtras } from "./roleExtras.js";
import { reorderRoles } from "./roleOrder.js";
import { grantSpeaker, revokeSpeaker } from "./stage.js";

/**
 * Community parity A1 (feature "community-permissions", docs/COMMUNITY_PERMISSIONS.md): @everyone defaults, nicknames,
 * role extras and order, and stage speakers. Channel options travel with channel creation and PATCH
 * /v1/conversations/:id; the defaults are read with GET /v1/orgs/:orgId/roles.
 */
export default async function communityPermissionsRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const feature = ctx.communityPermissions;
  await communityProfileRoutes(app, ctx);

  app.put("/v1/orgs/:orgId/roles/everyone", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const { permissions } = parse(EveryoneBody, req.body);
    feature.requireEnabled();
    return {
      everyone: await setEveryone(ctx, orgId, me(req).userId, permissions as Permission[]),
    };
  });

  app.put("/v1/orgs/:orgId/members/:userId/nickname", auth, async (req) => {
    const p = parse(OrgMemberParams, req.params);
    const { nickname } = parse(NicknameBody, req.body);
    feature.requireEnabled();
    return setNickname(ctx, p.orgId, me(req).userId, p.userId, nickname);
  });

  app.put("/v1/roles/:roleId/extras", auth, async (req) => {
    const { roleId } = parse(RoleParams, req.params);
    const body = parse(RoleExtrasBody, req.body);
    feature.requireEnabled();
    return setRoleExtras(ctx, roleId, me(req).userId, body);
  });

  app.put("/v1/orgs/:orgId/roles/order", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const { roleIds } = parse(RoleOrderBody, req.body);
    feature.requireEnabled();
    return reorderRoles(ctx, orgId, me(req).userId, roleIds);
  });

  app.put("/v1/conversations/:id/stage/speakers/:userId", auth, async (req) => {
    const p = parse(ChannelMemberParams, req.params);
    feature.requireEnabled();
    return grantSpeaker(ctx, p.id, me(req).userId, p.userId);
  });

  app.delete("/v1/conversations/:id/stage/speakers/:userId", auth, async (req) => {
    const p = parse(ChannelMemberParams, req.params);
    feature.requireEnabled();
    return revokeSpeaker(ctx, p.id, me(req).userId, p.userId);
  });
}
