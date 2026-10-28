import type { FastifyInstance } from "fastify";
import { HistoryItemsQuery, historyPutBody } from "../../../shared/contracts/http/history.js";
import { hasNewAccountLimits } from "../../../app/middleware/abuse.js";
import { type AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { parse } from "../../../shared/validation/index.js";
import { ApiError } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";

/**
 * Encrypted message history (docs/MESSAGE_HISTORY.md). An account's devices upload each message they hold, encrypted
 * with a key derived from the account identity key (which never reaches a server), under opaque tags. Any device of
 * the account, or one restored with the recovery key, downloads and decrypts them. The server only sees how many
 * items an account has, their sizes, times and update order: never content, senders, conversation ids or message ids.
 *
 * Only the account itself can read or change its history; deleting the account deletes it (foreign keys).
 */

const MAX_BATCH_BYTES = 4 * 1024 * 1024;

export default async function historyRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const cfg = ctx.config.history;
  const { db, history } = ctx;

  const requireEnabled = () => {
    if (!cfg.enabled) throw new ApiError(403, "history_off", "This server doesn't keep message history.");
  };
  const newAccountBytes = ctx.config.abuse.newAccountHistoryBytes;
  /** The account's allowance: smaller while it's under new-account limits (docs/ABUSE_CONTROLS.md). */
  const maxBytesFor = (userId: string) =>
    newAccountBytes > 0 && hasNewAccountLimits(ctx.identity, userId) ? Math.min(newAccountBytes, cfg.maxBytesPerUser) : cfg.maxBytesPerUser;
  app.get("/v1/history/summary", auth, async (req) => {
    const { userId } = me(req);
    const a = await history.account(userId);
    return {
      enabled: cfg.enabled,
      items: a?.items ?? 0,
      bytes: a?.bytes ?? 0,
      seq: (a?.next_seq ?? 1) - 1,
      maxItems: cfg.maxItemsPerUser,
      maxBytes: maxBytesFor(userId),
      maxItemBytes: cfg.maxItemBytes,
    };
  });

  const putSchema = historyPutBody(Math.ceil((cfg.maxItemBytes * 4) / 3) + 4);

  // Adds or replaces items (an edited message replaces its item). All or nothing: a batch over the account's quota is
  // refused whole, with 429.
  app.put("/v1/history/items", { ...auth, bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    requireEnabled();
    const { userId } = me(req);
    const { items } = parse(putSchema, req.body);
    const decoded = items.map((i) => {
      const body = i.body === null ? null : Buffer.from(i.body, "base64");
      if (body && (body.length === 0 || body.length > cfg.maxItemBytes)) throw new ApiError(413, "too_large", "A history item is too large");
      return { ...i, body };
    });
    if (decoded.reduce((n, i) => n + (i.body?.length ?? 0), 0) > MAX_BATCH_BYTES) throw new ApiError(413, "too_large", "Send fewer history items at once");
    // A tag sent twice in one batch: the last copy counts.
    const plan = [...new Map(decoded.map((i) => [i.tag, i] as const)).values()];
    const result = await history.put(userId, plan, { maxItems: cfg.maxItemsPerUser, maxBytes: maxBytesFor(userId), maxTotalBytes: cfg.maxTotalBytes }, now());
    if (result === "account") throw new ApiError(429, "quota_exceeded", "Your message history on this server is full.");
    if (result === "server") throw new ApiError(507, "history_full", "This server's message history storage is full. Try again later.");
    return result;
  });

  // Items written after [after] (a seq this device has seen), oldest write first, for a restore or to catch up with
  // the account's other devices.
  app.get("/v1/history/items", auth, async (req) => {
    requireEnabled();
    const { userId } = me(req);
    const q = parse(HistoryItemsQuery, req.query);
    const rows = await history.items(userId, q.after, q.limit + 1);
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => ({ tag: r.tag, conv: r.conv_tag, seq: r.seq, ts: r.ts, body: r.body ? r.body.toString("base64") : null })),
      next: page.length ? page[page.length - 1].seq : q.after,
      more,
    };
  });

  // Deletes this account's whole history from the server (the person's choice in Settings). Devices keep their copies.
  app.delete("/v1/history", auth, async (req) => {
    const { userId } = me(req);
    const deleted = await history.deleteForUser(userId);
    ctx.audit({ actorId: userId, action: "history.deleted", target: userId, detail: String(deleted) });
    return { deleted };
  });
}

/**
 * History retention: deletion markers only need to live until every device has caught up; then they go. With history
 * in MongoDB, an account deletion or encryption reset that couldn't delete its history (MongoDB unreachable at that
 * moment) leaves it for this job: history whose user is gone is deleted here.
 */
export async function purgeHistory(ctx: AppContext, t: number): Promise<number> {
  const store = ctx.history;
  let n = await store.purgeTombstones(t - ctx.config.history.tombstoneDays * 86_400_000);
  const orphans = await store.orphanUserIds((ids) => {
    const rows = ctx.identity.all<{ id: string }>("users", { where: { deleted_at: null, id: { in: ids } } });
    return new Set(rows.map((r) => r.id));
  });
  for (const userId of orphans) n += await store.deleteForUser(userId);
  if (orphans.length) ctx.log.warn({ accounts: orphans.length }, "history retention: removed history left by deleted accounts");
  return n;
}

/**
 * After an account deletion or encryption reset already committed in SQLite: deletes the history kept in MongoDB
 * (SQLite's copy went in the same transaction). A failure is logged and left for [purgeHistory]; for a reset, the old
 * items can't be read with the new keys anyway.
 */
export async function deleteHistoryAfterCommit(ctx: AppContext, userId: string, why: string): Promise<void> {
  try {
    await ctx.history.deleteForUser(userId);
  } catch (e) {
    ctx.log.error({ errorType: (e as Error).name, why }, "history delete failed: left for the retention job");
  }
}
