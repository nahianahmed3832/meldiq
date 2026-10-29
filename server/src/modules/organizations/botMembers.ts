import type { AppContext } from "../../app/context.js";
import { ApiError } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { notifyOrg, removeFromWorkspace } from "./orgsRoutes.js";

/**
 * Bots in communities (API 0.65.0, settings parity batch B; modules/bots decides who may add which bot). A bot joins
 * as an ordinary MEMBER: the community's roles and channel permissions apply to it like to anyone, and admins may
 * give it roles. It's counted against the community's member limit, and a ban keeps it out.
 */

/** Who may add or remove bots: the community's "Edit community" permission (owners and admins have it). */
export function requireBotManager(ctx: AppContext, orgId: string, userId: string): void {
  ctx.authz.requirePermission(orgId, userId, "workspace.edit", "Adding and removing bots needs the Edit community permission");
}

/** Adds [botId] to [orgId] as a member, joining the channels members join; false when it was there already. */
export async function addBotMember(ctx: AppContext, orgId: string, botId: string, actorId: string): Promise<boolean> {
  if (ctx.authz.isBanned(orgId, botId)) throw new ApiError(403, "banned", "This bot is banned from this community");
  const t = now();
  const added = await ctx.ws.write((w) => {
    if (w.get("org_members", { org_id: orgId, user_id: botId })) return false;
    ctx.entitlements.check("members", w.count("org_members", { org_id: orgId }), orgId);
    w.insert("org_members", { org_id: orgId, user_id: botId, role: "MEMBER", joined_at: t, expires_at: null });
    ctx.authz.autoJoinScope(w, orgId, botId, t);
    return true;
  });
  if (!added) return false;
  ctx.audit({ actorId, orgId, action: "bot.add", target: botId });
  notifyOrg(ctx, orgId);
  return true;
}

/** Takes [botId] out of [orgId] the way a manager removes a member; false when it wasn't there. */
export async function removeBotMember(ctx: AppContext, orgId: string, botId: string, actorId: string): Promise<boolean> {
  if (!ctx.authz.orgRole(orgId, botId)) return false;
  await removeFromWorkspace(ctx, orgId, botId, actorId, "removed");
  return true;
}

export interface BotChannelView {
  id: string;
  name: string | null;
  kind: string;
  voice: boolean;
  canPost: boolean;
}

/** The channels of [orgId] that [botId] is in, and whether it may post in each. */
export function botChannels(ctx: AppContext, orgId: string, botId: string): BotChannelView[] {
  return ctx.authz
    .conversationIdsOf(orgId)
    .map((id) => ctx.authz.conversation(id))
    .filter((c): c is NonNullable<typeof c> => !!c && !c.archived_at && ctx.authz.isMember(c.id, botId))
    .map((c) => ({ id: c.id, name: c.name ?? null, kind: c.kind ?? "PUBLIC", voice: c.voice === 1, canPost: ctx.authz.canPost(c, botId) }));
}
