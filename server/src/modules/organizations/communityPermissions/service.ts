import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { ChannelOptionsView } from "../../../shared/contracts/http/communityPermissions.js";
import { ApiError } from "../../../shared/errors.js";
import type { RowWriter } from "../../../infrastructure/database/rows/index.js";
import { type AuthzExtras, type ConversationRow, parsePermissionList } from "../authz.js";
import { BASE_ROLE_PERMISSIONS, type Permission } from "../permissions/catalog.js";
import { type ChannelOptions, type ChannelOptionsRow, optionsOfRow } from "../permissions/channelOptions.js";
import { type ChannelOptionsInput, updateChannelOptions } from "./channelSettings.js";
import { assignAutoRoles, extrasOf, type RoleExtrasWire } from "./roleExtras.js";

/** A stored @everyone row: changes to the catalog's Member base set. */
export interface MemberDefaultsRow {
  org_id: string;
  added: string;
  removed: string;
  updated_by: string;
  updated_at: number;
}

/** The Member base set with a community's changes applied. */
export function applyDefaults(row: Pick<MemberDefaultsRow, "added" | "removed">): Set<Permission> {
  const removed = new Set(parsePermissionList(row.removed));
  return new Set([...[...BASE_ROLE_PERMISSIONS.MEMBER].filter((p) => !removed.has(p)), ...parsePermissionList(row.added)]);
}

/**
 * Community parity A1 (feature "community-permissions", docs/COMMUNITY_PERMISSIONS.md): what a community sets beyond
 * roles, read synchronously from the workspace rows like the rest of authorisation (Authz reads it through
 * AuthzExtras). With COMMUNITY_PERMISSIONS=off the routes answer 503, Authz isn't given these, and nothing is enforced;
 * what communities set stays for when it's back on.
 */
export class CommunityPermissions implements AuthzExtras {
  constructor(
    private readonly ctx: AppContext,
    readonly enabled: boolean,
  ) {}

  /** Throws 503 while the feature is switched off. */
  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "Community permission settings are switched off for now. Try again later.");
  }

  memberDefaultsRow(orgId: string): MemberDefaultsRow | undefined {
    return this.ctx.ws.get<MemberDefaultsRow>("community_member_defaults", { org_id: orgId });
  }

  memberDefaults(orgId: string): ReadonlySet<Permission> | null {
    const row = this.memberDefaultsRow(orgId);
    return row ? applyDefaults(row) : null;
  }

  channelOptions(conversationId: string): ChannelOptions {
    return optionsOfRow(this.ctx.ws.get<ChannelOptionsRow>("channel_options", { conversation_id: conversationId }));
  }

  isStageSpeaker(conversationId: string, userId: string): boolean {
    return !!this.ctx.ws.get("stage_speakers", { conversation_id: conversationId, user_id: userId });
  }

  /** Who a stage's moderators let speak, earliest first. */
  stageSpeakers(conversationId: string): string[] {
    return this.ctx.ws.all<{ user_id: string }>("stage_speakers", { where: { conversation_id: conversationId }, orderBy: [["granted_at", "asc"]] }).map((r) => r.user_id);
  }

  /** The community's nicknames by person (empty while the feature is off). */
  nicknamesOf(orgId: string): Map<string, string> {
    if (!this.enabled) return new Map();
    return new Map(this.ctx.ws.all<{ user_id: string; nickname: string }>("org_nicknames", { where: { org_id: orgId } }).map((r) => [r.user_id, r.nickname]));
  }

  /** Whether anyone may mention [roleId] in [orgId]: an active role of it that's open to mentions. */
  roleMentionable(orgId: string, roleId: string): boolean {
    if (!this.ctx.ws.get("org_roles", { id: roleId, org_id: orgId, archived_at: null })) return false;
    return extrasOf(this.ctx.ws, roleId).mentionable;
  }

  /** A role's extras as role views carry them (undefined while the feature is off). */
  roleExtras(roleId: string): RoleExtrasWire | undefined {
    return this.enabled ? extrasOf(this.ctx.ws, roleId) : undefined;
  }

  /** A channel's options as its view carries them (moderators of a stage also see who may speak). */
  channelView(conv: ConversationRow, viewer: string): { options?: z.infer<typeof ChannelOptionsView> } {
    if (!this.enabled || conv.type !== "CHANNEL" || !conv.org_id) return {};
    const o = this.channelOptions(conv.id);
    const speakers = o.stage && this.ctx.authz.moderatesStage(conv, viewer) ? { speakerIds: this.stageSpeakers(conv.id) } : {};
    return { options: { textOnly: o.textOnly, noGifs: o.noGifs, stage: o.stage, readOnly: o.readOnly, posterRoleIds: o.posterRoleIds, ...speakers } };
  }

  /**
   * Options sent with a channel's creation or a change of it (PATCH /v1/conversations/:id): checked and written.
   * Returns whether anything changed. Nothing to do when none were sent.
   */
  async updateChannel(conv: ConversationRow, actorId: string, input: ChannelOptionsInput, creating = false): Promise<boolean> {
    const sent = Object.values(input).some((v) => v !== undefined);
    if (!sent) return false;
    this.requireEnabled();
    return updateChannelOptions(this.ctx, conv, actorId, input, creating);
  }

  /** Gives someone who just joined [orgId] the roles it hands out automatically (inside the join's write unit). */
  assignAutoRoles(w: RowWriter, orgId: string, userId: string, joinedAt: number): void {
    if (this.enabled) assignAutoRoles(w, orgId, userId, joinedAt);
  }
}
