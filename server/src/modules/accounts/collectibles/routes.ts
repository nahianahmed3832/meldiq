import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import {
  CATEGORIES,
  ItemId,
  CatalogQuery,
  EquipBody,
} from "../../../shared/contracts/http/collectibles.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { CollectionService, available } from "./service.js";
import { serveAsset, cleanupStaging } from "./assets.js";
export default async function collectionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const service = new CollectionService(ctx);
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await service.expireUnavailable();
      await cleanupStaging(ctx);
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
    const ownership = new Map(
      service.inventory(me(req).userId).map((x) => [x.decoration_id, x]),
    );
    const filtered = service.catalog().filter((x) => {
      const own = ownership.get(x.id);
      return (
        available(x) &&
        (!q.category || x.category === q.category) &&
        (!q.q ||
          (x.name + " " + x.description)
            .toLowerCase()
            .includes(q.q.toLowerCase())) &&
        (q.filter === "owned" || q.filter === "recent"
          ? !!own
          : q.filter === "unowned"
            ? !own
            : q.filter === "favorites"
              ? !!own?.is_favorite
              : true)
      );
    });
    if (q.filter === "recent")
      filtered.sort(
        (a, b) =>
          (ownership.get(b.id)?.acquired_at ?? 0) -
            (ownership.get(a.id)?.acquired_at ?? 0) ||
          a.id.localeCompare(b.id, "en"),
      );
    // Cursor IDs refer to this filtered order, including acquisition-time ordering.
    const all = q.after
      ? filtered.slice(
          Math.max(0, filtered.findIndex((x) => x.id === q.after) + 1),
        )
      : filtered;
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
        await service.favorite(
          me(req).userId,
          parse(params, req.params).id,
          method === "PUT",
        );
        return { ok: true };
      },
    });
  app.get("/v2/users/me/profile-customization", auth, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return service.state(me(req).userId);
  });
  app.patch(
    "/v2/users/me/profile-customization",
    { ...auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const body = parse(EquipBody, req.body);
      return service.equip(me(req).userId, body.baseStyleRevision, body.slots);
    },
  );
  app.get(
    "/v2/profile-collectibles/assets/:id/:variant",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (req, reply) => serveAsset(ctx, req, reply),
  );
}
