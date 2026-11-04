import type { AppContext } from "../../app/context.js";
import type { ConversationRow } from "../organizations/index.js";
import type { RowWriter } from "../../infrastructure/database/rows/index.js";
import type { MessageEvent } from "./store/messageStore.js";
import { threadRootOf } from "./store/messageStore.js";
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { memberIds } from "./memberUsers.js";
export interface ThreadRow {
  root_id: string;
  conversation_id: string;
  author_id: string;
  root_ts: number;
  closed: number;
  locked: number;
  delete_requested: number;
  delete_parent: number;
  deleted_at: number | null;
  deletion_actor: string | null;
  deletion_device: string | null;
  deletion_error: string | null;
  delete_cursor_ts: number | null;
  delete_cursor_id: string | null;
  pending_target: string | null;
  deleted_replies: number;
  rev: number;
  updated_at: number;
}
export interface ThreadPreference {
  root_id: string;
  user_id: string;
  conversation_id: string;
  following: number;
  updated_at: number;
}
const queues = new WeakMap<AppContext, Map<string, Promise<void>>>();
/** Lifecycle changes and reply acceptance share this root's queue within the API's existing single-writer workspace model. */
export async function withThreadLock<T>(
  ctx: AppContext,
  rootId: string,
  run: () => Promise<T>,
): Promise<T> {
  let map = queues.get(ctx);
  if (!map) {
    map = new Map();
    queues.set(ctx, map);
  }
  const previous = map.get(rootId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    tail = previous.then(() => gate);
  map.set(rootId, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (map.get(rootId) === tail) map.delete(rootId);
  }
}
export function threadScope(
  ctx: AppContext,
  root: MessageEvent,
  userId: string,
): ConversationRow {
  const conv = ctx.authz.conversation(root.conversation_id);
  if (
    !conv ||
    conv.type !== "CHANNEL" ||
    !conv.org_id ||
    !ctx.authz.isMember(conv.id, userId)
  )
    throw notFound("Thread not found");
  const since = ctx.authz.historySince(conv, userId);
  if (since !== null && root.server_ts < since)
    throw notFound("Thread not found");
  return conv;
}
export function isThreadManager(
  ctx: AppContext,
  conv: ConversationRow,
  userId: string,
): boolean {
  return (
    ctx.authz.canManageConversation(conv, userId) ||
    ctx.authz.channelPermissions(conv, userId).has("threads.manage")
  );
}
export function initialThread(root: MessageEvent): ThreadRow {
  return {
    root_id: root.id,
    conversation_id: root.conversation_id,
    author_id: root.sender_user_id,
    root_ts: root.server_ts,
    closed: 0,
    locked: 0,
    delete_requested: 0,
    delete_parent: 0,
    deleted_at: null,
    deletion_actor: null,
    deletion_device: null,
    deletion_error: null,
    delete_cursor_ts: null,
    delete_cursor_id: null,
    pending_target: null,
    deleted_replies: 0,
    rev: 0,
    updated_at: root.server_ts,
  };
}
export async function loadThread(ctx: AppContext, id: string, userId: string) {
  const root = await ctx.messages.get(id);
  if (!root || root.cls !== "message") throw notFound("Thread not found");
  const conv = threadScope(ctx, root, userId);
  if (threadRootOf(root))
    throw badRequest("A thread starts from a top-level message");
  const stored = ctx.ws.get<ThreadRow>("message_threads", { root_id: id });
  const deleted = (await ctx.messages.changesTo(conv.id, id, "delete")).some(
    (change) => change.audience !== "self",
  );
  if (deleted && !stored?.delete_requested) throw notFound("Thread not found");
  threadScope(ctx, root, userId);
  return { root, conv, row: stored ?? initialThread(root) };
}
export function requireThreadOwnerOrManager(
  ctx: AppContext,
  root: MessageEvent,
  userId: string,
) {
  const conv = threadScope(ctx, root, userId),
    manager = isThreadManager(ctx, conv, userId);
  if (root.sender_user_id !== userId && !manager)
    throw forbidden(
      "Only the root author or thread managers can manage this thread",
    );
  return { conv, manager };
}
export function saveThread(w: RowWriter, row: ThreadRow): void {
  w.upsert("message_threads", { ...row }, "replace");
}
export function threadView(
  ctx: AppContext,
  root: MessageEvent,
  row: ThreadRow,
  userId: string,
  started = true,
) {
  const conv = threadScope(ctx, root, userId),
    manager = isThreadManager(ctx, conv, userId),
    owns = root.sender_user_id === userId;
  const preference = ctx.ws.get<ThreadPreference>("thread_preferences", {
    root_id: root.id,
    user_id: userId,
  });
  const unavailable = !!row.delete_requested || row.deleted_at !== null;
  return {
    rootId: root.id,
    conversationId: root.conversation_id,
    authorId: root.sender_user_id,
    rev: row.rev,
    deletesParent: row.delete_requested
      ? !!row.delete_parent
      : conv.format === "forum",
    closed: !!row.closed,
    locked: !!row.locked,
    deleting: !!row.delete_requested && row.deleted_at === null,
    deleted: row.deleted_at !== null,
    deletionError: row.deletion_error as
      "access_changed" | "retry_required" | null,
    deletedReplies: row.deleted_replies,
    canReply:
      !unavailable &&
      !row.closed &&
      !row.locked &&
      ctx.authz.canPost(conv, userId) &&
      ctx.authz
        .channelPermissions(conv, userId)
        .has(started ? "threads.post" : "threads.create"),
    canClose: !unavailable && (owns || manager) && (!row.locked || manager),
    canLock: !unavailable && manager,
    canDelete: row.deleted_at === null && (owns || manager),
    following: preference ? !!preference.following : null,
  };
}
export function notifyThread(
  ctx: AppContext,
  root: MessageEvent,
  row: ThreadRow,
) {
  const users = memberIds(ctx, root.conversation_id).filter((id) => {
    try {
      threadScope(ctx, root, id);
      return true;
    } catch {
      return false;
    }
  });
  ctx.hub.sendToUsers(users, {
    t: "thread.updated",
    conversationId: root.conversation_id,
    rootId: root.id,
    rev: row.rev,
  });
}
export async function admitThreadReply(
  ctx: AppContext,
  conv: ConversationRow,
  userId: string,
  rootId: string,
) {
  if (conv.type !== "CHANNEL" || !conv.org_id) return;
  const { root, row } = await loadThread(ctx, rootId, userId);
  if (root.conversation_id !== conv.id) throw notFound("Thread not found");
  if (row.delete_requested || row.deleted_at !== null)
    throw conflict("This thread was deleted or is being deleted");
  if (row.locked) throw forbidden("This thread is locked");
  if (row.closed) throw conflict("Reopen this thread before replying");
}
export async function verifyThreadDeletionGrant(
  ctx: AppContext,
  conversationId: string,
  rootId: string,
  targetId: string,
  userId: string,
) {
  const { root, row } = await loadThread(ctx, rootId, userId);
  const { conv } = requireThreadOwnerOrManager(ctx, root, userId);
  if (
    conv.id !== conversationId ||
    !row.delete_requested ||
    row.deletion_actor !== userId ||
    row.deleted_at !== null
  )
    throw forbidden("This thread deletion is not authorized");
  const target = await ctx.messages.get(targetId);
  if (targetId === rootId && !row.delete_parent)
    throw forbidden("This operation preserves the parent message");
  if (row.pending_target !== targetId)
    throw forbidden("This target is not pending in the thread deletion");
  if (
    !target ||
    target.conversation_id !== conv.id ||
    target.cls !== "message" ||
    (target.id !== rootId && threadRootOf(target) !== rootId)
  )
    throw notFound("Thread message not found");
  return conv;
}
export const staleThread = () =>
  new ApiError(
    409,
    "stale_revision",
    "This thread changed. Refresh before changing it.",
  );
export function changedThread(
  row: ThreadRow,
  patch: Partial<ThreadRow>,
): ThreadRow {
  return { ...row, ...patch, rev: row.rev + 1, updated_at: now() };
}

/** Preserve ordinary message deletion semantics while removing thread activity and preferences. */
export async function settleThreadRootDeletion(
  ctx: AppContext,
  message: { cls: string; audience?: string; payload: Record<string, unknown> },
): Promise<void> {
  if (
    message.cls !== "control" ||
    message.payload.type !== "delete" ||
    message.audience === "self" ||
    typeof message.payload.target !== "string"
  )
    return;
  const id = message.payload.target,
    prior = ctx.ws.get<ThreadRow>("message_threads", { root_id: id });
  if (!prior || prior.delete_requested || prior.deleted_at !== null) return;
  const root = await ctx.messages.get(id);
  if (!root) return;
  const row = await ctx.ws.write((w) => {
    const current = w.get<ThreadRow>("message_threads", { root_id: id });
    if (!current || current.delete_requested || current.deleted_at !== null)
      return null;
    const next = changedThread(current, {
      closed: 1,
      locked: 1,
      deleted_at: now(),
    });
    saveThread(w, next);
    w.delete("thread_preferences", { root_id: id });
    return next;
  });
  if (row) notifyThread(ctx, root, row);
}
