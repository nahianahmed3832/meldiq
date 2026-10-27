import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "../../app/context.js";
import { isJpeg } from "./profile.js";
import { ApiError, badRequest } from "../../shared/errors.js";

/** Largest photo accepted, a person's or an organisation's (the app sends a 512 px JPEG of about 60 KB). */
export const MAX_PHOTO_BYTES = 512 * 1024;

/** Photos are stored per revision, so a replaced photo is never served under the new revision. */
export const photoBlobId = (ownerId: string, rev: number): string => `${ownerId.replace(/[^A-Za-z0-9_-]/g, "")}-${rev}`;

/** Largest community banner accepted (the apps send a 1200 × 480 JPEG of about 150 KB). */
export const MAX_BANNER_BYTES = 1024 * 1024;

/** A community banner's blob ("<orgId>_banner-<rev>"), beside its photo in the same store. */
export const bannerBlobId = (orgId: string, rev: number): string => photoBlobId(`${orgId}_banner`, rev);

/**
 * Reads a JPEG request body of at most [max] bytes, stopping as soon as it's too large. The apps re-encode photos
 * first, so there is no metadata to strip.
 */
export async function readJpegBody(req: FastifyRequest, what: string, max = MAX_PHOTO_BYTES): Promise<Buffer> {
  const body = req.body as Readable | undefined;
  if (!body || typeof body.pipe !== "function") throw badRequest("Expected application/octet-stream body");
  const tooLarge = () => new ApiError(413, "too_large", `${what} can be up to ${max >= 1024 * 1024 ? `${max / (1024 * 1024)} MB` : `${max / 1024} KB`}`);
  if (Number(req.headers["content-length"] ?? Number.NaN) > max) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    size += (c as Buffer).length;
    if (size > max) {
      body.destroy();
      throw tooLarge();
    }
    chunks.push(c as Buffer);
  }
  const buf = Buffer.concat(chunks);
  if (!isJpeg(buf)) throw badRequest(`${what} must be JPEG`);
  return buf;
}

/** Stores [buf] as the profile-photos blob [blobId]; 503 when the blob store can't take it. */
export async function storePhoto(ctx: AppContext, blobId: string, buf: Buffer): Promise<void> {
  const tmp = path.join(ctx.blobs.spoolDir, `photo-${blobId}.part`);
  await fs.promises.writeFile(tmp, buf, { mode: 0o600 });
  try {
    await ctx.blobs.putFile("profile-photos", blobId, tmp, buf.length, crypto.createHash("sha256").update(buf).digest("hex"));
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    ctx.log.error({ err: e }, "photo store write failed");
    throw new ApiError(503, "storage_unavailable", "The server couldn't store the photo. Try again in a moment.");
  }
}
