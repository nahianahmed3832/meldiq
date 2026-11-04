import type { z } from "zod/v4";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { BotPermissionList, type BotManifestUpdate, type BotInstallationApproval, type BotPlatformScope } from "../../shared/contracts/http/botPlatform.js";
import { requireBotManager } from "../organizations/index.js";
import type { BotService } from "./service.js";
import type { Bot } from "./store.js";

type Requested = { bot_id: string; permissions: string; rev: number; updated_at: number };
type Approved = { org_id: string; bot_id: string; permissions: string; manifest_rev: number; rev: number; approved_by: string; approved_at: number };
const read = (value: string | undefined): BotPlatformScope[] => {
  try { return BotPermissionList.parse(JSON.parse(value ?? "[]")); } catch { return []; }
};
const READ_SCOPES = new Set(["communities.read", "channels.read", "members.read", "events.read", "direct_messages"]);

/** Requested scopes, installation approval, then current native roles/channel authority: all must allow an action. */
export class BotPermissions {
  constructor(private readonly bots: BotService) {}

  manifest(botId: string) {
    const row = this.bots.ctx.ws.get<Requested>("bot_requested_permissions", { bot_id: botId });
    return { botId, permissions: read(row?.permissions), rev: row?.rev ?? 0 };
  }

  async update(ownerId: string, botId: string, body: z.infer<typeof BotManifestUpdate>) {
    const bot = await this.bots.store.bot(botId);
    if (!bot || bot.ownerId !== ownerId) throw notFound("You have no bot with that id");
    await this.bots.ctx.ws.write((w) => {
      const prior = w.get<Requested>("bot_requested_permissions", { bot_id: botId });
      if ((prior?.rev ?? 0) !== body.rev) throw new ApiError(409, "stale_revision", "The requested permissions changed. Reload before saving.");
      const change = { permissions: JSON.stringify(body.permissions), rev: body.rev + 1, updated_at: this.bots.clock() };
      w.upsert("bot_requested_permissions", { bot_id: botId, ...change }, change);
    });
    this.bots.ctx.audit({ actorId: ownerId, action: "bot.permissions.requested", target: botId });
    return this.manifest(botId);
  }

  installation(orgId: string, botId: string) {
    const row = this.bots.ctx.ws.get<Approved>("bot_installation_permissions", { org_id: orgId, bot_id: botId });
    return { orgId, botId, permissions: read(row?.permissions), manifestRev: row?.manifest_rev ?? 0, rev: row?.rev ?? 0, approvedBy: row?.approved_by ?? null, approvedAt: row?.approved_at ?? null };
  }

  async approve(actorId: string, orgId: string, botId: string, body: z.infer<typeof BotInstallationApproval>) {
    const ctx = this.bots.ctx;
    requireBotManager(ctx, orgId, actorId);
    if (!(await this.bots.store.bot(botId))) throw notFound("No bot with that id");
    await ctx.ws.write((w) => {
      requireBotManager(ctx, orgId, actorId);
      ctx.authz.requireOrgMember(orgId, botId);
      const manifest = w.get<Requested>("bot_requested_permissions", { bot_id: botId });
      if (!manifest || manifest.rev !== body.manifestRev) throw new ApiError(409, "stale_revision", "The bot changed its requested permissions. Review them again.");
      const prior = w.get<Approved>("bot_installation_permissions", { org_id: orgId, bot_id: botId });
      if ((prior?.rev ?? 0) !== body.rev) throw new ApiError(409, "stale_revision", "This installation changed. Reload before saving.");
      const requested = new Set(read(manifest.permissions));
      const actorPermissions = ctx.authz.permissions(orgId, actorId);
      for (const permission of body.permissions) {
        if (!requested.has(permission)) throw forbidden("The bot did not request this permission");
        if (!READ_SCOPES.has(permission) && !actorPermissions.has(permission as never)) throw forbidden("You cannot approve a permission you do not hold");
      }
      const change = { permissions: JSON.stringify(body.permissions), manifest_rev: manifest.rev, rev: body.rev + 1, approved_by: actorId, approved_at: this.bots.clock() };
      w.upsert("bot_installation_permissions", { org_id: orgId, bot_id: botId, ...change }, change);
    });
    ctx.audit({ actorId, orgId, action: "bot.permissions.approved", target: botId });
    return this.installation(orgId, botId);
  }

  allows(bot: Bot, orgId: string, permission: BotPlatformScope): boolean {
    const ctx = this.bots.ctx;
    if (!ctx.authz.permissions(orgId, bot.id).size) return false;
    const approved = this.installation(orgId, bot.id);
    return approved.permissions.includes(permission) && this.manifest(bot.id).permissions.includes(permission);
  }

  require(bot: Bot, orgId: string, permission: BotPlatformScope): void {
    if (!this.allows(bot, orgId, permission)) throw forbidden("This bot installation has not been approved for that action");
  }
}
