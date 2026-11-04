import type { BotService } from "./service.js";
import type { Bot } from "./store.js";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { requireFeature } from "../../app/platformControls.js";

/** Separate file consent. Existing messages.post/history approvals do not grant these new capabilities. */
export class BotFiles {
  constructor(private readonly bots: BotService) {}
  admission(
    bot: Bot,
    channelId: string,
    scope: "files.upload" | "files.read",
    createdAt?: number,
  ) {
    const ctx = this.bots.ctx;
    const destination = ctx.authz.requireMember(channelId, bot.id);
    if (
      destination.type !== "CHANNEL" ||
      !destination.org_id ||
      destination.archived_at
    )
      throw notFound("No community file destination");
    const orgId = destination.org_id;
    const installation = this.bots.permissions.installationIdentity(
      orgId,
      bot.id,
    );
    const current = () => {
      if (!this.bots.permissions.currentCredential(bot.id, bot.tokenHash))
        throw new ApiError(
          401,
          "unauthorized",
          "The bot credential was revoked",
        );
      if (
        installation !==
        this.bots.permissions.installationIdentity(orgId, bot.id)
      )
        throw forbidden("This bot installation changed");
      const conv = ctx.authz.requireMember(channelId, bot.id);
      if (conv.archived_at || conv.org_id !== orgId)
        throw notFound("No active community file destination");
      this.bots.permissions.require(bot, orgId, scope);
      if (scope === "files.upload") {
        requireFeature(ctx.platform, "uploads", bot.id);
        if (
          !ctx.authz.canPost(conv, bot.id) ||
          !ctx.authz.canAttach(conv, bot.id)
        )
          throw forbidden("This bot cannot attach files in this channel");
      } else {
        const since = ctx.authz.historySince(conv, bot.id);
        if (since !== null && createdAt !== undefined && createdAt < since)
          throw notFound("Attachment not found or expired");
      }
    };
    current();
    return current;
  }
}
