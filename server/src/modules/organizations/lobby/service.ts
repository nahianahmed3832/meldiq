import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import {
  LOBBY_LIMITS,
  type LobbyFeedPostBody,
  type LobbySettingsBody,
  type LobbySettingsView,
} from "../../../shared/contracts/http/communityLobby.js";
import type { LobbyView } from "../../../shared/contracts/http/communityLobbyView.js";
import { ApiError, notFound } from "../../../shared/errors.js";
import { newId, now, sha256Hex } from "../../../shared/utilities/util.js";
import { ActivityCache } from "./boards.js";
import { applyTemplate, type Settings, type TemplateKey } from "./defaults.js";
import { DEFAULT_FEED_IMAGE_HOSTS, parseFeedPost } from "./feed.js";
import { LobbyStore } from "./store.js";
import { lobbyView, settingsFor, visibleChannels } from "./view.js";

type Body = z.infer<typeof LobbySettingsBody>;
const FAQ_ID = /^[A-Za-z0-9_-]{1,32}$/;
const FIELDS = [
  "enabled",
  "tagline",
  "buttons",
  "about",
  "mainChannelIds",
  "faq",
  "showWhoRunsIt",
  "look",
  "sections",
  "phoneOrder",
  "ordersLinked",
  "leaderboards",
] as const;

/** A channel the lobby may point at: a live channel of [orgId]. */
function lobbyChannel(ctx: AppContext, orgId: string, id: string): boolean {
  const c = ctx.authz.conversation(id);
  return !!c && c.type === "CHANNEL" && c.org_id === orgId && !c.archived_at;
}

/** FAQ items with their ids kept when they're valid and unique, new ones otherwise. */
function faqWithIds(items: NonNullable<Body["faq"]>): Settings["faq"] {
  const seen = new Set<string>();
  return items.map((x) => {
    const id =
      x.id && FAQ_ID.test(x.id) && !seen.has(x.id) ? x.id : newId("faq", 9);
    seen.add(id);
    return { id, question: x.question, answer: x.answer };
  });
}

/** "Show who runs it" and the who_runs_it card's switch are one setting: whichever [body] sets wins (the switch first). */
function syncWhoRunsIt(next: Settings, body: Body): Settings {
  const card = next.sections.find((s) => s.key === "who_runs_it")!;
  const shown =
    body.showWhoRunsIt ?? (body.sections ? card.shown : next.showWhoRunsIt);
  return {
    ...next,
    showWhoRunsIt: shown,
    sections: next.sections.map((s) =>
      s.key === "who_runs_it" ? { ...s, shown } : s,
    ),
  };
}

/** [current] with what [body] sets. */
function merged(current: Settings, body: Body): Settings {
  const next: Settings = {
    enabled: body.enabled ?? current.enabled,
    tagline:
      body.tagline === undefined ? current.tagline : body.tagline || null,
    buttons: body.buttons
      ? body.buttons.map((b) => ({
          label: b.label,
          url: b.url ?? null,
          channelId: b.channelId ?? null,
        }))
      : current.buttons,
    about: body.about === undefined ? current.about : body.about || null,
    mainChannelIds: body.mainChannelIds ?? current.mainChannelIds,
    faq: body.faq ? faqWithIds(body.faq) : current.faq,
    showWhoRunsIt: current.showWhoRunsIt,
    look: body.look
      ? {
          ...current.look,
          ...body.look,
          accent: (body.look.accent ?? current.look.accent).toLowerCase(),
        }
      : current.look,
    sections: body.sections
      ? body.sections.map((s) => ({ ...s }))
      : current.sections,
    phoneOrder:
      body.phoneOrder ??
      current.phoneOrder ??
      current.sections.map((s) => s.key),
    ordersLinked: body.ordersLinked ?? current.ordersLinked ?? false,
    leaderboards: body.leaderboards ?? current.leaderboards,
  };
  return syncWhoRunsIt(next, body);
}

/**
 * The community lobby (community parity B, feature "community-lobby", docs/COMMUNITY_PARITY_API.md › Lobby): its
 * settings, templates, feed URL and who has seen it. With COMMUNITY_LOBBY=off the routes answer 503.
 */
export class CommunityLobby {
  readonly store: LobbyStore;
  readonly activity: ActivityCache;
  private readonly imageHosts: readonly string[];

  constructor(
    private readonly ctx: AppContext,
    readonly enabled: boolean,
    extraImageHosts: readonly string[] = [],
    private readonly clock: () => number = now,
  ) {
    this.store = new LobbyStore(ctx.ws);
    this.activity = new ActivityCache(ctx, clock);
    this.imageHosts = [...DEFAULT_FEED_IMAGE_HOSTS, ...extraImageHosts];
  }

  /** Throws 503 while the feature is switched off. */
  requireEnabled(): void {
    if (!this.enabled)
      throw new ApiError(
        503,
        "feature_disabled",
        "The lobby is switched off for now. Try again later.",
      );
  }

  canEdit(orgId: string, userId: string): boolean {
    return this.ctx.authz.can(orgId, userId, "workspace.edit");
  }

  settingsView(
    orgId: string,
    viewerId: string,
  ): z.infer<typeof LobbySettingsView> {
    const lobby = this.store.lobby(orgId);
    const editor = this.canEdit(orgId, viewerId);
    const visible = new Set(
      visibleChannels(this.ctx, orgId, viewerId).map((c) => c.id),
    );
    const feed = editor ? this.store.feed(orgId) : undefined;
    return {
      settings: settingsFor(lobby.settings, editor, visible),
      rev: lobby.rev,
      updatedAt: lobby.updatedAt,
      canEdit: editor,
      feed: feed
        ? { createdAt: feed.created_at, lastPostAt: feed.last_post_at }
        : null,
    };
  }

  view(orgId: string, viewerId: string): Promise<z.infer<typeof LobbyView>> {
    return lobbyView(
      { ctx: this.ctx, store: this.store, activity: this.activity },
      orgId,
      viewerId,
      this.store.lobby(orgId),
    );
  }

  /** What community views carry for members: whether the lobby is on and whether they've seen it. */
  summary(
    orgId: string,
    userId: string,
  ): { lobby?: { enabled: boolean; seen: boolean } } {
    if (!this.enabled) return {};
    return {
      lobby: {
        enabled: this.store.lobby(orgId).settings.enabled,
        seen: this.store.seenAt(orgId, userId) !== null,
      },
    };
  }

  /** 400 lobby_channel_invalid unless every channel [body] names is a live channel of [orgId]. */
  private checkChannels(orgId: string, body: Body): void {
    const ids = [
      ...(body.mainChannelIds ?? []),
      ...(body.buttons ?? []).flatMap((b) =>
        b.channelId ? [b.channelId] : [],
      ),
    ];
    const bad = ids.find((id) => !lobbyChannel(this.ctx, orgId, id));
    if (bad)
      throw new ApiError(
        400,
        "lobby_channel_invalid",
        "Pick channels of this community for the lobby",
        { channelId: bad },
      );
  }

  private requireRev(orgId: string, rev: number | undefined): void {
    const current = this.store.lobby(orgId).rev;
    if (rev !== undefined && rev !== current)
      throw new ApiError(
        409,
        "lobby_stale",
        "Someone else changed the lobby meanwhile. Load the latest version and try again.",
        { rev: current },
      );
  }

  /** Applies [body] (the caller checked the permission); the names of the fields that changed. */
  async update(orgId: string, actorId: string, body: Body): Promise<string[]> {
    this.requireRev(orgId, body.rev);
    this.checkChannels(orgId, body);
    const current = this.store.lobby(orgId).settings;
    const next = merged(current, body);
    const changed = FIELDS.filter(
      (f) => JSON.stringify(next[f]) !== JSON.stringify(current[f]),
    );
    if (changed.length > 0)
      await this.store.save(orgId, next, body.rev, actorId, this.clock());
    return changed;
  }

  /** Applies template [key] on revision [rev] (or the current one). */
  async applyTemplate(
    orgId: string,
    actorId: string,
    key: TemplateKey,
    rev: number | undefined,
  ): Promise<void> {
    this.requireRev(orgId, rev);
    const lobby = this.store.lobby(orgId);
    await this.store.save(
      orgId,
      applyTemplate(lobby.settings, key, () => newId("faq", 9)),
      lobby.rev,
      actorId,
      this.clock(),
    );
  }

  async markSeen(orgId: string, userId: string): Promise<number> {
    return this.store.markSeen(orgId, userId, this.clock());
  }

  /** A new feed URL token (the old one, if any, stops working). Only its hash is kept. */
  async createFeed(
    orgId: string,
    actorId: string,
  ): Promise<{ token: string; createdAt: number; replaced: boolean }> {
    const replaced = !!this.store.feed(orgId);
    const token = newId("lf", 24);
    const createdAt = this.clock();
    await this.store.putFeed({
      org_id: orgId,
      token_hash: sha256Hex(token),
      created_at: createdAt,
      created_by: actorId,
      last_post_at: null,
    });
    return { token, createdAt, replaced };
  }

  deleteFeed(orgId: string): Promise<boolean> {
    return this.store.deleteFeed(orgId);
  }

  /** A post through the feed URL [token]; 404 for a token that isn't (or no longer is) a feed's. */
  async post(
    token: string,
    body: z.infer<typeof LobbyFeedPostBody>,
  ): Promise<{ id: string; postedAt: number; orgId: string }> {
    const feed = this.store.feedByHash(sha256Hex(token));
    if (!feed) throw notFound("This feed URL doesn't exist or was replaced");
    const post = parseFeedPost(body, this.imageHosts);
    const row = {
      id: newId("lp"),
      org_id: feed.org_id,
      ...post,
      posted_at: this.clock(),
    };
    const postedAt = await this.store.addPost(row, LOBBY_LIMITS.feedPosts);
    return { id: row.id, postedAt, orgId: feed.org_id };
  }

  /** The member left or was removed: rejoining lands them on the lobby again. */
  forgetMember(orgId: string, userId: string): Promise<void> {
    return this.store.forgetMember(orgId, userId);
  }

  deleteForUser(userId: string): Promise<void> {
    return this.store.deleteForUser(userId);
  }
}
