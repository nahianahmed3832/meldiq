import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { BOT_CATEGORIES, BOT_DIRECTORY_PAGE, type BotCategory, type BotDirectoryPage, type BotDirectoryQuery, type BotListing, type BotListingBody } from "../../../shared/contracts/http/botDirectory.js";
import { ApiError, notFound } from "../../../shared/errors.js";
import { compareText, foldAscii, likeContains } from "../../../shared/utilities/sqlText.js";

interface ListingRow {
  bot_id: string;
  owner_id: string;
  listed: number;
  category: z.infer<typeof BotCategory>;
  description: string;
  listed_at: number | null;
  updated_at: number;
}

type DirectoryBot = z.infer<typeof BotDirectoryPage>["bots"][number];

/**
 * The community bot directory (community parity batch E, feature "bot-directory", docs/COMMUNITY_PARITY_API.md ›
 * Discovery): bot owners list their public bots with a category and a short description; anyone signed in browses,
 * searches (names, description, slash commands) and sorts them. Bots that are gone or private again are left out.
 */
export class BotDirectory {
  constructor(
    private readonly ctx: AppContext,
    readonly enabled: boolean,
    private readonly clock: () => number = Date.now,
  ) {}

  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "The bot directory is switched off for now. Try again later.");
  }

  async page(q: z.infer<typeof BotDirectoryQuery>): Promise<z.infer<typeof BotDirectoryPage>> {
    const rows = this.ctx.ws.all<ListingRow>("bot_listings", { where: { listed: 1, ...(q.category ? { category: q.category } : {}) } });
    const byId = new Map(rows.map((r) => [r.bot_id, r]));
    const bots = (await this.ctx.bots.store.botsByIds([...byId.keys()])).filter((b) => b.public);
    const names = this.ctx.bots.names([...bots.map((b) => b.id), ...bots.map((b) => b.ownerId)]);
    const term = q.q ?? "";
    const found = bots
      .map((b): DirectoryBot => {
        const l = byId.get(b.id)!;
        const n = names.get(b.id);
        const owner = names.get(b.ownerId);
        return {
          id: b.id,
          username: n?.username ?? "",
          displayName: n?.displayName ?? "",
          description: l.description,
          category: l.category,
          installCount: this.ctx.ws.count("org_members", { user_id: b.id }),
          commands: b.commands.map((c) => ({ name: c.name, description: c.description })),
          owner: owner ? { id: b.ownerId, username: owner.username } : null,
          listedAt: l.listed_at ?? l.updated_at,
        };
      })
      .filter((b) => !term || [b.displayName, b.username, b.description, ...b.commands.flatMap((c) => [c.name, c.description])].some((s) => likeContains(s, term)))
      .sort(order(q.sort));
    const page = found.slice(q.cursor, q.cursor + BOT_DIRECTORY_PAGE);
    return { bots: page, nextCursor: found.length > q.cursor + BOT_DIRECTORY_PAGE ? q.cursor + BOT_DIRECTORY_PAGE : null, categories: [...BOT_CATEGORIES] };
  }

  private async owned(ownerId: string, botId: string) {
    const bot = await this.ctx.bots.store.bot(botId);
    if (!bot || bot.ownerId !== ownerId) throw notFound("You have no bot with that id");
    return bot;
  }

  async listing(ownerId: string, botId: string): Promise<z.infer<typeof BotListing>> {
    const bot = await this.owned(ownerId, botId);
    const l = this.ctx.ws.get<ListingRow>("bot_listings", { bot_id: botId });
    return { listed: l?.listed === 1, category: l?.category ?? "other", description: l?.description ?? "", listedAt: l?.listed_at ?? null, updatedAt: l?.updated_at ?? null, public: bot.public };
  }

  /** Saves [ownerId]'s listing of [botId]; 409 bot_private when listing a private bot. */
  async setListing(ownerId: string, botId: string, body: z.infer<typeof BotListingBody>): Promise<z.infer<typeof BotListing>> {
    const bot = await this.owned(ownerId, botId);
    if (body.listed && !bot.public) throw new ApiError(409, "bot_private", "Make the bot public first: only public bots can be listed.");
    const t = this.clock();
    await this.ctx.ws.write((w) => {
      const before = w.get<ListingRow>("bot_listings", { bot_id: botId });
      const row: ListingRow = { bot_id: botId, owner_id: ownerId, listed: body.listed ? 1 : 0, category: body.category, description: body.description, listed_at: before?.listed_at ?? (body.listed ? t : null), updated_at: t };
      w.upsert("bot_listings", { ...row }, "replace");
    });
    this.ctx.audit({ actorId: ownerId, action: "bot.listing", target: botId, detail: body.listed ? `listed in ${body.category}` : "unlisted" });
    return this.listing(ownerId, botId);
  }
}

function order(sort: z.infer<typeof BotDirectoryQuery>["sort"]): (a: DirectoryBot, b: DirectoryBot) => number {
  const byName = (a: DirectoryBot, b: DirectoryBot) => compareText(foldAscii(a.displayName), foldAscii(b.displayName)) || compareText(a.id, b.id);
  if (sort === "newest") return (a, b) => b.listedAt - a.listedAt || byName(a, b);
  if (sort === "a_z") return byName;
  return (a, b) => b.installCount - a.installCount || byName(a, b);
}
