import type { FastifyBaseLogger } from "fastify";
import { ApiError, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { sendServerMessage } from "../messaging/index.js";
import type { BotService } from "./service.js";
import type { Bot } from "./store.js";
import type { BotPlatformScope } from "../../shared/contracts/http/botPlatform.js";
import type { StoredEvent } from "../../shared/contracts/http/serverMessages.js";

const MESSAGE_FIELDS = new Set([
  "type",
  "text",
  "replyTo",
  "threadRoot",
  "mentions",
  "attachments",
  "title",
  "tags",
  "embeds",
  "buttons",
  "webhook",
  "textFromEmbeds",
  "giveaway",
  "poll",
  "sticker",
  "gif",
  "location",
  "origin",
  "forwarded",
]);
const messagePayload = (payload: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(payload).filter(([key]) => MESSAGE_FIELDS.has(key)),
  );
type NativePage = {
  messages: StoredEvent[];
  context?: StoredEvent[];
  changes: StoredEvent[];
  [key: string]: unknown;
};

/** Approved adapters of native message controls; never a second posting/moderation implementation. */
export class BotMessages {
  constructor(private readonly bots: BotService) {}

  /** Current content only: native app pages carry historic edit/delete controls and private protocol controls. */
  async projectNativePage(bot: Bot, channelId: string, value: unknown) {
    await this.bots.events.fresh(bot);
    const conv = this.channel(bot, channelId, "messages.history");
    const since = this.bots.ctx.authz.historySince(conv, bot.id);
    const page = value as NativePage;
    if (!Array.isArray(page.messages) || !Array.isArray(page.changes))
      throw new Error("Native message page contract changed");
    const visible = new Map<string, StoredEvent>();
    for (const message of [...page.messages, ...(page.context ?? [])]) {
      if (
        message.conversationId !== channelId ||
        (since !== null && message.serverTs < since)
      )
        continue;
      visible.set(message.id, {
        ...message,
        payload: messagePayload(message.payload),
      });
    }
    for (const change of [...page.changes].sort(
      (a, b) => a.serverTs - b.serverTs || a.id.localeCompare(b.id),
    )) {
      if (
        change.conversationId !== channelId ||
        typeof change.payload.target !== "string"
      )
        continue;
      const target = visible.get(change.payload.target);
      if (!target) continue;
      if (change.payload.type === "delete") {
        visible.delete(target.id);
        continue;
      }
      if (
        change.payload.type !== "edit" ||
        change.senderUserId !== target.senderUserId
      )
        continue;
      const payload = { ...target.payload };
      for (const key of ["text", "mentions", "title", "tags"])
        if (change.payload[key] !== undefined)
          payload[key] = change.payload[key];
      if (
        change.payload.embeds !== undefined ||
        change.payload.giveaway !== undefined
      ) {
        for (const key of ["embeds", "buttons", "textFromEmbeds", "giveaway"]) {
          delete payload[key];
          if (change.payload[key] !== undefined)
            payload[key] = change.payload[key];
        }
      }
      visible.set(target.id, { ...target, payload });
    }
    const changes = page.changes
      .filter(
        (event) =>
          ["reaction", "pin"].includes(String(event.payload.type)) &&
          typeof event.payload.target === "string" &&
          visible.has(event.payload.target),
      )
      .map((event) => ({
        ...event,
        payload: Object.fromEntries(
          Object.entries(event.payload).filter(([key]) =>
            ["type", "target", "emoji", "add", "pinned"].includes(key),
          ),
        ),
      }));
    return {
      ...page,
      messages: page.messages.flatMap((event) => visible.get(event.id) ?? []),
      ...(page.context
        ? {
            context: page.context.flatMap(
              (event) => visible.get(event.id) ?? [],
            ),
          }
        : {}),
      ...(Array.isArray(page.threads)
        ? {
            threads: page.threads.filter((thread) =>
              visible.has((thread as { rootId: string }).rootId),
            ),
            historySince: since,
          }
        : {}),
      changes,
    };
  }

  private channel(bot: Bot, channelId: string, scope: BotPlatformScope) {
    const conv = this.bots.ctx.authz.requireMember(channelId, bot.id);
    if (conv.type !== "CHANNEL" || !conv.org_id)
      throw notFound("Channel not found");
    this.bots.permissions.require(bot, conv.org_id, scope);
    return conv;
  }

  private async target(
    bot: Bot,
    channelId: string,
    messageId: string,
    scope: BotPlatformScope,
  ) {
    this.channel(bot, channelId, scope);
    const message = await this.bots.ctx.messages.get(messageId);
    const conv = this.channel(bot, channelId, scope);
    const since = this.bots.ctx.authz.historySince(conv, bot.id);
    if (
      !message ||
      message.conversation_id !== channelId ||
      message.cls !== "message" ||
      message.audience !== "all" ||
      (since !== null && message.server_ts < since)
    )
      throw notFound("Message not found");
    return message;
  }

  async reactions(bot: Bot, channelId: string, messageId: string) {
    const target = await this.target(
      bot,
      channelId,
      messageId,
      "messages.history",
    );
    const changes = await this.bots.ctx.messages.changesTo(
      channelId,
      messageId,
      "reaction",
    );
    await this.bots.events.fresh(bot);
    const conv = this.channel(bot, channelId, "messages.history");
    const since = this.bots.ctx.authz.historySince(conv, bot.id);
    if (since !== null && target.server_ts < since)
      throw notFound("Message not found");
    // The native store returns chronological changes. Latest add/remove per actor and emoji wins.
    const latest = new Map<
      string,
      { userId: string; emoji: string; add: boolean }
    >();
    for (const change of changes) {
      if (change.audience !== "all") continue;
      const payload = JSON.parse(change.payload) as {
        emoji?: unknown;
        add?: unknown;
      };
      if (typeof payload.emoji !== "string") continue;
      latest.set(`${change.sender_user_id}\0${payload.emoji}`, {
        userId: change.sender_user_id,
        emoji: payload.emoji,
        add: payload.add !== false,
      });
    }
    const byEmoji = new Map<string, string[]>();
    for (const value of latest.values())
      if (value.add)
        byEmoji.set(value.emoji, [
          ...(byEmoji.get(value.emoji) ?? []),
          value.userId,
        ]);
    return {
      reactions: [...byEmoji].map(([emoji, userIds]) => ({
        emoji,
        userIds,
        count: userIds.length,
      })),
    };
  }

  async react(
    bot: Bot,
    channelId: string,
    messageId: string,
    emoji: string,
    add: boolean,
    log: FastifyBaseLogger,
  ) {
    await this.target(bot, channelId, messageId, "messages.react");
    return this.control(
      bot,
      channelId,
      { type: "reaction", target: messageId, emoji, add },
      "messages.react",
      log,
    );
  }

  async pin(
    bot: Bot,
    channelId: string,
    messageId: string,
    add: boolean,
    log: FastifyBaseLogger,
  ) {
    await this.target(bot, channelId, messageId, "messages.manage");
    return this.control(
      bot,
      channelId,
      { type: "pin", target: messageId, pinned: add },
      "messages.manage",
      log,
    );
  }

  async bulkDelete(
    bot: Bot,
    channelId: string,
    ids: string[],
    log: FastifyBaseLogger,
  ) {
    this.channel(bot, channelId, "messages.manage");
    const deleted: string[] = [],
      failed: { messageId: string; code: string }[] = [];
    for (const messageId of ids) {
      try {
        await this.target(bot, channelId, messageId, "messages.manage");
        await this.control(
          bot,
          channelId,
          { type: "delete", target: messageId },
          "messages.manage",
          log,
        );
        deleted.push(messageId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.statusCode >= 500)
          throw error;
        failed.push({ messageId, code: error.code });
      }
    }
    return { deleted, failed };
  }

  private async control(
    bot: Bot,
    channelId: string,
    payload: {
      type: string;
      target: string;
      emoji?: string;
      add?: boolean;
      pinned?: boolean;
    },
    scope: BotPlatformScope,
    log: FastifyBaseLogger,
  ) {
    await this.bots.events.fresh(bot);
    this.channel(bot, channelId, scope);
    return sendServerMessage(
      this.bots.ctx,
      { userId: bot.id, deviceId: null },
      {
        conversationId: channelId,
        messageId: newId("m"),
        cls: "control",
        sentAt: this.bots.clock(),
        payload,
      },
      log,
    );
  }
}
