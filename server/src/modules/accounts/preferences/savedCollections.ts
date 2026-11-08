import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../../app/context.js";
import { ApiError } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { EMPTY_PREFS } from "./schema.js";
import { SavedCollection, SavedCollectionOp } from "../../../shared/contracts/http/webExperience.js";

// The existing workspace preferences API rejects this reserved key because it is neither personal nor an org.
const KEY = "saved-collections";
type Collection = z.infer<typeof SavedCollection>;

export default async function savedCollectionRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = {
    preHandler: requireAuth(ctx),
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  };
  const visibleSavedIds = async (userId: string) => {
    const prefs = await ctx.prefs.get(userId, "personal");
    const access = new Map<string, boolean>();
    return new Set((prefs?.prefs.saved ?? []).filter((s) => {
      if (!access.has(s.conversationId)) access.set(s.conversationId, ctx.authz.isMember(s.conversationId, userId));
      return access.get(s.conversationId);
    }).map((s) => s.messageId));
  };
  const visible = (items: Collection[], allowed: Set<string>) =>
    items.map((c) => ({ ...c, messageIds: c.messageIds.filter((id) => allowed.has(id)) }));

  app.get("/v2/me/saved-collections", auth, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { userId } = me(req);
    const [doc, allowed] = await Promise.all([ctx.prefs.get(userId, KEY), visibleSavedIds(userId)]);
    return { collections: visible(doc?.prefs.savedCollections ?? [], allowed) };
  });

  app.post("/v2/me/saved-collections", auth, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { userId } = me(req);
    const op = parse(SavedCollectionOp, req.body);
    for (let attempt = 0; attempt < 5; attempt++) {
      const [doc, allowed] = await Promise.all([ctx.prefs.get(userId, KEY), visibleSavedIds(userId)]);
      let items = visible(doc?.prefs.savedCollections ?? [], allowed);
      const current = items.find((c) => c.id === op.id);
      if (op.op === "create") {
        if (current) return { collections: items }; // retry after a lost response
        if (items.length >= 20) throw new ApiError(409, "limit_reached", "You can create up to 20 collections.");
        items.push({ id: op.id, name: op.name, messageIds: [] });
      } else if (op.op === "delete") {
        items = items.filter((c) => c.id !== op.id);
      } else {
        if (!current) throw new ApiError(404, "not_found", "Collection not found.");
        if (op.op === "rename") current.name = op.name;
        else if (op.op === "remove") current.messageIds = current.messageIds.filter((id) => id !== op.messageId);
        else {
          if (!allowed.has(op.messageId)) throw new ApiError(404, "not_found", "Saved message not found.");
          if (!current.messageIds.includes(op.messageId)) {
            if (current.messageIds.length >= 100) throw new ApiError(409, "limit_reached", "This collection can hold up to 100 messages.");
            current.messageIds.push(op.messageId);
          }
        }
      }
      const result = await ctx.prefs.put(userId, KEY, { ...EMPTY_PREFS, savedCollections: items }, doc?.rev ?? 0, Date.now());
      if (result.ok) return { collections: items };
    }
    throw new ApiError(409, "stale_preferences", "Your collections changed on another device. Try again.");
  });
}
