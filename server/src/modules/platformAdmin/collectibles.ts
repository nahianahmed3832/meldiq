import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import {
  CatalogItem,
  ItemId,
} from "../../shared/contracts/http/collectibles.js";
import { ApiError, forbidden } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import {
  CollectionService,
  ASSET_MAX,
  processAsset,
  serveAsset,
  readProfileMediaBody,
  createCollectibleUpload,
  completeCollectibleUpload,
} from "../accounts/index.js";
import { principal, requirePermission } from "./guards.js";
import type { AdminDeps } from "./dataRoutes.js";
export default async function collectibleAdminRoutes(
  app: FastifyInstance,
  d: AdminDeps,
) {
  const service = new CollectionService(d.ctx);
  const needs = {
    preHandler: async (
      req: Parameters<ReturnType<typeof requirePermission>>[0],
    ) => {
      await requirePermission(d.auth, d.audit, "collectibles.manage")(req);
      if (principal(req).grant.role !== "super_admin") {
        const p = principal(req);
        await d.audit.record({
          action: "collectible.permission",
          outcome: "denied",
          actorAccountId: p.account.id,
          actorRole: p.grant.role,
          requestId: String(req.id),
        });
        throw forbidden(
          "Only super administrators manage the collectible catalog",
        );
      }
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  };
  const audit = async (
    req: Parameters<typeof principal>[0],
    action: string,
    id: string,
  ) => {
    const p = principal(req);
    await d.audit.record({
      action,
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "collectible",
      targetId: id,
      reason: "Catalog management",
      requestId: String(req.id),
    });
  };
  const params = z.object({ id: ItemId });
  app.get("/admin/v1/profile-collectibles", needs, async () => ({
    items: service.catalog(),
  }));
  app.put("/admin/v1/profile-collectibles/:id", needs, async (req) => {
    const { id } = parse(params, req.params);
    const item = parse(CatalogItem, req.body);
    if (item.id !== id)
      throw new ApiError(400, "bad_request", "IDs must match");
    await service.save(item);
    await audit(req, "collectible.save", id);
    return { item: service.item(id) };
  });
  app.delete("/admin/v1/profile-collectibles/:id", needs, async (req) => {
    const { id } = parse(params, req.params);
    await service.save({ ...service.item(id), isActive: false });
    await audit(req, "collectible.deactivate", id);
    return { ok: true };
  });
  app.post("/admin/v1/profile-collectibles/:id/grant", needs, async (req) => {
    const { id } = parse(params, req.params);
    const { userId, reason } = parse(
      z.strictObject({
        userId: z.string().min(1).max(64),
        reason: z.string().trim().min(4).max(300),
      }),
      req.body,
    );
    await service.acquire(
      userId,
      id,
      `admin:${principal(req).account.id}:${reason}`,
      true,
    );
    await audit(req, "collectible.grant", id);
    return { ok: true };
  });
  app.post(
    "/admin/v1/profile-collectibles/assets",
    { ...needs, bodyLimit: ASSET_MAX },
    async (req) => {
      const asset = await processAsset(
        d.ctx,
        await readProfileMediaBody(req, ASSET_MAX, "Decoration assets"),
      );
      await audit(req, "collectible.asset", asset.id);
      return { asset };
    },
  );
  app.get(
    "/admin/v1/profile-collectibles/assets/:id/:variant",
    needs,
    async (req, reply) => serveAsset(d.ctx, req, reply, true),
  );
  app.post("/admin/v1/profile-collectibles/uploads", needs, async (req) => {
    const body = parse(
      z.strictObject({
        size: z.number().int().min(1).max(ASSET_MAX),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      req.body,
    );
    return createCollectibleUpload(d.ctx, principal(req).account.id, body);
  });
  app.post(
    "/admin/v1/profile-collectibles/uploads/:id/complete",
    needs,
    async (req) => {
      const { id } = parse(
        z.object({ id: z.string().regex(/^col-upload-[a-f0-9-]{36}$/) }),
        req.params,
      );
      const asset = await completeCollectibleUpload(
        d.ctx,
        principal(req).account.id,
        id,
      );
      await audit(req, "collectible.asset", asset.id);
      return { asset };
    },
  );
}
