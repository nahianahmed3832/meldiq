import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";

/**
 * A community's lobby (community parity B, feature "community-lobby", docs/COMMUNITY_PARITY_API.md › Lobby): the home
 * page members land on, with a header, an about text, main channels, a FAQ, who runs it, what's live, leaderboards and
 * an incoming feed, laid out by its own look and section order. Plaintext configuration, like the community guide
 * (which stays as it is). The view members read is in communityLobbyView.ts; the routes in communityLobbyRoutes.ts.
 */

export const LOBBY_LIMITS = {
  tagline: 120,
  buttons: 4,
  buttonLabel: 40,
  url: 500,
  about: 2000,
  mainChannels: 6,
  faq: 10,
  question: 200,
  answer: 1000,
  /** Feed posts kept per community (the newest). */
  feedPosts: 20,
  feedTitle: 200,
  feedText: 1000,
  /** People on each leaderboard. */
  leaderboard: 10,
} as const;

/** The lobby's cards, in the reference's default order. */
export const LOBBY_SECTION_KEYS = [
  "about",
  "main_channels",
  "live_now",
  "giveaways",
  "feed",
  "faq",
  "leaderboard",
  "pick_roles",
  "rules",
  "who_runs_it",
  "links",
] as const;
export const LOBBY_BOARDS = ["levels", "messages_week", "invites"] as const;
export const LOBBY_TEMPLATES = [
  "gaming",
  "study",
  "creators",
  "hangout",
  "minimal",
] as const;

export const LobbySectionKey = z.enum(LOBBY_SECTION_KEYS);
export const LobbyBoard = z.enum(LOBBY_BOARDS);
export const LobbyTemplateKey = z.enum(LOBBY_TEMPLATES);

/** An https link (the lobby never links anywhere else). */
export const HttpsUrl = z
  .string()
  .trim()
  .max(LOBBY_LIMITS.url)
  .regex(/^https:\/\/[^\s]+$/i, "Links must start with https://")
  .refine((u) => URL.canParse(u), "Not a link");

const ChannelRef = z.string().min(1).max(64);
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const LobbyLook = z.strictObject({
  /** classic: two columns; spotlight: one centred column; magazine: big hero and tiles; compact: dense list. */
  layout: z.enum(["classic", "spotlight", "magazine", "compact"]),
  /** "auto": the community's accent; otherwise "#rrggbb" (lower case). */
  accent: z.union([z.literal("auto"), HexColor]),
  background: z.enum(["glow", "mesh", "banner_blur", "plain"]),
  cards: z.enum(["filled", "glass", "outline"]),
  font: z.enum(["default", "rounded", "serif", "mono", "display"]),
  bannerHeight: z.enum(["tall", "normal", "short"]),
  title: z.enum(["left", "centered"]),
});

/** One card's place: shown or hidden, and in the classic layout's main or side column. */
export const LobbySection = z.strictObject({
  key: LobbySectionKey,
  shown: z.boolean(),
  column: z.enum(["main", "side"]),
});

/** A button at the top of the page: a site (https) or a channel of the community. The first one is the primary one. */
export const LobbyButton = z.strictObject({
  label: z.string(),
  url: z.string().nullable(),
  channelId: z.string().nullable(),
});
export const LobbyFaqItem = z.strictObject({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
});

/** Everything the lobby's editor sets. */
export const LobbySettings = z.strictObject({
  /** Members land on the lobby the first time they open the community. */
  enabled: z.boolean(),
  tagline: z.string().nullable(),
  buttons: z.array(LobbyButton),
  /** Markdown. */
  about: z.string().nullable(),
  /** In tap order. Empty: the lobby shows the busiest channels the viewer can see. */
  mainChannelIds: z.array(z.string()),
  faq: z.array(LobbyFaqItem),
  /** The same switch as the who_runs_it section's `shown`. */
  showWhoRunsIt: z.boolean(),
  look: LobbyLook,
  sections: z.array(LobbySection),
  phoneOrder: z
    .array(LobbySectionKey)
    .length(LOBBY_SECTION_KEYS.length)
    .refine((v) => new Set(v).size === v.length, "Each section once")
    .optional(),
  ordersLinked: z.boolean().optional(),
  /** The leaderboard card's boards, in tab order. */
  leaderboards: z.array(LobbyBoard),
});

export const LobbyButtonBody = z
  .strictObject({
    label: z.string().trim().min(1).max(LOBBY_LIMITS.buttonLabel),
    url: HttpsUrl.nullish(),
    channelId: ChannelRef.nullish(),
  })
  .refine(
    (b) => !!b.url !== !!b.channelId,
    "A button opens either a link or a channel",
  );

export const LobbyFaqBody = z.strictObject({
  /** Kept when it's 1–32 of A-Z, a-z, 0-9, _ and -; a new id otherwise. */
  id: z.string().max(32).optional(),
  question: z.string().trim().min(1).max(LOBBY_LIMITS.question),
  answer: z.string().trim().min(1).max(LOBBY_LIMITS.answer),
});

const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;

export const LobbySectionsBody = z
  .array(LobbySection)
  .length(LOBBY_SECTION_KEYS.length)
  .refine(
    (s) => unique(s.map((x) => x.key)),
    "Each section appears exactly once",
  );

/**
 * A change to the lobby: [rev] is the revision it was made on (0 before the first save); a stale one is refused with
 * 409 lobby_stale. Fields left out keep their value; `look` may set some of its fields.
 */
export const LobbySettingsBody = z.strictObject({
  rev: zCount,
  enabled: z.boolean().optional(),
  tagline: z.string().trim().max(LOBBY_LIMITS.tagline).nullish(),
  buttons: z.array(LobbyButtonBody).max(LOBBY_LIMITS.buttons).optional(),
  about: z.string().trim().max(LOBBY_LIMITS.about).nullish(),
  mainChannelIds: z
    .array(ChannelRef)
    .max(LOBBY_LIMITS.mainChannels)
    .refine(unique, "Each channel once")
    .optional(),
  faq: z.array(LobbyFaqBody).max(LOBBY_LIMITS.faq).optional(),
  showWhoRunsIt: z.boolean().optional(),
  look: LobbyLook.partial().optional(),
  sections: LobbySectionsBody.optional(),
  phoneOrder: z
    .array(LobbySectionKey)
    .length(LOBBY_SECTION_KEYS.length)
    .refine(unique, "Each section once")
    .optional(),
  ordersLinked: z.boolean().optional(),
  leaderboards: z
    .array(LobbyBoard)
    .min(1)
    .max(LOBBY_BOARDS.length)
    .refine(unique, "Each board once")
    .optional(),
});

/** Applies a template's look and section layout; text, channels and buttons stay, starter questions only fill an empty FAQ. */
export const LobbyTemplateBody = z.strictObject({
  key: LobbyTemplateKey,
  rev: zCount.optional(),
});

/** The feed URL's state (never the URL itself, which is shown once). */
export const LobbyFeedInfo = z.strictObject({
  createdAt: zTime,
  lastPostAt: zTime.nullable(),
});

export const LobbySettingsView = z.strictObject({
  settings: LobbySettings,
  /** The revision to send with the next change (0 before the first save). */
  rev: zCount,
  updatedAt: zTime.nullable(),
  /** Whether the viewer may change the lobby (`workspace.edit`). */
  canEdit: z.boolean(),
  /** For people who can edit it: the feed URL, null without one. Always null for everyone else. */
  feed: LobbyFeedInfo.nullable(),
});

/** A new or rotated feed URL: POST [token] to /v1/lobby-feed/<token>. The token is shown only now. */
export const LobbyFeedCreated = z.strictObject({
  token: z.string(),
  feed: LobbyFeedInfo,
});
export const LobbyFeedDeleted = z.strictObject({ feed: z.null() });
export const LobbySeen = z.strictObject({
  seen: z.literal(true),
  seenAt: zTime,
});

/** Anything longer is refused outright; what fits is cut to the lobby's limits. */
const FeedText = z.string().max(8000).nullish();
const FeedImage = z.object({ url: FeedText }).nullish();
const FeedEmbed = z.object({
  title: FeedText,
  description: FeedText,
  url: FeedText,
  image: FeedImage,
  thumbnail: FeedImage,
});

/**
 * What the feed URL takes: Meldiq's own `{title, text, url, image}`, or a Discord-style webhook body
 * (`{content, embeds: [{title, description, url, image: {url}}]}`, the first embed is used). Other fields are ignored.
 */
export const LobbyFeedPostBody = z.object({
  title: FeedText,
  text: FeedText,
  url: FeedText,
  image: z.union([FeedText, FeedImage]),
  content: FeedText,
  embeds: z.array(FeedEmbed).max(10).nullish(),
});

export const LobbyFeedAccepted = z.strictObject({
  id: z.string(),
  postedAt: zTime,
});
export const LobbyFeedParams = z.object({ token: z.string().min(10).max(128) });
