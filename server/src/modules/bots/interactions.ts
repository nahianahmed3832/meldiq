import type { ServerResponse } from "node:http";
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod/v4";
import { type BotCommand, INTERACTION_TTL_MS, type InteractionBody, type ReplyBody } from "../../shared/contracts/http/bots.js";
import { ApiError, badRequest, forbidden, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { botsAmong, requireStanding } from "../accounts/index.js";
import { sendServerMessage } from "../messaging/index.js";
import { orgMemberIds } from "../organizations/index.js";
import type { BotService } from "./service.js";
import type { Bot, Interaction, OptionValue } from "./store.js";

/** Commands waiting for one bot at most: past this, people are asked to try again. */
const OPEN_LIMIT = 500;
/** Interactions handed out per poll. */
const BATCH = 50;
/** A command handed out but not answered is handed out again after this long (a bot that crashed mid-way). */
const REDELIVER_MS = 60_000;
/** A long poll re-checks the store this often, for interactions queued by another server process. */
const RECHECK_MS = 5_000;
/** Interactions are kept this long past their expiry, so a late answer hears "expired" rather than "not found". */
const KEEP_EXPIRED_MS = 60 * 60_000;
const PURGE_EVERY_MS = 10 * 60_000;
const USER_ID = /^[A-Za-z0-9_-]{3,64}$/;

/** [options] checked against [cmd]'s: known names, the right types, required ones present. */
function checkOptions(cmd: BotCommand, options: Record<string, OptionValue>): Record<string, OptionValue> {
  for (const name of Object.keys(options)) {
    if (!cmd.options.some((o) => o.name === name)) throw badRequest(`/${cmd.name} has no option "${name}"`);
  }
  for (const o of cmd.options) {
    const v = options[o.name];
    if (v === undefined) {
      if (o.required) throw badRequest(`/${cmd.name} needs "${o.name}"`);
      continue;
    }
    const ok =
      o.type === "number" ? typeof v === "number" && Number.isFinite(v) : o.type === "boolean" ? typeof v === "boolean" : o.type === "user" ? typeof v === "string" && USER_ID.test(v) : typeof v === "string";
    if (!ok) throw badRequest(`"${o.name}" must be a ${o.type === "user" ? "user id" : o.type}`);
  }
  return options;
}

/**
 * Slash commands (API 0.65.0): bots register them, people run them in a channel, the bot takes them with a long poll
 * and answers in the channel or to that person alone. Nothing for a bot's developer to host.
 */
export class Interactions {
  private lastPurge = 0;

  constructor(private readonly bots: BotService) {}

  private get ctx() {
    return this.bots.ctx;
  }

  async setCommands(bot: Bot, commands: BotCommand[]) {
    const updated = await this.bots.store.updateBot(bot.id, { commands });
    if (!updated) throw notFound("This bot was deleted");
    return { commands: updated.commands };
  }

  /** The commands of the bots in [orgId] a member may run (in [channelId]: only bots that can post there). */
  async orgCommands(userId: string, orgId: string, channelId: string | undefined) {
    const { authz } = this.ctx;
    authz.requireOrgMember(orgId, userId);
    const conv = channelId ? authz.conversation(channelId) : undefined;
    if (channelId && (!conv || conv.org_id !== orgId || !authz.canViewChannel(conv, userId))) throw notFound("No such channel in this community");
    const bots = (await this.bots.store.botsByIds(botsAmong(this.ctx, orgMemberIds(this.ctx.ws, orgId)))).filter((b) => !conv || (authz.isMember(conv.id, b.id) && authz.canPost(conv, b.id)));
    const names = this.bots.names(bots.map((b) => b.id));
    return {
      commands: bots.flatMap((b) =>
        b.commands.map((c) => ({ ...c, botId: b.id, botUsername: names.get(b.id)?.username ?? "", botDisplayName: names.get(b.id)?.displayName ?? "" })),
      ),
    };
  }

  /** Someone runs a command: they must be able to post in the channel, and the bot must be in it. */
  async run(userId: string, body: z.infer<typeof InteractionBody>) {
    const { authz } = this.ctx;
    requireStanding(this.ctx.safety, userId, "send_message");
    const conv = authz.requireMember(body.channelId, userId);
    if (conv.type !== "CHANNEL" || !conv.org_id) throw badRequest("Slash commands work in community channels");
    if (!authz.canPost(conv, userId)) throw forbidden("You can't post in this channel");
    if (authz.mustAgreeRules(conv.org_id, userId)) throw new ApiError(403, "rules_not_agreed", "Agree to this community's rules before you post or react", { orgId: conv.org_id });
    // Community parity A2: running a command is posting (the lock and the verification level apply).
    await this.ctx.communitySafety.admitPost(conv, userId, "post", false);
    const bot = await this.bots.store.bot(body.botId);
    if (!bot || !authz.orgRole(conv.org_id, bot.id) || !authz.isMember(conv.id, bot.id)) throw new ApiError(404, "bot_not_here", "That bot isn't in this channel");
    const cmd = bot.commands.find((c) => c.name === body.command);
    if (!cmd) throw notFound(`That bot has no /${body.command} command`);
    const t = this.bots.clock();
    await this.purgeNowAndThen(t);
    if ((await this.bots.store.openCount(bot.id, t)) >= OPEN_LIMIT) throw new ApiError(429, "rate_limited", "This bot has too many commands waiting. Try again in a minute.");
    const i: Interaction = {
      id: newId("ix"),
      botId: bot.id,
      userId,
      orgId: conv.org_id,
      conversationId: conv.id,
      command: cmd.name,
      options: checkOptions(cmd, body.options),
      state: "pending",
      createdAt: t,
      expiresAt: t + INTERACTION_TTL_MS,
      deliveredAt: null,
      repliedAt: null,
    };
    await this.bots.store.addInteraction(i);
    this.bots.waiters.notify(bot.id);
    return { interaction: { id: i.id, botId: i.botId, command: i.command, createdAt: i.createdAt, expiresAt: i.expiresAt } };
  }

  /** What a bot polls: interactions due now, or (waiting up to [waitS] seconds) the first ones that come. */
  async poll(bot: Bot, waitS: number, connection: Pick<ServerResponse, "once">) {
    const deadline = this.bots.clock() + waitS * 1000;
    // The response closes before it's sent only when the bot hung up: stop waiting, take nothing more.
    let gone = false;
    let wakeNow: (() => void) | null = null;
    connection.once("close", () => {
      gone = true;
      wakeNow?.();
    });
    const onAbort = (wake: () => void) => {
      wakeNow = wake;
    };
    let due = await this.claim(bot);
    while (!due.length && !gone) {
      const left = deadline - this.bots.clock();
      if (left <= 0) break;
      await this.bots.waiters.wait(bot.id, Math.min(left, RECHECK_MS), onAbort);
      if (!gone) due = await this.claim(bot);
    }
    const names = this.bots.names([...new Set(due.map((i) => i.userId))]);
    return {
      interactions: due.flatMap((i) => {
        const n = names.get(i.userId);
        return n
          ? [{ id: i.id, command: i.command, options: i.options, user: { id: i.userId, ...n }, channelId: i.conversationId, communityId: i.orgId, createdAt: i.createdAt, expiresAt: i.expiresAt }]
          : [];
      }),
    };
  }

  private claim(bot: Bot): Promise<Interaction[]> {
    const t = this.bots.clock();
    return this.bots.store.claim(bot.id, t, t - REDELIVER_MS, BATCH);
  }

  /** The bot's answer: a message in the channel from the bot, or (ephemeral) a realtime frame to that person only. */
  async reply(bot: Bot, id: string, body: z.infer<typeof ReplyBody>, log: FastifyBaseLogger) {
    const i = await this.bots.store.interaction(id);
    if (!i || i.botId !== bot.id) throw notFound("This bot has no interaction with that id");
    const t = this.bots.clock();
    const outcome = await this.bots.store.answer(id, bot.id, t);
    if (outcome === "missing") throw notFound("This bot has no interaction with that id");
    if (outcome === "answered") throw new ApiError(409, "interaction_answered", "This command was answered already");
    if (outcome === "expired") throw new ApiError(410, "interaction_expired", "This command waited more than 15 minutes and expired");
    if (body.ephemeral) {
      this.ctx.hub.sendToUser(i.userId, { t: "interaction.reply", interactionId: i.id, conversationId: i.conversationId, botId: bot.id, command: i.command, content: body.content, at: t });
      return { interactionId: i.id, ephemeral: true, messageId: null };
    }
    const messageId = newId("m");
    const payload = { type: "text", text: body.content, interaction: { id: i.id, command: i.command, userId: i.userId } };
    try {
      await sendServerMessage(this.ctx, { userId: bot.id, deviceId: null }, { conversationId: i.conversationId, messageId, cls: "message", sentAt: t, payload }, log);
    } catch (e) {
      // Not posted (the bot lost its posting rights, slowmode…): it may answer again.
      await this.bots.store.reopen(i.id);
      throw e;
    }
    return { interactionId: i.id, ephemeral: false, messageId };
  }

  private async purgeNowAndThen(t: number): Promise<void> {
    if (t - this.lastPurge < PURGE_EVERY_MS) return;
    this.lastPurge = t;
    await this.bots.store.purgeExpired(t - KEEP_EXPIRED_MS);
  }
}
