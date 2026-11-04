import type { z } from "zod/v4";
import { isDeepStrictEqual } from "node:util";
import {
  BotMessageComponents,
  type BotComponent,
  type BotComponentInvocation,
  type ComponentInteractionBody,
} from "../../shared/contracts/http/botComponents.js";
import type { BotMessageBody } from "../../shared/contracts/http/bots.js";
import {
  INTERACTION_TTL_MS,
  MAX_PENDING_BOT_INTERACTIONS,
} from "../../shared/contracts/http/bots.js";
import {
  ApiError,
  badRequest,
  forbidden,
  notFound,
} from "../../shared/errors.js";
import { DuplicateDocument } from "../../infrastructure/database/documents.js";
import { richPostFields } from "../organizations/index.js";
import { blockedEitherWay, requireStanding } from "../accounts/index.js";
import { admitCurrentChannelContent } from "../messaging/index.js";
import type { BotService } from "./service.js";
import type { Bot, Interaction } from "./store.js";
import { admitInteractionActor } from "./interactionAccess.js";

type Submission = z.output<typeof ComponentInteractionBody>;
const equal = isDeepStrictEqual;

/** Native source-message-bound controls, using the existing interaction leases and reply path. */
export class BotComponents {
  constructor(private readonly bots: BotService) {}
  private supported() {
    if (!this.bots.ctx.postgres)
      throw new ApiError(
        503,
        "bot_events_unavailable",
        "Interactive bot messages require the authoritative PostgreSQL adapter",
      );
  }
  rich(
    bot: Bot,
    conversationId: string,
    body: z.output<typeof BotMessageBody>,
  ) {
    const advanced = !!(
      body.embeds?.length ||
      body.buttons?.length ||
      body.components?.length ||
      body.attachments?.length
    );
    if (!advanced) return null;
    this.supported();
    this.authority(bot, conversationId);
    const { embeds, buttons } = richPostFields({
      content: body.content,
      embeds: body.embeds,
      buttons: body.buttons,
    });
    return {
      ...(body.attachments?.length ? { attachments: body.attachments } : {}),
      ...(embeds.length ? { embeds } : {}),
      ...(buttons.length ? { buttons } : {}),
      ...(body.components?.length
        ? {
            botComponents: {
              items: body.components,
              expiresAt:
                this.bots.clock() + (body.componentsTtlSeconds ?? 3600) * 1000,
            },
          }
        : {}),
    };
  }
  private authority(bot: Bot, conversationId: string, actorId?: string) {
    const { authz } = this.bots.ctx;
    const conv = authz.requireMember(conversationId, bot.id);
    if (!authz.canPost(conv, bot.id))
      throw forbidden("This bot cannot answer in this conversation");
    if (conv.type === "CHANNEL" && conv.org_id)
      this.bots.permissions.require(bot, conv.org_id, "messages.post");
    else if (conv.type === "DM") {
      const consent = this.bots.directMessages.require(bot, conv.id);
      if (actorId && consent.user_id !== actorId)
        throw notFound("This interaction is unavailable");
    } else throw notFound("This conversation does not support bot controls");
    if (actorId) {
      if (blockedEitherWay(this.bots.ctx, bot.id, actorId))
        throw notFound("This interaction is unavailable");
      requireStanding(this.bots.ctx.safety, actorId, "send_message");
      authz.requireMember(conv.id, actorId);
      if (!authz.canPost(conv, actorId))
        throw forbidden("You can't post in this conversation");
    }
    return conv;
  }
  private async source(
    bot: Bot,
    actorId: string,
    conversationId: string,
    messageId: string,
    customId: string,
  ) {
    const conv = this.authority(bot, conversationId, actorId);
    const message = await this.bots.ctx.messages.get(messageId);
    if (
      !message ||
      message.sender_user_id !== bot.id ||
      message.conversation_id !== conv.id ||
      message.cls !== "message" ||
      message.audience !== "all" ||
      message.imported_by !== null
    )
      throw notFound("This bot control is unavailable");
    const since = this.bots.ctx.authz.historySince(conv, actorId);
    if (since !== null && message.server_ts < since)
      throw notFound("This bot control is unavailable");
    const payload = JSON.parse(message.payload) as Record<string, unknown>;
    const controls = BotMessageComponents.safeParse(payload.botComponents);
    if (!controls.success) throw notFound("This bot control is unavailable");
    const control = controls.data.items.find(
      (item) => item.customId === customId,
    );
    if (!control) throw notFound("This bot control is unavailable");
    if (controls.data.expiresAt <= this.bots.clock() || control.disabled)
      throw new ApiError(
        410,
        "interaction_expired",
        "This bot control has expired or is disabled",
      );
    const deleted = await this.bots.ctx.messages.changesTo(
      conv.id,
      message.id,
      "delete",
    );
    if (deleted.some((event) => event.audience === "all"))
      throw notFound("This bot control is unavailable");
    this.authority(bot, conversationId, actorId);
    return { conv, control, expiresAt: controls.data.expiresAt };
  }
  private invocation(
    body: Submission,
    control: BotComponent,
  ): BotComponentInvocation {
    const base = {
      messageId: body.messageId,
      customId: control.customId,
      label: control.label,
      type: control.type,
    };
    if (control.type === "button") {
      if (body.values.length || Object.keys(body.fields).length)
        throw badRequest("This button does not accept values");
      return base;
    }
    if (control.type === "select") {
      const selected = new Set(body.values);
      if (
        Object.keys(body.fields).length ||
        selected.size !== body.values.length ||
        selected.size < control.minValues ||
        selected.size > control.maxValues ||
        [...selected].some(
          (value) => !control.options.some((option) => option.value === value),
        )
      )
        throw badRequest("Choose only the available options");
      // Canonical order makes retry identity independent of the browser's selection ordering.
      return {
        ...base,
        values: control.options
          .filter((option) => selected.has(option.value))
          .map((option) => option.value),
      };
    }
    if (
      body.values.length ||
      Object.keys(body.fields).some(
        (key) => !control.fields.some((field) => field.id === key),
      )
    )
      throw badRequest("This form contains an unknown field");
    const fields: [string, string][] = [];
    for (const field of control.fields) {
      const value = Object.hasOwn(body.fields, field.id)
        ? body.fields[field.id]
        : "";
      if (
        (field.required && !value.trim()) ||
        (value.length && value.length < field.minLength) ||
        value.length > field.maxLength
      )
        throw badRequest("Complete the form within its field limits");
      fields.push([field.id, value]);
    }
    return { ...base, fields: Object.fromEntries(fields) };
  }
  async run(actorId: string, body: Submission) {
    this.supported();
    const accessRevision = this.bots.interactions.accessRevision();
    const bot = await this.bots.store.bot(body.botId);
    if (!bot) throw notFound("This bot is unavailable");
    await this.bots.requireActive(bot);
    let source = await this.source(
      bot,
      actorId,
      body.channelId,
      body.messageId,
      body.customId,
    );
    await admitInteractionActor(this.bots.ctx, actorId, source.conv);
    source = await this.source(
      bot,
      actorId,
      body.channelId,
      body.messageId,
      body.customId,
    );
    await this.bots.events.fresh(bot);
    const component = this.invocation(body, source.control);
    const result = (interaction: Interaction, duplicate: boolean) => ({
      interaction: {
        id: interaction.id,
        botId: bot.id,
        command: interaction.command,
        createdAt: interaction.createdAt,
        expiresAt: interaction.expiresAt,
      },
      duplicate,
    });
    const prior = await this.bots.store.interaction(body.interactionId);
    if (prior) {
      if (
        prior.botId !== bot.id ||
        prior.userId !== actorId ||
        prior.conversationId !== body.channelId ||
        !equal(prior.component, component)
      )
        throw new ApiError(
          409,
          "conflict",
          "That interaction id is already in use",
        );
      return result(prior, true);
    }
    const at = this.bots.clock();
    await this.bots.interactions.maintain();
    if (
      (await this.bots.store.openCount(bot.id, at)) >=
      MAX_PENDING_BOT_INTERACTIONS
    )
      throw new ApiError(
        429,
        "rate_limited",
        "This bot has too many interactions waiting",
      );
    const interaction: Interaction = {
      id: body.interactionId,
      botId: bot.id,
      userId: actorId,
      conversationId: body.channelId,
      orgId: source.conv.org_id,
      command: source.control.label,
      options: {},
      component,
      state: "pending",
      createdAt: at,
      expiresAt: Math.min(at + INTERACTION_TTL_MS, source.expiresAt),
      deliveredAt: null,
      repliedAt: null,
    };
    try {
      await this.bots.store.addInteraction(interaction, () => {
        if (accessRevision !== this.bots.interactions.accessRevision())
          throw new ApiError(
            409,
            "conflict",
            "Access changed while submitting. Review the control before retrying.",
          );
        if (
          !this.bots.permissions.currentCredential(bot.id, bot.tokenHash) ||
          !this.current(bot, interaction)
        )
          throw notFound("This interaction is no longer available");
      });
    } catch (error) {
      if (!(error instanceof DuplicateDocument)) throw error;
      const concurrent = await this.bots.store.interaction(body.interactionId);
      if (
        !concurrent ||
        concurrent.botId !== bot.id ||
        concurrent.userId !== actorId ||
        concurrent.conversationId !== body.channelId ||
        !equal(concurrent.component, component)
      )
        throw new ApiError(
          409,
          "conflict",
          "That interaction id is already in use",
        );
      return result(concurrent, true);
    }
    this.bots.waiters.notify(bot.id);
    this.bots.events.notify();
    return result(interaction, false);
  }
  async visible(bot: Bot, interaction: Interaction): Promise<boolean> {
    if (!interaction.component || interaction.expiresAt <= this.bots.clock())
      return false;
    try {
      const { conv } = await this.source(
        bot,
        interaction.userId,
        interaction.conversationId,
        interaction.component.messageId,
        interaction.component.customId,
      );
      return (
        interaction.createdAt >=
          (this.bots.ctx.authz.memberSince(conv.id, bot.id) ?? Infinity) &&
        interaction.createdAt >=
          (this.bots.ctx.authz.memberSince(conv.id, interaction.userId) ??
            Infinity)
      );
    } catch (error) {
      if (error instanceof ApiError && error.statusCode < 500) return false;
      throw error;
    }
  }
  /** Final synchronous authority check after asynchronous source/content reads. */
  current(bot: Bot, interaction: Interaction): boolean {
    if (!interaction.component || interaction.expiresAt <= this.bots.clock())
      return false;
    try {
      const conv = this.authority(
        bot,
        interaction.conversationId,
        interaction.userId,
      );
      return (
        interaction.createdAt >=
          (this.bots.ctx.authz.memberSince(conv.id, bot.id) ?? Infinity) &&
        interaction.createdAt >=
          (this.bots.ctx.authz.memberSince(conv.id, interaction.userId) ??
            Infinity)
      );
    } catch (error) {
      if (error instanceof ApiError && error.statusCode < 500) return false;
      throw error;
    }
  }
  admitPublish(
    bot: Bot,
    conversationId: string,
    payload: { type: string; [key: string]: unknown },
  ) {
    if (!this.bots.permissions.currentCredential(bot.id, bot.tokenHash))
      throw new ApiError(401, "unauthorized", "The bot credential was revoked");
    const conv = this.authority(bot, conversationId);
    admitCurrentChannelContent(this.bots.ctx, conv, bot.id, payload, true);
  }
}
