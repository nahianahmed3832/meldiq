import { z } from "zod/v4";
import { zUsername } from "./auth.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";
import { SendMessageResult } from "./serverMessages.js";
import { BotComponentList, BotComponentInvocation, ComponentInteractionBody } from "./botComponents.js";
import { WebhookEmbedInput, LinkButtonInput } from "./webhooks.js";
import { MessageAttachment } from "../attachments.js";

/**
 * Bots people make (API 0.65.0, settings parity batch B, docs/SETTINGS_PARITY_API.md). A bot is an account of its own
 * (profiles say `bot: true`) that can't sign in: it acts only through `Authorization: Bot <token>` on /v2/bot/…, posts
 * through the same message path as people, and answers slash commands it pulls with a long poll (nothing to host).
 */

export const COMMAND_NAME = /^[a-z0-9-]{1,32}$/;
export const COMMAND_LIMIT = 100;
export const OPTION_LIMIT = 25;
export const OPTION_TYPES = ["string", "number", "boolean", "user"] as const;
/** The longest wait a bot may ask of GET /v2/bot/interactions, in seconds. */
export const MAX_POLL_WAIT_S = 25;
/** How long a command waits for the bot's answer. */
export const INTERACTION_TTL_MS = 15 * 60_000;
export const MAX_CONTENT = 4000;
export const MAX_PENDING_BOT_INTERACTIONS = 500;

const zCommandName = z.string().regex(COMMAND_NAME, "1–32 characters: a–z, 0–9 and -");
const zDescription = z.string().trim().min(1).max(100);
const uniqueNames = (items: readonly { name: string }[]) => new Set(items.map(item => item.name)).size === items.length;

export const CommandOption = z.strictObject({
  name: zCommandName,
  description: zDescription,
  type: z.enum(OPTION_TYPES),
  required: z.boolean().default(false),
});
export const BotCommand = z.strictObject({
  name: zCommandName,
  description: zDescription,
  options: z
    .array(CommandOption)
    .max(OPTION_LIMIT)
    .default([])
    .refine(uniqueNames, "Each option name once"),
});
export type BotCommand = z.output<typeof BotCommand>;
export const CommandsBody = z.strictObject({
  commands: z
    .array(BotCommand)
    .max(COMMAND_LIMIT)
    .refine(uniqueNames, "Each command name once"),
});
export const CommandsResult = z.strictObject({ commands: z.array(BotCommand) });

const zBotName = z.string().trim().min(1).max(80);

/** A bot as its owner sees it. Its id is its account's user id. */
export const DeveloperBot = z.strictObject({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  /** Public: any community admin may add it. Private: only you can. */
  public: z.boolean(),
  createdAt: zTime,
  tokenRotatedAt: zTime,
  commands: zCount,
  communities: zCount,
  /** Beyond what your plan allows now (a downgrade): its token is refused until you upgrade or delete another bot. */
  locked: z.boolean(),
});
export const BotList = z.strictObject({
  bots: z.array(DeveloperBot),
  /** Bots your plan allows (docs/MOJO.md). */
  limit: zCount,
  plan: z.string(),
});
export const BotCreateBody = z.strictObject({ name: zBotName, username: zUsername.optional(), public: z.boolean().optional() });
export const BotPatch = z
  .strictObject({ name: zBotName.optional(), public: z.boolean().optional() })
  .refine((b) => b.name !== undefined || b.public !== undefined, "Send a name or public");
export const BotWithToken = z.strictObject({
  bot: DeveloperBot,
  /** Shown this once: Meldiq keeps only its hash. Send it as `Authorization: Bot <token>`. */
  token: z.string(),
});
export const BotResult = z.strictObject({ bot: DeveloperBot });
export const BotParams = z.strictObject({ id: z.string().min(1).max(64) });
export const BotIdParams = z.strictObject({ botId: z.string().min(1).max(64) });
export const BotDeleted = z.strictObject({ deleted: z.literal(true) });

/** What anyone about to add a bot sees. */
export const BotProfile = z.strictObject({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  public: z.boolean(),
  owner: z.strictObject({ id: z.string(), username: z.string() }).nullable(),
  commands: zCount,
});
export const BotProfileResult = z.strictObject({ bot: BotProfile });

export const OrgBotParams = z.strictObject({ orgId: z.string().max(64), botId: z.string().min(1).max(64) });
export const InstallBody = z.strictObject({ botId: z.string().min(1).max(64) });
export const InstallResult = z.strictObject({
  bot: BotProfile,
  /** false: it was in the community already. */
  installed: z.boolean(),
});
export const RemoveResult = z.strictObject({ removed: z.boolean() });

export const OrgCommandsQuery = z.object({ channelId: z.string().max(64).optional() });
export const OrgCommand = BotCommand.extend({ botId: z.string(), botUsername: z.string(), botDisplayName: z.string() });
export const OrgCommands = z.strictObject({ commands: z.array(OrgCommand) });

const zOptionValue = z.union([z.string().max(1000), z.number(), z.boolean()]);
export const CommandInteractionBody = z.strictObject({
  channelId: z.string().max(64),
  botId: z.string().min(1).max(64),
  command: zCommandName,
  /** Option name → value, checked against the command's options (a "user" option takes a user id). */
  options: z.record(z.string().max(32), zOptionValue).default({}),
});
export const InteractionBody = z.union([CommandInteractionBody, ComponentInteractionBody]);
export const InteractionCreated = z.strictObject({
  interaction: z.strictObject({ id: z.string(), botId: z.string(), command: z.string(), createdAt: zTime, expiresAt: zTime }),
  duplicate: z.boolean().optional(),
});

export const BotSelf = z.strictObject({
  bot: z.strictObject({ id: z.string(), username: z.string(), displayName: z.string(), public: z.boolean(), ownerId: z.string() }),
});
export const BotChannel = z.strictObject({ id: z.string(), name: z.string().nullable(), kind: z.string(), voice: z.boolean(), canPost: z.boolean() });
export const BotCommunities = z.strictObject({
  communities: z.array(z.strictObject({ id: z.string(), name: z.string(), channels: z.array(BotChannel) })),
});
const zContent = z.string().min(1).max(MAX_CONTENT);
export const ChannelParams = z.strictObject({ channelId: z.string().max(64) });
export const MessageParams = z.strictObject({ messageId: z.string().min(1).max(64) });
export const BotMessageBody = z.strictObject({
  content: zContent,
  replyTo: z.string().max(64).optional(),
  /** Your own id for the message (8–64 of [A-Za-z0-9_-]): sending it again is answered as a duplicate. */
  messageId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  embeds: z.array(WebhookEmbedInput).max(10).optional(),
  buttons: z.array(LinkButtonInput).max(5).optional(),
  components: BotComponentList.optional(),
  componentsTtlSeconds: z.number().int().min(60).max(86400).optional(),
  attachments: z.array(MessageAttachment).max(10).optional(),
});
export const BotEditBody = z.strictObject({ content: zContent });

export const InteractionsQuery = z.object({ wait: z.coerce.number().int().min(0).max(MAX_POLL_WAIT_S).default(0) });
export const BotInteraction = z.strictObject({
  id: z.string(),
  command: z.string(),
  options: z.record(z.string(), zOptionValue),
  user: z.strictObject({ id: z.string(), username: z.string(), displayName: z.string() }),
  channelId: z.string(),
  communityId: z.string().nullable(),
  createdAt: zTime,
  /** Answer before this (15 minutes after the command). */
  expiresAt: zTime,
  component: BotComponentInvocation.optional(),
});
export const BotInteractions = z.strictObject({ interactions: z.array(BotInteraction) });
export const InteractionParams = z.strictObject({ id: z.string().min(1).max(64) });
export const ReplyBody = z.strictObject({
  content: zContent,
  /** true: only the person who ran the command sees it (a realtime frame to them), and nothing is stored. */
  ephemeral: z.boolean().optional(),
});
export const ReplyResult = z.strictObject({ interactionId: z.string(), ephemeral: z.boolean(), messageId: z.string().nullable() });

const dev = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "developer", auth: true, ...c });
const bot = (c: Omit<Parameters<typeof route>[0], "tag" | "auth" | "scheme">) => route({ tag: "bot api", auth: true, scheme: "bot", ...c });
const bots = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "bots", auth: true, ...c });

export const botRoutes = [
  dev({ method: "GET", url: "/v2/developer/bots", summary: "Your bots, and how many your plan allows.", response: BotList }),
  dev({
    method: "POST",
    url: "/v2/developer/bots",
    summary: "Make a bot: an account of its own; its token is shown this once.",
    body: BotCreateBody,
    response: BotWithToken,
    status: 201,
    errors: ["limit_reached", "username_taken"],
  }),
  dev({ method: "PATCH", url: "/v2/developer/bots/:id", summary: "Rename a bot, or make it public or private.", params: BotParams, body: BotPatch, response: BotResult, errors: ["not_found"] }),
  dev({ method: "DELETE", url: "/v2/developer/bots/:id", summary: "Delete a bot: it leaves every community.", params: BotParams, response: BotDeleted, errors: ["not_found"] }),
  dev({
    method: "POST",
    url: "/v2/developer/bots/:id/token",
    summary: "Replace a bot's token (the old one stops working at once); the new one is shown this once.",
    params: BotParams,
    response: BotWithToken,
    errors: ["not_found"],
  }),
  bots({ method: "GET", url: "/v2/bots/:botId", summary: "A bot as someone about to add it sees it (public bots, or your own).", params: BotIdParams, response: BotProfileResult, errors: ["not_found"] }),
  bots({
    method: "POST",
    url: "/v1/orgs/:orgId/bots",
    summary: "Add a bot to a community (Edit community permission; a private bot only by its owner). It joins as a member.",
    params: z.strictObject({ orgId: z.string().max(64) }),
    body: InstallBody,
    response: InstallResult,
    errors: ["not_found", "forbidden", "bot_private", "banned", "limit_reached"],
  }),
  bots({ method: "DELETE", url: "/v1/orgs/:orgId/bots/:botId", summary: "Remove a bot from a community.", params: OrgBotParams, response: RemoveResult, errors: ["not_found", "forbidden"] }),
  bots({
    method: "GET",
    url: "/v1/orgs/:orgId/commands",
    summary: "Slash commands of the bots in a community (with channelId: only bots that can post there).",
    params: z.strictObject({ orgId: z.string().max(64) }),
    query: OrgCommandsQuery,
    response: OrgCommands,
    errors: ["not_found"],
  }),
  bots({
    method: "POST",
    url: "/v2/interactions",
    summary: "Run a bot's slash command in a channel: queued for the bot, which answers within 15 minutes.",
    body: InteractionBody,
    response: InteractionCreated,
    status: 201,
    errors: ["not_found", "bot_not_here", "forbidden", "onboarding_not_finished", "rules_not_agreed", "rate_limited"],
  }),
  bot({ method: "GET", url: "/v2/bot/me", summary: "The bot itself.", response: BotSelf }),
  bot({ method: "GET", url: "/v2/bot/communities", summary: "The communities the bot is in, with the channels it's in and whether it can post there.", response: BotCommunities }),
  bot({
    method: "POST",
    url: "/v2/bot/channels/:channelId/messages",
    summary: "Send a message to a channel the bot can post in (everyone sees it as a message from the bot).",
    params: ChannelParams,
    body: BotMessageBody,
    response: SendMessageResult,
    errors: ["not_found", "forbidden", "slowmode", "message_too_long"],
  }),
  bot({ method: "PATCH", url: "/v2/bot/messages/:messageId", summary: "Edit one of the bot's own messages.", params: MessageParams, body: BotEditBody, response: SendMessageResult, errors: ["not_found", "not_yours"] }),
  bot({ method: "DELETE", url: "/v2/bot/messages/:messageId", summary: "Delete the bot's own message, or another sender's message only with approved messages.manage and current native moderation authority.", params: MessageParams, response: SendMessageResult, errors: ["not_found", "not_yours"] }),
  bot({ method: "GET", url: "/v2/bot/commands", summary: "The bot's slash commands.", response: CommandsResult }),
  bot({ method: "PUT", url: "/v2/bot/commands", summary: "Replace the bot's slash commands (up to 100, each with up to 25 options).", body: CommandsBody, response: CommandsResult }),
  bot({
    method: "GET",
    url: "/v2/bot/interactions",
    summary: "Commands people ran, each given out once; ?wait=25 holds the request up to 25 s until one comes (long poll).",
    query: InteractionsQuery,
    response: BotInteractions,
  }),
  bot({
    method: "POST",
    url: "/v2/bot/interactions/:id/reply",
    summary: "Answer a command within 15 minutes: a message in the channel, or (ephemeral) only to the person who ran it.",
    params: InteractionParams,
    body: ReplyBody,
    response: ReplyResult,
    errors: ["not_found", "interaction_answered", "interaction_expired", "forbidden"],
  }),
];
