import type { AppContext } from "../../../app/context.js";
import { ApiError } from "../../../shared/errors.js";
import type { CollectionQuery } from "../../../shared/contracts/http/messageCollections.js";
import type { CollectionPage, CollectionThread } from "../messageCollections.js";
import type { MessageEvent } from "./messageStore.js";

/** Authoritative collection queries. Historical payloads remain intact; malformed JSON is excluded safely. */
export async function postgresCollectionPage(ctx: AppContext, cid: string, viewer: string, since: number | null, query: CollectionQuery): Promise<CollectionPage> {
  const db = ctx.postgres!.database;
  const payload = "meldiq_private.event_payload(m.payload)";
  const root = `CASE WHEN jsonb_typeof(${payload}->'threadRoot')='string' AND (${payload}->>'threadRoot') ~ '^[A-Za-z0-9_-]{8,64}$' THEN ${payload}->>'threadRoot' ELSE NULL END`;
  const base = `m.conversation_id=$1 AND m.cls='message' AND m.server_ts >= $3 AND (m.audience='all' OR m.sender_user_id=$2) AND jsonb_typeof(${payload})='object'`;
  const alive = `NOT EXISTS(SELECT 1 FROM meldiq.message_events c WHERE c.conversation_id=m.conversation_id AND c.cls='control' AND c.type='delete' AND c.target=m.id AND (c.audience='all' OR c.sender_user_id=$2))`;
  const args: unknown[] = [cid, viewer, since ?? 0];
  if (query.kind === "threads") {
    let boundary = "true";
    if (query.before !== undefined) {args.push(query.before, query.beforeId); boundary = `("lastReplyTs","rootId") < ($4,$5)`;}
    args.push(query.limit + 1);
    const found = (await db.query<CollectionThread>(`WITH thread_stats AS (
      SELECT ${root} AS "rootId",count(*) AS "replyCount",max(m.server_ts) AS "lastReplyTs"
      FROM meldiq.message_events m WHERE ${base} AND ${alive} GROUP BY "rootId"
    ) SELECT * FROM thread_stats WHERE "rootId" IS NOT NULL AND ${boundary} ORDER BY "lastReplyTs" DESC,"rootId" DESC LIMIT $${args.length}`, args)).rows;
    const threads = found.slice(0, query.limit), last = threads.at(-1), more = found.length > query.limit;
    const roots = (await db.query<MessageEvent>(`SELECT * FROM meldiq.message_events m WHERE ${base} AND m.id=ANY($4::text[])`, [cid, viewer, since ?? 0, threads.map(thread => thread.rootId)])).rows;
    const byId = new Map(roots.map(message => [message.id, message]));
    return {messages: threads.flatMap(thread => byId.has(thread.rootId) ? [byId.get(thread.rootId)!] : []), context: [], threads, more,
      nextCursor: more && last ? {serverTs: last.lastReplyTs, id: last.rootId} : null};
  }
  let where = base;
  if (query.kind !== "main" && query.kind !== "thread") where += ` AND ${alive}`;
  if (query.kind === "main") where += ` AND ${root} IS NULL`;
  if (query.kind === "thread") {args.push(query.root); where += ` AND ${root}=$${args.length}`;}
  if (query.kind === "media" || query.kind === "files") {
    const visual = `(lower(a.value->>'mime') LIKE 'video/%' OR lower(a.value->>'mime') IN ('image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/bmp','image/avif'))`;
    where += ` AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${payload}->'attachments')='array' THEN ${payload}->'attachments' ELSE '[]'::jsonb END) a(value)
      WHERE jsonb_typeof(a.value->'mime')='string' AND length(a.value->>'mime')>0 AND a.value->'voice' IS DISTINCT FROM 'true'::jsonb AND ${query.kind === "files" ? "NOT " : ""}${visual})`;
  }
  if (query.kind === "pins") where += ` AND coalesce((SELECT meldiq_private.event_payload(c.payload)->'pinned'='true'::jsonb FROM meldiq.message_events c
    WHERE c.conversation_id=m.conversation_id AND c.cls='control' AND c.type='pin' AND c.target=m.id AND (c.audience='all' OR c.sender_user_id=$2)
    ORDER BY c.server_ts DESC,c.id DESC LIMIT 1),false)`;
  const run = async (position: {time: number; id: string} | null, direction: "older" | "newer", limit: number) => {
    const values = [...args];
    let boundary = "";
    if (position) {values.push(position.time, position.id); boundary = ` AND (m.server_ts,m.id) ${direction === "older" ? "<" : ">"} ($${values.length-1},$${values.length})`;}
    values.push(limit);
    const order = direction === "older" ? "DESC" : "ASC";
    return (await db.query<MessageEvent>(`SELECT m.* FROM meldiq.message_events m WHERE ${where}${boundary} ORDER BY m.server_ts ${order},m.id ${order} LIMIT $${values.length}`, values)).rows;
  };
  let messages: MessageEvent[], more: boolean;
  if (query.around) {
    const values = [...args, query.around];
    const anchor = (await db.query<MessageEvent>(`SELECT m.* FROM meldiq.message_events m WHERE ${where} AND m.id=$${values.length}`, values)).rows[0];
    if (!anchor) throw new ApiError(404, "not_found", "That reply isn't in this thread");
    const half = Math.ceil(query.limit / 2), position = {time: anchor.server_ts, id: anchor.id};
    const older = await run(position, "older", half + 1), newer = await run(position, "newer", half);
    messages = [...newer.reverse(), anchor, ...older.slice(0, half)]; more = older.length > half;
  } else {
    const found = await run(query.before === undefined ? null : {time: query.before, id: query.beforeId!}, "older", query.limit + 1);
    messages = found.slice(0, query.limit); more = found.length > query.limit;
  }
  const context = query.root ? (await db.query<MessageEvent>(`SELECT m.* FROM meldiq.message_events m WHERE ${base} AND m.id=$4`, [cid, viewer, since ?? 0, query.root])).rows : [];
  const last = messages.at(-1);
  return {messages, context, threads: [], more, nextCursor: more && last ? {serverTs: last.server_ts, id: last.id} : null};
}
