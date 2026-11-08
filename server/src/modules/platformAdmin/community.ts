import type { FastifyInstance } from "fastify";
import { AdminCommunityChange } from "../../shared/contracts/http/adminCommunity.js";
import { STICKER_MAX_BYTES, STICKER_MAX_DIMENSION } from "../../shared/contracts/http/expressions.js";
import { AdminOrgParams } from "../../shared/contracts/http/platformAdmin.js";
import { notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { parse } from "../../shared/validation/index.js";
import { COMMUNITY_OFFERS } from "../billing/providers/communityPayPal.js";
import { notifyOrg, readPingRoles, updatePingRoles } from "../organizations/index.js";
import type { AdminDeps } from "./dataRoutes.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import type { Permission } from "./permissions.js";

export default async function adminCommunityRoutes(app: FastifyInstance, d: AdminDeps) {
  const { ctx } = d;
  const needs = (permission: Permission) => ({ preHandler: requirePermission(d.auth, d.audit, permission) });
  const requireCommunity = (id: string) => {
    if (!ctx.ws.get("orgs", { id, kind: "community" })) throw notFound("Community not found");
  };
  const view = (id: string) => {
    const { emojiSlots, stickerSlots } = ctx.mojo.levelOf(id);
    const discovery = ctx.discovery.settingsView(id);
    return {
      voiceClips: ctx.communitySettings.clipsPolicy(id),
      pingRoles: readPingRoles(ctx.ws, id),
      expressions: {
        emojiUsed: ctx.ws.count("community_expressions", { org_id: id, kind: "emoji" }),
        emojiSlots,
        stickerUsed: ctx.ws.count("community_expressions", { org_id: id, kind: "sticker" }),
        stickerSlots,
        stickerMaxBytes: STICKER_MAX_BYTES,
        stickerMaxDimension: STICKER_MAX_DIMENSION,
      },
      discovery: {
        enabled: ctx.discovery.config.enabled,
        listed: discovery.listed,
        discoverable: discovery.discoverable,
        reason: discovery.reason,
        tags: discovery.tags,
      },
    };
  };

  app.get("/admin/v1/orgs/:orgId/community-features", needs("orgs.view"), async (req) => {
    const { orgId } = parse(AdminOrgParams, req.params);
    requireCommunity(orgId);
    return view(orgId);
  });

  app.put("/admin/v1/orgs/:orgId/community-features", needs("orgs.members.manage"), async (req) => {
    const { orgId } = parse(AdminOrgParams, req.params);
    requireCommunity(orgId);
    const body = parse(AdminCommunityChange, req.body);
    const p = principal(req);
    if (body.kind === "voice_clips") {
      const key = ctx.communitySettings.clipsPolicyKey(orgId);
      await ctx.platform.write((w) => {
        if (body.blocked) {
          w.upsert("platform_settings", { key, value: "true", updated_at: now(), updated_by: p.account.id }, "replace");
        } else {
          w.delete("platform_settings", { key });
        }
      });
    } else {
      await updatePingRoles(ctx, orgId, body);
    }
    await d.audit.record({
      action: `community.${body.kind}`,
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "org",
      targetId: orgId,
      requestId: metaOf(req).requestId,
      reason: body.reason,
      detail: body.kind === "voice_clips" ? { blocked: body.blocked } : { previousRevision: body.rev, roles: body.roles.length },
    });
    notifyOrg(ctx, orgId);
    return view(orgId);
  });

  app.get("/admin/v1/billing/community-offers", needs("billing.view"), async () => ({
    currency: "USD",
    offers: Object.entries(COMMUNITY_OFFERS).map(([id, { cents, interval, min, max }]) => ({
      id, cents, interval, min, max,
      // These are the recurring offers. The legacy one-time Sparks and Promote adapter have separate lifecycles.
      checkoutAvailable: false,
    })),
  }));
}
