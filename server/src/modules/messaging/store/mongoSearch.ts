import type { Document } from "mongodb";
import type { AppContext } from "../../../app/context.js";
import type { MessageSearchQuery } from "../../../shared/contracts/http/serverMessages.js";
import type { SearchPage, SearchScope } from "../messageSearch.js";
import type { MessageEvent } from "./messageStore.js";
import { backfillRetrieval } from "./retrievalMeta.js";

const ready = new WeakMap<AppContext, Promise<unknown>>();
const raw = (d: Document): MessageEvent => {
  const {
    _id,
    _retrieval,
    _states,
    _state,
    _edit,
    _pin,
    _text,
    _mentions,
    _link,
    ...event
  } = d;
  return event as MessageEvent;
};
export function mongoEffective(viewer: string): Document[] {
  const visible = { $or: [{ audience: "all" }, { sender_user_id: viewer }] };
  const editField = (field: string) => [
    { $match: { type: "edit", [`_retrieval.search.${field}`]: { $ne: null } } },
    { $limit: 1 },
    { $project: { "_retrieval.search": 1 } },
  ];
  return [
    {
      $lookup: {
        from: "message_events",
        let: {
          target: "$_id",
          cid: "$conversation_id",
          sender: "$sender_user_id",
        },
        pipeline: [
          {
            $match: {
              cls: "control",
              type: { $in: ["edit", "delete", "pin"] },
              ...visible,
              $expr: {
                $and: [
                  { $eq: ["$target", "$$target"] },
                  { $eq: ["$conversation_id", "$$cid"] },
                  {
                    $or: [
                      { $ne: ["$type", "edit"] },
                      { $eq: ["$sender_user_id", "$$sender"] },
                    ],
                  },
                ],
              },
            },
          },
          { $sort: { server_ts: -1, _id: -1 } },
          {
            $facet: {
              text: editField("text"),
              mentions: editField("mentions"),
              title: editField("title"),
              tags: editField("tags"),
              deleted: [
                { $match: { type: "delete" } },
                { $limit: 1 },
                { $project: { _id: 1 } },
              ],
              pin: [
                { $match: { type: "pin" } },
                { $limit: 1 },
                { $project: { "_retrieval.pin": 1 } },
              ],
            },
          },
        ],
        as: "_states",
      },
    },
    { $set: { _state: { $arrayElemAt: ["$_states", 0] } } },
    { $match: { "_state.deleted.0": { $exists: false } } },
    {
      $set: {
        _edit: {
          latest: {
            search: {
              text: {
                $arrayElemAt: ["$_state.text._retrieval.search.text", 0],
              },
              mentions: {
                $arrayElemAt: [
                  "$_state.mentions._retrieval.search.mentions",
                  0,
                ],
              },
              title: {
                $arrayElemAt: ["$_state.title._retrieval.search.title", 0],
              },
              tags: {
                $arrayElemAt: ["$_state.tags._retrieval.search.tags", 0],
              },
              link: {
                $arrayElemAt: ["$_state.text._retrieval.search.link", 0],
              },
            },
          },
        },
        _pin: {
          latest: { pin: { $arrayElemAt: ["$_state.pin._retrieval.pin", 0] } },
        },
      },
    },
    {
      $set: {
        _text: {
          $ifNull: [
            "$_edit.latest.search.text",
            { $ifNull: ["$_retrieval.search.text", ""] },
          ],
        },
        _mentions: {
          $ifNull: [
            "$_edit.latest.search.mentions",
            { $ifNull: ["$_retrieval.search.mentions", []] },
          ],
        },
        _link: {
          $cond: [
            { $ne: [{ $ifNull: ["$_edit.latest.search.text", null] }, null] },
            "$_edit.latest.search.link",
            "$_retrieval.search.link",
          ],
        },
      },
    },
  ];
}

export async function mongoMessageSearch(
  ctx: AppContext,
  scope: SearchScope[],
  viewer: string,
  q: MessageSearchQuery,
  senders: string[] | null,
  mentioned: string[] | null,
): Promise<SearchPage> {
  let backfill = ready.get(ctx);
  if (!backfill) {
    backfill = backfillRetrieval(ctx.mongo!.db);
    ready.set(ctx, backfill);
    void backfill.catch(() => ready.delete(ctx));
  }
  await backfill;
  const col = ctx.mongo!.db.collection("message_events");
  const visible = { $or: [{ audience: "all" }, { sender_user_id: viewer }] };
  const base: Document = {
    cls: "message",
    type: "text",
    "_retrieval.valid": true,
    $and: [
      visible,
      {
        $or: scope.map((s) => ({
          conversation_id: s.id,
          server_ts: { $gte: s.since },
        })),
      },
    ],
  };
  if (senders) base.sender_user_id = { $in: senders };
  const bounds: Document = {};
  if (q.before !== undefined) bounds.$lt = q.before;
  if (q.after !== undefined) bounds.$gte = q.after;
  if (Object.keys(bounds).length) base.server_ts = bounds;
  if (q.cursorTs !== undefined)
    base.$and.push({
      $or: [
        { server_ts: { $lt: q.cursorTs } },
        { server_ts: q.cursorTs, _id: { $lt: q.cursorId } },
      ],
    });
  const pipeline: Document[] = [{ $match: base }, ...mongoEffective(viewer)];
  if (q.q)
    pipeline.push({
      $match: {
        $expr: {
          $gte: [
            { $indexOfCP: [{ $toLower: "$_text" }, q.q.toLowerCase()] },
            0,
          ],
        },
      },
    });
  if (q.pinned !== undefined)
    pipeline.push({
      $match: {
        $expr: {
          $eq: [{ $ifNull: ["$_pin.latest.pin", false] }, q.pinned === "true"],
        },
      },
    });
  if (mentioned)
    pipeline.push({
      $match: {
        $expr: {
          $or: [
            {
              $gt: [
                { $size: { $setIntersection: ["$_mentions", mentioned] } },
                0,
              ],
            },
            ...(mentioned.includes(viewer)
              ? [{ $eq: ["$mention_all", 1] }]
              : []),
          ],
        },
      },
    });
  for (const kind of new Set(q.has?.split(",") ?? []))
    pipeline.push({
      $match:
        kind === "link" ? { _link: true } : { "_retrieval.search.has": kind },
    });
  pipeline.push({ $sort: { server_ts: -1, _id: -1 } }, { $limit: q.limit + 1 });
  const found = await col
    .aggregate(pipeline, { allowDiskUse: true, maxTimeMS: 15000 })
    .toArray();
  const messages = found.slice(0, q.limit).map(raw),
    more = found.length > q.limit;
  if (!messages.length)
    return { messages: [], changes: [], more: false, nextCursor: null };
  const pairs = new Map(messages.map((m) => [m.id, m.conversation_id]));
  const changes = (
    await col
      .find({
        cls: "control",
        target: { $in: messages.map((m) => m.id) },
        conversation_id: { $in: [...pairs.values()] },
        ...visible,
      })
      .sort({ server_ts: 1, _id: 1 })
      .toArray()
  )
    .filter(
      (d) => pairs.get(d.target) === d.conversation_id && d._retrieval?.valid,
    )
    .map(raw);
  const last = messages.at(-1)!;
  return {
    messages,
    changes,
    more,
    nextCursor: more ? { serverTs: last.server_ts, id: last.id } : null,
  };
}
