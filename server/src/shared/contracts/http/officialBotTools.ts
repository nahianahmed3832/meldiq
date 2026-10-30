import { z } from "zod/v4";
import { BOT_LIMITS } from "./officialBots.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Official bots with something of their own to manage besides settings (community parity batch D part 2,
 * docs/COMMUNITY_PARITY_API.md › Official bots): the YouTube channels Alerts follows, and a member's Wordy game of the
 * day played privately from the apps (`/wordy`), so their guesses aren't shown to the channel.
 */

const zChannelId = z.string().min(1).max(64);

export const AlertWatch = z.strictObject({
  id: z.string(),
  /** What was pasted: a channel link or @handle. */
  source: z.string(),
  youtubeChannelId: z.string(),
  /** The YouTube channel's name ({creator}). */
  creator: z.string(),
  /** Where new uploads are posted. */
  channelId: z.string(),
  /** The role pinged ({role}), null: no ping. */
  roleId: z.string().nullable(),
  /** The community's own line; null: Meldiq's. Placeholders {creator} {title} {url} {role}. */
  message: z.string().nullable(),
  /** When it was last checked, null before the first check. */
  checkedAt: zTime.nullable(),
  createdAt: zTime,
  /** false: beyond the free limit while the community has no Bots+ (kept, not checked). */
  active: z.boolean(),
});

export const AlertWatches = z.strictObject({
  watches: z.array(AlertWatch),
  /** How many this community may follow now (3, or 25 with Bots+). */
  limit: z.number().int(),
  defaultMessage: z.string(),
});

export const AlertWatchBody = z.strictObject({
  /** A YouTube channel link (youtube.com/@handle, /channel/UC…, /user/name) or an @handle. */
  source: z.string().trim().min(2).max(300),
  channelId: zChannelId,
  roleId: z.string().min(1).max(64).nullable().optional(),
  message: z.string().trim().min(1).max(BOT_LIMITS.alertMessage).nullable().optional(),
});

export const AlertWatchPatch = z.strictObject({
  channelId: zChannelId.optional(),
  roleId: z.string().min(1).max(64).nullable().optional(),
  message: z.string().trim().min(1).max(BOT_LIMITS.alertMessage).nullable().optional(),
});

export const AlertWatchParams = z.object({ orgId: z.string().min(1).max(64), watchId: z.string().min(1).max(64) });

const WordyRow = z.strictObject({
  /** The word guessed: only the player sees their own game. */
  guess: z.string(),
  /** 🟩 right place, 🟨 elsewhere in the word, ⬛ not in it; five of them. */
  marks: z.string(),
});

export const WordyStats = z.strictObject({
  played: zCount,
  won: zCount,
  /** 0 once a day was missed or lost. */
  streak: zCount,
  bestStreak: zCount,
  /** Wins in 1, 2… 6 tries. */
  distribution: z.array(zCount),
});

export const WordyGame = z.strictObject({
  /** The UTC day, "YYYY-MM-DD", and the puzzle's number. */
  day: z.string(),
  number: z.number().int(),
  rows: z.array(WordyRow),
  maxTries: z.number().int(),
  finished: z.boolean(),
  solved: z.boolean(),
  /** The Wordy channel, where the result and the daily recap are posted (null: none picked). */
  channelId: z.string().nullable(),
  stats: WordyStats,
});

export const WordyGuessBody = z.strictObject({ guess: z.string().trim().min(1).max(20) });

const OrgOnly = z.object({ orgId: z.string().min(1).max(64) });
const tag = "official-bots";
const off = ["not_found", "feature_disabled"] as const;

export const officialBotToolRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/official-bots/alerts/watches",
    tag,
    summary: "The YouTube channels Alerts follows here (people who can edit the community).",
    auth: true,
    params: OrgOnly,
    response: AlertWatches,
    errors: [...off, "forbidden", "alerts_unconfigured"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/official-bots/alerts/watches",
    tag,
    summary: "Follow a YouTube channel: its new uploads are posted in the channel picked.",
    auth: true,
    params: OrgOnly,
    body: AlertWatchBody,
    response: z.strictObject({ watch: AlertWatch }),
    status: 201,
    errors: [...off, "forbidden", "alerts_unconfigured", "alerts_source_unknown", "official_bot_channel_invalid", "bots_plus_required", "limit_reached", "conflict"],
  }),
  route({
    method: "PATCH",
    url: "/v1/orgs/:orgId/official-bots/alerts/watches/:watchId",
    tag,
    summary: "Change where a followed channel's uploads go, the role pinged or the line.",
    auth: true,
    params: AlertWatchParams,
    body: AlertWatchPatch,
    response: z.strictObject({ watch: AlertWatch }),
    errors: [...off, "forbidden", "alerts_unconfigured", "official_bot_channel_invalid", "conflict"],
  }),
  route({
    method: "DELETE",
    url: "/v1/orgs/:orgId/official-bots/alerts/watches/:watchId",
    tag,
    summary: "Stop following a YouTube channel.",
    auth: true,
    params: AlertWatchParams,
    response: z.strictObject({ deleted: z.boolean() }),
    errors: [...off, "forbidden"],
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/official-bots/wordy/game",
    tag,
    summary: "Your Wordy game of the day (started when you first guess) and your record here.",
    auth: true,
    params: OrgOnly,
    response: WordyGame,
    errors: [...off, "official_bot_off"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/official-bots/wordy/game",
    tag,
    summary: "Guess today's word privately; the result (without letters) is posted in the Wordy channel when you finish.",
    auth: true,
    params: OrgOnly,
    body: WordyGuessBody,
    response: WordyGame,
    errors: [...off, "official_bot_off", "wordy_not_a_word", "wordy_finished"],
  }),
];
