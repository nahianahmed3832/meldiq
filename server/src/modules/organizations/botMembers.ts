import type { AppContext } from "../../app/context.js";
import { ApiError } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { botsAmong, isBotUser } from "../accounts/index.js";
import { type ConversationRow, parsePermissionList } from "./authz.js";
import { reconcileAccess } from "./communityRoutes.js";
import { notifyOrg, removeFromWorkspace } from "./orgsRoutes.js";
import { permissionDef } from "./permissions/catalog.js";
import { EVERYONE } from "./permissions/channel.js";
import { roleAssignmentRefusal } from "./permissions/rules.js";
import { MAX_ROLES_PER_MEMBER } from "./rolesRoutes.js";

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

/**
 * Official bots (community parity batch D, modules/officialBots): a channel anyone in the community can read, a live
 * text channel that isn't private and doesn't hide itself from @everyone. Starboard skips the others, and Welcomer's
 * default channel is one.
 */
export function publicTextChannel(ctx: AppContext, conv: ConversationRow | undefined, orgId: string): conv is ConversationRow {
  if (!conv || conv.type !== "CHANNEL" || conv.org_id !== orgId || conv.archived_at || conv.voice === 1) return false;
  if ((conv.format ?? "text") !== "text" || conv.kind === "PRIVATE") return false;
  return !ctx.authz.overwrites("channel", conv.id).some((o) => o.subject === EVERYONE && o.deny.includes("channels.view"));
}

interface BotRoleRow {
  id: string;
  org_id: string;
  name: string;
  permissions: string;
  denies: string;
  archived_at: number | null;
}

/** Org role marker (org_role_members.assigned_by) for roles an official bot gave: "bot:<key>". */
export const officialBotAssigner = (key: string): string => `bot:${key}`;

const hasAdminPower = (r: BotRoleRow) => parsePermissionList(r.permissions).some((p) => permissionDef(p).admin || permissionDef(p).ownerOnly);

/**
 * Whether an official bot set up by [actorId] may hand out [roleId] (Levels' role rewards): an active role of [orgId]
 * that is just for show (no permissions or restrictions, like automatic roles), or one the actor could assign
 * themselves and that carries no administrative power (like reaction roles).
 */
export function botRoleGivableBy(ctx: AppContext, orgId: string, actorId: string, roleId: string): boolean {
  const r = ctx.ws.get<BotRoleRow>("org_roles", { id: roleId, org_id: orgId, archived_at: null });
  if (!r) return false;
  const grant = { permissions: parsePermissionList(r.permissions), denies: parsePermissionList(r.denies) };
  if (grant.permissions.length === 0 && grant.denies.length === 0) return true;
  const actor = ctx.authz.actor(orgId, actorId);
  return !!actor && !hasAdminPower(r) && !roleAssignmentRefusal(actor, { base: "MEMBER", perms: new Set(), self: false }, grant);
}

/**
 * An official bot gives [userId] the role [roleId], checked again now: an active role without administrative powers,
 * never to bots, only what a guest may hold to guests, and within the roles a person may hold. Returns the role's name
 * when it was given.
 */
export async function giveRoleAsBot(ctx: AppContext, orgId: string, roleId: string, userId: string, botId: string, key: string): Promise<string | null> {
  const base = ctx.authz.orgRole(orgId, userId);
  const role = ctx.ws.get<BotRoleRow>("org_roles", { id: roleId, org_id: orgId, archived_at: null });
  if (!base || !role || hasAdminPower(role) || isBotUser(ctx, userId)) return null;
  if (base === "GUEST" && parsePermissionList(role.permissions).some((p) => !permissionDef(p).guestAllowed)) return null;
  const added = await ctx.ws.write((w) => {
    if (w.get("org_role_members", { role_id: role.id, user_id: userId })) return false;
    if (w.count("org_role_members", { org_id: orgId, user_id: userId }) >= MAX_ROLES_PER_MEMBER) return false;
    w.insert("org_role_members", { role_id: role.id, org_id: orgId, user_id: userId, assigned_by: officialBotAssigner(key), assigned_at: now() });
    return true;
  });
  if (!added) return null;
  ctx.audit({ actorId: botId, orgId, action: "role.assign", target: `${role.id}:${userId}`, detail: role.name });
  await reconcileAccess(ctx, orgId, [userId]);
  return role.name;
}

/** The community's name, and how many people (not bots) are in it. */
export function communityFacts(ctx: AppContext, orgId: string): { name: string; people: number } {
  const ids = ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: orgId } }).map((m) => m.user_id);
  const bots = new Set(botsAmong(ctx, ids));
  return { name: ctx.ws.get<{ name: string }>("orgs", { id: orgId })?.name ?? "this community", people: ids.filter((id) => !bots.has(id)).length };
}
