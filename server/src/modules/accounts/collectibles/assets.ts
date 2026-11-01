import { COLLECTIBLE_DECODED_PIXELS, COLLECTIBLE_PROCESSORS } from "./limits.js";
import { safeSvg, lottieWebp } from "./vectors.js";
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
  variants: z.record(
    z.string(),
    z.object({ blob: z.string(), type: z.string(), bytes: z.number() }),
  ),
});
export type Asset = z.infer<typeof Asset>;
let active = 0;
export async function processAsset(
  ctx: Pick<AppContext, "identity" | "blobs">,
  input: Buffer,
): Promise<Asset> {
  if (active >= COLLECTIBLE_PROCESSORS)
    throw new ApiError(
      429,
      "rate_limited",
      "Asset processing is busy. Try again shortly.",
    );
  active++;
  try {
    return await processAssetUnchecked(ctx, input);
  } finally {
    active--;
  }
}
async function processAssetUnchecked(
  ctx: Pick<AppContext, "identity" | "blobs">,
  input: Buffer,
): Promise<Asset> {
  if (!input.length || input.length > ASSET_MAX)
    throw badRequest("Assets must be between 1 byte and 6 MB");
  const original = input;
  const textHead = input.subarray(0, 256).toString("utf8").trimStart();
  let sourceFormat: "svg" | "lottie" | undefined;
  if (textHead.startsWith("<")) {
    input = safeSvg(input);
    sourceFormat = "svg";
  }
  if (textHead.startsWith("{")) {
    input = await lottieWebp(input);
    sourceFormat = "lottie";
  }
  const format = sourceFormat === "svg" ? "svg" : sniff(input);
  if (!["png", "webp", "gif", "jpeg", "svg"].includes(format ?? ""))
    throw badRequest(
      "Upload PNG, WebP, GIF, JPEG, a self-contained SVG or a supported 2D Lottie JSON.",
    );
  const id = createHash("sha256").update(original).digest("hex");
  const existing = ctx.identity.get<{ metadata: string }>(
    "profile_collectible_assets",
    { id },
  );
  if (existing) return Asset.parse(JSON.parse(existing.metadata));
  let outputs: Record<string, { body: Buffer; type: string }>;
  let meta;
  try {
    meta = await sharp(input, {
      animated: true,
      limitInputPixels: COLLECTIBLE_DECODED_PIXELS,
      failOn: "warning",
    }).metadata();
    const width = meta.width ?? 0,
      height = meta.pageHeight ?? meta.height ?? 0,
      frames = meta.pages ?? 1;
    if (
      width < 32 ||
      height < 32 ||
      width > 2048 ||
      height > 2048 ||
      frames > 120 ||
      width * height * frames > COLLECTIBLE_DECODED_PIXELS
    )
      throw Error("dimensions");
    const still = () =>
      sharp(input, {
        page: 0,
        pages: 1,
        limitInputPixels: COLLECTIBLE_DECODED_PIXELS,
        failOn: "warning",
      }).rotate();
    const full = sharp(input, {
      animated: true,
      limitInputPixels: COLLECTIBLE_DECODED_PIXELS,
      failOn: "warning",
    });
    if (frames === 1) full.rotate();
    outputs = {
      original: {
        body: original,
        type:
          sourceFormat === "svg"
            ? "image/svg+xml"
            : sourceFormat === "lottie"
              ? "application/json"
              : format === "jpeg"
                ? "image/jpeg"
                : `image/${format}`,
      },
      full: {
        body: await full
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
    throw badRequest(
      "Image could not be decoded safely. Use 32–2048 px, at most 120 frames and 8 million decoded pixels.",
    );
  }
  const variants: Asset["variants"] = {};
  for (const [name, output] of Object.entries(outputs)) {
    const blob = `col-${id}-${name}`;
    const file = path.join(
      ctx.blobs.spoolDir,
      `collectible-${randomUUID()}.part`,
    );
    try {
      await fs.writeFile(file, output.body, { mode: 0o600 });
      const hash = createHash("sha256").update(output.body).digest("hex");
      try {
        await ctx.blobs.putFile(
          "profile-photos",
          blob,
          file,
          output.body.length,
          hash,
        );
      } catch (error) {
        // A previous attempt may have stored this variant before failing later. Only reuse exact verified bytes.
        const existing = await ctx.blobs.direct?.head("profile-photos", blob);
        if (
          !existing ||
          existing.size !== output.body.length ||
          existing.sha256 !== Buffer.from(hash, "hex").toString("base64")
        )
          throw error;
      }
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
    format: sourceFormat ?? format!,
    variants,
  };
  await ctx.identity.write((w) =>
    w.insert(
      "profile_collectible_assets",
      { id, metadata: JSON.stringify(asset), created_at: Date.now() },
      { orIgnore: true },
    ),
  );
  return asset;
}
export async function serveAsset(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  admin = false,
) {
  const { id, variant: requestedVariant } = parse(
    z.object({
      id: AssetId,
      variant: z.enum([
        "full",
        "poster",
        "thumbnail",
        "avif",
        "original",
        "full.webp",
        "poster.webp",
        "thumbnail.webp",
        "avif.avif",
      ]),
    }),
    req.params,
  );
  const variant = requestedVariant.split(".")[0];
  if (
    !admin &&
    !new CollectionService(ctx)
      .catalog()
      .some((x) => available(x) && x.recipe.assetId === id)
  )
    throw notFound("Asset not found");
  const row = ctx.identity.get<{ metadata: string }>(
    "profile_collectible_assets",
    { id },
  );
  if (!row) throw notFound("Asset not found");
  const chosen = Asset.parse(JSON.parse(row.metadata)).variants[variant];
  const stream = await ctx.blobs.get("profile-photos", chosen.blob);
  if (!stream) throw notFound("Asset not found");
  if (variant === "original") reply.header("content-disposition", "attachment");
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

/** Expired signed staging is never an approved catalog asset. Delete only expired upload IDs, in bounded batches. */
export async function cleanupStaging(ctx: AppContext) {
  const expired = ctx.identity.all<{ id: string }>(
    "profile_collectible_uploads",
    { where: { expires_at: { lt: Date.now() } }, limit: 50 },
  );
  for (const row of expired) {
    await ctx.blobs.delete("profile-photos", row.id);
    await ctx.identity.write((w) =>
      w.delete("profile_collectible_uploads", { id: row.id }),
    );
  }
}
