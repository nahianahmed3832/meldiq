import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * The community bot directory (community parity batch E, feature "bot-directory", docs/COMMUNITY_PARITY_API.md ›
 * Discovery): public developer bots their owners chose to list, with a category, a short description, how many
 * communities they're in and their slash commands. Adding one is unchanged (POST /v1/orgs/:orgId/bots with its id).
 */

export const BOT_CATEGORIES = ["moderation", "fun", "games", "utility", "music", "economy", "social", "ai", "other"] as const;
export const BotCategory = z.enum(BOT_CATEGORIES);
export const BOT_LISTING_DESCRIPTION_MAX = 200;
export const BOT_DIRECTORY_PAGE = 30;

export const BotDirectoryQuery = z.object({
  /** Matches the bot's name, username, description and slash command names and descriptions. */
  q: z.string().trim().max(60).optional(),
  category: BotCategory.optional(),
  sort: z.enum(["most_used", "newest", "a_z"]).default("most_used"),
  cursor: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const DirectoryBot = z.strictObject({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  description: z.string(),
  category: BotCategory,
  /** Communities it's in. */
  installCount: zCount,
  commands: z.array(z.strictObject({ name: z.string(), description: z.string() })),
  owner: z.strictObject({ id: z.string(), username: z.string() }).nullable(),
  listedAt: zTime,
});

export const BotDirectoryPage = z.strictObject({ bots: z.array(DirectoryBot), nextCursor: zCount.nullable(), categories: z.array(BotCategory) });

export const BotListing = z.strictObject({
  listed: z.boolean(),
  category: BotCategory,
  description: z.string(),
  /** When it first went into the directory ("Newest"). */
  listedAt: zTime.nullable(),
  updatedAt: zTime.nullable(),
  /** Only public bots can be listed. */
  public: z.boolean(),
});

export const BotListingBody = z.strictObject({ listed: z.boolean(), category: BotCategory, description: z.string().trim().max(BOT_LISTING_DESCRIPTION_MAX) });
const BotOnly = z.strictObject({ id: z.string().min(1).max(64) });

const tag = "bot-directory";
const off = ["feature_disabled"] as const;

export const botDirectoryRoutes = [
  route({ method: "GET", url: "/v1/bot-directory", tag, summary: "Listed community bots: search, category, sort by most used, newest or A to Z.", auth: true, query: BotDirectoryQuery, response: BotDirectoryPage, errors: [...off] }),
  route({ method: "GET", url: "/v2/developer/bots/:id/listing", tag, summary: "Your bot's directory listing.", auth: true, params: BotOnly, response: z.strictObject({ listing: BotListing }), errors: [...off, "not_found"] }),
  route({
    method: "PUT",
    url: "/v2/developer/bots/:id/listing",
    tag,
    summary: "List your public bot in the directory (or take it out), with a category and a short description.",
    auth: true,
    params: BotOnly,
    body: BotListingBody,
    response: z.strictObject({ listing: BotListing }),
    errors: [...off, "not_found", "bot_private"],
  }),
];
