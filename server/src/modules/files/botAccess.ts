import type { AppContext } from "../../app/context.js";
import { notFound } from "../../shared/errors.js";

/** Owning-domain lookup only; bot policy never reads private file tables. */
export async function botFileContext(
  ctx: AppContext,
  id: string,
  botId: string,
  upload: boolean,
) {
  if (upload) {
    const pending = await ctx.files.upload(id);
    if (pending) {
      if (pending.user_id !== botId) throw notFound("Upload not found");
      return {
        conversationId: pending.conversation_id,
        createdAt: pending.created_at,
      };
    }
  }
  const file = await ctx.files.attachment(id);
  if (
    !file ||
    (upload && file.uploader_user_id !== botId) ||
    (file.pending_message_until != null && file.uploader_user_id !== botId)
  )
    throw notFound("Attachment not found or expired");
  return { conversationId: file.conversation_id, createdAt: file.created_at };
}
