import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { idParams } from "../../shared/contracts/http/primitives.js";
import {
  ThreadChange,
  ThreadDelete,
  ThreadFollow,
  ThreadPreferencesQuery,
} from "../../shared/contracts/http/threadLifecycle.js";
import { parse } from "../../shared/validation/index.js";
import { ApiError, conflict, forbidden } from "../../shared/errors.js";
import { now, sha256Hex } from "../../shared/utilities/util.js";
import { authorizedCollectionPage } from "./messageCollections.js";
import { sendServerMessage } from "./serverSend.js";
import { settlePollDeletion } from "./managedPolls.js";
import {
  changedThread,
  initialThread,
  isThreadManager,
  loadThread,
  notifyThread,
  requireThreadOwnerOrManager,
  saveThread,
  staleThread,
  threadScope,
  threadView,
  withThreadLock,
  type ThreadPreference,
  type ThreadRow,
} from "./threadManagement.js";

/** A persisted target is cleared only after its deletion and private-poll settlement succeed. */
export async function deleteThreadBatch(
  ctx: AppContext,
  rootId: string,
  keepGoing = () => true,
): Promise<void> {
  await withThreadLock(ctx, rootId, async () => {
    const stored = ctx.ws.get<ThreadRow>("message_threads", {
      root_id: rootId,
    });
    if (
      !stored ||
      !stored.delete_requested ||
      stored.deleted_at !== null ||
      stored.deletion_error ||
      !stored.deletion_actor
    )
      return;
    let row: ThreadRow = stored;
    let root;
    try {
      const loaded = await loadThread(ctx, rootId, row.deletion_actor!);
      root = loaded.root;
      const { conv } = requireThreadOwnerOrManager(
        ctx,
        root,
        row.deletion_actor!,
      );
      const { page } = await authorizedCollectionPage(
        ctx,
        conv.id,
        row.deletion_actor!,
        {
          kind: "thread",
          root: rootId,
          limit: 25,
          ...(row.delete_cursor_ts !== null
            ? { before: row.delete_cursor_ts, beforeId: row.delete_cursor_id! }
            : {}),
        },
      );
      const targets = [
        ...new Set([
          ...(row.pending_target ? [row.pending_target] : []),
          ...page.messages.map((m) => m.id),
        ]),
      ];
      const finish = !page.more;
      if (finish && row.delete_parent && !targets.includes(rootId))
        targets.push(rootId);
      for (const target of targets) {
        if (!keepGoing()) return;
        const actor: string = row.deletion_actor!;
        const wasPending: boolean = row.pending_target === target;
        const targetMessage = await ctx.messages.get(target);
        // Recheck authority for every accepted deletion; a role revocation interrupts the remaining work.
        requireThreadOwnerOrManager(ctx, root, actor);
        row = await ctx.ws.write((w) => {
          const current = w.get<ThreadRow>("message_threads", {
            root_id: rootId,
          })!;
          if (current.deleted_at !== null || current.deletion_actor !== actor)
            throw conflict("Thread deletion changed");
          const next = { ...current, pending_target: target };
          saveThread(w, next);
          return next;
        });
        const already = (
          await ctx.messages.changesTo(conv.id, target, "delete")
        ).some((c) => c.audience !== "self");
        const command = {
          conversationId: conv.id,
          messageId: `td_${sha256Hex(`${rootId}:${target}:${actor}`).slice(0, 56)}`,
          cls: "control" as const,
          sentAt: now(),
          payload: { type: "delete", target },
        };
        if (!already)
          await sendServerMessage(
            ctx,
            {
              userId: actor,
              deviceId: row.deletion_device,
              threadGrant: rootId,
            },
            command,
            ctx.log,
          );
        else await settlePollDeletion(ctx, command);
        row = await ctx.ws.write((w) => {
          const current = w.get<ThreadRow>("message_threads", {
            root_id: rootId,
          })!;
          if (current.pending_target !== target) return current;
          const next: ThreadRow = {
            ...current,
            pending_target: null,
            deleted_replies:
              current.deleted_replies +
              (target === rootId || (already && !wasPending) ? 0 : 1),
            ...(targetMessage && target !== rootId
              ? {
                  delete_cursor_ts: targetMessage.server_ts,
                  delete_cursor_id: target,
                }
              : {}),
            updated_at: now(),
          };
          saveThread(w, next);
          return next;
        });
      }
      if (finish) {
        row = await ctx.ws.write((w) => {
          const current = w.get<ThreadRow>("message_threads", {
            root_id: rootId,
          })!;
          const next = changedThread(current, {
            deleted_at: now(),
            pending_target: null,
          });
          saveThread(w, next);
          w.delete("thread_preferences", { root_id: rootId });
          return next;
        });
        ctx.audit({
          actorId: row.deletion_actor,
          orgId: conv.org_id,
          action: "thread.delete",
          target: rootId,
          detail: `${row.deleted_replies} replies`,
        });
      }
      notifyThread(ctx, root, row);
    } catch (error) {
      const code =
        error instanceof ApiError &&
        ["forbidden", "not_found", "timed_out"].includes(error.code)
          ? "access_changed"
          : "retry_required";
      const failed = await ctx.ws.write((w) => {
        const current = w.get<ThreadRow>("message_threads", {
          root_id: rootId,
        });
        if (!current || current.deleted_at !== null) return null;
        const next = changedThread(current, { deletion_error: code });
        saveThread(w, next);
        return next;
      });
      if (root && failed) notifyThread(ctx, root, failed);
      ctx.log.warn({ failure: code }, "Thread deletion interrupted");
    }
  });
}

export default async function threadRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const auth = { preHandler: requireAuth(ctx) };
  const view = async (id: string, userId: string) => {
    const { root, row, conv } = await loadThread(ctx, id, userId);
    const started =
      conv.format === "forum" ||
      (await ctx.messages.threadHasReplies(conv.id, id, root.server_ts));
    return threadView(ctx, root, row, userId, started);
  };
  app.get("/v1/threads/:id", auth, async (req) =>
    view(parse(idParams, req.params).id, me(req).userId),
  );
  app.patch("/v1/threads/:id", auth, async (req) => {
    const id = parse(idParams, req.params).id,
      userId = me(req).userId,
      body = parse(ThreadChange, req.body);
    await withThreadLock(ctx, id, async () => {
      const { root } = await loadThread(ctx, id, userId);
      const result = await ctx.ws.write((w) => {
        const { conv, manager } = requireThreadOwnerOrManager(
          ctx,
          root,
          userId,
        );
        const current =
          w.get<ThreadRow>("message_threads", { root_id: id }) ??
          initialThread(root);
        if (current.delete_requested || current.deleted_at !== null)
          throw conflict("This thread is being deleted");
        if (body.locked !== undefined && !manager)
          throw forbidden("Only thread managers can lock or unlock");
        if (body.closed === false && current.locked && !manager)
          throw forbidden("A thread manager must unlock this thread");
        const patch = {
          closed:
            body.locked === true
              ? 1
              : body.closed === undefined
                ? current.closed
                : body.closed
                  ? 1
                  : 0,
          locked:
            body.locked === undefined ? current.locked : body.locked ? 1 : 0,
        };
        if (patch.closed === current.closed && patch.locked === current.locked)
          return { row: current, changed: false, conv };
        if (current.rev !== body.baseRev) throw staleThread();
        const next = changedThread(current, patch);
        saveThread(w, next);
        return { row: next, changed: true, conv };
      });
      if (result.changed) {
        ctx.audit({
          actorId: userId,
          orgId: result.conv.org_id,
          action: "thread.update",
          target: id,
          detail: `closed=${result.row.closed};locked=${result.row.locked}`,
        });
        notifyThread(ctx, root, result.row);
      }
    });
    return view(id, userId);
  });
  app.post("/v1/threads/:id/delete", auth, async (req) => {
    const id = parse(idParams, req.params).id,
      { userId, deviceId } = me(req),
      body = parse(ThreadDelete, req.body);
    await withThreadLock(ctx, id, async () => {
      const { root } = await loadThread(ctx, id, userId);
      const result = await ctx.ws.write((w) => {
        const { conv } = requireThreadOwnerOrManager(ctx, root, userId),
          current =
            w.get<ThreadRow>("message_threads", { root_id: id }) ??
            initialThread(root);
        if (
          current.deleted_at !== null ||
          (current.delete_requested && !current.deletion_error)
        )
          return { row: current, changed: false, conv };
        if (current.rev !== body.baseRev) throw staleThread();
        const deleteParent = current.delete_requested
          ? !!current.delete_parent
          : conv.format === "forum";
        if (body.deleteParent !== deleteParent)
          throw conflict(
            "The channel format changed. Refresh before deleting this thread.",
          );
        const next = changedThread(current, {
          closed: 1,
          delete_requested: 1,
          delete_parent: deleteParent ? 1 : 0,
          deletion_actor: userId,
          deletion_device: deviceId,
          deletion_error: null,
        });
        saveThread(w, next);
        return { row: next, changed: true, conv };
      });
      if (result.changed) {
        ctx.audit({
          actorId: userId,
          orgId: result.conv.org_id,
          action: "thread.delete_requested",
          target: id,
        });
        notifyThread(ctx, root, result.row);
      }
    });
    return view(id, userId);
  });
  app.put("/v1/threads/:id/follow", auth, async (req) => {
    const id = parse(idParams, req.params).id,
      userId = me(req).userId,
      { following } = parse(ThreadFollow, req.body);
    const conv = await withThreadLock(ctx, id, async () => {
      const { root, conv } = await loadThread(ctx, id, userId);
      await ctx.ws.write((w) => {
        threadScope(ctx, root, userId);
        const row = w.get<ThreadRow>("message_threads", { root_id: id });
        if (
          row?.delete_requested ||
          (row?.deleted_at !== null && row?.deleted_at !== undefined)
        )
          throw conflict("This thread is being deleted");
        if (!row) saveThread(w, initialThread(root));
        w.upsert(
          "thread_preferences",
          {
            root_id: id,
            user_id: userId,
            conversation_id: conv.id,
            following: following ? 1 : 0,
            updated_at: now(),
          },
          "replace",
        );
      });
      return conv;
    });
    ctx.hub.sendToUser(userId, {
      t: "thread.preference",
      conversationId: conv.id,
      rootId: id,
      following,
    });
    return { rootId: id, following };
  });
  app.get("/v1/me/thread-preferences", auth, async (req) => {
    const userId = me(req).userId,
      q = parse(ThreadPreferencesQuery, req.query);
    const rows = ctx.ws
      .all<ThreadPreference>("thread_preferences", {
        where: {
          user_id: userId,
          ...(q.after ? { root_id: { gt: q.after } } : {}),
        },
        orderBy: [["root_id", "asc"]],
      })
      .filter((p) => {
        const thread = ctx.ws.get<ThreadRow>("message_threads", {
            root_id: p.root_id,
          }),
          conv = ctx.authz.conversation(p.conversation_id);
        if (
          !thread ||
          thread.delete_requested ||
          !conv ||
          !ctx.authz.isMember(conv.id, userId)
        )
          return false;
        const since = ctx.authz.historySince(conv, userId);
        return since === null || thread.root_ts >= since;
      })
      .slice(0, q.limit + 1);
    return {
      preferences: rows
        .slice(0, q.limit)
        .map((p) => ({
          rootId: p.root_id,
          conversationId: p.conversation_id,
          following: !!p.following,
        })),
      nextAfter: rows.length > q.limit ? rows[q.limit - 1].root_id : null,
    };
  });
  let stopping = false,
    timer: ReturnType<typeof setInterval> | null = null,
    running: Promise<void> | null = null;
  const sweep = () => {
    if (stopping || running) return;
    running = (async () => {
      const pending = ctx.ws.all<ThreadRow>("message_threads", {
        where: { delete_requested: 1, deleted_at: null, deletion_error: null },
        limit: 5,
      });
      for (const row of pending) {
        if (stopping) break;
        await deleteThreadBatch(ctx, row.root_id, () => !stopping);
      }
    })()
      .catch(() =>
        ctx.log.warn({ failure: "retry_required" }, "Thread sweep will retry"),
      )
      .finally(() => {
        running = null;
      });
  };
  app.addHook("onReady", async () => {
    timer = setInterval(sweep, 500);
    timer.unref();
    sweep();
  });
  app.addHook("onClose", async () => {
    stopping = true;
    if (timer) clearInterval(timer);
    await running;
  });
}
