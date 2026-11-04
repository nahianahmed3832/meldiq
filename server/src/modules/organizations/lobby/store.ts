import type { Rows } from "../../../infrastructure/database/rows/index.js";
import { LobbySettings } from "../../../shared/contracts/http/communityLobby.js";
import { ApiError } from "../../../shared/errors.js";
import {
  DEFAULT_SECTIONS,
  defaultSettings,
  type Section,
  type Settings,
} from "./defaults.js";

interface LobbyRow {
  org_id: string;
  settings: string;
  rev: number;
  updated_at: number;
  updated_by: string;
}

export interface FeedRow {
  org_id: string;
  token_hash: string;
  created_at: number;
  created_by: string;
  last_post_at: number | null;
}

export interface PostRow {
  id: string;
  org_id: string;
  title: string | null;
  text: string | null;
  url: string | null;
  image: string | null;
  posted_at: number;
}

export interface StoredLobby {
  settings: Settings;
  rev: number;
  updatedAt: number | null;
}

/** Every known card once, in the stored order, with cards the save didn't know about added after (hidden: no). */
function completeSections(stored: readonly Section[]): Section[] {
  const seen = new Set<string>();
  const known = stored.filter(
    (s) =>
      DEFAULT_SECTIONS.some((d) => d.key === s.key) &&
      !seen.has(s.key) &&
      seen.add(s.key),
  );
  return [
    ...known,
    ...DEFAULT_SECTIONS.filter((d) => !seen.has(d.key)).map((d) => ({ ...d })),
  ];
}

/** Stored settings over the defaults; anything unreadable falls back to the default lobby. */
export function parseSettings(json: string): Settings {
  try {
    const merged = {
      ...defaultSettings(),
      ...(JSON.parse(json) as Partial<Settings>),
    };
    const stored = JSON.parse(json) as Partial<Settings>;
    const r = LobbySettings.safeParse({
      ...merged,
      phoneOrder: stored.phoneOrder ?? merged.sections.map((s) => s.key),
      sections: completeSections(merged.sections ?? []),
    });
    return r.success ? r.data : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

/**
 * The lobby's rows (migration 072): in the workspace domain, so SQLite or MongoDB with an in-memory copy, read
 * synchronously like the rest of a community's configuration.
 */
export class LobbyStore {
  constructor(private readonly rows: Rows) {}

  lobby(orgId: string): StoredLobby {
    const r = this.rows.get<LobbyRow>("community_lobbies", { org_id: orgId });
    return r
      ? {
          settings: parseSettings(r.settings),
          rev: r.rev,
          updatedAt: r.updated_at,
        }
      : { settings: defaultSettings(), rev: 0, updatedAt: null };
  }

  /** Saves [settings] made on revision [rev]; 409 lobby_stale when someone saved since. The new revision. */
  async save(
    orgId: string,
    settings: Settings,
    rev: number,
    actorId: string,
    t: number,
  ): Promise<number> {
    return this.rows.write((w) => {
      const current =
        w.get<LobbyRow>("community_lobbies", { org_id: orgId })?.rev ?? 0;
      if (current !== rev)
        throw new ApiError(
          409,
          "lobby_stale",
          "Someone else changed the lobby meanwhile. Load the latest version and try again.",
          { rev: current },
        );
      const row: LobbyRow = {
        org_id: orgId,
        settings: JSON.stringify(settings),
        rev: current + 1,
        updated_at: t,
        updated_by: actorId,
      };
      w.upsert("community_lobbies", { ...row }, "replace");
      return row.rev;
    });
  }

  feed(orgId: string): FeedRow | undefined {
    return this.rows.get<FeedRow>("community_lobby_feeds", { org_id: orgId });
  }

  feedByHash(tokenHash: string): FeedRow | undefined {
    return this.rows.get<FeedRow>("community_lobby_feeds", {
      token_hash: tokenHash,
    });
  }

  /** A new feed URL replaces the old one (which stops working at once). */
  async putFeed(row: FeedRow): Promise<void> {
    await this.rows.write((w) =>
      w.upsert("community_lobby_feeds", { ...row }, "replace"),
    );
  }

  async deleteFeed(orgId: string): Promise<boolean> {
    return (
      (await this.rows.write((w) =>
        w.delete("community_lobby_feeds", { org_id: orgId }),
      )) > 0
    );
  }

  posts(orgId: string, limit: number): PostRow[] {
    return this.rows.all<PostRow>("community_lobby_posts", {
      where: { org_id: orgId },
      orderBy: [
        ["posted_at", "desc"],
        ["id", "desc"],
      ],
      limit,
    });
  }

  /**
   * Adds [post] and keeps only the newest [keep] of the community's posts. Its time is moved just past the newest
   * post's when several arrive in the same millisecond, so the order they came in is the order they show. The time used.
   */
  async addPost(post: PostRow, keep: number): Promise<number> {
    return this.rows.write((w) => {
      const newest =
        w.get<{ posted_at: number }>(
          "community_lobby_posts",
          { org_id: post.org_id },
          [["posted_at", "desc"]],
        )?.posted_at ?? 0;
      const postedAt = Math.max(post.posted_at, newest + 1);
      w.insert("community_lobby_posts", { ...post, posted_at: postedAt });
      w.update(
        "community_lobby_feeds",
        { org_id: post.org_id },
        { last_post_at: postedAt },
      );
      const old = w
        .all<{ id: string }>("community_lobby_posts", {
          where: { org_id: post.org_id },
          orderBy: [
            ["posted_at", "desc"],
            ["id", "desc"],
          ],
        })
        .slice(keep);
      if (old.length > 0)
        w.delete("community_lobby_posts", { id: { in: old.map((p) => p.id) } });
      return postedAt;
    });
  }

  seenAt(orgId: string, userId: string): number | null {
    return (
      this.rows.get<{ seen_at: number }>("community_lobby_seen", {
        org_id: orgId,
        user_id: userId,
      })?.seen_at ?? null
    );
  }

  /** Records the first time [userId] opened the lobby; later calls keep it. When they first saw it. */
  async markSeen(orgId: string, userId: string, t: number): Promise<number> {
    await this.rows.write((w) =>
      w.insert(
        "community_lobby_seen",
        { org_id: orgId, user_id: userId, seen_at: t },
        { orIgnore: true },
      ),
    );
    return this.seenAt(orgId, userId) ?? t;
  }

  async forgetMember(orgId: string, userId: string): Promise<void> {
    if (this.seenAt(orgId, userId) === null) return;
    await this.rows.write((w) =>
      w.delete("community_lobby_seen", { org_id: orgId, user_id: userId }),
    );
  }

  async deleteForUser(userId: string): Promise<void> {
    if (this.rows.count("community_lobby_seen", { user_id: userId }) === 0)
      return;
    await this.rows.write((w) =>
      w.delete("community_lobby_seen", { user_id: userId }),
    );
  }
}
