import { z } from "zod/v4";
import type { AppContext } from "../../app/context.js";
import { effectiveFileMaxBytes } from "../../app/config.js";
import { ApiError } from "../../shared/errors.js";
import { runtimePolicy } from "../platformAdmin/index.js";
import { KEPT_FOREVER } from "./store.js";

const descriptor = z.object({
  id: z.string().min(1).max(128), name: z.string().max(512), mime: z.string().max(255),
  size: z.number().int().positive(), key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/), sha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  chunk: z.number().int().min(1024).max(16 * 1024 * 1024).optional(),
});
const attachment = descriptor.extend({ thumbnail: descriptor.extend({
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]), size: z.number().int().positive().max(128 * 1024), chunk: z.undefined().optional(),
}).nullish() });

/** Validate completed objects before publishing references. No decryption or media processing runs on the API. */
export async function messageAttachments(ctx: AppContext, userId: string, conversationId: string, orgId: string | null, raw: unknown): Promise<string[]> {
  if (raw === undefined || raw === null) return [];
  const parsed = z.array(attachment).max(10).safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "bad_request", "Choose valid files and upload them before sending.");
  const seen = new Set<string>();
  const max = Math.min(effectiveFileMaxBytes(ctx.config), ctx.mojo.uploadBytes(userId, orgId), runtimePolicy(ctx.platform).policy.maxFileBytes);
  for (const original of parsed.data) {
    if (original.size > max) throw new ApiError(413, "upload_limit", "This file exceeds your upload limit here.", { maxBytes: max });
    for (const ref of [original, ...(original.thumbnail ? [original.thumbnail] : [])]) {
      if (seen.has(ref.id)) throw new ApiError(400, "bad_request", "The same file appears more than once.");
      seen.add(ref.id);
      const stored = await ctx.files.attachment(ref.id);
      const size = ref.size + (ref.chunk === undefined ? 16 : 16 * Math.max(1, Math.ceil(ref.size / ref.chunk)));
      // A member may re-share an existing file in the same conversation; another conversation requires a fresh upload.
      if (!stored || stored.conversation_id !== conversationId || stored.expires_at <= Date.now() || stored.size !== size || (stored.sha256 != null && stored.sha256 !== ref.sha256) || (stored.pending_message_until != null && stored.uploader_user_id !== userId)) {
        throw new ApiError(400, "bad_request", "A file is unavailable or has not finished uploading. Upload it again.");
      }
    }
  }
  return [...seen];
}

/** New uploads expire if never sent; published files follow the operator's existing retention policy. */
export async function retainMessageAttachments(ctx: AppContext, ids: string[], messageId: string): Promise<void> {
  for (const id of ids) await ctx.files.publish(id, messageId, ctx.config.attachmentKeepForever ? KEPT_FOREVER : undefined);
}
