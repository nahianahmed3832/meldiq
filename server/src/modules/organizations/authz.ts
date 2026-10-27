import type { DB } from "../../infrastructure/database/db.js";
import { isPermission, type Permission, permissionDef } from "./permissions/catalog.js";
import { type ChannelActor, channelPermissions, type Overwrite, parseCapabilities } from "./permissions/channel.js";
import { type Actor, effectivePermissions, type RoleGrant } from "./permissions/rules.js";
import { forbidden, notFound } from "../../shared/errors.js";

/**
 * Server-side authorisation. Every sensitive route calls into this module; the Android UI
 * merely mirrors the same rules to hide controls. Communities, roles and channel permissions:
 * docs/COMMUNITY_REBUILD_2026-10-21.md §5.
 */

/** What a timeout takes away in a community's channels. */
export const TIMEOUT_TAKES: readonly Permission[] = ["messages.post", "messages.attach", "messages.announce", "voice.connect", "voice.speak"];

export type OrgRole = "OWNER" | "ADMIN" | "MEMBER" | "GUEST";

export interface ConversationRow {
  id: string;
  type: "DM" | "GROUP" | "CHANNEL";
  org_id: string | null;
  /** Kept as the community rebuild found it, so an older server still reads it; this server ignores it. */
  scope: "ORG" | "BRANCH" | "TEAM" | null;
  scope_id: string | null;
  kind: "PUBLIC" | "PRIVATE" | "ANNOUNCEMENT" | null;
  name: string | null;
  topic: string | null;
  dm_key: string | null;
  auto_join: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  /** 1: a voice channel (migration 019, docs/VOICE_ROOMS.md). */
  voice?: number;
  /** Migration 032: the channel's category (null: none), its order, and text or forum. */
  category_id?: string | null;
  position?: number;
  format?: "text" | "forum";
  /** Seconds between one person's new messages in a channel; 0 is off (migration 035, batch B3). */
  slowmode_sec?: number;
  /** A forum's tags, JSON [{id, name}] (migration 033). */
  forum_tags?: string | null;
}

/** A custom role as assigned to someone (src/permissions, docs/WORKSPACE_ROLES.md). */
export interface AssignedRole extends RoleGrant {
  id: string;
  name: string;
  color: string | null;
}

/** Stored permission lists are written by validated routes; anything unknown (a key from a newer server) is ignored. */
export function parsePermissionList(json: string): Permission[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((k): k is Permission => typeof k === "string" && isPermission(k)) : [];
  } catch {
    return [];
  }
}

export class Authz {
  constructor(private db: DB) {}

  /** Set only while [reconcileCommunity] runs: overwrites and channel actors read once per target and person. */
  private overwriteCache: Map<string, Overwrite[]> | null = null;
  private actorCache: Map<string, ChannelActor | null> | null = null;

  /** The custom roles [userId] holds in [orgId] (archived roles grant and restrict nothing). */
  assignedRoles(orgId: string, userId: string): AssignedRole[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.name, r.color, r.permissions, r.denies FROM org_role_members m JOIN org_roles r ON r.id = m.role_id
         WHERE m.org_id = ? AND m.user_id = ? AND r.archived_at IS NULL ORDER BY r.position, r.name`,
      )
      .all(orgId, userId) as { id: string; name: string; color: string | null; permissions: string; denies: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, permissions: parsePermissionList(r.permissions), denies: parsePermissionList(r.denies) }));
  }

  /**
   * Effective permissions in a workspace: the base role's, plus custom roles' grants, minus their restrictions
   * (src/permissions/rules.ts). Empty for someone who isn't a member: deny by default.
   */
  permissions(orgId: string, userId: string): Set<Permission> {
    return this.actor(orgId, userId)?.perms ?? new Set();
  }

  can(orgId: string, userId: string, permission: Permission): boolean {
    return this.permissions(orgId, userId).has(permission);
  }

  /** The member's base role and effective permissions, or null for someone outside the workspace. */
  actor(orgId: string, userId: string): (Actor & { perms: Set<Permission> }) | null {
    const base = this.orgRole(orgId, userId);
    return base ? { base, perms: effectivePermissions(base, this.assignedRoles(orgId, userId)) } : null;
  }

  /**
   * What the member's custom roles would give them on another base role. A guest keeps their roles while only the
   * guest-safe parts count, so promoting them back brings the rest back: whoever promotes must reach that too.
   */
  permissionsAs(orgId: string, userId: string, base: OrgRole): Set<Permission> {
    return effectivePermissions(base, this.assignedRoles(orgId, userId));
  }

  /** An active custom role's grants and restrictions, or undefined when it's archived, deleted or elsewhere. */
  roleGrant(roleId: string, orgId: string): RoleGrant | undefined {
    const r = this.db.prepare("SELECT permissions, denies FROM org_roles WHERE id = ? AND org_id = ? AND archived_at IS NULL").get(roleId, orgId) as
      | { permissions: string; denies: string }
      | undefined;
    return r ? { permissions: parsePermissionList(r.permissions), denies: parsePermissionList(r.denies) } : undefined;
  }

  /** Members of the workspace who hold [permission] now (to tell them about something waiting for them). */
  workspaceMembersWith(orgId: string, permission: Permission): string[] {
    const ids = (this.db.prepare("SELECT user_id FROM org_members WHERE org_id = ?").all(orgId) as { user_id: string }[]).map((r) => r.user_id);
    return ids.filter((id) => this.can(orgId, id, permission));
  }

  /** The workspace's active custom role ids. */
  workspaceRoleIds(orgId: string): string[] {
    return (this.db.prepare("SELECT id FROM org_roles WHERE org_id = ? AND archived_at IS NULL").all(orgId) as { id: string }[]).map((r) => r.id);
  }

  /** 404 for outsiders (the workspace's existence stays hidden), 403 without the permission. Returns the base role. */
  requirePermission(orgId: string, userId: string, permission: Permission, message?: string): OrgRole {
    const role = this.requireOrgMember(orgId, userId);
    if (!this.can(orgId, userId, permission)) throw forbidden(message ?? "You don't have permission to do that in this workspace");
    return role;
  }

  orgRole(orgId: string, userId: string): OrgRole | null {
    const r = this.db.prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?").get(orgId, userId) as
      | { role: OrgRole }
      | undefined;
    return r?.role ?? null;
  }

  isOrgAdmin(orgId: string, userId: string): boolean {
    const r = this.orgRole(orgId, userId);
    return r === "OWNER" || r === "ADMIN";
  }

  /** Require org membership (any role); 404 hides org existence from outsiders. */
  requireOrgMember(orgId: string, userId: string): OrgRole {
    const role = this.orgRole(orgId, userId);
    if (!role) throw notFound("Organization not found");
    return role;
  }

  requireOrgAdmin(orgId: string, userId: string): void {
    this.requireOrgMember(orgId, userId);
    if (!this.isOrgAdmin(orgId, userId)) throw forbidden("Only organization owners and admins can do that");
  }

  /** Every conversation of a community (its channels), for adding up what they hold. */
  conversationIdsOf(orgId: string): string[] {
    return (this.db.prepare("SELECT id FROM conversations WHERE org_id = ?").all(orgId) as { id: string }[]).map((r) => r.id);
  }

  conversation(id: string): ConversationRow | undefined {
    return this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
  }

  conversationRole(convId: string, userId: string): "ADMIN" | "MEMBER" | null {
    const r = this.db
      .prepare("SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?")
      .get(convId, userId) as { role: "ADMIN" | "MEMBER" } | undefined;
    return r?.role ?? null;
  }

  isMember(convId: string, userId: string): boolean {
    return this.conversationRole(convId, userId) !== null;
  }

  /** Overwrites on a category or a channel. */
  overwrites(targetType: "category" | "channel", targetId: string): Overwrite[] {
    const key = `${targetType}:${targetId}`;
    const cached = this.overwriteCache?.get(key);
    if (cached) return cached;
    const rows = this.db
      .prepare("SELECT subject, allow, deny FROM channel_overwrites WHERE target_type = ? AND target_id = ?")
      .all(targetType, targetId) as { subject: string; allow: string; deny: string }[];
    const list = rows.map((r) => ({ subject: r.subject, allow: parseCapabilities(r.allow), deny: parseCapabilities(r.deny) }));
    this.overwriteCache?.set(key, list);
    return list;
  }

  /** What [userId] brings into channel permissions: base role, community permissions, roles and their restrictions. */
  channelActor(orgId: string, userId: string): ChannelActor | null {
    const key = `${orgId}:${userId}`;
    if (this.actorCache?.has(key)) return this.actorCache.get(key)!;
    const actor = this.readChannelActor(orgId, userId);
    this.actorCache?.set(key, actor);
    return actor;
  }

  private readChannelActor(orgId: string, userId: string): ChannelActor | null {
    const base = this.orgRole(orgId, userId);
    if (!base) return null;
    const roles = this.assignedRoles(orgId, userId);
    const restricted = new Set<Permission>();
    if (base !== "OWNER") for (const r of roles) for (const d of r.denies) if (permissionDef(d).restrictable) restricted.add(d);
    const perms = new Set(effectivePermissions(base, roles));
    // A timeout takes posting, files and voice away everywhere in the community; like a role's restriction, no channel
    // overwrite gives them back (docs/product/MELDIQ_FEATURE_GAP_MATRIX.md MOD-06).
    if (base !== "OWNER" && this.timeoutUntil(orgId, userId) !== null) {
      for (const p of TIMEOUT_TAKES) {
        perms.delete(p);
        restricted.add(p);
      }
    }
    return { base, userId, perms, roleIds: roles.map((r) => r.id), restricted };
  }

  /** When this member's timeout ends, or null when they aren't timed out. */
  timeoutUntil(orgId: string, userId: string): number | null {
    const r = this.db.prepare("SELECT timeout_until FROM org_members WHERE org_id = ? AND user_id = ?").get(orgId, userId) as
      | { timeout_until: number | null }
      | undefined;
    return r?.timeout_until && r.timeout_until > Date.now() ? r.timeout_until : null;
  }

  /** Permissions inside a category (its overwrites applied): what creating channels there and editing it need. */
  categoryPermissions(orgId: string, categoryId: string, userId: string): Set<Permission> {
    const actor = this.channelActor(orgId, userId);
    return actor ? channelPermissions(actor, [this.overwrites("category", categoryId)]) : new Set();
  }

  /** Effective permissions in a community channel (category overwrites, then the channel's). Empty for outsiders. */
  channelPermissions(conv: ConversationRow, userId: string): Set<Permission> {
    if (conv.type !== "CHANNEL" || !conv.org_id) return new Set();
    const actor = this.channelActor(conv.org_id, userId);
    if (!actor) return new Set();
    const levels = [conv.category_id ? this.overwrites("category", conv.category_id) : [], this.overwrites("channel", conv.id)];
    return channelPermissions(actor, levels);
  }

  /** May this user administer the channel/group (rename, members, archive, permissions)? */
  canManageConversation(conv: ConversationRow, userId: string): boolean {
    if (conv.type === "DM") return false;
    if (conv.type === "GROUP") return this.conversationRole(conv.id, userId) === "ADMIN";
    if (!conv.org_id) return false;
    if (this.channelPermissions(conv, userId).has("channels.manage")) return true;
    return this.conversationRole(conv.id, userId) === "ADMIN";
  }

  /**
   * May this user change who can see, join and post in a channel (public, private or announcement)? Only holders of
   * `channels.visibility`: a channel admin by role alone may not, so nobody can turn a private channel public just
   * because they were made its admin (docs/WORKSPACE_ADMINISTRATION.md).
   */
  canManageChannelAccess(conv: ConversationRow, userId: string): boolean {
    if (conv.type !== "CHANNEL" || !conv.org_id) return false;
    return this.can(conv.org_id, userId, "channels.visibility");
  }

  /**
   * Eligibility for a public or announcement channel: may this user be a member without being added by hand? Owners
   * and admins always; members while their channel permissions include `channels.view`; guests never (a manager adds
   * them explicitly).
   */
  scopeEligible(conv: ConversationRow, userId: string): boolean {
    if (conv.type !== "CHANNEL" || !conv.org_id) return false;
    const role = this.orgRole(conv.org_id, userId);
    if (!role || role === "GUEST") return false;
    if (role === "OWNER" || role === "ADMIN") return true;
    return this.channelPermissions(conv, userId).has("channels.view");
  }

  /** Can the user see that this channel exists (browse / preview)? */
  canViewChannel(conv: ConversationRow, userId: string): boolean {
    if (this.isMember(conv.id, userId)) return true;
    if (conv.kind === "PRIVATE") return false;
    return this.scopeEligible(conv, userId);
  }

  /** Throws unless the user is a current member. Non-members get 404 to avoid leaking existence. */
  requireMember(convId: string, userId: string): ConversationRow {
    const conv = this.conversation(convId);
    if (!conv || !this.isMember(conv.id, userId)) throw notFound("Conversation not found");
    return conv;
  }

  canPost(conv: ConversationRow, userId: string): boolean {
    if (conv.archived_at) return false;
    if (!this.isMember(conv.id, userId)) return false;
    if (conv.type !== "CHANNEL" || !conv.org_id) return true;
    // A role or a channel overwrite may restrict posting; announcements need a manager or `messages.announce`.
    const perms = this.channelPermissions(conv, userId);
    if (!perms.has("messages.post")) return false;
    if (conv.kind === "ANNOUNCEMENT") return perms.has("messages.announce") || this.canManageConversation(conv, userId);
    return true;
  }

  /**
   * API 0.46.0: the tag [userId] may show from [orgId] (its letters and the community's accent), or null when they
   * aren't a member or it has no tag. Accounts ask here, so community tables stay this module's.
   */
  communityTag(orgId: string, userId: string): { text: string; color: string | null } | null {
    const row = this.db.prepare("SELECT o.tag, o.accent FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE o.id = ? AND m.user_id = ?").get(orgId, userId) as
      | { tag: string | null; accent: string | null }
      | undefined;
    return row?.tag ? { text: row.tag, color: row.accent ?? null } : null;
  }

  /**
   * Batch B4: until when a community has paused [what] (joining by invitation or openly; new DMs between its
   * members), or null when it hasn't (or the pause ended).
   */
  pausedUntil(orgId: string, what: "invites" | "dms", at: number): number | null {
    const row = this.db.prepare("SELECT invites_paused_until AS invites, dms_paused_until AS dms FROM orgs WHERE id = ?").get(orgId) as
      | { invites: number | null; dms: number | null }
      | undefined;
    const until = row?.[what] ?? null;
    return until !== null && until > at ? until : null;
  }

  /**
   * Whether slowmode leaves this user alone in [conv] (batch B3): people who manage the channel, and holders of
   * `messages.bypass_slowmode` in its community.
   */
  slowmodeExempt(conv: ConversationRow, userId: string): boolean {
    if (conv.type !== "CHANNEL" || !conv.org_id) return true;
    return this.canManageConversation(conv, userId) || this.can(conv.org_id, userId, "messages.bypass_slowmode");
  }

  /** When [userId] may post their next message in [conv] under slowmode; null when they may post now or it's off. */
  nextPostAt(conv: ConversationRow, userId: string, at: number): number | null {
    const sec = conv.slowmode_sec ?? 0;
    if (sec <= 0 || this.slowmodeExempt(conv, userId)) return null;
    const row = this.db.prepare("SELECT last_post_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(conv.id, userId) as
      | { last_post_at: number | null }
      | undefined;
    const next = (row?.last_post_at ?? 0) + sec * 1000;
    return next > at ? next : null;
  }

  /** May this user upload a file into the conversation? Posting rights plus `messages.attach` in channels. */
  canAttach(conv: ConversationRow, userId: string): boolean {
    if (!this.canPost(conv, userId)) return false;
    if (conv.type !== "CHANNEL" || !conv.org_id) return true;
    return this.channelPermissions(conv, userId).has("messages.attach");
  }

  /** May this user join the call of a voice channel? Members of it, holding `voice.connect` there (not checked outside communities). */
  canConnectVoice(conv: ConversationRow, userId: string): boolean {
    if (!this.isMember(conv.id, userId)) return false;
    if (conv.type !== "CHANNEL" || !conv.org_id) return true;
    return this.channelPermissions(conv, userId).has("voice.connect");
  }

  /** May this user talk (and share video or the screen) in a voice channel's call? Without it, they listen only. */
  canSpeakInVoice(conv: ConversationRow, userId: string): boolean {
    if (!this.canConnectVoice(conv, userId)) return false;
    if (conv.type !== "CHANNEL" || !conv.org_id) return true;
    return this.channelPermissions(conv, userId).has("voice.speak");
  }

  /**
   * Re-check a person's channel memberships in a community after anything that can change their access: their base
   * role, their roles, a channel's or category's overwrites, a channel moving to another category. Removes the
   * memberships they are no longer allowed. Guests keep the channels a manager added them to; private channels keep
   * their members unless an overwrite takes `channels.view` away. Returns the ids of conversations they were removed from.
   */
  revalidateChannelMemberships(orgId: string, userId: string): string[] {
    const role = this.orgRole(orgId, userId);
    const rows = this.db
      .prepare(
        `SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE c.org_id = ? AND m.user_id = ? AND c.type = 'CHANNEL'`,
      )
      .all(orgId, userId) as ConversationRow[];
    const removed: string[] = [];
    for (const conv of rows) {
      let keep: boolean;
      if (role === null) keep = false;
      else if (role === "GUEST") keep = true;
      else if (conv.kind === "PRIVATE") keep = this.channelPermissions(conv, userId).has("channels.view");
      else keep = this.scopeEligible(conv, userId);
      if (!keep) {
        this.db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?").run(conv.id, userId);
        removed.push(conv.id);
      }
    }
    return removed;
  }

  /**
   * Demotion to Guest. Guests have explicit-only access, so every channel membership the person had through their
   * former role goes (public, private and announcement). Managers re-add the specific channels a guest should keep.
   * DMs and groups are not community-scoped and are left alone. Returns the ids of conversations they were removed from.
   */
  demoteToGuest(orgId: string, userId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE c.org_id = ? AND c.type = 'CHANNEL' AND m.user_id = ?`,
      )
      .all(orgId, userId) as { id: string }[];
    const remove = this.db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?");
    for (const r of rows) remove.run(r.id, userId);
    return rows.map((r) => r.id);
  }

  /**
   * Whether `userId` may issue a community invite with this role: owners invite admins; holders of `members.invite`
   * invite members and guests. Checked when an invite is created and again whenever it is used (T3.1), so an invite
   * stops working once its creator loses the right to issue it.
   */
  canIssueInvite(orgId: string, userId: string, role: string): boolean {
    const actorRole = this.orgRole(orgId, userId);
    if (!actorRole || actorRole === "GUEST") return false;
    if (role === "ADMIN") return actorRole === "OWNER";
    return this.can(orgId, userId, "members.invite");
  }

  /** Whether [userId] is banned from the community. */
  isBanned(orgId: string, userId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM org_bans WHERE org_id = ? AND user_id = ?").get(orgId, userId);
  }

  /**
   * Online state and last-seen are visible to the person themself, to anyone who shares a
   * conversation with them, and to non-guest members of a community they belong to. Knowing a
   * username or id is not enough.
   */
  canSeePresence(viewerId: string, targetId: string): boolean {
    if (viewerId === targetId) return true;
    const shared = this.db
      .prepare("SELECT 1 FROM conversation_members a JOIN conversation_members b ON b.conversation_id = a.conversation_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1")
      .get(viewerId, targetId);
    if (shared) return true;
    return !!this.db
      .prepare("SELECT 1 FROM org_members a JOIN org_members b ON b.org_id = a.org_id WHERE a.user_id = ? AND a.role != 'GUEST' AND b.user_id = ? LIMIT 1")
      .get(viewerId, targetId);
  }

  /** Auto-join the public and announcement channels a person may now see. Returns the channels joined. */
  autoJoinScope(orgId: string, userId: string, now: number): string[] {
    const role = this.orgRole(orgId, userId);
    if (!role || role === "GUEST") return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM conversations WHERE org_id = ? AND type = 'CHANNEL' AND archived_at IS NULL
         AND (kind = 'ANNOUNCEMENT' OR auto_join = 1)
         AND id NOT IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?)`,
      )
      .all(orgId, userId) as ConversationRow[];
    const joined: string[] = [];
    for (const conv of rows) {
      if (this.scopeEligible(conv, userId)) {
        this.db
          .prepare("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)")
          .run(conv.id, userId, now);
        joined.push(conv.id);
      }
    }
    return joined;
  }

  /**
   * After an access change that can touch many people (a role's members, an overwrite, a channel move): re-check and
   * auto-join every member of the community. Returns, per person, the channels they lost.
   */
  reconcileCommunity(orgId: string, now: number): Map<string, string[]> {
    const lost = new Map<string, string[]>();
    const members = (this.db.prepare("SELECT user_id FROM org_members WHERE org_id = ?").all(orgId) as { user_id: string }[]).map((r) => r.user_id);
    // Nothing that decides access changes while this runs (the caller holds the write transaction), so overwrites and
    // each person's roles are read once instead of once per channel.
    this.overwriteCache = new Map();
    this.actorCache = new Map();
    try {
      for (const u of members) {
        const removed = this.revalidateChannelMemberships(orgId, u);
        this.autoJoinScope(orgId, u, now);
        if (removed.length) lost.set(u, removed);
      }
    } finally {
      this.overwriteCache = null;
      this.actorCache = null;
    }
    return lost;
  }
}
