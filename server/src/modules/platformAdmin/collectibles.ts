import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { CatalogItem, ItemId } from "../../shared/contracts/http/collectibles.js";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { readBody } from "../accounts/profileMediaRoutes.js";
import { ASSET_MAX, processAsset, serveAsset, boundedBlob } from "../accounts/collectibles/assets.js";
import { CollectionService } from "../accounts/collectibles/service.js";
import { principal, requirePermission } from "./guards.js";
import type { AdminDeps } from "./dataRoutes.js";
export default async function collectibleAdminRoutes(app: FastifyInstance, d: AdminDeps) {
  const service = new CollectionService(d.ctx);
  const needs = {
    preHandler: async (req: Parameters<ReturnType<typeof requirePermission>>[0]) => {
      await requirePermission(d.auth, d.audit, "decorations.review")(req);
      if (principal(req).grant.role !== "super_admin") {
        const p = principal(req);
        await d.audit.record({
          action: "collectible.permission",
          outcome: "denied",
          actorAccountId: p.account.id,
          actorRole: p.grant.role,
          requestId: String(req.id),
        });
        throw forbidden("Only super administrators manage the collectible catalog");
      }
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  };
  const audit = async (req: Parameters<typeof principal>[0], action: string, id: string) => {
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
    if (item.id !== id) throw new ApiError(400, "bad_request", "IDs must match");
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
    if (!d.ctx.identity.get("users", { id: userId })) throw notFound("User not found");
    await service.acquire(userId, id, `admin:${principal(req).account.id}:${reason}`, true);
    await audit(req, "collectible.grant", id);
    return { ok: true };
  });
  app.post("/admin/v1/profile-collectibles/assets", { ...needs, bodyLimit: ASSET_MAX }, async (req) => {
    const asset = await processAsset(d.ctx, await readBody(req, ASSET_MAX, "Decoration assets"));
    await audit(req, "collectible.asset", asset.id);
    return { asset };
  });
  app.get("/admin/v1/profile-collectibles/assets/:id/:variant", needs, async (req, reply) => serveAsset(d.ctx, req, reply, true));
  app.post("/admin/v1/profile-collectibles/uploads", needs, async (req) => {
    for (const old of d.ctx.identity.all<{ id: string }>("profile_collectible_uploads", { where: { expires_at: { lt: Date.now() } }, limit: 50 })) {
      await d.ctx.blobs.delete("profile-photos", old.id);
      await d.ctx.identity.write((w) => w.delete("profile_collectible_uploads", { id: old.id }));
    }
    const body = parse(
      z.strictObject({
        size: z.number().int().min(1).max(ASSET_MAX),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      req.body,
    );
    const direct = d.ctx.blobs.direct;
    if (!direct) throw new ApiError(409, "direct_unavailable", "Use the server upload on this storage backend");
    const id = `col-upload-${randomUUID()}`;
    const expires = Date.now() + 300000;
    const upload = await direct.presignPut("profile-photos", id, body.size, Buffer.from(body.sha256, "hex").toString("base64"), 300);
    await d.ctx.identity.write((w) =>
      w.insert("profile_collectible_uploads", {
        id,
        actor_id: principal(req).account.id,
        size: body.size,
        sha256: body.sha256,
        expires_at: expires,
      }),
    );
    return { id, upload };
  });
  app.post("/admin/v1/profile-collectibles/uploads/:id/complete", needs, async (req) => {
    const { id } = parse(z.object({ id: z.string().regex(/^col-upload-[a-f0-9-]{36}$/) }), req.params);
    const row = d.ctx.identity.get<{
      actor_id: string;
      size: number;
      sha256: string;
      expires_at: number;
    }>("profile_collectible_uploads", { id });
    if (!row || row.actor_id !== principal(req).account.id || row.expires_at < Date.now()) throw notFound("Upload expired or not found");
    const bytes = await boundedBlob(d.ctx, id, row.size);
    if (bytes.length !== row.size || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new ApiError(400, "bad_upload", "Size or checksum mismatch");
    const asset = await processAsset(d.ctx, bytes);
    await d.ctx.blobs.delete("profile-photos", id);
    await d.ctx.identity.write((w) => w.delete("profile_collectible_uploads", { id }));
    await audit(req, "collectible.asset", asset.id);
    return { asset };
  });
}
