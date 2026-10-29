import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { ReactionRolesBody, ReactionRolesView } from "../../../shared/contracts/http/reactionRoles.js";
import { ApiError, badRequest, forbidden, notFound } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { isBotUser } from "../../accounts/index.js";
import { type ConversationRow, parsePermissionList } from "../authz.js";
import { reconcileAccess } from "../communityRoutes.js";
import { permissionDef } from "../permissions/catalog.js";
import { roleAssignmentRefusal } from "../permissions/rules.js";
import { MAX_ROLES_PER_MEMBER } from "../rolesRoutes.js";

/** org_role_members.assigned_by for roles a reaction gave: taking the reaction off takes back only those. */
export const REACTION_ROLE_MARKER = "reaction_roles";

interface PairRow {
  message_id: string;
  emoji: string;
  org_id: string;
  channel_id: string;
  role_id: string;
  position: number;
  set_by: string;
  set_at: number;
}

interface RoleRow {
  id: string;
  name: string;
  color: string | null;
  permissions: string;
  denies: string;
  archived_at: number | null;
}

/** A change accepted on a community channel (messaging/serverSend.ts): its sender and payload. */
export interface ChannelChange {
  orgId: string;
  conversationId: string;
  userId: string;
  payload: Record<string, unknown>;
}

/**
 * Reaction roles (community parity batch C, feature "reaction-roles", docs/COMMUNITY_PARITY_API.md): on a community
 * message, holders of `roles.assign` pair up to 20 emoji with roles. Reacting with one gives its role, taking the
 * reaction off takes the role back, through the reaction's own path, so timeouts and the community's rules apply to
 * reactions as they already do. Only roles without administrative powers that the person setting them could assign;
 * checked again on every reaction, because a role can change.
 */
export class ReactionRoles {
  constructor(
    private readonly ctx: AppContext,
    readonly enabled: boolean,
  ) {}

  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "Reaction roles are switched off for now. Try again later.");
  }

  /** The message in a channel of [orgId] the viewer is in. */
  private async message(orgId: string, channelId: string, messageId: string, userId: string): Promise<ConversationRow> {
    this.requireEnabled();
    const conv = this.ctx.authz.requireMember(channelId, userId);
    if (conv.type !== "CHANNEL" || conv.org_id !== orgId) throw notFound("Conversation not found");
    const m = await this.ctx.messages.get(messageId);
    if (!m || m.conversation_id !== channelId || m.cls !== "message") throw notFound("No such message in this channel");
    return conv;
  }

  private role(orgId: string, roleId: string): RoleRow | undefined {
    return this.ctx.ws.get<RoleRow>("org_roles", { id: roleId, org_id: orgId });
  }

  /** A role a reaction may give: active and without administrative powers. */
  private givable(r: RoleRow | undefined): r is RoleRow {
    return !!r && !r.archived_at && parsePermissionList(r.permissions).every((p) => !permissionDef(p).admin && !permissionDef(p).ownerOnly);
  }

  view(messageId: string, channelId: string): z.infer<typeof ReactionRolesView> {
    const rows = this.ctx.ws.all<PairRow>("reaction_roles", { where: { message_id: messageId }, orderBy: [["position", "asc"]] });
    const roles = new Map(this.ctx.ws.all<RoleRow>("org_roles", { where: { id: { in: rows.map((r) => r.role_id) } } }).map((r) => [r.id, r]));
    return {
      messageId,
      channelId,
      reactionRoles: rows.flatMap((r) => (roles.has(r.role_id) ? [{ emoji: r.emoji, roleId: r.role_id, roleName: roles.get(r.role_id)!.name, roleColor: roles.get(r.role_id)!.color }] : [])),
      setBy: rows[0]?.set_by ?? null,
      setAt: rows[0]?.set_at ?? null,
    };
  }

  async get(orgId: string, channelId: string, messageId: string, userId: string) {
    await this.message(orgId, channelId, messageId, userId);
    return this.view(messageId, channelId);
  }

  async set(orgId: string, channelId: string, messageId: string, userId: string, body: z.infer<typeof ReactionRolesBody>) {
    await this.message(orgId, channelId, messageId, userId);
    const actor = this.ctx.authz.actor(orgId, userId);
    if (!actor?.perms.has("roles.assign")) throw forbidden("Your role doesn't include assigning roles");
    const pairs = body.reactionRoles;
    if (new Set(pairs.map((p) => p.emoji)).size !== pairs.length) throw badRequest("Each emoji can give one role");
    if (new Set(pairs.map((p) => p.roleId)).size !== pairs.length) throw badRequest("Each role can be given by one emoji");
    for (const p of pairs) {
      const r = this.role(orgId, p.roleId);
      if (!r) throw notFound("Role not found");
      const grant = { permissions: parsePermissionList(r.permissions), denies: parsePermissionList(r.denies) };
      if (!this.givable(r) || roleAssignmentRefusal(actor, { base: "MEMBER", perms: new Set(), self: false }, grant)) {
        throw new ApiError(403, "reaction_role_not_givable", "Reaction roles can only give roles you could assign yourself, without administrative powers", { roleId: p.roleId });
      }
    }
    const t = now();
    await this.ctx.ws.write((w) => {
      w.delete("reaction_roles", { message_id: messageId });
      pairs.forEach((p, i) => w.insert("reaction_roles", { message_id: messageId, emoji: p.emoji, org_id: orgId, channel_id: channelId, role_id: p.roleId, position: i, set_by: userId, set_at: t }));
    });
    this.ctx.audit({ actorId: userId, orgId, action: "reaction_roles.set", target: messageId, detail: `${pairs.length} in ${channelId}` });
    return this.view(messageId, channelId);
  }

  async remove(orgId: string, channelId: string, messageId: string, userId: string) {
    await this.message(orgId, channelId, messageId, userId);
    if (!this.ctx.authz.can(orgId, userId, "roles.assign")) throw forbidden("Your role doesn't include assigning roles");
    const removed = await this.ctx.ws.write((w) => w.delete("reaction_roles", { message_id: messageId }));
    if (removed > 0) this.ctx.audit({ actorId: userId, orgId, action: "reaction_roles.remove", target: messageId });
    return { deleted: removed > 0 };
  }

  /**
   * A change was accepted in a community channel: a reaction with a paired emoji gives or takes its role, and deleting
   * a message removes its pairs. Anything else costs one type check.
   */
  async noteChange(c: ChannelChange): Promise<void> {
    const { type, target } = c.payload;
    if (!this.enabled || typeof target !== "string") return;
    if (type === "delete") {
      if (!this.ctx.ws.get("reaction_roles", { message_id: target, channel_id: c.conversationId })) return;
      await this.ctx.ws.write((w) => w.delete("reaction_roles", { message_id: target, channel_id: c.conversationId }));
      return;
    }
    if (type !== "reaction" || typeof c.payload.emoji !== "string") return;
    const pair = this.ctx.ws.get<PairRow>("reaction_roles", { message_id: target, emoji: c.payload.emoji });
    // A reaction names its message without the message path checking where that is: only one in this channel counts.
    if (!pair || pair.channel_id !== c.conversationId) return;
    if (c.payload.add === false) await this.take(pair, c.userId);
    else await this.give(pair, c.userId);
  }

  private async give(pair: PairRow, userId: string): Promise<void> {
    const base = this.ctx.authz.orgRole(pair.org_id, userId);
    const role = this.role(pair.org_id, pair.role_id);
    if (!base || !this.givable(role) || isBotUser(this.ctx, userId)) return;
    // Guests only hold what a guest may (as when someone assigns them a role).
    if (base === "GUEST" && parsePermissionList(role.permissions).some((p) => !permissionDef(p).guestAllowed)) return;
    const added = await this.ctx.ws.write((w) => {
      if (w.get("org_role_members", { role_id: role.id, user_id: userId })) return false;
      if (w.count("org_role_members", { org_id: pair.org_id, user_id: userId }) >= MAX_ROLES_PER_MEMBER) return false;
      w.insert("org_role_members", { role_id: role.id, org_id: pair.org_id, user_id: userId, assigned_by: REACTION_ROLE_MARKER, assigned_at: now() });
      return true;
    });
    if (!added) return;
    this.ctx.audit({ actorId: userId, orgId: pair.org_id, action: "role.assign", target: `${role.id}:${userId}`, detail: `${role.name} (reaction role)` });
    await reconcileAccess(this.ctx, pair.org_id, [userId]);
  }

  private async take(pair: PairRow, userId: string): Promise<void> {
    const removed = await this.ctx.ws.write((w) => w.delete("org_role_members", { role_id: pair.role_id, user_id: userId, assigned_by: REACTION_ROLE_MARKER }));
    if (removed === 0) return;
    const name = this.role(pair.org_id, pair.role_id)?.name ?? pair.role_id;
    this.ctx.audit({ actorId: userId, orgId: pair.org_id, action: "role.unassign", target: `${pair.role_id}:${userId}`, detail: `${name} (reaction role)` });
    await reconcileAccess(this.ctx, pair.org_id, [userId]);
  }
}
