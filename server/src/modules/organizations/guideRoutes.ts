import type { FastifyInstance } from "fastify";
import { GUIDE_LIMITS, OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
import { GuideBody, type GuideItemBody } from "../../shared/contracts/http/onboarding.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { ApiError, forbidden } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { notifyOrg } from "./orgsRoutes.js";

/**
 * The community guide (batch B8b, matrix COM-17, Discord's Server Guide): a welcome line, up to five "Get started"
 * tasks that each open a channel, and up to five resources. Plaintext configuration like the community's rules; set
 * by people who can edit the community. Which tasks someone did is kept on their phone.
 */
export { GUIDE_LIMITS };

export interface GuideItem {
  id: string;
  title: string;
  channelId: string;
}
export interface Guide {
  welcome: string | null;
  tasks: GuideItem[];
  resources: GuideItem[];
}

/**
 * A community's guide as [viewerId] sees it, or null without one. Items whose channel is gone are left out, and so are
 * channels the viewer can't see (B13: a private channel's id reached every member), except for people who edit the
 * guide, so saving it never drops what they can't open.
 */
export function guideOf(ctx: AppContext, org: { id: string; guide?: string | null }, viewerId: string): Guide | null {
  if (!org.guide) return null;
  try {
    const g = JSON.parse(org.guide) as Guide;
    const editor = ctx.authz.can(org.id, viewerId, "workspace.edit");
    const live = (i: GuideItem) => {
      const c = ctx.authz.conversation(i.channelId);
      return !!c && c.org_id === org.id && !c.archived_at && (editor || ctx.authz.canViewChannel(c, viewerId));
    };
    return { welcome: g.welcome ?? null, tasks: (g.tasks ?? []).filter(live), resources: (g.resources ?? []).filter(live) };
  } catch {
    return null;
  }
}

export default async function guideRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, authz } = ctx;
  const auth = { preHandler: requireAuth(ctx) };

  app.put("/v1/orgs/:orgId/guide", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    const body = parse(GuideBody, req.body);
    authz.requireOrgMember(orgId, userId);
    if (!authz.can(orgId, userId, "workspace.edit")) throw forbidden("Your role doesn't include changing the community guide");
    const items = (list: GuideItemBody[]) =>
      list.map((i) => {
        const c = authz.conversation(i.channelId);
        if (!c || c.type !== "CHANNEL" || c.org_id !== orgId) throw new ApiError(400, "channel_not_found", "Pick a channel of this community", { channelId: i.channelId });
        return { id: i.id && /^[A-Za-z0-9_-]{1,32}$/.test(i.id) ? i.id : newId("g"), title: i.title, channelId: i.channelId };
      });
    const guide: Guide | null = body && { welcome: body.welcome || null, tasks: items(body.tasks), resources: items(body.resources) };
    const empty = !guide || (!guide.welcome && guide.tasks.length === 0 && guide.resources.length === 0);
    await ctx.ws.write((w) => w.update("orgs", { id: orgId }, { guide: empty ? null : JSON.stringify(guide) }));
    ctx.audit({ actorId: userId, orgId, action: "community.guide", target: orgId });
    notifyOrg(ctx, orgId);
    return { guide: empty ? null : guide };
  });
}
