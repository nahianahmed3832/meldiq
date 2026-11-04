import type { Document } from "mongodb";
import type { AppContext } from "../../app/context.js";
import type { CollectionQuery } from "../../shared/contracts/http/messageCollections.js";
import type { CollectionPage } from "./messageCollections.js";
import type { MessageEvent } from "./store/messageStore.js";
import { mongoEffective } from "./store/mongoSearch.js";

/** One authoritative forum page: visibility, edits, tags and activity sorting all precede LIMIT. */
export async function forumPage(
  ctx: AppContext,
  cid: string,
  viewer: string,
  since: number | null,
  q: CollectionQuery,
): Promise<CollectionPage> {
  if (ctx.messages.backend === "mongodb")
    return mongoForum(ctx, cid, viewer, since, q);
  const pg = !!ctx.postgres,
    values: unknown[] = [];
  const bind = (v: unknown) => {
    values.push(v);
    return pg ? `$${values.length}` : `@p${values.length}`;
  };
  const who = bind(viewer),
    conversation = bind(cid),
    cutoff = bind(since ?? 0),
    table = pg ? "meldiq.message_events" : "message_events";
  const json = (a: string) =>
    pg
      ? `meldiq_private.event_payload(${a}.payload)`
      : `CASE WHEN json_valid(${a}.payload) THEN CASE WHEN json_type(${a}.payload)='object' THEN ${a}.payload ELSE '{}' END ELSE '{}' END`;
  const node = (p: string, key: string) =>
    pg ? `(${p}->'${key}')` : `json_extract(${p},'$.${key}')`;
  const text = (p: string, key: string) =>
    pg ? `(${p}->>'${key}')` : `json_extract(${p},'$.${key}')`;
  const body = `(${json("m")})`,
    edit = pg
      ? "meldiq_private.event_payload(m._edit)"
      : "(CASE WHEN json_valid(m._edit) THEN m._edit ELSE '{}' END)";
  const root = pg
    ? `CASE WHEN ${text(body, "threadRoot")} ~ '^[A-Za-z0-9_-]{8,64}$' THEN ${text(body, "threadRoot")} ELSE NULL END`
    : `CASE WHEN json_type(${body},'$.threadRoot')='text' AND length(${text(body, "threadRoot")}) BETWEEN 8 AND 64 AND ${text(body, "threadRoot")} NOT GLOB '*[^A-Za-z0-9_-]*' THEN ${text(body, "threadRoot")} ELSE NULL END`;
  const visible = `(c.audience='all' OR c.sender_user_id=${who})`;
  const edited = `(SELECT c.payload FROM ${table} c WHERE c.conversation_id=m.conversation_id AND c.target=m.id AND c.cls='control' AND c.type='edit' AND c.sender_user_id=m.sender_user_id AND ${visible} AND ${pg ? `jsonb_typeof((${json("c")})->'text')='string'` : `json_type((${json("c")}), '$.text')='text'`} ORDER BY c.server_ts DESC,c.id DESC LIMIT 1)`;
  const metadataEdit = (key: string, kind: "array" | "string") =>
    `(SELECT c.payload FROM ${table} c WHERE c.conversation_id=m.conversation_id AND c.target=m.id AND c.cls='control' AND c.type='edit' AND c.sender_user_id=m.sender_user_id AND ${visible} AND ${pg ? `jsonb_typeof(${node(`(${json("c")})`, key)})='${kind}'` : `json_type((${json("c")}), '$.${key}')='${kind === "string" ? "text" : "array"}'`} ORDER BY c.server_ts DESC,c.id DESC LIMIT 1)`;
  const decode = (column: string) =>
    pg
      ? `meldiq_private.event_payload(m."${column}")`
      : `(CASE WHEN json_valid(m."${column}") THEN m."${column}" ELSE '{}' END)`;
  const tagBody = decode("_tagEdit"),
    titleBody = decode("_titleEdit");
  const tags = `coalesce(${node(tagBody, "tags")},${node(body, "tags")},${pg ? "'[]'::jsonb" : "'[]'"})`;
  const filtered: string[] = [];
  if (q.q) {
    const match = bind(q.q);
    const hay = `(coalesce(${text(titleBody, "title")},${text(body, "title")},'') || ' ' || coalesce(${text(edit, "text")},${text(body, "text")},''))`;
    filtered.push(
      pg
        ? `strpos(lower(${hay}),lower(${match}))>0`
        : `instr(lower(${hay}),lower(${match}))>0`,
    );
  }
  if (q.tags) {
    const wanted = [...new Set(q.tags.split(","))];
    const available = pg
      ? `jsonb_array_elements_text(CASE WHEN jsonb_typeof(${tags})='array' THEN ${tags} ELSE '[]'::jsonb END) a(value)`
      : `json_each(CASE WHEN json_type(${tags})='array' THEN ${tags} ELSE '[]' END) a`;
    if (q.match === "all")
      for (const tag of wanted)
        filtered.push(
          `EXISTS(SELECT 1 FROM ${available} WHERE a.value=${bind(tag)})`,
        );
    else
      filtered.push(
        `EXISTS(SELECT 1 FROM ${available} WHERE a.value IN (${wanted.map(bind).join(",")}))`,
      );
  }
  const activity = pg
    ? "greatest(m.server_ts,coalesce(s.last,0))"
    : "max(m.server_ts,coalesce(s.last,0))";
  const sort = q.sort === "newest" ? "m.server_ts" : "m._activity";
  if (q.before !== undefined)
    filtered.push(`(${sort},m.id)<(${bind(q.before)},${bind(q.beforeId)})`);
  const limit = bind(q.limit + 1);
  const sql = `WITH visible_messages AS (
    SELECT m.*,${root} AS _root,${edited} AS _edit,${metadataEdit("tags", "array")} AS "_tagEdit",${metadataEdit("title", "string")} AS "_titleEdit" FROM ${table} m
    WHERE m.conversation_id=${conversation} AND m.cls='message' AND m.type='text' AND m.server_ts>=${cutoff}
      AND (m.audience='all' OR m.sender_user_id=${who}) AND ${pg ? `jsonb_typeof(${body})='object'` : "json_valid(m.payload) AND json_type(m.payload)='object'"}
      AND NOT EXISTS(SELECT 1 FROM ${table} c WHERE c.conversation_id=m.conversation_id AND c.target=m.id AND c.cls='control' AND c.type='delete' AND ${visible})
  ), stats AS (SELECT _root AS root,count(*) AS replies,max(server_ts) AS last FROM visible_messages WHERE _root IS NOT NULL GROUP BY _root),
  roots AS (SELECT m.*,coalesce(s.replies,0) AS _replies,${activity} AS _activity FROM visible_messages m LEFT JOIN stats s ON s.root=m.id WHERE m._root IS NULL)
  SELECT m.* FROM roots m WHERE ${filtered.join(" AND ") || "true"} ORDER BY ${sort} DESC,m.id DESC LIMIT ${limit}`;
  type Result = MessageEvent & { _replies: number; _activity: number };
  const found = pg
    ? (await ctx.postgres!.database.query<Result>(sql, values)).rows
    : (ctx.db
        .prepare(sql)
        .all(
          Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v])),
        ) as Result[]);
  const rows = found.slice(0, q.limit),
    more = found.length > q.limit,
    last = rows.at(-1);
  return {
    messages: rows,
    context: [],
    threads: rows.map((m) => ({
      rootId: m.id,
      replyCount: m._replies,
      lastReplyTs: m._activity,
    })),
    more,
    nextCursor:
      more && last
        ? {
            serverTs: q.sort === "newest" ? last.server_ts : last._activity,
            id: last.id,
          }
        : null,
  };
}
async function mongoForum(
  ctx: AppContext,
  cid: string,
  viewer: string,
  since: number | null,
  q: CollectionQuery,
): Promise<CollectionPage> {
  const col = ctx.mongo!.db.collection("message_events"),
    visible = { $or: [{ audience: "all" }, { sender_user_id: viewer }] };
  const pipeline: Document[] = [
    {
      $match: {
        conversation_id: cid,
        cls: "message",
        type: "text",
        "_retrieval.valid": true,
        "_retrieval.root": null,
        server_ts: { $gte: since ?? 0 },
        ...visible,
      },
    },
    ...mongoEffective(viewer),
    {
      $set: {
        _tags: {
          $ifNull: [
            "$_edit.latest.search.tags",
            { $ifNull: ["$_retrieval.search.tags", []] },
          ],
        },
        _title: {
          $ifNull: [
            "$_edit.latest.search.title",
            { $ifNull: ["$_retrieval.search.title", ""] },
          ],
        },
      },
    },
  ];
  if (q.q)
    pipeline.push({
      $match: {
        $expr: {
          $gte: [
            {
              $indexOfCP: [
                { $toLower: { $concat: ["$_title", " ", "$_text"] } },
                q.q.toLowerCase(),
              ],
            },
            0,
          ],
        },
      },
    });
  if (q.tags)
    pipeline.push({
      $match: {
        $expr:
          q.match === "all"
            ? { $setIsSubset: [q.tags.split(","), "$_tags"] }
            : {
                $gt: [
                  {
                    $size: { $setIntersection: [q.tags.split(","), "$_tags"] },
                  },
                  0,
                ],
              },
      },
    });
  pipeline.push(
    {
      $lookup: {
        from: "message_events",
        let: { root: "$_id" },
        pipeline: [
          {
            $match: {
              conversation_id: cid,
              cls: "message",
              type: "text",
              "_retrieval.valid": true,
              server_ts: { $gte: since ?? 0 },
              ...visible,
              $expr: { $eq: ["$_retrieval.root", "$$root"] },
            },
          },
          {
            $lookup: {
              from: "message_events",
              let: { id: "$_id" },
              pipeline: [
                {
                  $match: {
                    conversation_id: cid,
                    cls: "control",
                    type: "delete",
                    ...visible,
                    $expr: { $eq: ["$target", "$$id"] },
                  },
                },
                { $limit: 1 },
              ],
              as: "deleted",
            },
          },
          { $match: { "deleted.0": { $exists: false } } },
          {
            $group: {
              _id: null,
              replies: { $sum: 1 },
              last: { $max: "$server_ts" },
            },
          },
        ],
        as: "_stats",
      },
    },
    {
      $set: {
        _replies: { $ifNull: [{ $arrayElemAt: ["$_stats.replies", 0] }, 0] },
        _activity: {
          $max: [
            "$server_ts",
            { $ifNull: [{ $arrayElemAt: ["$_stats.last", 0] }, 0] },
          ],
        },
      },
    },
  );
  const sort = q.sort === "newest" ? "server_ts" : "_activity";
  if (q.before !== undefined)
    pipeline.push({
      $match: {
        $or: [
          { [sort]: { $lt: q.before } },
          { [sort]: q.before, _id: { $lt: q.beforeId } },
        ],
      },
    });
  pipeline.push({ $sort: { [sort]: -1, _id: -1 } }, { $limit: q.limit + 1 });
  const found = await col
      .aggregate(pipeline, { allowDiskUse: true, maxTimeMS: 15000 })
      .toArray(),
    rows = found.slice(0, q.limit),
    more = found.length > q.limit,
    last = rows.at(-1);
  return {
    messages: rows as unknown as MessageEvent[],
    context: [],
    threads: rows.map((m) => ({
      rootId: m.id,
      replyCount: m._replies,
      lastReplyTs: m._activity,
    })),
    more,
    nextCursor: more && last ? { serverTs: last[sort], id: last.id } : null,
  };
}
