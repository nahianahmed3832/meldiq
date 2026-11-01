import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { LOBBY_LIMITS } from "../../../shared/contracts/http/communityLobby.js";
import type { LobbyChannel, LobbyCommunity, LobbyView } from "../../../shared/contracts/http/communityLobbyView.js";
import { onlineCount } from "../../accounts/index.js";
import type { ConversationRow } from "../authz.js";
import { type ActivityCache, leaderboards } from "./boards.js";
import type { Settings } from "./defaults.js";
import { communityLinks, liveNow, pickRoles, rulesChannel, whoRunsIt } from "./sources.js";
import type { LobbyStore, StoredLobby } from "./store.js";

type View = z.infer<typeof LobbyView>;
type Channel = z.infer<typeof LobbyChannel>;

/** Channels across the viewer's current communities, with the existing visibility checks. */
export function leaderboardChannels(ctx: AppContext, viewerId: string): ConversationRow[] {
  return ctx.ws.all<{ org_id: string }>("org_members", { where: { user_id: viewerId } })
    .flatMap(o => visibleChannels(ctx, o.org_id, viewerId));
}

/** Live channels of [orgId] that [viewerId] can see, in the community's order. */
export function visibleChannels(ctx: AppContext, orgId: string, viewerId: string): ConversationRow[] {
  return ctx.authz
    .conversationIdsOf(orgId)
    .flatMap((id) => ctx.authz.conversation(id) ?? [])
    .filter((c) => c.type === "CHANNEL" && !c.archived_at && ctx.authz.canViewChannel(c, viewerId))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.created_at - b.created_at);
}

/** [settings] as [viewerId] may see them: editors see everything; others never see channels they can't open. */
export function settingsFor(settings: Settings, editor: boolean, visibleIds: ReadonlySet<string>): Settings {
  if (editor) return settings;
  return {
    ...settings,
    mainChannelIds: settings.mainChannelIds.filter((id) => visibleIds.has(id)),
    buttons: settings.buttons.filter((b) => !b.channelId || visibleIds.has(b.channelId)),
  };
}

function header(ctx: AppContext, orgId: string): z.infer<typeof LobbyCommunity> {
  const org = ctx.ws.get<{ name: string; photo_rev?: number | null; banner_rev?: number | null; accent?: string | null }>("orgs", { id: orgId })!;
  const members = ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: orgId } }).map((m) => m.user_id);
  return {
    id: orgId,
    name: org.name,
    photoRev: org.photo_rev ?? null,
    bannerRev: org.banner_rev ?? null,
    accent: org.accent ?? null,
    memberCount: members.length,
    onlineCount: onlineCount(ctx, members),
  };
}

/**
 * The main channels: the ones the community picked that the viewer can see, or (none picked, or none of them
 * visible) the busiest text channels the viewer can see this week, then the first ones in the community's order.
 */
function pickMainChannels(settings: Settings, visible: readonly ConversationRow[], perConversation: Record<string, number>): { rows: ConversationRow[]; picked: boolean } {
  const byId = new Map(visible.map((c) => [c.id, c]));
  const picked = settings.mainChannelIds.flatMap((id) => byId.get(id) ?? []);
  if (picked.length > 0) return { rows: picked, picked: true };
  const text = visible.filter((c) => c.voice !== 1);
  const busiest = [...text].sort((a, b) => (perConversation[b.id] ?? 0) - (perConversation[a.id] ?? 0));
  return { rows: busiest.slice(0, LOBBY_LIMITS.mainChannels), picked: false };
}

async function mainChannels(ctx: AppContext, rows: readonly ConversationRow[]): Promise<Channel[]> {
  const last = await ctx.messages.lastMessageAt(rows.filter((c) => c.voice !== 1).map((c) => c.id));
  return rows.map((c) => ({ id: c.id, name: c.name, kind: c.kind, voice: c.voice === 1, format: c.format ?? "text", lastActiveAt: last[c.id] ?? null }));
}

export interface ViewDeps {
  ctx: AppContext;
  store: LobbyStore;
  activity: ActivityCache;
}

/** Everything [viewerId]'s lobby of [orgId] shows (the caller checked they're a member). */
export async function lobbyView({ ctx, store, activity }: ViewDeps, orgId: string, viewerId: string, lobby: StoredLobby): Promise<View> {
  const editor = ctx.authz.can(orgId, viewerId, "workspace.edit");
  const visible = visibleChannels(ctx, orgId, viewerId);
  const settings = settingsFor(lobby.settings, editor, new Set(visible.map((c) => c.id)));
  const week = await activity.week(orgId, visible.filter((c) => c.voice !== 1).map((c) => c.id));
  const main = pickMainChannels(settings, visible, week.perConversation);
  const seenAt = store.seenAt(orgId, viewerId);
  return {
    community: header(ctx, orgId),
    settings,
    rev: lobby.rev,
    canEdit: editor,
    seen: seenAt !== null,
    seenAt,
    mainChannels: await mainChannels(ctx, main.rows),
    mainChannelsPicked: main.picked,
    // Editors always get the list, so the live editor can preview the card before it's switched on.
    whoRunsIt: settings.showWhoRunsIt || editor ? whoRunsIt(ctx, orgId) : [],
    liveNow: await liveNow(ctx, visible),
    rules: rulesChannel(ctx, orgId, viewerId),
    links: communityLinks(ctx, orgId),
    pickRoles: pickRoles(ctx, orgId, viewerId),
    leaderboards: leaderboards(ctx, orgId, settings.leaderboards, week),
    // The Giveaways bot (community parity D, part 2) fills this through the official bots' runtime.
    giveaways: ctx.officialBots.giveaways(orgId, viewerId),
    feed: store.posts(orgId, LOBBY_LIMITS.feedPosts).map((p) => ({ id: p.id, title: p.title, text: p.text, url: p.url, image: p.image, postedAt: p.posted_at })),
  };
}
