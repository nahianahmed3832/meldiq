import type { AppContext } from "../../app/context.js";
import type { ConversationRow } from "../organizations/authz.js";
import type { MessageEvent } from "./store/messageStore.js";
import { forumTags } from "./conversationsRoutes.js";
import { badRequest, forbidden } from "../../shared/errors.js";
const validRoot = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
/** Metadata is authoritative for new forum posts; replies and unchanged legacy metadata retain their meaning. */
export async function admitForumMetadata(
  ctx: AppContext,
  conv: ConversationRow,
  userId: string,
  p: Record<string, unknown>,
  target?: MessageEvent,
) {
  if (conv.format !== "forum") return;
  if (target) {
    const original = JSON.parse(target.payload);
    if (
      validRoot(original.threadRoot) ||
      (p.tags === undefined && p.title === undefined)
    )
      return;
  } else if (validRoot(p.threadRoot)) return;
  if (
    p.title !== undefined &&
    (typeof p.title !== "string" ||
      !p.title.trim() ||
      [...p.title].length > 120)
  )
    throw badRequest("A forum post title is 1–120 characters");
  if (target && p.tags === undefined) return;
  const tags = p.tags ?? [];
  if (
    !Array.isArray(tags) ||
    tags.length > 5 ||
    tags.some((t) => typeof t !== "string")
  )
    throw badRequest("Choose at most five forum tags");
  const chosen = [...new Set(tags as string[])],
    available = forumTags(conv);
  if (chosen.some((id) => !available.some((t) => t.id === id)))
    throw badRequest("Choose tags from this forum");
  if (conv.forum_require_tag === 1 && chosen.length === 0)
    throw badRequest("Choose at least one forum tag");
  const moderator =
    ctx.authz.canManageConversation(conv, userId) ||
    ctx.authz.channelPermissions(conv, userId).has("messages.manage");
  if (!moderator) {
    let prior: string[] = [];
    if (target) {
      const original = JSON.parse(target.payload);
      prior = Array.isArray(original.tags) ? original.tags : [];
      for (const edit of await ctx.messages.changesTo(
        conv.id,
        target.id,
        "edit",
      ))
        if (edit.sender_user_id === target.sender_user_id) {
          try {
            const payload = JSON.parse(edit.payload);
            if (Array.isArray(payload.tags)) prior = payload.tags;
          } catch {
            /* Historical malformed controls are ignored. */
          }
        }
    }
    if (
      available.some(
        (t) => t.restricted && chosen.includes(t.id) !== prior.includes(t.id),
      )
    )
      throw forbidden("Only moderators can change restricted forum tags");
  }
}
