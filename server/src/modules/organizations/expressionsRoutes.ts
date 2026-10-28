import crypto from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { IdParamsNonEmpty, OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
import { ExpressionRenameBody, ExpressionUploadQuery } from "../../shared/contracts/http/expressions.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { storePhoto } from "../accounts/photos.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { deleteBlobNow } from "../files/routes.js";
import { notifyOrg } from "./orgsRoutes.js";
import type { RowReader } from "../../infrastructure/database/rows/index.js";

/**
 * A community's own emoji and stickers (batch B9, matrix EXP-04/05). Members see and use them; people with
 * `expressions.manage` upload (PNG, GIF or WebP up to 256 KiB), rename and remove them. Messages carry the emoji's id
 * and hash next to its `:name:`, inside the encryption, so a phone can fetch the image and check it.
 */
export const EXPRESSION_LIMITS = { emoji: 50, sticker: 20, bytes: 256 * 1024 } as const;
export const EXPRESSION_NAME = /^[a-z0-9_]{2,32}$/;
type Kind = "emoji" | "sticker";

interface ExpressionRow {
  id: string;
  org_id: string;
  kind: Kind;
  name: string;
  mime: string;
  animated: number;
  sha256: string;
  size: number;
  created_by: string;
  created_at: number;
}

/** The image type from its first bytes, and whether it moves; null for anything else. */
export function imageKind(b: Buffer): { mime: string; animated: boolean } | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", animated: b.includes(Buffer.from("acTL")) };
  }
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF89a" || b.subarray(0, 6).toString("latin1") === "GIF87a")) {
    // More than one image descriptor after the header means frames.
    let frames = 0;
    for (let i = 13; i < b.length && frames < 2; i++) if (b[i] === 0x2c) frames++;
    return { mime: "image/gif", animated: frames > 1 };
  }
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    return { mime: "image/webp", animated: b.includes(Buffer.from("ANIM")) };
  }
  return null;
}

async function readImage(req: FastifyRequest): Promise<Buffer> {
  const body = req.body as Readable | undefined;
  if (!body || typeof body.pipe !== "function") throw badRequest("Expected application/octet-stream body");
  const tooLarge = () => new ApiError(413, "too_large", "Emoji and stickers can be up to 256 KB");
  if (Number(req.headers["content-length"] ?? Number.NaN) > EXPRESSION_LIMITS.bytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    size += (c as Buffer).length;
    if (size > EXPRESSION_LIMITS.bytes) {
      body.destroy();
      throw tooLarge();
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export default async function expressionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, ws, authz } = ctx;
  const auth = { preHandler: requireAuth(ctx) };

  const view = (r: ExpressionRow) => ({
    id: r.id, orgId: r.org_id, kind: r.kind, name: r.name, animated: !!r.animated, sha256: r.sha256, size: r.size,
    createdBy: (db.prepare("SELECT display_name FROM users WHERE id = ?").get(r.created_by) as { display_name: string } | undefined)?.display_name ?? null,
    createdAt: r.created_at,
  });
  const load = (id: string) => ws.get<ExpressionRow>("community_expressions", { id });
  const requireManager = (orgId: string, userId: string) => {
    authz.requireOrgMember(orgId, userId);
    if (!authz.can(orgId, userId, "expressions.manage")) throw forbidden("Your role doesn't include managing emoji and stickers");
  };

  app.get("/v1/orgs/:orgId/expressions", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    authz.requireOrgMember(orgId, me(req).userId);
    const rows = ws.all<ExpressionRow>("community_expressions", { where: { org_id: orgId }, orderBy: [["kind", "asc"], ["name", "asc"]] });
    return { expressions: rows.map(view), limits: { emoji: EXPRESSION_LIMITS.emoji, sticker: EXPRESSION_LIMITS.sticker } };
  });

  /** Uploads one: `?kind=emoji|sticker&name=party_parrot`, the image as the body. */
  app.post("/v1/orgs/:orgId/expressions", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const userId = me(req).userId;
    const q = parse(ExpressionUploadQuery, req.query);
    requireManager(orgId, userId);
    if (!EXPRESSION_NAME.test(q.name)) throw badRequest("Names are 2–32 letters, digits or _ (lowercase)");
    // Checked before the upload (a quick answer) and again just before the row is written (B13: two uploads at once
    // both passed the first check across the awaits below, giving two emoji the same name).
    const roomFor = (rows: RowReader = ws) => {
      const count = rows.count("community_expressions", { org_id: orgId, kind: q.kind });
      if (count >= EXPRESSION_LIMITS[q.kind]) throw new ApiError(409, "limit_reached", `A community has room for ${EXPRESSION_LIMITS[q.kind]} ${q.kind === "emoji" ? "emoji" : "stickers"}`);
      if (rows.get("community_expressions", { org_id: orgId, kind: q.kind, name: q.name })) throw conflict("That name is taken in this community");
    };
    roomFor();
    const buf = await readImage(req);
    const kind = imageKind(buf);
    if (!kind) throw badRequest("Use a PNG, GIF or WebP image");
    const id = newId(q.kind === "emoji" ? "emj" : "stk");
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    await storePhoto(ctx, id, buf);
    try {
      await ws.write((w) => {
        roomFor(w);
        w.insert("community_expressions", {
          id,
          org_id: orgId,
          kind: q.kind,
          name: q.name,
          mime: kind.mime,
          animated: kind.animated ? 1 : 0,
          sha256,
          size: buf.length,
          created_by: userId,
          created_at: now(),
        });
      });
    } catch (e) {
      await deleteBlobNow(ctx, "profile-photos", id);
      throw e;
    }
    ctx.audit({ actorId: userId, orgId, action: `expression.add`, target: id, detail: `${q.kind} :${q.name}:` });
    notifyOrg(ctx, orgId);
    return { expression: view(load(id)!) };
  });

  app.patch("/v1/expressions/:id", auth, async (req) => {
    const { id } = parse(IdParamsNonEmpty, req.params);
    const userId = me(req).userId;
    const { name } = parse(ExpressionRenameBody, req.body);
    const r = load(id);
    if (!r) throw notFound("Not found");
    requireManager(r.org_id, userId);
    if (!EXPRESSION_NAME.test(name)) throw badRequest("Names are 2–32 letters, digits or _ (lowercase)");
    await ws.write((w) => {
      if (w.get("community_expressions", { org_id: r.org_id, kind: r.kind, name, id: { ne: id } })) throw conflict("That name is taken in this community");
      w.update("community_expressions", { id }, { name });
    });
    ctx.audit({ actorId: userId, orgId: r.org_id, action: "expression.rename", target: id, detail: `:${r.name}: → :${name}:` });
    notifyOrg(ctx, r.org_id);
    return { expression: view(load(id)!) };
  });

  app.delete("/v1/expressions/:id", auth, async (req) => {
    const { id } = parse(IdParamsNonEmpty, req.params);
    const userId = me(req).userId;
    const r = load(id);
    if (!r) return { ok: true };
    requireManager(r.org_id, userId);
    await ws.write((w) => w.delete("community_expressions", { id }));
    await deleteBlobNow(ctx, "profile-photos", id);
    ctx.audit({ actorId: userId, orgId: r.org_id, action: "expression.remove", target: id, detail: `${r.kind} :${r.name}:` });
    notifyOrg(ctx, r.org_id);
    return { ok: true };
  });

  /** The image, for the community's members (people outside it see the message's `:name:` text instead). */
  app.get("/v1/expressions/:id/image", auth, async (req, reply) => {
    const { id } = parse(IdParamsNonEmpty, req.params);
    const r = load(id);
    if (!r || !authz.orgRole(r.org_id, me(req).userId)) throw notFound("Not found");
    const stream = await ctx.blobs.get("profile-photos", id);
    if (!stream) throw notFound("Not found");
    return reply.header("content-type", r.mime).header("cache-control", "private, max-age=86400").header("etag", `"${r.sha256}"`).send(stream);
  });
}
