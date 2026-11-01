import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { CommunityProfile, CommunityProfileBody, OrgMemberParams } from "../../../shared/contracts/http/communityPermissions.js";
import { me, requireAuth } from "../../auth/index.js";
import { parse } from "../../../shared/validation/index.js";
import { conflict, forbidden, notFound } from "../../../shared/errors.js";
import { profileAudience } from "../../accounts/index.js";
import { notifyOrg } from "../orgsRoutes.js";
const EMPTY = { aboutMe: null, pronouns: null, theme: null };
interface Row {
  org_id: string;
  user_id: string;
  profile: string;
  rev: number;
  updated_at: number;
}
export async function communityProfileRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const view = (orgId: string, userId: string, viewer: string) => {
    ctx.communityPermissions.requireEnabled();
    if (!ctx.authz.orgRole(orgId, viewer) || !ctx.authz.orgRole(orgId, userId)) throw notFound("Member not found");
    const audience = profileAudience(ctx, userId, viewer);
    if (!audience) throw notFound("Member not found");
    const r = ctx.ws.get<Row>("community_profiles", {
      org_id: orgId,
      user_id: userId,
    });
    const parsed = r ? CommunityProfile.parse(JSON.parse(r.profile)) : EMPTY;
    const own = viewer === userId;
    return {
      orgId,
      userId,
      rev: own ? (r?.rev ?? 0) : 0,
      own,
      profile: own
        ? parsed
        : {
            ...(audience.bio ? { aboutMe: parsed.aboutMe, pronouns: parsed.pronouns } : {}),
            ...(audience.theme ? { theme: parsed.theme } : {}),
          },
    };
  };
  app.get("/v1/orgs/:orgId/members/:userId/profile", auth, async (req) => {
    const p = parse(OrgMemberParams, req.params);
    return view(p.orgId, p.userId, me(req).userId);
  });
  app.put("/v1/orgs/:orgId/members/:userId/profile", auth, async (req) => {
    const p = parse(OrgMemberParams, req.params);
    const viewer = me(req).userId;
    if (viewer !== p.userId) throw forbidden("Only you can edit your community profile");
    view(p.orgId, p.userId, viewer);
    const body = parse(CommunityProfileBody, req.body);
    await ctx.ws.write((w) => {
      if (!ctx.authz.orgRole(p.orgId, viewer)) throw notFound("Member not found");
      const current = ctx.ws.get<Row>("community_profiles", {
        org_id: p.orgId,
        user_id: viewer,
      });
      if ((current?.rev ?? 0) !== body.baseRev) throw conflict("Your community profile changed on another device. Reload it before saving.");
      const row = {
        org_id: p.orgId,
        user_id: viewer,
        profile: JSON.stringify(body.profile),
        rev: body.baseRev + 1,
        updated_at: Date.now(),
      };
      w.upsert("community_profiles", row, {
        profile: row.profile,
        rev: row.rev,
        updated_at: row.updated_at,
      });
    });
    notifyOrg(ctx, p.orgId);
    return view(p.orgId, p.userId, viewer);
  });
}
