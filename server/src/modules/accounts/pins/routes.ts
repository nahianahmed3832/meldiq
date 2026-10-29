import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { CreatePinQuery, zCommunityPinId, zPinId } from "../../../shared/contracts/http/pins.js";
import { notFound } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { readBody } from "../profileMediaRoutes.js";
import { PIN_LIMITS } from "./service.js";

const orgParams = z.strictObject({ orgId: z.string() });
const pinParams = z.strictObject({ orgId: z.string(), pinId: zCommunityPinId });
const holderParams = z.strictObject({ orgId: z.string(), pinId: zCommunityPinId, userId: z.string() });

/** Profile pins (API 0.64.0, docs/PROFILE_PINS.md): Meldiq's catalog, images, and a community's own pins. */
export default async function pinRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  const pins = ctx.pins;
  const MANAGE = "Only the community's owners and admins can make and give its pins";
  const manager = (orgId: string, userId: string) => ctx.authz.requirePermission(orgId, userId, "workspace.edit", MANAGE);

  app.get("/v2/pins", auth, async () => ({ pins: pins.catalog() }));

  // Anyone may load these (they're shown on public profiles), so an <img> or an image loader needs no sign-in.
  app.get("/v2/pins/:id/image", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id } = parse(z.strictObject({ id: zPinId }), req.params);
    const image = await pins.image(id);
    if (!image) throw notFound("Not found");
    return reply
      .header("content-type", image.type)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", image.immutable ? "public, max-age=31536000, immutable" : "public, max-age=86400")
      .send(image.body);
  });

  app.get("/v2/orgs/:orgId/pins", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(orgParams, req.params);
    ctx.authz.requireOrgMember(orgId, userId);
    return { pins: pins.communityPins(orgId), canManage: ctx.authz.can(orgId, userId, "workspace.edit"), limit: PIN_LIMITS.perCommunity };
  });

  app.post("/v2/orgs/:orgId/pins", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (req, reply) => {
    const { userId } = me(req);
    const { orgId } = parse(orgParams, req.params);
    manager(orgId, userId);
    const { name, description } = parse(CreatePinQuery, req.query);
    const buf = await readBody(req, PIN_LIMITS.bytes, "Pins");
    const p = await pins.create(orgId, userId, name, description ?? null, buf);
    return reply.status(201).send({ pin: pins.view(p) });
  });

  app.delete("/v2/orgs/:orgId/pins/:pinId", auth, async (req) => {
    const { userId } = me(req);
    const { orgId, pinId } = parse(pinParams, req.params);
    manager(orgId, userId);
    await pins.remove(pins.pinOf(orgId, pinId), userId);
    return { ok: true as const };
  });

  app.get("/v2/orgs/:orgId/pins/:pinId/holders", auth, async (req) => {
    const { userId } = me(req);
    const { orgId, pinId } = parse(pinParams, req.params);
    ctx.authz.requireOrgMember(orgId, userId);
    return { holders: pins.holders(pins.pinOf(orgId, pinId).id) };
  });

  app.put("/v2/orgs/:orgId/pins/:pinId/holders/:userId", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId, pinId, userId } = parse(holderParams, req.params);
    manager(orgId, actor);
    await pins.award(pins.pinOf(orgId, pinId), userId, actor);
    return { ok: true as const };
  });

  app.delete("/v2/orgs/:orgId/pins/:pinId/holders/:userId", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId, pinId, userId } = parse(holderParams, req.params);
    manager(orgId, actor);
    await pins.revoke(pins.pinOf(orgId, pinId), userId, actor);
    return { ok: true as const };
  });
}
