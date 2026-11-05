import {messageFilterIdentities} from "../accounts/index.js";
import type { AppContext } from "../../app/context.js";
import type { MessageSearchQuery } from "../../shared/contracts/http/serverMessages.js";
import type { MessageEvent } from "./store/messageStore.js";
import { mongoMessageSearch } from "./store/mongoSearch.js";

export type SearchScope = { id: string; since: number };
export type SearchPage = {
  messages: MessageEvent[];
  changes: MessageEvent[];
  more: boolean;
  nextCursor: { serverTs: number; id: string } | null;
};
export const emptySearch = (): SearchPage => ({
  messages: [],
  changes: [],
  more: false,
  nextCursor: null,
});

/** Resolve names without another request. Results still come exclusively from the viewer's authorized scope. */
export function searchPeople(
  ctx: AppContext,
  viewer: string,
  query?: string,
): string[] | null {
  if (query === undefined) return null;
  const name = query.replace(/^@/, "").toLowerCase();
  if (name === "me" || name === "you") return [viewer];
  return messageFilterIdentities(ctx.identity,query,name);
}
const sqliteFunctions = new WeakSet<object>();
const valid = (e: MessageEvent) => {
  try {
    const p = JSON.parse(e.payload);
    return p && typeof p === "object" && !Array.isArray(p);
  } catch {
    return false;
  }
};

/** Filters and visibility run before LIMIT, including edits/deletes/pin controls. No message cache is searched. */
export async function messageSearch(
  ctx: AppContext,
  scope: SearchScope[],
  viewer: string,
  q: MessageSearchQuery,
): Promise<SearchPage> {
  const senders = searchPeople(ctx, viewer, q.from),
    mentioned = searchPeople(ctx, viewer, q.mentions);
  if (!scope.length || senders?.length === 0 || mentioned?.length === 0)
    return emptySearch();
  const excludedSenders = ctx.officialBots.starboardSearchExclusions(scope.map(({ id }) => id));
  if (ctx.messages.backend === "mongodb")
    return mongoMessageSearch(ctx, scope, viewer, q, senders, mentioned, excludedSenders);
  const pg = !!ctx.postgres;
  const values: unknown[] = [];
  const bind = (v: unknown) => {
    values.push(v);
    return pg ? `$${values.length}` : `@p${values.length}`;
  };
  const who = bind(viewer),
    table = pg ? "meldiq.message_events" : "message_events";
  const json = (a: string) =>
    pg
      ? `meldiq_private.event_payload(${a}.payload)`
      : `(CASE WHEN json_valid(${a}.payload) THEN CASE WHEN json_type(${a}.payload)='object' THEN ${a}.payload ELSE '{}' END ELSE '{}' END)`;
  const field = (body: string, key: string) =>
    pg ? `(${body}->>'${key}')` : `json_extract(${body},'$.${key}')`;
  const array = (body: string, key: string) =>
    pg
      ? `CASE WHEN jsonb_typeof(${body}->'${key}')='array' THEN ${body}->'${key}' ELSE '[]'::jsonb END`
      : `CASE WHEN json_type(${body},'$.${key}')='array' THEN json_extract(${body},'$.${key}') ELSE '[]' END`;
  const seen = `(c.audience='all' OR c.sender_user_id=${who})`;
  const scoped = scope
    .map(
      (s) =>
        `(m.conversation_id=${bind(s.id)} AND m.server_ts>=${bind(s.since)})`,
    )
    .join(" OR ");
  const edit = `(SELECT c.payload FROM ${table} c WHERE c.conversation_id=m.conversation_id AND c.target=m.id AND c.cls='control' AND c.type='edit' AND c.sender_user_id=m.sender_user_id AND ${seen} AND ${pg ? `jsonb_typeof((${json("c")})->'text')='string'` : `json_type((${json("c")}), '$.text')='text'`} ORDER BY c.server_ts DESC,c.id DESC LIMIT 1)`;
  const pinValue = pg
    ? `(${field(json("c"), "pinned")}='true')`
    : field(json("c"), "pinned");
  const pin = `(SELECT ${pinValue} FROM ${table} c WHERE c.conversation_id=m.conversation_id AND c.target=m.id AND c.cls='control' AND c.type='pin' AND ${seen} ORDER BY c.server_ts DESC,c.id DESC LIMIT 1)`;
  const original = json("m"),
    edited = pg
      ? "meldiq_private.event_payload(m._edit)"
      : "(CASE WHEN json_valid(m._edit) THEN m._edit ELSE '{}' END)";
  const text = `coalesce(${field(edited, "text")},${field(original, "text")},'')`;
  const where: string[] = [];
  if (q.q)
    where.push(
      `${pg ? `strpos(lower(${text}),lower(${bind(q.q)}))` : `instr(lower(${text}),lower(${bind(q.q)}))`}>0`,
    );
  if (q.before !== undefined) where.push(`m.server_ts<${bind(q.before)}`);
  if (q.after !== undefined) where.push(`m.server_ts>=${bind(q.after)}`);
  if (q.cursorTs !== undefined)
    where.push(`(m.server_ts,m.id)<(${bind(q.cursorTs)},${bind(q.cursorId)})`);
  if (senders)
    where.push(`m.sender_user_id IN (${senders.map(bind).join(",")})`);
  if (q.pinned !== undefined)
    where.push(
      `coalesce(m._pinned,${pg ? "false" : "0"})=${pg ? (q.pinned === "true" ? "true" : "false") : q.pinned === "true" ? "1" : "0"}`,
    );
  if (mentioned) {
    const mentions = pg
      ? `coalesce(${edited}->'mentions',${original}->'mentions','[]'::jsonb)`
      : `coalesce(json_extract(${edited},'$.mentions'),json_extract(${original},'$.mentions'),'[]')`;
    const check = pg
      ? `EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${mentions})='array' THEN ${mentions} ELSE '[]'::jsonb END) a(value) WHERE a.value IN (${mentioned.map(bind).join(",")}))`
      : `EXISTS(SELECT 1 FROM json_each(${mentions}) a WHERE a.value IN (${mentioned.map(bind).join(",")}))`;
    where.push(
      `(${check}${mentioned.includes(viewer) ? " OR m.mention_all=1" : ""})`,
    );
  }
  for (const kind of new Set(q.has?.split(",") ?? [])) {
    if (kind === "link") {
      if (!pg && !sqliteFunctions.has(ctx.db)) {
        ctx.db.function(
          "meldiq_search_link",
          { deterministic: true },
          (value: unknown) =>
            typeof value === "string" && /\bhttps?:\/\/\S/i.test(value) ? 1 : 0,
        );
        sqliteFunctions.add(ctx.db);
      }
      where.push(
        pg
          ? `${text} ~* '\\mhttps?://[^[:space:]]'`
          : `meldiq_search_link(${text})=1`,
      );
      continue;
    }
    const elements = pg
      ? `jsonb_array_elements(${array(original, "attachments")})`
      : `json_each(${array(original, "attachments")})`;
    const attachment =
      "CASE WHEN json_valid(a.value) THEN a.value ELSE '{}' END";
    const mime = pg
      ? "lower(a.value->>'mime')"
      : `lower(json_extract(${attachment},'$.mime'))`;
    const voice = pg
      ? "a.value->'voice' IS DISTINCT FROM 'true'::jsonb"
      : `coalesce(json_extract(${attachment},'$.voice'),0)<>1`;
    const media =
      kind === "image"
        ? `${mime} LIKE 'image/%'`
        : kind === "video"
          ? `${mime} LIKE 'video/%'`
          : `${mime} NOT LIKE 'image/%' AND ${mime} NOT LIKE 'video/%' AND length(${mime})>0`;
    where.push(
      `EXISTS(SELECT 1 FROM ${elements} a WHERE ${voice} AND ${media})`,
    );
  }
  const limit = bind(q.limit + 1);
  const excludeCopies = excludedSenders.length ? `AND m.sender_user_id NOT IN (${excludedSenders.map(bind).join(",")})` : "";
  const sql = `WITH candidates AS (SELECT m.*,${edit} AS _edit,${pin} AS _pinned FROM ${table} m
    WHERE (${scoped}) AND m.cls='message' AND m.type='text' AND ${pg ? `jsonb_typeof(${original})='object'` : "CASE WHEN json_valid(m.payload) THEN json_type(m.payload)='object' ELSE 0 END"} AND (m.audience='all' OR m.sender_user_id=${who}) ${excludeCopies}
    AND NOT EXISTS(SELECT 1 FROM ${table} c WHERE c.conversation_id=m.conversation_id AND c.target=m.id AND c.cls='control' AND c.type='delete' AND ${seen}))
    SELECT m.* FROM candidates m WHERE ${where.join(" AND ") || "true"} ORDER BY m.server_ts DESC,m.id DESC LIMIT ${limit}`;
  const sqliteArgs = () =>
    Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v]));
  const found = (
    pg
      ? (await ctx.postgres!.database.query<MessageEvent>(sql, values)).rows
      : (ctx.db.prepare(sql).all(sqliteArgs()) as MessageEvent[])
  ).filter(valid);
  const messages = found.slice(0, q.limit),
    more = found.length > q.limit;
  if (!messages.length) return emptySearch();
  const ids = messages.map((m) => m.id);
  const conversations = [...new Set(messages.map((m) => m.conversation_id))];
  const changes = pg
    ? (
        await ctx.postgres!.database.query<MessageEvent>(
          `SELECT * FROM ${table} WHERE cls='control' AND target=ANY($1::text[]) AND conversation_id=ANY($3::text[]) AND (audience='all' OR sender_user_id=$2) ORDER BY server_ts,id`,
          [ids, viewer, conversations],
        )
      ).rows
    : (ctx.db
        .prepare(
          `SELECT * FROM ${table} WHERE cls='control' AND target IN (${ids.map(() => "?").join(",")}) AND conversation_id IN (${conversations.map(() => "?").join(",")}) AND (audience='all' OR sender_user_id=?) ORDER BY server_ts,id`,
        )
        .all(...ids, ...conversations, viewer) as MessageEvent[]);
  const last = messages.at(-1)!;
  const pairs = new Map(messages.map((m) => [m.id, m.conversation_id]));
  return {
    messages,
    changes: changes.filter(
      (e) => valid(e) && pairs.get(e.target!) === e.conversation_id,
    ),
    more,
    nextCursor: more ? { serverTs: last.server_ts, id: last.id } : null,
  };
}
