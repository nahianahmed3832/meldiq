import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod/v4";
import type { BotEditBody, BotMessageBody } from "../../shared/contracts/http/bots.js";
import { notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { sendServerMessage } from "../messaging/index.js";
import { botChannels, membershipsOf } from "../organizations/index.js";
import type { BotService } from "./service.js";
import type { Bot } from "./store.js";

/**
 * What a bot does with its token (API 0.65.0): read who it is and where it is, and send, edit and delete its own
 * messages. Every message goes through the server's one message path (messaging/serverSend.ts) with the bot as the
 * sender, under the same rules as anyone's: membership, the channel's posting permission, slowmode, @everyone policy.
 */
export class BotApi {
  constructor(private readonly bots: BotService) {}

  self(bot: Bot) {
    const n = this.bots.names([bot.id]).get(bot.id);
    return { bot: { id: bot.id, username: n?.username ?? "", displayName: n?.displayName ?? "", public: bot.public, ownerId: bot.ownerId } };
  }

  communities(bot: Bot) {
    const ctx = this.bots.ctx;
    return { communities: membershipsOf(ctx.ws, bot.id).map((m) => ({ id: m.org_id, name: m.name, channels: botChannels(ctx, m.org_id, bot.id) })) };
  }

  /** A message to a community channel the bot is in (DMs and groups never have bots). */
  send(bot: Bot, channelId: string, body: z.infer<typeof BotMessageBody>, log: FastifyBaseLogger) {
    const conv = this.bots.ctx.authz.conversation(channelId);
    if (!conv || conv.type !== "CHANNEL") throw notFound("Conversation not found");
    const payload = { type: "text", text: body.content, ...(body.replyTo ? { replyTo: body.replyTo } : {}) };
    return sendServerMessage(this.bots.ctx, { userId: bot.id, deviceId: null }, { conversationId: conv.id, messageId: body.messageId ?? newId("m"), cls: "message", sentAt: this.bots.clock(), payload }, log);
  }

  edit(bot: Bot, messageId: string, body: z.infer<typeof BotEditBody>, log: FastifyBaseLogger) {
    return this.change(bot, messageId, { type: "edit", target: messageId, text: body.content }, log);
  }

  delete(bot: Bot, messageId: string, log: FastifyBaseLogger) {
    return this.change(bot, messageId, { type: "delete", target: messageId }, log);
  }

  /** An edit or a deletion: the message path checks it's the bot's own (403 not_yours) and in a channel it's in. */
  private async change(bot: Bot, messageId: string, payload: { type: string; target: string; text?: string }, log: FastifyBaseLogger) {
    const target = await this.bots.ctx.messages.get(messageId);
    if (!target) throw notFound("No such message");
    return sendServerMessage(this.bots.ctx, { userId: bot.id, deviceId: null }, { conversationId: target.conversation_id, messageId: newId("m"), cls: "control", sentAt: this.bots.clock(), payload }, log);
  }
}
