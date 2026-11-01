import { z } from "zod/v4";
import { zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Official bots (community parity batch D, feature "community-bots", docs/COMMUNITY_PARITY_API.md › Official bots):
 * Meldiq's own bots a community turns on from Settings › Bots. Each one on is a bot member of the community with its own
 * name and picture there. Bots+ (granted per community) unlocks every bot's Plus extras.
 */

/** Every official bot, in the order the Bots page lists them. */
export const OFFICIAL_BOT_KEYS = ["welcomer", "helper", "levels", "logger", "starboard", "giveaways", "tickets", "alerts", "wordy"] as const;
export type OfficialBotKey = (typeof OFFICIAL_BOT_KEYS)[number];
/** The bots that run (all nine since part 2; Alerts is still unavailable on a server without a YouTube API key). */
export const LIVE_BOT_KEYS = OFFICIAL_BOT_KEYS;
export type LiveBotKey = (typeof LIVE_BOT_KEYS)[number];

export const BOT_LIMITS = {
  lookName: 32,
  welcomeMessage: 300,
  welcomeLines: { free: 1, plus: 10 },
  customCommands: 25,
  customCommandName: 32,
  customResponse: 500,
  roleRewards: 20,
  maxLevel: 500,
  excludedChannels: 25,
  starThresholds: [1, 2, 3, 4, 5, 7, 10, 15, 20, 30],
  defaultStarThreshold: 5,
  xpBoosts: [1, 1.5, 2],
  giveawayWinners: { free: 3, plus: 20 },
  giveawayDays: { free: 7, plus: 30 },
  giveawayPrize: 200,
  ticketPanels: { free: 2, plus: 10 },
  ticketsOpenPerPerson: { free: 3, plus: 10 },
  ticketWelcome: 500,
  alertWatches: { free: 3, plus: 25 },
  alertMessage: 300,
} as const;

const zChannelId = z.string().min(1).max(64);
const oneOf = (values: readonly number[], what: string) => z.number().refine((n) => values.includes(n), `${what}: one of ${values.join(", ")}`);
const zThreshold = oneOf(BOT_LIMITS.starThresholds, "Stars needed");
const zBoost = oneOf(BOT_LIMITS.xpBoosts, "XP boost");

/** Welcomer. `channelId` null: the community's #general, or its first public text channel. Plus: 10 lines, goodbye. */
export const WelcomerSettings = z.strictObject({
  channelId: zChannelId.nullable(),
  /** Picked at random for each newcomer; placeholders {user} (a mention), {name}, {server}, {count}. */
  messages: z.array(z.string().trim().min(1).max(BOT_LIMITS.welcomeMessage)).min(1).max(BOT_LIMITS.welcomeLines.plus),
  /** Plus: said in the same channel when someone leaves; {user} is their name then. */
  goodbye: z.string().trim().min(1).max(BOT_LIMITS.welcomeMessage).nullable(),
});

/** Helper: the built-in commands need nothing. Plus: the community's own commands. */
export const HelperSettings = z.strictObject({
  commands: z
    .array(
      z.strictObject({
        /** Without the "!": letters, digits, "-" and "_". */
        name: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9_-]+$/)
          .min(1)
          .max(BOT_LIMITS.customCommandName),
        /** {user}: whoever ran it (a mention). */
        response: z.string().trim().min(1).max(BOT_LIMITS.customResponse),
      }),
    )
    .max(BOT_LIMITS.customCommands),
});

/** Levels. `announceChannelId` null: where they were chatting. Plus: boost, role rewards, own level-up message. */
export const LevelsSettings = z.strictObject({
  announce: z.boolean(),
  announceChannelId: zChannelId.nullable(),
  boost: zBoost,
  roleRewards: z
    .array(
      z.strictObject({
        level: z.number().int().min(1).max(BOT_LIMITS.maxLevel),
        roleId: z.string().min(1).max(64),
      }),
    )
    .max(BOT_LIMITS.roleRewards),
  /** Placeholders {user} (a mention) and {level}; null: Meldiq's line. */
  levelUpMessage: z.string().trim().min(1).max(BOT_LIMITS.welcomeMessage).nullable(),
});

/** Logger: quiet until `channelId` is set. Plus: member events in their own channel, channels left out. */
export const LoggerSettings = z.strictObject({
  channelId: zChannelId.nullable(),
  memberChannelId: zChannelId.nullable(),
  excludeChannelIds: z.array(zChannelId).max(BOT_LIMITS.excludedChannels),
});

/** Starboard: quiet until `channelId` is set. Plus: own emoji instead of ⭐/🌟, self-stars, channels left out. */
export const StarboardSettings = z.strictObject({
  channelId: zChannelId.nullable(),
  threshold: zThreshold,
  emoji: z.string().trim().min(1).max(64).nullable(),
  selfStar: z.boolean(),
  excludeChannelIds: z.array(zChannelId).max(BOT_LIMITS.excludedChannels),
});

const zRoleId = z.string().min(1).max(64);

/** Giveaways: the limits follow Bots+ (winners, length). Plus: only members holding `requiredRoleId` may win. */
export const GiveawaysSettings = z.strictObject({
  requiredRoleId: zRoleId.nullable(),
});

/**
 * What the Tickets bot keeps itself: the Bots+ extras of each panel (by panel id) and transcripts. The rest of its
 * settings is batch C's tickets config (`TicketsBotSettings` is what editors see and send).
 */
export const TicketsBotStored = z.strictObject({
  panels: z.record(
    z.string(),
    z.strictObject({
      supportRoleId: zRoleId.nullable(),
      welcomeMessage: z.string().nullable(),
    }),
  ),
  transcripts: z.boolean(),
});

/** Alerts: its YouTube channels are managed under /official-bots/alerts/watches; nothing else to set. */
export const AlertsSettings = z.strictObject({});

/** Wordy: quiet until `channelId` (where the game is played and the daily recap goes) is set. */
export const WordySettings = z.strictObject({
  channelId: zChannelId.nullable(),
});

export const BOT_SETTINGS = {
  welcomer: WelcomerSettings,
  helper: HelperSettings,
  levels: LevelsSettings,
  logger: LoggerSettings,
  starboard: StarboardSettings,
  giveaways: GiveawaysSettings,
  tickets: TicketsBotStored,
  alerts: AlertsSettings,
  wordy: WordySettings,
} as const;
export type BotSettings<K extends LiveBotKey> = z.infer<(typeof BOT_SETTINGS)[K]>;

/** A Tickets panel as the Tickets bot shows and takes it: batch C's panel, with its Bots+ extras. */
const TicketsBotPanel = z.strictObject({
  /** Kept when it's one of this community's panels; a new id otherwise. */
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(40),
  postChannelId: zChannelId,
  categoryId: zChannelId.nullable(),
  logChannelId: zChannelId.nullable(),
  /** Plus: can see this panel's tickets and is pinged when one opens. Left out when saving: the stored one is kept. */
  supportRoleId: zRoleId.nullable().optional(),
  /** Plus: said in each new ticket of this panel; {user} mentions the opener, {panel} is the panel's name. Left out when
   * saving: the stored one is kept. */
  welcomeMessage: z.string().trim().min(1).max(BOT_LIMITS.ticketWelcome).nullable().optional(),
  /** Shown in views (the panel's last posted message); ignored when sent. */
  postedMessageId: z.string().nullable().optional(),
});

/** The Tickets bot's settings: the tickets config itself (per person, panels) and the Bots+ extras. */
export const TicketsBotSettings = z.strictObject({
  maxOpenPerPerson: z.number().int().min(1).max(BOT_LIMITS.ticketsOpenPerPerson.plus),
  panels: z.array(TicketsBotPanel).max(BOT_LIMITS.ticketPanels.plus),
  /** Plus: a text log of the ticket's messages in the panel's log channel when it closes. */
  transcripts: z.boolean(),
});

export const CatalogBot = z.strictObject({
  key: z.enum(OFFICIAL_BOT_KEYS),
  name: z.string(),
  tagline: z.string(),
  description: z.string(),
  /** The detail window's header colour, "#rrggbb". */
  color: z.string(),
  /** An emoji standing in for the bot's picture until the community picks one. */
  icon: z.string(),
  /** The detail window's chips. */
  features: z.array(z.string()),
  /** What the bot says, for the detail window's preview. */
  sample: z.string(),
  commands: z.array(z.strictObject({ usage: z.string(), description: z.string() })),
  /** The Free vs Plus table. */
  limits: z.array(z.strictObject({ what: z.string(), free: z.string(), plus: z.string() })),
  /** false: listed, but it can't be turned on here. */
  available: z.boolean(),
  /** Why it can't (e.g. "Needs a YouTube API key"), null when it can. */
  unavailableReason: z.string().nullable(),
});

export const OfficialBotsCatalog = z.strictObject({
  bots: z.array(CatalogBot),
  botsPlus: z.strictObject({
    name: z.string(),
    description: z.string(),
    perks: z.array(z.string()),
  }),
});

export const OfficialBotView = z.strictObject({
  key: z.enum(OFFICIAL_BOT_KEYS),
  name: z.string(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  enabled: z.boolean(),
  /** The bot's account in this community (null before it was first turned on or given a look). */
  userId: z.string().nullable(),
  look: z.strictObject({
    /** The community's own name for it (null: `displayName` is the bot's standard name). */
    name: z.string().nullable(),
    displayName: z.string(),
    /** Its picture: GET /v1/users/:userId/photo; null: the standard one. */
    photoRev: zTime.nullable(),
  }),
  /** Its settings (people who can edit the community; null for everyone else and for bots not available yet). */
  settings: z.record(z.string(), z.unknown()).nullable(),
  /** Plus settings stored but not applied because the community has no Bots+ (field names). */
  plusPaused: z.array(z.string()),
  updatedAt: zTime.nullable(),
});

export const CommunityOfficialBots = z.strictObject({
  botsPlus: z.boolean(),
  /** When Bots+ ends (null: no end, or none). */
  botsPlusUntil: zTime.nullable(),
  /** `workspace.edit`: may turn bots on and change them. */
  canEdit: z.boolean(),
  bots: z.array(OfficialBotView),
});

export const OfficialBotBody = z.strictObject({
  enabled: z.boolean().optional(),
  /** Some or all of the bot's settings (the rest stay); checked against that bot's settings. */
  settings: z.record(z.string(), z.unknown()).optional(),
  look: z
    .strictObject({
      name: z.string().trim().min(1).max(BOT_LIMITS.lookName).nullable(),
    })
    .optional(),
});

export const OfficialBotOne = z.strictObject({ bot: OfficialBotView });
export const OfficialBotParams = z.object({
  orgId: z.string().min(1).max(64),
  key: z.enum(OFFICIAL_BOT_KEYS),
});
const OrgOnly = z.object({ orgId: z.string().min(1).max(64) });

/** Platform Admin Console: Bots+ for a community, while billing for it is off. */
export const AdminBotsPlusBody = z.strictObject({
  enabled: z.boolean(),
  /** When it ends (required when granting; null, no end, is for super admins). */
  expiresAt: zTime.nullable().optional(),
  reason: z.string().trim().min(3).max(500),
});
export const BotsPlusGrant = z.strictObject({
  enabled: z.boolean(),
  grantedAt: zTime.nullable(),
  expiresAt: zTime.nullable(),
  grantedBy: z.string().nullable(),
  reason: z.string().nullable(),
});

const tag = "official-bots";
const off = ["not_found", "feature_disabled"] as const;

export const BotDiagnostics = z.strictObject({
  enabled: z.boolean(),
  available: z.boolean(),
  reason: z.string().nullable(),
  checkedAt: z.number().int(),
  checks: z.array(z.strictObject({ label: z.string(), ok: z.boolean(), detail: z.string() })),
  events: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      outcome: z.enum(["ok", "failed"]),
      at: z.number().int(),
    }),
  ),
});

export const officialBotRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/official-bots/:key/diagnostics",
    tag,
    auth: true,
    summary: "Read-only configuration checks and last 50 metadata-only event outcomes for community editors.",
    params: OfficialBotParams,
    response: BotDiagnostics,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "GET",
    url: "/v1/official-bots",
    tag,
    summary: "The official bots: what each does, its commands and its Free vs Plus table.",
    auth: true,
    response: OfficialBotsCatalog,
    errors: ["feature_disabled"],
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/official-bots",
    tag,
    summary: "A community's official bots: on or off, look, settings (editors) and Bots+.",
    auth: true,
    params: OrgOnly,
    response: CommunityOfficialBots,
    errors: [...off],
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/official-bots/:key",
    tag,
    summary: "One official bot in a community.",
    auth: true,
    params: OfficialBotParams,
    response: OfficialBotOne,
    errors: [...off],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/official-bots/:key",
    tag,
    summary: "Turn an official bot on or off, change its settings or its name here (people who can edit the community).",
    auth: true,
    params: OfficialBotParams,
    body: OfficialBotBody,
    response: OfficialBotOne,
    errors: [...off, "forbidden", "bots_plus_required", "official_bot_unavailable", "official_bot_channel_invalid", "bot_role_not_givable", "banned", "limit_reached"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/official-bots/:key/avatar",
    tag,
    summary: "The bot's picture in this community (JPEG).",
    auth: true,
    params: OfficialBotParams,
    binary: "request",
    response: OfficialBotOne,
    errors: [...off, "forbidden", "official_bot_unavailable", "too_large", "storage_unavailable"],
  }),
  route({
    method: "DELETE",
    url: "/v1/orgs/:orgId/official-bots/:key/avatar",
    tag,
    summary: "Back to the bot's standard picture.",
    auth: true,
    params: OfficialBotParams,
    response: OfficialBotOne,
    errors: [...off, "forbidden", "official_bot_unavailable"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/official-bots/welcomer/test",
    tag,
    summary: "Welcomer greets you in its channel, as it would a newcomer.",
    auth: true,
    params: OrgOnly,
    response: z.strictObject({ messageId: z.string(), channelId: z.string() }),
    errors: [...off, "forbidden", "official_bot_off", "official_bot_channel_invalid"],
  }),
];
