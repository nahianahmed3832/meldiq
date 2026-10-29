import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { SubmitDecorationQuery, zDecorationId } from "../../../shared/contracts/http/decorations.js";
import { idParams } from "../../../shared/contracts/http/primitives.js";
import { notFound } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { readBody } from "../profileMediaRoutes.js";
import { builtinDir, CLASSIC_DECORATIONS, DECORATION_LIMITS } from "./service.js";

const decorationParams = z.strictObject({ id: zDecorationId });

type Image = { type: string; body: NodeJS.ReadableStream | Buffer; immutable: boolean };

function sendImage(reply: FastifyReply, image: Image | null, cache: string) {
  if (!image) throw notFound("Not found");
  return reply.header("content-type", image.type).header("x-content-type-options", "nosniff").header("cache-control", image.immutable ? "public, max-age=31536000, immutable" : cache).send(image.body);
}

/** Profile decorations (API 0.60.0, docs/PROFILE_DECORATIONS.md): the catalog, images, and sending your own in. */
export default async function decorationRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const deco = ctx.decorations;

  app.get("/v2/decorations", auth, async () => ({ decorations: deco.catalog(), classic: [...CLASSIC_DECORATIONS], templateUrl: "/v2/decorations/template" }));

  // Anyone may load these (they're shown on public profiles), so an <img> or an image loader needs no sign-in.
  app.get("/v2/decorations/:id/image", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id } = parse(decorationParams, req.params);
    return sendImage(reply, await deco.publicImage(id), "public, max-age=86400");
  });

  app.get("/v2/decorations/template", async (_req, reply) => {
    const file = path.join(builtinDir(), "template.png");
    if (!fs.existsSync(file)) throw notFound("Not found");
    return reply.header("content-type", "image/png").header("cache-control", "public, max-age=86400").header("content-disposition", 'attachment; filename="meldiq-decoration-template.png"').send(fs.createReadStream(file));
  });

  app.get("/v2/decorations/mine", auth, async (req) => deco.mine(me(req).userId));

  app.get("/v2/decorations/mine/:id/image", auth, async (req, reply) => {
    const { id } = parse(decorationParams, req.params);
    return sendImage(reply, await deco.ownImage(me(req).userId, id), "private, max-age=3600");
  });

  app.post("/v2/decorations", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req, reply) => {
    const { userId } = me(req);
    const { name } = parse(SubmitDecorationQuery, req.query);
    const buf = await readBody(req, DECORATION_LIMITS.bytes, "Decorations");
    const d = await deco.submit(userId, name, buf);
    return reply.status(201).send({ submission: deco.submissionView(d) });
  });

  app.delete("/v2/decorations/mine/:id", auth, async (req) => {
    const { id } = parse(decorationParams, req.params);
    await deco.withdraw(me(req).userId, id);
    return { ok: true as const };
  });

  app.get("/v2/users/:id/decorations", auth, async (req) => {
    const { id } = parse(idParams, req.params);
    if (!ctx.identity.get("users", { id, disabled_at: null })) throw notFound("User not found");
    return { decorations: deco.creations(id) };
  });
}
