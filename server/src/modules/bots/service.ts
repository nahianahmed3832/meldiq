import type { z } from "zod/v4";
import type { AppContext } from "../../app/context.js";
import type {
  BotCreateBody,
  BotPatch,
  BotProfile,
  DeveloperBot,
} from "../../shared/contracts/http/bots.js";
import { ApiError, notFound } from "../../shared/errors.js";
import { newSecret, secretHash } from "../../shared/utilities/secrets.js";
import {
  createBotIdentity,
  eraseBotIdentity,
  namesOf,
  renameBotIdentity,
} from "../accounts/index.js";
import {
  addBotMember,
  membershipsOf,
  removeBotMember,
  requireBotManager,
} from "../organizations/index.js";
import { BotApi } from "./botApi.js";
import { Interactions } from "./interactions.js";
import type { Bot, BotStore } from "./store.js";
import { Waiters } from "./waiters.js";
import { BotPermissions } from "./permissions.js";
import { BotEvents } from "./events.js";
import { BotEventWebhooks } from "./eventWebhooks.js";
import { BotMessages } from "./messages.js";
import { BotDirectMessages } from "./directMessages.js";
import { BotComponents } from "./components.js";
import { BotVoice } from "./voice.js";
import { BotFiles } from "./files.js";

/** Bot tokens: "mqb_" and 43 base64url characters. */
export const BOT_TOKEN_PREFIX = "mqb";

type Names = Map<string, { username: string; displayName: string }>;

/**
 * Bots (API 0.65.0, docs/SETTINGS_PARITY_API.md): making, changing and deleting them (quota from the owner's plan,
 * modules/billing/perks.ts), their tokens, and adding them to communities. Slash commands and interactions are
 * interactions.ts; what a bot does with its token is botApi.ts.
 */
export class BotService {
  private readonly connections = new Map<
    string,
    { botId: string; status: "online" | "idle" | "dnd" | "offline" }
  >();
  presenceOf(botId: string): "online" | "idle" | "dnd" | "offline" | undefined {
    return [...this.connections.values()].findLast(
      (connection) => connection.botId === botId,
    )?.status;
  }
  connectionPresence(
    connectionId: string,
    botId: string,
    status: "online" | "idle" | "dnd" | "offline" | null,
  ): void {
    const before = this.presenceOf(botId) ?? "offline";
    if (status === null) this.connections.delete(connectionId);
    else {
      this.connections.delete(connectionId);
      this.connections.set(connectionId, { botId, status });
    }
    const after = this.presenceOf(botId) ?? "offline";
    if (before !== after)
      this.ctx.hub.onPresenceChange(botId, after !== "offline");
  }
  readonly waiters = new Waiters();
  readonly interactions = new Interactions(this);
  readonly api = new BotApi(this);
  readonly permissions = new BotPermissions(this);
  readonly events = new BotEvents(this);
  readonly eventWebhooks = new BotEventWebhooks(this);
  readonly messages = new BotMessages(this);
  readonly directMessages = new BotDirectMessages(this);
  readonly components = new BotComponents(this);
  readonly voice = new BotVoice(this);
  readonly files = new BotFiles(this);

  constructor(
    readonly ctx: AppContext,
    readonly store: BotStore,
    readonly clock: () => number = Date.now,
  ) {
    ctx.authz.inviteCredentialValid = (id, creator, org) =>
      this.permissions.inviteCredentialValid(id, creator, org);
  }

  names(ids: readonly string[]): Names {
    return new Map(
      namesOf(this.ctx.identity, ids).map((n) => [
        n.id,
        { username: n.username, displayName: n.displayName },
      ]),
    );
  }

  private view(
    b: Bot,
    names: Names,
    locked: ReadonlySet<string> = new Set(),
  ): z.infer<typeof DeveloperBot> {
    const n = names.get(b.id);
    return {
      id: b.id,
      username: n?.username ?? "",
      displayName: n?.displayName ?? "",
      public: b.public,
      createdAt: b.createdAt,
      tokenRotatedAt: b.tokenRotatedAt,
      commands: b.commands.length,
      communities: membershipsOf(this.ctx.ws, b.id).length,
      locked: locked.has(b.id),
    };
  }

  profile(b: Bot): z.infer<typeof BotProfile> {
    const names = this.names([b.id, b.ownerId]);
    const owner = names.get(b.ownerId);
    return {
      id: b.id,
      username: names.get(b.id)?.username ?? "",
      displayName: names.get(b.id)?.displayName ?? "",
      public: b.public,
      owner: owner ? { id: b.ownerId, username: owner.username } : null,
      commands: b.commands.length,
    };
  }

  /** How many bots [ownerId]'s plan allows, and the plan. */
  private quota(ownerId: string): { limit: number; plan: string } {
    const perks = this.ctx.mojo.perksOf(ownerId);
    return { limit: perks.bots, plan: perks.key };
  }

  async list(ownerId: string) {
    const bots = await this.store.botsOf(ownerId);
    const names = this.names(bots.map((b) => b.id));
    const locked = this.lockedAmong(ownerId, bots);
    return {
      bots: bots.map((b) => this.view(b, names, locked)),
      ...this.quota(ownerId),
    };
  }

  /**
   * [ownerId]'s bots beyond what their plan allows now, newest first locked (docs/PLANS.md › Downgrades): a downgrade
   * deletes nothing, but those bots can't act until the owner upgrades or deletes others. Only while plan limits are
   * enforced (MOJO_ENFORCE), as with every other plan limit.
   */
  private lockedAmong(ownerId: string, bots: readonly Bot[]): Set<string> {
    const limits = this.ctx.mojo.limitsOf(ownerId);
    if (!limits || bots.length <= limits.bots) return new Set();
    const oldestFirst = [...bots].sort(
      (a, b) =>
        a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return new Set(oldestFirst.slice(limits.bots).map((b) => b.id));
  }

  async create(ownerId: string, body: z.infer<typeof BotCreateBody>) {
    const { limit, plan } = this.quota(ownerId);
    if ((await this.store.botsOf(ownerId)).length >= limit) {
      throw new ApiError(
        409,
        "limit_reached",
        `Your plan allows ${limit} bots. Delete one, or upgrade, to make another.`,
        { limit, plan },
      );
    }
    const { userId, createdAt } = await createBotIdentity(
      this.ctx,
      body.name,
      body.username,
    );
    const token = newSecret(BOT_TOKEN_PREFIX);
    const bot: Bot = {
      id: userId,
      ownerId,
      tokenHash: secretHash(token),
      public: body.public ?? false,
      commands: [],
      createdAt,
      tokenRotatedAt: createdAt,
    };
    await this.store.insertBot(bot);
    await this.permissions.credentialRevision(bot, bot.tokenHash);
    this.ctx.audit({ actorId: ownerId, action: "bot.create", target: bot.id });
    return { bot: this.view(bot, this.names([bot.id])), token };
  }

  async owned(ownerId: string, id: string): Promise<Bot> {
    const bot = await this.store.bot(id);
    if (!bot || bot.ownerId !== ownerId)
      throw notFound("You have no bot with that id");
    return bot;
  }

  async update(ownerId: string, id: string, patch: z.infer<typeof BotPatch>) {
    await this.owned(ownerId, id);
    if (patch.name !== undefined)
      await renameBotIdentity(this.ctx, id, patch.name);
    const bot = (await this.store.updateBot(id, { public: patch.public }))!;
    this.ctx.audit({ actorId: ownerId, action: "bot.update", target: id });
    return { bot: this.view(bot, this.names([id])) };
  }

  async remove(ownerId: string, id: string) {
    await this.deleteBot(await this.owned(ownerId, id), ownerId);
    return { deleted: true as const };
  }

  /** The token stops working first, then the bot leaves every community and its account becomes "Deleted account". */
  private async deleteBot(bot: Bot, actorId: string): Promise<void> {
    await this.permissions.credentialRevision(bot, "", false);
    await this.store.deleteBot(bot.id);
    this.events.invalidate(bot.id);
    this.waiters.notify(bot.id);
    await eraseBotIdentity(this.ctx, bot.id, actorId);
    this.ctx.audit({ actorId, action: "bot.delete", target: bot.id });
  }

  async rotateToken(ownerId: string, id: string) {
    const prior = await this.owned(ownerId, id);
    const token = newSecret(BOT_TOKEN_PREFIX);
    await this.permissions.credentialRevision(prior, secretHash(token));
    const bot = (await this.store.updateBot(id, {
      tokenHash: secretHash(token),
      tokenRotatedAt: this.clock(),
    }))!;
    this.events.invalidate(bot.id);
    this.waiters.notify(bot.id);
    this.ctx.audit({
      actorId: ownerId,
      action: "bot.token_rotate",
      target: id,
    });
    return { bot: this.view(bot, this.names([id])), token };
  }

  /** The bot a token belongs to, unless its account was disabled. */
  async authenticate(token: string): Promise<Bot | null> {
    if (!token.startsWith(`${BOT_TOKEN_PREFIX}_`) || token.length > 200)
      return null;
    const bot = await this.store.botByToken(secretHash(token));
    if (!bot || this.ctx.accounts.identityBlocked(bot.id)) return null;
    await this.requireActive(bot);
    return bot;
  }

  async requireActive(bot: Bot): Promise<void> {
    if (this.ctx.accounts.identityBlocked(bot.id))
      throw new ApiError(403, "forbidden", "This bot is unavailable");
    if (!this.ctx.mojo.limitsOf(bot.ownerId)) return;
    if (
      this.lockedAmong(bot.ownerId, await this.store.botsOf(bot.ownerId)).has(
        bot.id,
      )
    ) {
      throw new ApiError(
        403,
        "bot_locked",
        "This bot is beyond its owner's plan. The owner can upgrade, or delete another bot, to unlock it.",
      );
    }
  }

  /** A bot as someone about to add it sees it: public bots, or your own. */
  async lookup(viewerId: string, botId: string) {
    const bot = await this.store.bot(botId);
    if (!bot || (!bot.public && bot.ownerId !== viewerId))
      throw notFound("No bot with that id");
    return { bot: this.profile(bot) };
  }

  /** Adds a bot to a community: a manager with Edit community, and only its owner while it's private. */
  async install(actorId: string, orgId: string, botId: string) {
    requireBotManager(this.ctx, orgId, actorId);
    const bot = await this.store.bot(botId);
    if (!bot) throw notFound("No bot with that id");
    if (!bot.public && bot.ownerId !== actorId)
      throw new ApiError(
        403,
        "bot_private",
        "This bot is private: only its owner can add it to a community",
      );
    const installed = await addBotMember(this.ctx, orgId, bot.id, actorId);
    return { bot: this.profile(bot), installed };
  }

  async uninstall(actorId: string, orgId: string, botId: string) {
    requireBotManager(this.ctx, orgId, actorId);
    if (!(await this.store.bot(botId))) throw notFound("No bot with that id");
    const removed = await removeBotMember(this.ctx, orgId, botId, actorId);
    if (removed) this.events.invalidate(botId);
    if (removed) this.waiters.notify(botId);
    return { removed };
  }

  /** Account deletion: [userId]'s bots go (each deleted as above) and the commands they ran. */
  async deleteForUser(userId: string, actorId: string): Promise<void> {
    for (const bot of await this.store.botsOf(userId))
      await this.deleteBot(bot, actorId);
    await this.store.deleteInteractionsOf(userId);
  }
}
