import { createHash, randomUUID } from "node:crypto";
import type { AppContext } from "../../../app/context.js";
import { ApiError, notFound } from "../../../shared/errors.js";
import { cleanupStaging, processAsset, boundedBlob } from "./assets.js";
export async function createCollectibleUpload(
  ctx: AppContext,
  actorId: string,
  body: { size: number; sha256: string },
) {
  await cleanupStaging(ctx);
  const direct = ctx.blobs.direct;
  if (!direct)
    throw new ApiError(
      409,
      "direct_unavailable",
      "Use the server upload on this storage backend",
    );
  const id = `col-upload-${randomUUID()}`;
  const upload = await direct.presignPut(
    "profile-photos",
    id,
    body.size,
    Buffer.from(body.sha256, "hex").toString("base64"),
    300,
  );
  await ctx.identity.write((w) =>
    w.insert("profile_collectible_uploads", {
      id,
      actor_id: actorId,
      size: body.size,
      sha256: body.sha256,
      expires_at: Date.now() + 300000,
    }),
  );
  return { id, upload };
}
export async function completeCollectibleUpload(
  ctx: AppContext,
  actorId: string,
  id: string,
) {
  const row = ctx.identity.get<{
    actor_id: string;
    size: number;
    sha256: string;
    expires_at: number;
  }>("profile_collectible_uploads", { id });
  if (!row || row.actor_id !== actorId || row.expires_at < Date.now())
    throw notFound("Upload expired or not found");
  const bytes = await boundedBlob(ctx, id, row.size);
  if (
    bytes.length !== row.size ||
    createHash("sha256").update(bytes).digest("hex") !== row.sha256
  )
    throw new ApiError(400, "bad_upload", "Size or checksum mismatch");
  const asset = await processAsset(ctx, bytes);
  await ctx.blobs.delete("profile-photos", id);
  await ctx.identity.write((w) =>
    w.delete("profile_collectible_uploads", { id }),
  );
  return asset;
}
