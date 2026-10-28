import type { ConversationRow } from "../../organizations/authz.js";
import type { AppContext } from "../../../app/context.js";
import { allows, appearsOnline, canSeeLastSeen, privacyOf, relation } from "../../accounts/profile.js";
import { userSummary } from "../../auth/routes.js";
import { conversationView, liveCallsOf } from "../conversationsRoutes.js";

/**
 * Universal search on the server (docs/SEARCH.md, round 7 slice C2): what the server can read and the searcher may see.
 * Each kind uses the same rule as the resource itself, applied while reading, never by hiding results afterwards:
 *
 * - people: others in a workspace you share (not as a guest), or anyone by exact @username who lets everyone find them
 *   that way; never someone who blocked you (the same rule as `GET /v1/users/search`, which older apps keep using);
 * - channels: in every workspace you belong to, those you could open (`Authz.canViewChannel`): joined ones, and public
 *   ones in your scope; a private channel only if you're in it;
 * - workspaces: the ones you belong to;
 * - groups: group conversations you're in, by name.
 *
 * Messages, files, pins and reminders are end-to-end encrypted: the server can't search them, and the apps search the
 * device's own history instead. No content is stored for search; queries are never logged or kept.
 */
export const SEARCH_KINDS = ["people", "channels", "workspaces", "groups"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** Most candidates ranked per kind; a page is cut from them. */
const MAX_CANDIDATES = 200;

/**
 * How well [text] matches [q] (both lower-cased): 0 exact, 1 starts with it, 2 a word starts with it, 3 contains it;
 * null when it doesn't match.
 */
export function matchRank(text: string | null | undefined, q: string): number | null {
  const t = (text ?? "").toLowerCase();
  if (!t || !q) return null;
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (new RegExp(`(^|[\\s_.#@-])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t)) return 2;
  if (t.includes(q)) return 3;
  return null;
}

const bestRank = (q: string, ...texts: (string | null | undefined)[]): number | null =>
  texts.map((t) => matchRank(t, q)).reduce<number | null>((best, r) => (r === null ? best : best === null ? r : Math.min(best, r)), null);

interface Ranked<T> {
  rank: number;
  name: string;
  item: T;
}

function sortRanked<T>(list: Ranked<T>[]): T[] {
  return [...list].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map((r) => r.item);
}

const escapeLike = (s: string) => s.replace(/[%_\\]/g, (ch) => "\\" + ch);

export function searchPeople(ctx: AppContext, userId: string, q: string, orgId?: string) {
  const term = q.replace(/^@/, "").toLowerCase();
  const like = `%${escapeLike(term)}%`;
  const rows = ctx.db
    .prepare(
      `SELECT DISTINCT u.* FROM users u
       WHERE u.disabled_at IS NULL AND u.home_server_id IS NULL AND u.kind = 'person' AND u.id != ? AND (
         u.username = ? COLLATE NOCASE OR (
           (u.username LIKE ? ESCAPE '\\' OR lower(u.display_name) LIKE ? ESCAPE '\\')
           AND EXISTS (
             SELECT 1 FROM org_members a JOIN org_members b ON a.org_id = b.org_id
             WHERE a.user_id = ? AND b.user_id = u.id AND a.role != 'GUEST' AND (? IS NULL OR a.org_id = ?)
           )
         )
       ) LIMIT ${MAX_CANDIDATES}`,
    )
    .all(userId, term, like, like, userId, orgId ?? null, orgId ?? null) as any[];
  const visible = rows.filter((u) => {
    const r = relation(ctx, userId, u.id);
    return !r.blockedByTarget && (r.contact || allows(privacyOf(u).findByUsername, r));
  });
  return sortRanked(
    visible.flatMap((u) => {
      const rank = bestRank(term, u.username, u.display_name);
      if (rank === null) return [];
      return [{ rank, name: u.display_name ?? u.username, item: { ...userSummary(u), online: canSeeLastSeen(ctx, userId, u) ? appearsOnline(ctx, u) : null } }];
    }),
  );
}

export async function searchChannels(ctx: AppContext, userId: string, q: string, orgId?: string) {
  const term = q.replace(/^#/, "").toLowerCase();
  const like = `%${escapeLike(term)}%`;
  const rows = ctx.db
    .prepare(
      `SELECT c.*, o.name AS org_name FROM conversations c JOIN orgs o ON o.id = c.org_id
       WHERE c.type = 'CHANNEL' AND c.archived_at IS NULL
         AND c.org_id IN (SELECT org_id FROM org_members WHERE user_id = ?) AND (? IS NULL OR c.org_id = ?)
         AND (lower(c.name) LIKE ? ESCAPE '\\' OR lower(coalesce(c.topic, '')) LIKE ? ESCAPE '\\')
       LIMIT ${MAX_CANDIDATES}`,
    )
    .all(userId, orgId ?? null, orgId ?? null, like, like) as (ConversationRow & { org_name: string })[];
  const visible = rows.filter((c) => ctx.authz.canViewChannel(c, userId));
  const live = await liveCallsOf(ctx, visible);
  return sortRanked(
    visible
      .flatMap((c) => {
        const rank = bestRank(term, c.name, c.topic);
        if (rank === null) return [];
        // A topic-only match ranks below any name match.
        const byName = matchRank(c.name, term) !== null;
        return [{ rank: byName ? rank : rank + 4, name: c.name ?? "", item: { ...conversationView(ctx, c, userId, live), orgName: c.org_name } }];
      }),
  );
}

export function searchWorkspaces(ctx: AppContext, userId: string, q: string) {
  const term = q.toLowerCase();
  const rows = ctx.db
    .prepare(
      `SELECT o.id, o.name, o.slug, m.role FROM orgs o JOIN org_members m ON m.org_id = o.id
       WHERE m.user_id = ? AND lower(o.name) LIKE ? ESCAPE '\\' LIMIT ${MAX_CANDIDATES}`,
    )
    .all(userId, `%${escapeLike(term)}%`) as { id: string; name: string; slug: string; role: string }[];
  return sortRanked(
    rows.flatMap((o) => {
      const rank = matchRank(o.name, term);
      return rank === null ? [] : [{ rank, name: o.name, item: { id: o.id, name: o.name, slug: o.slug, myRole: o.role } }];
    }),
  );
}

export async function searchGroups(ctx: AppContext, userId: string, q: string) {
  const term = q.toLowerCase();
  const rows = ctx.db
    .prepare(
      `SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
       WHERE m.user_id = ? AND c.type = 'GROUP' AND lower(coalesce(c.name, '')) LIKE ? ESCAPE '\\' LIMIT ${MAX_CANDIDATES}`,
    )
    .all(userId, `%${escapeLike(term)}%`) as ConversationRow[];
  const live = await liveCallsOf(ctx, rows);
  return sortRanked(
    rows.flatMap((c) => {
      const rank = matchRank(c.name, term);
      return rank === null ? [] : [{ rank, name: c.name ?? "", item: conversationView(ctx, c, userId, live) }];
    }),
  );
}

export interface SearchPage<T> {
  items: T[];
  /** Pass back as `cursor` (with `types` set to this one kind) for the next page; null at the end. */
  next: string | null;
}

export function page<T>(all: T[], cursor: string | undefined, limit: number): SearchPage<T> {
  const offset = cursor ? Math.max(0, Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) || 0) : 0;
  const items = all.slice(offset, offset + limit);
  const end = offset + items.length;
  return { items, next: end < all.length ? Buffer.from(String(end), "utf8").toString("base64url") : null };
}

export async function search(ctx: AppContext, userId: string, q: string, kinds: readonly SearchKind[], opts: { orgId?: string; limit: number; cursor?: string }) {
  const run: Record<SearchKind, () => unknown[] | Promise<unknown[]>> = {
    people: () => searchPeople(ctx, userId, q, opts.orgId),
    channels: () => searchChannels(ctx, userId, q, opts.orgId),
    workspaces: () => (opts.orgId ? [] : searchWorkspaces(ctx, userId, q)),
    groups: () => (opts.orgId ? [] : searchGroups(ctx, userId, q)),
  };
  const pages = await Promise.all(kinds.map(async (k) => [k, page(await run[k](), kinds.length === 1 ? opts.cursor : undefined, opts.limit)] as const));
  return Object.fromEntries(pages) as Partial<Record<SearchKind, SearchPage<unknown>>>;
}
