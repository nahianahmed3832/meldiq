import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import {
  availableUser,
  blockedEitherWay,
  isSynthetic,
  requireSyntheticScopeForPeople,
} from "../accounts/index.js";
import {
  createBotDirectConversation,
  closeBotDirectConversation,
} from "../messaging/index.js";
import { notifyConversation } from "../organizations/index.js";
import type { BotService } from "./service.js";
import type { Bot } from "./store.js";

export const BOT_DM_NOTICE_VERSION = "bot-dm-2026-11-05";
type Consent = {
  bot_id: string;
  user_id: string;
  conversation_id: string | null;
  enabled: number;
  manifest_rev: number;
  notice_version: string;
  rev: number;
  approved_at: number;
};

/** Recipient-controlled personal consent. Community approvals can never authorize outreach to a person. */
export class BotDirectMessages {
  constructor(private readonly bots: BotService) {}
  private supported() {
    if (!this.bots.ctx.postgres)
      throw new ApiError(
        503,
        "bot_events_unavailable",
        "Bot direct messages require the authoritative PostgreSQL adapter",
      );
  }
  private row(userId: string, botId: string) {
    return this.bots.ctx.ws.get<Consent>("bot_dm_consents", {
      bot_id: botId,
      user_id: userId,
    });
  }
  private allowed(row: Consent): boolean {
    const { ctx, permissions } = this.bots;
    const manifest = permissions.manifest(row.bot_id);
    const credential = ctx.ws.get<{ active: number; owner_id: string }>(
      "bot_credential_revisions",
      { bot_id: row.bot_id },
    );
    return (
      row.enabled === 1 &&
      row.manifest_rev === manifest.rev &&
      manifest.permissions.includes("direct_messages") &&
      credential?.active === 1 &&
      isSynthetic(ctx.identity, credential.owner_id) ===
        isSynthetic(ctx.identity, row.user_id) &&
      !!availableUser(ctx, row.user_id) &&
      !blockedEitherWay(ctx, row.bot_id, row.user_id)
    );
  }
  grants(botId: string) {
    if (!this.bots.ctx.postgres) return [];
    return this.bots.ctx.ws
      .all<Consent>("bot_dm_consents", { where: { bot_id: botId, enabled: 1 } })
      .filter((row) => this.allowed(row) && !!row.conversation_id);
  }
  require(bot: Bot, conversationId: string) {
    const row = this.bots.ctx.ws.get<Consent>("bot_dm_consents", {
      bot_id: bot.id,
      conversation_id: conversationId,
    });
    if (!row || !this.allowed(row))
      throw forbidden("Direct messages with this bot are not enabled");
    this.bots.ctx.authz.requireMember(conversationId, bot.id);
    this.bots.ctx.authz.requireMember(conversationId, row.user_id);
    return row;
  }
  /** Native human sends must observe the same consent, including after scope changes or a block. */
  admit(conversationId: string): void {
    const row = this.bots.ctx.ws.get<Consent>("bot_dm_consents", {
      conversation_id: conversationId,
    });
    if (row && !this.allowed(row))
      throw forbidden("Direct messages with this bot are not enabled");
  }
  postingAllowed(conversationId: string): boolean {
    const row = this.bots.ctx.ws.get<Consent>("bot_dm_consents", {
      conversation_id: conversationId,
    });
    return row
      ? this.allowed(row)
      : !this.bots.ctx.authz
          .conversation(conversationId)
          ?.dm_key?.startsWith("botdm|");
  }
  /** A block revokes personal approval, so unblocking does not silently resume bot outreach. */
  async revokeBlocked(userId: string, botId: string) {
    if (!this.bots.ctx.postgres) return;
    let conversation: string | null = null;
    await this.bots.ctx.ws.write((w) => {
      const row = w.get<Consent>("bot_dm_consents", {
        user_id: userId,
        bot_id: botId,
      });
      if (!row || row.enabled !== 1) return;
      w.update(
        "bot_dm_consents",
        { user_id: userId, bot_id: botId },
        { enabled: 0, rev: row.rev + 1 },
      );
      conversation = row.conversation_id;
      if (conversation)
        closeBotDirectConversation(w, conversation, this.bots.clock());
    });
    if (conversation) {
      notifyConversation(this.bots.ctx, conversation);
      this.bots.events.invalidate(botId);
    }
  }
  async review(userId: string, botId: string) {
    this.supported();
    const row = this.row(userId, botId);
    if (!row) await this.bots.lookup(userId, botId);
    const manifest = this.bots.permissions.manifest(botId);
    return {
      botId,
      enabled: !!row && this.allowed(row),
      conversationId: row?.conversation_id ?? null,
      rev: row?.rev ?? 0,
      manifestRev: manifest.rev,
      requested: manifest.permissions.includes("direct_messages"),
      noticeVersion: BOT_DM_NOTICE_VERSION,
    };
  }
  async update(
    userId: string,
    botId: string,
    body: {
      enabled: boolean;
      rev: number;
      manifestRev: number;
      noticeVersion: string;
    },
  ) {
    this.supported();
    const before = this.row(userId, botId);
    const bot = await this.bots.store.bot(botId);
    if (body.enabled) {
      if (!bot) throw notFound("Bot not found");
      if (!before) await this.bots.lookup(userId, botId);
      await this.bots.requireActive(bot);
      requireSyntheticScopeForPeople(this.bots.ctx.identity, bot.ownerId, [
        userId,
      ]);
      requireSyntheticScopeForPeople(this.bots.ctx.identity, userId, [
        bot.ownerId,
      ]);
      if (body.noticeVersion !== BOT_DM_NOTICE_VERSION)
        throw new ApiError(
          409,
          "stale_revision",
          "Review the current bot messaging notice before enabling messages",
        );
    }
    let changedConversation: string | null = null;
    await this.bots.ctx.ws.write((w) => {
      const prior = w.get<Consent>("bot_dm_consents", {
        bot_id: botId,
        user_id: userId,
      });
      if ((prior?.rev ?? 0) !== body.rev)
        throw new ApiError(
          409,
          "stale_revision",
          "Bot messaging consent changed. Reload before saving.",
        );
      const manifest = this.bots.permissions.manifest(botId);
      if (
        body.enabled &&
        (body.manifestRev !== manifest.rev ||
          !manifest.permissions.includes("direct_messages"))
      )
        throw new ApiError(
          409,
          "stale_revision",
          "The bot's requested access changed. Review it again.",
        );
      if (
        body.enabled &&
        (!availableUser(this.bots.ctx, userId) ||
          blockedEitherWay(this.bots.ctx, botId, userId))
      )
        throw notFound("Bot messaging is unavailable");
      const at = this.bots.clock();
      const keep = body.enabled && prior && this.allowed(prior);
      let conversation = keep ? prior.conversation_id : null;
      if (!keep && prior?.conversation_id) {
        closeBotDirectConversation(w, prior.conversation_id, at);
        changedConversation = prior.conversation_id;
      }
      if (body.enabled && !conversation) {
        conversation = newId("c");
        createBotDirectConversation(w, conversation, botId, userId, at);
      }
      if (prior || body.enabled) {
        const row = {
          bot_id: botId,
          user_id: userId,
          conversation_id: conversation ?? prior?.conversation_id ?? null,
          enabled: body.enabled ? 1 : 0,
          manifest_rev: manifest.rev,
          notice_version: BOT_DM_NOTICE_VERSION,
          rev: body.rev + 1,
          approved_at: keep ? prior.approved_at : at,
        };
        w.upsert("bot_dm_consents", row, row);
        changedConversation = conversation ?? changedConversation;
      }
    });
    if (changedConversation)
      notifyConversation(this.bots.ctx, changedConversation);
    this.bots.events.invalidate(botId);
    this.bots.ctx.audit({
      actorId: userId,
      action: body.enabled ? "bot.dm.approved" : "bot.dm.revoked",
      target: botId,
    });
    return this.review(userId, botId);
  }
  conversation(bot: Bot, userId: string) {
    const row = this.row(userId, bot.id);
    if (!row?.conversation_id)
      throw notFound("Direct messages are unavailable");
    this.require(bot, row.conversation_id);
    return row.conversation_id;
  }
}
