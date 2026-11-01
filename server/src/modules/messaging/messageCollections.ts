import type { FastifyInstance } from "fastify";
import type { Document, Collection } from "mongodb";
import type { AppContext } from "../../app/context.js";
import { CollectionQuery } from "../../shared/contracts/http/messageCollections.js";
import { parse } from "../../shared/validation/index.js";
import { ApiError } from "../../shared/errors.js";
import { me, requireAuth } from "../auth/index.js";
import { eventToWire } from "./serverSend.js";
import type { MessageEvent } from "./store/messageStore.js";
import { retrievalMeta, backfillRetrieval } from "./store/retrievalMeta.js";

type Cursor = { serverTs: number; id: string };
type Thread = { rootId: string; replyCount: number; lastReplyTs: number };
type Page = { messages: MessageEvent[]; context: MessageEvent[]; threads: Thread[]; more: boolean; nextCursor: Cursor | null };
const ready = new WeakMap<AppContext, Promise<void>>();

/** Bounded, idempotent backfill. New inserts already carry these fields; no payloads or control state are rewritten. */
async function metadataReady(ctx: AppContext) {
  if (!ctx.mongo?.owns("history")) return;
  let work = ready.get(ctx);
  if (!work) {
    work = (async () => { await backfillRetrieval(ctx.mongo!.db); })();
    ready.set(ctx, work);
    void work.catch(() => ready.delete(ctx));
  }
  await work;
}
const visible = (viewer: string) => ({ $or: [{ audience: "all" }, { sender_user_id: viewer }] });
function notDeleted(cid: string, viewer: string): Document[] {
  return [{ $lookup: { from: "message_events", let: { targetId: "$_id" }, pipeline: [
    { $match: { conversation_id: cid, cls: "control", type: "delete", ...visible(viewer), $expr: { $eq: ["$target", "$$targetId"] } } }, { $limit: 1 }, { $project: { _id: 1 } },
  ], as: "_deleted" } }, { $match: { "_deleted.0": { $exists: false } } }];
}
const beforeFilter = (q: CollectionQuery, time = "server_ts", id = "_id"): Document => q.before === undefined ? {} : {
  $or: [{ [time]: { $lt: q.before } }, { [time]: q.before, [id]: { $lt: q.beforeId } }],
};
const raw = (doc: any): MessageEvent => {
  const { _id, _retrieval, _deleted, _pin, ...e } = doc;
  return e as MessageEvent;
};

async function mongoPage(ctx: AppContext, cid: string, viewer: string, since: number | null, q: CollectionQuery): Promise<Page> {
  await metadataReady(ctx);
  const col: Collection<Document> = ctx.mongo!.db.collection("message_events");
  const base: Document = { conversation_id: cid, cls: "message", "_retrieval.valid": true, ...(since == null ? {} : { server_ts: { $gte: since } }) };
  if (q.kind === "threads") {
    const rows = await col.aggregate<any>([
      { $match: { ...base, "_retrieval.root": { $ne: null } } }, ...notDeleted(cid, viewer),
      { $group: { _id: "$_retrieval.root", replyCount: { $sum: 1 }, lastReplyTs: { $max: "$server_ts" } } },
      { $match: beforeFilter(q, "lastReplyTs") }, { $sort: { lastReplyTs: -1, _id: -1 } }, { $limit: q.limit + 1 },
    ], { allowDiskUse: true, maxTimeMS: 15_000 }).toArray();
    const selected = rows.slice(0, q.limit);
    const messages = (await Promise.all(selected.map((r) => ctx.messages.get(r._id)))).filter((m): m is MessageEvent => !!m && m.conversation_id === cid && m.cls === "message" && (since == null || m.server_ts >= since));
    const threads = selected.map((r) => ({ rootId: r._id as string, replyCount: r.replyCount as number, lastReplyTs: r.lastReplyTs as number }));
    const last = threads.at(-1); const more = rows.length > q.limit;
    return { messages, context: [], threads, more, nextCursor: more && last ? { serverTs: last.lastReplyTs, id: last.rootId } : null };
  }
  if (q.kind === "thread") base["_retrieval.root"] = q.root;
  if (q.kind === "main") base["_retrieval.root"] = null;
  if (q.kind === "media") base["_retrieval.media"] = true;
  if (q.kind === "files") base["_retrieval.files"] = true;
  let pipeline: Document[] = [{ $match: base }];
  if (q.kind === "pins") pipeline = [
    { $match: { conversation_id: cid, cls: "control", type: "pin", ...visible(viewer) } },
    { $sort: { server_ts: -1, _id: -1 } }, { $group: { _id: "$target", pin: { $first: "$_retrieval.pin" } } },
    { $match: { pin: true } },
    { $lookup: { from: "message_events", localField: "_id", foreignField: "_id", as: "_message" } },
    { $unwind: "$_message" }, { $replaceRoot: { newRoot: "$_message" } }, { $match: base },
  ];
  if (q.kind !== "thread" && q.kind !== "main") pipeline.push(...notDeleted(cid, viewer));
  const run = async (boundary: Document, direction: 1 | -1, limit: number) => (await col.aggregate([...pipeline, { $match: boundary }, { $sort: { server_ts: direction, _id: direction } }, { $limit: limit }], { allowDiskUse: true, maxTimeMS: 15_000 }).toArray()).map(raw);
  let rows: MessageEvent[]; let more: boolean;
  if (q.around) {
    const anchor = await ctx.messages.get(q.around);
    if (!anchor || anchor.conversation_id !== cid || anchor.cls !== "message" || retrievalMeta(anchor).root !== (q.root ?? null) || (since != null && anchor.server_ts < since)) throw new ApiError(404, "not_found", "That reply isn't in this thread");
    const half = Math.ceil(q.limit / 2);
    const older = await run({ $or: [{ server_ts: { $lt: anchor.server_ts } }, { server_ts: anchor.server_ts, _id: { $lt: anchor.id } }] }, -1, half + 1);
    const newer = await run({ $or: [{ server_ts: { $gt: anchor.server_ts } }, { server_ts: anchor.server_ts, _id: { $gt: anchor.id } }] }, 1, half);
    // A deleted anchor stays a tombstone after its controls apply, so message links still preserve context.
    rows = [...newer.reverse(), anchor, ...older.slice(0, half)]; more = older.length > half;
  } else { const found = await run(beforeFilter(q), -1, q.limit + 1); rows = found.slice(0, q.limit); more = found.length > q.limit; }
  const root = q.root ? await ctx.messages.get(q.root) : null;
  const context = root && root.conversation_id === cid && root.cls === "message" && (since == null || root.server_ts >= since) ? [root] : [];
  const last = rows.at(-1);
  return { messages: rows, context, threads: [], more, nextCursor: more && last ? { serverTs: last.server_ts, id: last.id } : null };
}

function sqlitePage(ctx: AppContext, cid: string, viewer: string, since: number | null, q: CollectionQuery): Page {
  const args: unknown[] = [cid, since ?? 0];
  const json = "CASE WHEN json_valid(m.payload) THEN m.payload ELSE '{}' END";
  const visibility = `(c.audience = 'all' OR c.sender_user_id = ?)`;
  const alive = (alias: string) => `NOT EXISTS (SELECT 1 FROM message_events c WHERE c.conversation_id = ${alias}.conversation_id AND c.cls = 'control' AND c.type = 'delete' AND c.target = ${alias}.id AND ${visibility})`;
  const rootField = `CASE WHEN json_type(${json}, '$.threadRoot') = 'text' AND length(json_extract(${json}, '$.threadRoot')) BETWEEN 8 AND 64 AND json_extract(${json}, '$.threadRoot') NOT GLOB '*[^A-Za-z0-9_-]*' THEN json_extract(${json}, '$.threadRoot') ELSE NULL END`;
  const base = `m.conversation_id = ? AND m.cls = 'message' AND m.server_ts >= ? AND json_type(${json}) = 'object'`;
  if (q.kind === "threads") {
    const params = [...args, viewer];
    let having = "";
    if (q.before != null) { having = "HAVING MAX(m.server_ts) < ? OR (MAX(m.server_ts) = ? AND rootId < ?)"; params.push(q.before, q.before, q.beforeId!); }
    params.push(q.limit + 1);
    const rows = ctx.db.prepare(`SELECT ${rootField} AS rootId, COUNT(*) AS replyCount, MAX(m.server_ts) AS lastReplyTs FROM message_events m
      WHERE ${base} AND ${rootField} IS NOT NULL AND ${alive("m")}
      GROUP BY rootId ${having} ORDER BY lastReplyTs DESC, rootId DESC LIMIT ?`).all(...params) as Thread[];
    const threads = rows.slice(0, q.limit); const more = rows.length > q.limit; const last = threads.at(-1);
    const get = ctx.db.prepare("SELECT * FROM message_events WHERE id = ? AND conversation_id = ? AND cls = 'message' AND server_ts >= ?");
    const messages = threads.flatMap((t) => { const m = get.get(t.rootId, cid, since ?? 0) as MessageEvent | undefined; return m ? [m] : []; });
    return { messages, context: [], threads, more, nextCursor: more && last ? { serverTs: last.lastReplyTs, id: last.rootId } : null };
  }
  let where = base;
  if (q.kind !== "thread" && q.kind !== "main") { where += ` AND ${alive("m")}`; args.push(viewer); }
  if (q.kind === "main") where += ` AND ${rootField} IS NULL`;
  if (q.kind === "thread") { where += ` AND ${rootField} = ?`; args.push(q.root!); }
  if (q.kind === "media" || q.kind === "files") {
    const attachment = "CASE WHEN a.type = 'object' THEN a.value ELSE '{}' END";
    const visual = `(lower(json_extract(${attachment}, '$.mime')) LIKE 'video/%' OR lower(json_extract(${attachment}, '$.mime')) IN ('image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/bmp','image/avif'))`;
    where += ` AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(${json}, '$.attachments') = 'array' THEN json_extract(${json}, '$.attachments') ELSE '[]' END) a
      WHERE json_type(${attachment}, '$.mime') = 'text' AND length(json_extract(${attachment}, '$.mime')) > 0 AND COALESCE(json_type(${attachment}, '$.voice'), 'missing') != 'true' AND ${q.kind === "files" ? "NOT " : ""}${visual})`;
  }
  if (q.kind === "pins") { where += ` AND COALESCE((SELECT CASE WHEN json_type(CASE WHEN json_valid(c.payload) THEN c.payload ELSE '{}' END, '$.pinned') = 'true' THEN 1 ELSE 0 END FROM message_events c WHERE c.conversation_id = m.conversation_id AND c.cls = 'control' AND c.type = 'pin' AND c.target = m.id AND ${visibility} ORDER BY c.server_ts DESC, c.id DESC LIMIT 1), 0) = 1`; args.push(viewer); }
  const run = (boundary: string, values: unknown[], order: string, limit: number) => ctx.db.prepare(`SELECT m.* FROM message_events m WHERE ${where}${boundary} ORDER BY m.server_ts ${order}, m.id ${order} LIMIT ?`).all(...args, ...values, limit) as MessageEvent[];
  let messages: MessageEvent[], more: boolean;
  if (q.around) {
    const anchor = ctx.db.prepare("SELECT * FROM message_events WHERE id = ? AND conversation_id = ? AND cls = 'message' AND server_ts >= ?").get(q.around, cid, since ?? 0) as MessageEvent | undefined;
    if (!anchor || retrievalMeta(anchor).root !== (q.root ?? null)) throw new ApiError(404, "not_found", "That reply isn't in this thread");
    const half = Math.ceil(q.limit / 2); const values = [anchor.server_ts, anchor.server_ts, anchor.id];
    const older = run(" AND (m.server_ts < ? OR (m.server_ts = ? AND m.id < ?))", values, "DESC", half + 1);
    const newer = run(" AND (m.server_ts > ? OR (m.server_ts = ? AND m.id > ?))", values, "ASC", half);
    messages = [...newer.reverse(), anchor, ...older.slice(0, half)]; more = older.length > half;
  } else {
    const rows = run(q.before == null ? "" : " AND (m.server_ts < ? OR (m.server_ts = ? AND m.id < ?))", q.before == null ? [] : [q.before, q.before, q.beforeId!], "DESC", q.limit + 1);
    messages = rows.slice(0, q.limit); more = rows.length > q.limit;
  }
  const root = q.root ? ctx.db.prepare("SELECT * FROM message_events WHERE id = ? AND conversation_id = ? AND cls = 'message' AND server_ts >= ?").get(q.root, cid, since ?? 0) as MessageEvent | undefined : undefined;
  const last = messages.at(-1);
  return { messages, context: root ? [root] : [], threads: [], more, nextCursor: more && last ? { serverTs: last.server_ts, id: last.id } : null };
}

async function changes(ctx: AppContext, cid: string, viewer: string, ids: string[]) {
  if (!ids.length) return [];
  if (ctx.messages.backend === "mongodb") return (await ctx.mongo!.db.collection("message_events").find({ conversation_id: cid, cls: "control", target: { $in: ids }, ...visible(viewer) }).sort({ server_ts: 1, _id: 1 }).toArray()).map(raw);
  return ctx.db.prepare(`SELECT * FROM message_events WHERE conversation_id = ? AND cls = 'control' AND target IN (${ids.map(() => "?").join(",")}) AND (audience = 'all' OR sender_user_id = ?) ORDER BY server_ts, id`).all(cid, ...ids, viewer) as MessageEvent[];
}
export default async function messageCollections(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { id: string } }>("/v2/conversations/:id/message-collections", { preHandler: requireAuth(ctx) }, async (req) => {
    const { userId } = me(req); const q = parse(CollectionQuery, req.query);
    const conv = ctx.authz.requireMember(req.params.id, userId); const since = ctx.authz.historySince(conv, userId);
    const page = ctx.messages.backend === "mongodb" ? await mongoPage(ctx, conv.id, userId, since, q) : sqlitePage(ctx, conv.id, userId, since, q);
    const edits = await changes(ctx, conv.id, userId, [...new Set([...page.messages, ...page.context].map((e) => e.id))]);
    return { ...page, historySince: since, messages: page.messages.map(eventToWire), context: page.context.map(eventToWire), changes: edits.map(eventToWire) };
  });
}
