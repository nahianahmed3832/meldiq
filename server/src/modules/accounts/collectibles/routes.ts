import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { CATEGORIES, ItemId, CatalogQuery, EquipBody } from "../../../shared/contracts/http/collectibles.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { CollectionService, available } from "./service.js";
import { serveAsset } from "./assets.js";
export default async function collectionRoutes(app: FastifyInstance, ctx: AppContext) {
  const service = new CollectionService(ctx);
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await service.expireUnavailable();
    } catch (err) {
      ctx.log.error({ err }, "Collectible availability sweep failed");
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void sweep(), 60000);
  timer.unref();
  app.addHook("onReady", async () => {
    await sweep();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
  const auth = {
    preHandler: requireAuth(ctx),
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  };
  const params = z.object({ id: ItemId });
  app.get("/v2/profile-collectibles/categories", auth, async () => ({
    categories: CATEGORIES,
  }));
  app.get("/v2/profile-collectibles", auth, async (req, reply) => {
    const q = parse(CatalogQuery, req.query);
    reply.header("cache-control", "private, no-cache");
    const all = service
      .catalog()
      .filter((x) => available(x) && (!q.category || x.category === q.category) && (!q.q || (x.name + " " + x.description).toLowerCase().includes(q.q.toLowerCase())) && (!q.after || x.id > q.after));
    const items = all.slice(0, q.limit);
    return { items, next: all.length > q.limit ? items.at(-1)!.id : null };
  });
  app.get("/v2/profile-collectibles/:id", auth, async (req) => ({
    item: service.item(parse(params, req.params).id),
  }));
  app.get("/v2/users/me/profile-collectibles", auth, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return { inventory: service.inventory(me(req).userId) };
  });
  app.post("/v2/users/me/profile-collectibles/:id/claim", auth, async (req) => {
    await service.acquire(me(req).userId, parse(params, req.params).id);
    return { inventory: service.inventory(me(req).userId) };
  });
  for (const method of ["PUT", "DELETE"] as const)
    app.route({
      method,
      url: "/v2/users/me/profile-collectibles/:id/favorite",
      ...auth,
      handler: async (req) => {
        await service.favorite(me(req).userId, parse(params, req.params).id, method === "PUT");
        return { ok: true };
      },
    });
  app.get("/v2/users/me/profile-customization", auth, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return service.state(me(req).userId);
  });
  app.patch("/v2/users/me/profile-customization", { ...auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = parse(EquipBody, req.body);
    return service.equip(me(req).userId, body.baseStyleRevision, body.slots);
  });
  app.get("/v2/profile-collectibles/assets/:id/:variant", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => serveAsset(ctx, req, reply));
}
