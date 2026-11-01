import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod/v4";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { AssetId } from "../../../shared/contracts/http/collectibles.js";
import { ApiError, badRequest, notFound } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";

import { sniff } from "../mediaFormats.js";
import { CollectionService, available } from "./service.js";
export const ASSET_MAX = 6 * 1024 * 1024;
export const Asset = z.object({
  id: AssetId,
  width: z.number(),
  height: z.number(),
  frames: z.number(),
  format: z.string(),
  variants: z.record(z.string(), z.object({ blob: z.string(), type: z.string(), bytes: z.number() })),
});
export type Asset = z.infer<typeof Asset>;
let active = 0;
export async function processAsset(ctx: AppContext, input: Buffer): Promise<Asset> {
  if (active >= 2) throw new ApiError(429, "rate_limited", "Asset processing is busy. Try again shortly.");
  active++;
  try {
    return await processAssetUnchecked(ctx, input);
  } finally {
    active--;
  }
}
async function processAssetUnchecked(ctx: AppContext, input: Buffer): Promise<Asset> {
  if (!input.length || input.length > ASSET_MAX) throw badRequest("Assets must be between 1 byte and 6 MB");
  const format = sniff(input);
  if (!["png", "webp", "gif", "jpeg"].includes(format ?? "")) throw badRequest("Upload PNG, WebP, GIF or JPEG. SVG and executable animation documents are not accepted.");
  const id = createHash("sha256").update(input).digest("hex");
  const existing = ctx.identity.get<{ metadata: string }>("profile_collectible_assets", { id });
  if (existing) return Asset.parse(JSON.parse(existing.metadata));
  let outputs: Record<string, { body: Buffer; type: string }>;
  let meta;
  try {
    meta = await sharp(input, {
      animated: true,
      limitInputPixels: 32_000_000,
      failOn: "warning",
    }).metadata();
    const width = meta.width ?? 0,
      height = meta.pageHeight ?? meta.height ?? 0,
      frames = meta.pages ?? 1;
    if (width < 32 || height < 32 || width > 2048 || height > 2048 || frames > 120 || width * height * frames > 32_000_000) throw Error("dimensions");
    const still = () =>
      sharp(input, {
        page: 0,
        pages: 1,
        limitInputPixels: 32_000_000,
        failOn: "warning",
      });
    outputs = {
      original: {
        body: input,
        type: format === "jpeg" ? "image/jpeg" : `image/${format}`,
      },
      full: {
        body: await sharp(input, {
          animated: true,
          limitInputPixels: 32_000_000,
          failOn: "warning",
        })
          .resize({
            width: 1200,
            height: 1200,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 85, effort: 3 })
          .toBuffer(),
        type: "image/webp",
      },
      poster: {
        body: await still()
          .resize({
            width: 1200,
            height: 1200,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toBuffer(),
        type: "image/webp",
      },
      thumbnail: {
        body: await still()
          .resize({
            width: 256,
            height: 256,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 78 })
          .toBuffer(),
        type: "image/webp",
      },
      avif: {
        body: await still()
          .resize({
            width: 1200,
            height: 1200,
            fit: "inside",
            withoutEnlargement: true,
          })
          .avif({ quality: 55, effort: 2 })
          .toBuffer(),
        type: "image/avif",
      },
    };
  } catch {
    throw badRequest("Image could not be decoded safely. Use 32–2048 px, at most 120 frames and 32 million decoded pixels.");
  }
  const variants: Asset["variants"] = {};
  for (const [name, output] of Object.entries(outputs)) {
    const blob = `col-${id}-${name}`;
    const file = path.join(ctx.blobs.spoolDir, `collectible-${randomUUID()}.part`);
    try {
      await fs.writeFile(file, output.body, { mode: 0o600 });
      await ctx.blobs.putFile("profile-photos", blob, file, output.body.length, createHash("sha256").update(output.body).digest("hex"));
    } finally {
      await fs.rm(file, { force: true });
    }
    variants[name] = { blob, type: output.type, bytes: output.body.length };
  }
  const asset: Asset = {
    id,
    width: meta.width!,
    height: meta.pageHeight ?? meta.height!,
    frames: meta.pages ?? 1,
    format: format!,
    variants,
  };
  await ctx.identity.write((w) => w.insert("profile_collectible_assets", { id, metadata: JSON.stringify(asset), created_at: Date.now() }, { orIgnore: true }));
  return asset;
}
export async function serveAsset(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, admin = false) {
  const { id, variant } = parse(
    z.object({
      id: AssetId,
      variant: z.enum(["full", "poster", "thumbnail", "avif", "original"]),
    }),
    req.params,
  );
  if (!admin && !new CollectionService(ctx).catalog().some((x) => available(x) && x.recipe.assetId === id)) throw notFound("Asset not found");
  const row = ctx.identity.get<{ metadata: string }>("profile_collectible_assets", { id });
  if (!row) throw notFound("Asset not found");
  const chosen = Asset.parse(JSON.parse(row.metadata)).variants[variant];
  const stream = await ctx.blobs.get("profile-photos", chosen.blob);
  if (!stream) throw notFound("Asset not found");
  const etag = `"${id}-${variant}"`;
  reply
    .header("etag", etag)
    .header("cache-control", admin ? "no-store" : "public, max-age=86400")
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox");
  if (req.headers["if-none-match"] === etag) {
    stream.destroy();
    return reply.status(304).send();
  }
  return reply.type(chosen.type).send(stream);
}
export async function boundedBlob(ctx: AppContext, id: string, max: number) {
  const stream = await ctx.blobs.get("profile-photos", id);
  if (!stream) throw notFound("Upload not found");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of stream) {
    const b = Buffer.from(part);
    size += b.length;
    if (size > max) {
      stream.destroy();
      throw new ApiError(413, "too_large", "Upload is too large");
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
