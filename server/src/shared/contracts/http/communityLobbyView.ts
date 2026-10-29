import { z } from "zod/v4";
import { LobbyBoard, LobbySettings } from "./communityLobby.js";
import { zCount, zTime } from "./primitives.js";

/**
 * What a member's lobby shows (community parity B, docs/COMMUNITY_PARITY_API.md › Lobby), all worked out by the server
 * for this viewer: channels they can't see are never named.
 */

/** A person as the lobby shows them (their photo only when they show it to everyone). */
export const LobbyPerson = z.strictObject({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarColor: z.number(),
  photoRev: z.number().nullable(),
});

export const LobbyCommunity = z.strictObject({
  id: z.string(),
  name: z.string(),
  photoRev: z.number().nullable(),
  bannerRev: z.number().nullable(),
  /** The community's own accent; the lobby's look may override it. */
  accent: z.string().nullable(),
  memberCount: zCount,
  /** Members who appear online now. */
  onlineCount: zCount,
});

export const LobbyChannel = z.strictObject({
  id: z.string(),
  name: z.string().nullable(),
  kind: z.enum(["PUBLIC", "PRIVATE", "ANNOUNCEMENT"]).nullable(),
  voice: z.boolean(),
  format: z.enum(["text", "forum"]),
  /** The newest message's time ("Active 5m ago"), null without one. */
  lastActiveAt: zTime.nullable(),
});

export const LobbyStaff = z.strictObject({ user: LobbyPerson, badge: z.enum(["owner", "admin", "mod"]) });

export const LobbyLiveRoom = z.strictObject({
  channelId: z.string(),
  name: z.string().nullable(),
  callId: z.string(),
  startedAt: zTime,
  participantCount: zCount,
  /** The first few people in the room. */
  participants: z.array(LobbyPerson),
});

const PickRole = z.strictObject({ id: z.string(), name: z.string(), color: z.string().nullable() });
const PickOption = z.strictObject({ id: z.string(), title: z.string(), emoji: z.string().nullable(), roles: z.array(PickRole) });
const PickPrompt = z.strictObject({ id: z.string(), title: z.string(), single: z.boolean(), options: z.array(PickOption) });

/** The onboarding questions whose answers give roles (answered on POST /v1/orgs/:orgId/onboarding/answers). */
export const LobbyPickRoles = z.strictObject({ prompts: z.array(PickPrompt), answered: z.array(z.string()) });

export const LobbyBoardEntry = z.strictObject({ rank: z.number().int().positive(), user: LobbyPerson, count: zCount });
/** One leaderboard: "levels" stays empty until the Levels bot arrives. */
export const LobbyLeaderboard = z.strictObject({ board: LobbyBoard, entries: z.array(LobbyBoardEntry) });

/** A running giveaway (filled by the Giveaways bot in a later batch; always empty for now). */
export const LobbyGiveaway = z.strictObject({ id: z.string(), title: z.string(), endsAt: zTime, entrants: zCount });

export const LobbyFeedPost = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  url: z.string().nullable(),
  image: z.string().nullable(),
  postedAt: zTime,
});

export const LobbyView = z.strictObject({
  community: LobbyCommunity,
  /** The lobby's settings as this viewer may see them (channels they can't open are left out unless they edit it). */
  settings: LobbySettings,
  rev: zCount,
  canEdit: z.boolean(),
  /** Whether the viewer has opened the lobby before (POST …/lobby/seen); apps open it first only while false. */
  seen: z.boolean(),
  seenAt: zTime.nullable(),
  mainChannels: z.array(LobbyChannel),
  /** true: the community picked them; false: the busiest channels the viewer can see this week. */
  mainChannelsPicked: z.boolean(),
  /** Empty when "show who runs it" is off, except for people who can edit the lobby (the editor's preview). */
  whoRunsIt: z.array(LobbyStaff),
  liveNow: z.array(LobbyLiveRoom),
  /** The rules channel when there is one and the viewer can see it. */
  rules: z.strictObject({ channelId: z.string() }).nullable(),
  links: z.array(z.strictObject({ label: z.string(), url: z.string() })),
  pickRoles: LobbyPickRoles,
  /** The settings' boards, in their order. */
  leaderboards: z.array(LobbyLeaderboard),
  giveaways: z.array(LobbyGiveaway),
  /** Newest first. */
  feed: z.array(LobbyFeedPost),
});
