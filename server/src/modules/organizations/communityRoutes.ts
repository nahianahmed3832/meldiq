import { requireStanding } from "../accounts/index.js";
import type { FastifyInstance } from "fastify";
import { requireSyntheticScopeForOrg } from "./syntheticScope.js";
import {
  BanBody,
  CATEGORY_LIMIT,
  CategoryNameBody,
  CHANNEL_CAPABILITY_KEYS,
  CHANNELS_PER_COMMUNITY,
  DiscoverQuery,
  ExpiryBody,
  GuestPolicyBody,
  IdParams,
  LayoutBody,
  OrgMemberParams,
  OrgParams,
  OverwriteBody,
  SecurityBody,
  TimeoutBody,
} from "../../shared/contracts/http/community.js";
import type { ConversationRow } from "./authz.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { BASE_ROLE_PERMISSIONS, type Permission, permissionDef } from "./permissions/catalog.js";
import {
  CHANNEL_CAPABILITIES,
  type ChannelCapability,
  channelPermissions,
  EVERYONE,
  type Overwrite,
  overwriteRefusal,
  USER_PREFIX,
} from "./permissions/channel.js";
import { banAllowed, timeoutAllowed } from "./roleRules.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { noteJoin } from "./activityAlerts.js";
import { joinQuestions } from "./applicationsRoutes.js";
import { evictFromCall, evictRemovedMember, type CallRow } from "../calls/routes.js";
import { CHANNEL_LIMITS, notifyConversation, notifyOrg, orgSummary, removeFromWorkspace } from "./orgsRoutes.js";

/**
 * Community structure and moderation (docs/COMMUNITY_REBUILD_2026-10-21.md): categories and the channel layout,
 * permission overwrites on categories and channels, public discovery and open joining, bans, and the guest policy.
 * Every write is checked here on the server; the app only mirrors the rules to hide controls.
 */

/** The longest Security actions pause (batch B4). */
export const SECURITY_PAUSE_MAX_MS = 7 * 86_400_000;
/** The longest timeout, as on other community platforms. */
export const TIMEOUT_MAX_MS = 28 * 86_400_000;
/** At most this many categories in one community (src/shared/contracts/http/community.ts). */
export { CATEGORY_LIMIT };
/** Discovery pages. */
const DISCOVER_PAGE = 30;

interface CategoryRow {
  id: string;
  org_id: string;
  name: string;
  position: number;
}

/**
 * The categories [userId] can see in a community, in order: those with a channel they can see, and every category for
 * people who can manage channels (an empty category is only useful to them). With what they may do there.
 */
export function categoryViews(ctx: AppContext, orgId: string, userId: string) {
  const { db, authz } = ctx;
  const manageAll = authz.can(orgId, userId, "channels.manage");
  const createAll = authz.can(orgId, userId, "channels.create");
  const rows = db.prepare("SELECT * FROM channel_categories WHERE org_id = ? ORDER BY position, lower(name), id").all(orgId) as CategoryRow[];
  return rows
    .map((c) => {
      const perms = authz.categoryPermissions(orgId, c.id, userId);
      const channels = db.prepare("SELECT * FROM conversations WHERE category_id = ? AND type = 'CHANNEL'").all(c.id) as ConversationRow[];
      const visible = channels.filter((ch) => !ch.archived_at && authz.canViewChannel(ch, userId)).length;
      const canManage = manageAll || perms.has("channels.manage");
      return { id: c.id, name: c.name, position: c.position, channelCount: visible, canManage, canCreateChannels: createAll || perms.has("channels.create"), show: visible > 0 || canManage };
    })
    .filter((c) => c.show)
    .map(({ show: _show, ...c }) => c);
}

/** What a plain member without roles sees: the preview of a public community shows only these channels. */
function visibleToEveryone(ctx: AppContext, conv: ConversationRow): boolean {
  if (conv.kind === "PRIVATE" || conv.archived_at) return false;
  const levels = [conv.category_id ? ctx.authz.overwrites("category", conv.category_id) : [], ctx.authz.overwrites("channel", conv.id)];
  const perms = channelPermissions({ base: "MEMBER", userId: "", perms: BASE_ROLE_PERMISSIONS.MEMBER, roleIds: [], restricted: new Set() }, levels);
  return perms.has("channels.view");
}

// The contract's copies of the capability list and the channel limit (shared/ can't import modules) stay equal to these.
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameCapabilities: SameKeys<(typeof CHANNEL_CAPABILITY_KEYS)[number], ChannelCapability> = true;
const _sameChannelLimit: typeof CHANNEL_LIMITS.perCommunity = CHANNELS_PER_COMMUNITY;
void _sameCapabilities;
void _sameChannelLimit;

/**
 * After an access change (a role's members or definition, an overwrite, a channel moving): the people concerned
 * ([userIds], or everyone in the community) are re-checked and auto-joined; those who lost a channel are told and taken
 * out of its call. Returns how many memberships were removed.
 */
export async function reconcileAccess(ctx: AppContext, orgId: string, userIds?: readonly string[]): Promise<{ removed: number }> {
  const { db, authz } = ctx;
  const lost = db.transaction(() => {
    if (!userIds) return authz.reconcileCommunity(orgId, now());
    const out = new Map<string, string[]>();
    for (const u of userIds) {
      const removed = authz.revalidateChannelMemberships(orgId, u);
      authz.autoJoinScope(orgId, u, now());
      if (removed.length) out.set(u, removed);
    }
    return out;
  })();
  notifyOrg(ctx, orgId);
  const byChannel = new Map<string, string[]>();
  for (const [userId, convs] of lost) {
    for (const c of convs) byChannel.set(c, [...(byChannel.get(c) ?? []), userId]);
    await evictRemovedMember(ctx, userId, convs);
  }
  for (const [c, users] of byChannel) notifyConversation(ctx, c, users);
  return { removed: [...lost.values()].reduce((n, cs) => n + cs.length, 0) };
}

export default async function communityRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const { db, authz } = ctx;

  const reconcile = (orgId: string) => reconcileAccess(ctx, orgId);

  const loadCategory = (id: string, userId: string): CategoryRow => {
    const c = db.prepare("SELECT * FROM channel_categories WHERE id = ?").get(id) as CategoryRow | undefined;
    if (!c) throw notFound("Category not found");
    authz.requireOrgMember(c.org_id, userId);
    return c;
  };
  const canManageCategory = (c: CategoryRow, userId: string) =>
    authz.can(c.org_id, userId, "channels.manage") || authz.categoryPermissions(c.org_id, c.id, userId).has("channels.manage");

  // ───────────── Categories ─────────────
  app.get("/v1/orgs/:orgId/categories", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    authz.requireOrgMember(orgId, me(req).userId);
    return { categories: categoryViews(ctx, orgId, me(req).userId) };
  });

  app.post("/v1/orgs/:orgId/categories", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, actor, "channels.create", "Your role doesn't include creating categories");
    const { name } = parse(CategoryNameBody, req.body);
    const n = (db.prepare("SELECT COUNT(*) n FROM channel_categories WHERE org_id = ?").get(orgId) as { n: number }).n;
    if (n >= CATEGORY_LIMIT) throw conflict(`A community has at most ${CATEGORY_LIMIT} categories`);
    const id = newId("cat");
    const t = now();
    const position = ((db.prepare("SELECT MAX(position) p FROM channel_categories WHERE org_id = ?").get(orgId) as { p: number | null }).p ?? -1) + 1;
    db.prepare("INSERT INTO channel_categories (id, org_id, name, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, orgId, name, position, actor, t, t);
    ctx.audit({ actorId: actor, orgId, action: "category.create", target: id, detail: name });
    notifyOrg(ctx, orgId);
    return { category: categoryViews(ctx, orgId, actor).find((c) => c.id === id) };
  });

  app.patch("/v1/categories/:id", auth, async (req) => {
    const actor = me(req).userId;
    const c = loadCategory(parse(IdParams, req.params).id, actor);
    if (!canManageCategory(c, actor)) throw forbidden("You can't manage this category");
    const { name } = parse(CategoryNameBody, req.body);
    db.prepare("UPDATE channel_categories SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), c.id);
    ctx.audit({ actorId: actor, orgId: c.org_id, action: "category.update", target: c.id });
    notifyOrg(ctx, c.org_id);
    return { category: categoryViews(ctx, c.org_id, actor).find((x) => x.id === c.id) ?? null };
  });

  /**
   * Deleting a category leaves its channels uncategorised. A category whose permissions still decide who sees its
   * channels can't be deleted while it holds any: removing those rules would silently show the channels to more people.
   */
  app.delete("/v1/categories/:id", auth, async (req) => {
    const actor = me(req).userId;
    const c = loadCategory(parse(IdParams, req.params).id, actor);
    authz.requirePermission(c.org_id, actor, "channels.manage", "Your role doesn't include managing channels");
    const channels = (db.prepare("SELECT COUNT(*) n FROM conversations WHERE category_id = ?").get(c.id) as { n: number }).n;
    if (channels > 0 && authz.overwrites("category", c.id).length > 0) {
      throw new ApiError(409, "category_has_permissions", "This category's permissions decide who sees its channels. Move its channels out (or delete them) first.");
    }
    db.transaction(() => {
      db.prepare("DELETE FROM channel_overwrites WHERE target_type = 'category' AND target_id = ?").run(c.id);
      db.prepare("DELETE FROM channel_categories WHERE id = ?").run(c.id);
    })();
    ctx.audit({ actorId: actor, orgId: c.org_id, action: "category.delete", target: c.id, detail: c.name });
    notifyOrg(ctx, c.org_id);
    return { ok: true };
  });

  /**
   * The whole layout in one atomic write: category order (the listed ones first), and each listed channel's category
   * and position. A channel
   * moving to another category takes that category's permissions, so everyone is re-checked afterwards.
   */
  app.put("/v1/orgs/:orgId/layout", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, actor, "channels.manage", "Your role doesn't include arranging channels");
    const body = parse(LayoutBody, req.body);
    const known = new Set((db.prepare("SELECT id FROM channel_categories WHERE org_id = ?").all(orgId) as { id: string }[]).map((r) => r.id));
    for (const id of body.categories) if (!known.has(id)) throw badRequest("Unknown category", { categoryId: id });
    let moved = false;
    for (const ch of body.channels) {
      const conv = authz.conversation(ch.id);
      if (!conv || conv.org_id !== orgId || conv.type !== "CHANNEL") throw badRequest("Unknown channel", { channelId: ch.id });
      if (ch.categoryId && !known.has(ch.categoryId)) throw badRequest("Unknown category", { categoryId: ch.categoryId });
      if ((conv.category_id ?? null) !== ch.categoryId) moved = true;
    }
    const perCategory = new Map<string, number>();
    const after = new Map((db.prepare("SELECT id, category_id FROM conversations WHERE org_id = ? AND type = 'CHANNEL'").all(orgId) as { id: string; category_id: string | null }[]).map((r) => [r.id, r.category_id]));
    for (const ch of body.channels) after.set(ch.id, ch.categoryId);
    for (const cat of after.values()) if (cat) perCategory.set(cat, (perCategory.get(cat) ?? 0) + 1);
    for (const [cat, n] of perCategory) if (n > CHANNEL_LIMITS.perCategory) throw conflict(`A category holds at most ${CHANNEL_LIMITS.perCategory} channels`, { categoryId: cat });
    const t = now();
    db.transaction(() => {
      // The listed categories first, in that order; any not listed keep their order after them.
      if (body.categories.length) {
        const current = (db.prepare("SELECT id FROM channel_categories WHERE org_id = ? ORDER BY position, lower(name), id").all(orgId) as { id: string }[]).map((r) => r.id);
        const order = [...new Set(body.categories), ...current.filter((id) => !body.categories.includes(id))];
        order.forEach((id, i) => db.prepare("UPDATE channel_categories SET position = ?, updated_at = ? WHERE id = ?").run(i, t, id));
      }
      for (const ch of body.channels) db.prepare("UPDATE conversations SET category_id = ?, position = ?, updated_at = ? WHERE id = ?").run(ch.categoryId, ch.position, t, ch.id);
    })();
    ctx.audit({ actorId: actor, orgId, action: "layout.update", detail: `${body.categories.length} categories, ${body.channels.length} channels` });
    const result = moved ? await reconcile(orgId) : (notifyOrg(ctx, orgId), { removed: 0 });
    for (const ch of body.channels) notifyConversation(ctx, ch.id);
    return { ok: true, ...result, categories: categoryViews(ctx, orgId, actor) };
  });

  // ───────────── Permission overwrites ─────────────
  type Target = { type: "category" | "channel"; id: string; orgId: string; held: Set<Permission>; canManage: boolean };

  const targetFor = (type: "category" | "channel", id: string, actor: string): Target => {
    if (type === "category") {
      const c = loadCategory(id, actor);
      return { type, id, orgId: c.org_id, held: authz.categoryPermissions(c.org_id, c.id, actor), canManage: canManageCategory(c, actor) };
    }
    const conv = authz.conversation(id);
    if (!conv || conv.type !== "CHANNEL" || !conv.org_id || !authz.canViewChannel(conv, actor)) throw notFound("Channel not found");
    return { type, id, orgId: conv.org_id, held: authz.channelPermissions(conv, actor), canManage: authz.canManageConversation(conv, actor) };
  };

  const overwriteView = (orgId: string, o: Overwrite) => {
    if (o.subject === EVERYONE) return { subject: o.subject, kind: "everyone", label: "@everyone", color: null, allow: o.allow, deny: o.deny };
    if (o.subject.startsWith(USER_PREFIX)) {
      const u = db.prepare("SELECT display_name FROM users WHERE id = ?").get(o.subject.slice(USER_PREFIX.length)) as { display_name: string } | undefined;
      return { subject: o.subject, kind: "member", label: u?.display_name ?? "Former member", color: null, allow: o.allow, deny: o.deny };
    }
    const r = db.prepare("SELECT name, color FROM org_roles WHERE id = ? AND org_id = ?").get(o.subject, orgId) as { name: string; color: string | null } | undefined;
    return { subject: o.subject, kind: "role", label: r?.name ?? "Deleted role", color: r?.color ?? null, allow: o.allow, deny: o.deny };
  };

  const capabilityCatalog = CHANNEL_CAPABILITIES.map((k) => ({ key: k, label: permissionDef(k).label, description: permissionDef(k).description }));

  const listOverwrites = (t: Target) => ({
    overwrites: authz.overwrites(t.type, t.id).map((o) => overwriteView(t.orgId, o)),
    capabilities: t.type === "category" ? capabilityCatalog : capabilityCatalog.filter((c) => c.key !== "channels.create"),
    roles: (db.prepare("SELECT id, name, color FROM org_roles WHERE org_id = ? AND archived_at IS NULL ORDER BY position, name").all(t.orgId) as { id: string; name: string; color: string | null }[]),
    canManage: t.canManage,
  });

  const writeOverwrite = async (type: "category" | "channel", id: string, actor: string, body: OverwriteBody) => {
    const t = targetFor(type, id, actor);
    if (!t.canManage) throw forbidden(type === "category" ? "You can't manage this category" : "You can't manage this channel");
    const subject = body.subject;
    if (subject !== EVERYONE) {
      if (subject.startsWith(USER_PREFIX)) {
        if (!authz.orgRole(t.orgId, subject.slice(USER_PREFIX.length))) throw badRequest("That person isn't in this community");
      } else if (!db.prepare("SELECT 1 FROM org_roles WHERE id = ? AND org_id = ? AND archived_at IS NULL").get(subject, t.orgId)) {
        throw badRequest("Unknown role");
      }
    }
    if (type === "channel" && [...body.allow, ...body.deny].includes("channels.create")) throw badRequest("Creating channels is set on a category");
    const allow = [...new Set(body.allow)] as ChannelCapability[];
    const deny = [...new Set(body.deny)] as ChannelCapability[];
    const prev = authz.overwrites(type, id).find((o) => o.subject === subject);
    // Owners and admins hold everything; others change only what they hold where the rule applies.
    const held = authz.isOrgAdmin(t.orgId, actor) ? new Set(authz.permissions(t.orgId, actor)) : t.held;
    const refusal = overwriteRefusal(held, { subject, allow, deny }, prev);
    if (refusal) throw new ApiError(refusal.status, refusal.code, refusal.message);
    // Who can see is the community's call, like making a channel public or private: managing a category or channel
    // isn't enough to show its channels to more (or fewer) people.
    const viewState = (o?: { allow: readonly string[]; deny: readonly string[] }) => (o?.allow.includes("channels.view") ? 1 : o?.deny.includes("channels.view") ? -1 : 0);
    if (viewState(prev) !== viewState({ allow, deny }) && !authz.can(t.orgId, actor, "channels.visibility")) {
      throw forbidden("Only people who can change channel access can change who sees it");
    }
    if (allow.length === 0 && deny.length === 0) {
      db.prepare("DELETE FROM channel_overwrites WHERE target_type = ? AND target_id = ? AND subject = ?").run(type, id, subject);
    } else {
      db.prepare(
        `INSERT INTO channel_overwrites (target_type, target_id, org_id, subject, allow, deny, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (target_type, target_id, subject) DO UPDATE SET allow = excluded.allow, deny = excluded.deny, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).run(type, id, t.orgId, subject, JSON.stringify(allow), JSON.stringify(deny), actor, now());
    }
    ctx.audit({ actorId: actor, orgId: t.orgId, action: "permissions.update", target: `${type}:${id}`, detail: `${subject} +${allow.join(",")} -${deny.join(",")}` });
    const result = await reconcile(t.orgId);
    if (type === "channel") notifyConversation(ctx, id);
    return { ...listOverwrites(targetFor(type, id, actor)), ...result };
  };

  app.get("/v1/categories/:id/overwrites", auth, async (req) => {
    const actor = me(req).userId;
    const t = targetFor("category", parse(IdParams, req.params).id, actor);
    // A category's rules name roles and people: shown to those who manage it or can see a channel in it.
    if (!t.canManage && !categoryViews(ctx, t.orgId, actor).some((c) => c.id === t.id)) throw notFound("Category not found");
    return listOverwrites(t);
  });
  app.put("/v1/categories/:id/overwrites", auth, async (req) => writeOverwrite("category", parse(IdParams, req.params).id, me(req).userId, parse(OverwriteBody, req.body)));
  app.get("/v1/conversations/:id/overwrites", auth, async (req) => listOverwrites(targetFor("channel", parse(IdParams, req.params).id, me(req).userId)));
  app.put("/v1/conversations/:id/overwrites", auth, async (req) => writeOverwrite("channel", parse(IdParams, req.params).id, me(req).userId, parse(OverwriteBody, req.body)));

  // ───────────── Discovery and joining ─────────────
  const discoverRate = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  /** Public communities, most members first; [q] matches name or description. Cursor: the next offset. */
  app.get("/v1/communities/discover", discoverRate, async (req) => {
    const userId = me(req).userId;
    const q = parse(DiscoverQuery, req.query);
    const like = q.q ? `%${q.q.toLowerCase().replace(/[%_\\]/g, (c) => "\\" + c)}%` : "%";
    const rows = db
      .prepare(
        `SELECT o.*, (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS member_count FROM orgs o
         WHERE o.visibility = 'public' AND (lower(o.name) LIKE ? ESCAPE '\\' OR lower(COALESCE(o.description, '')) LIKE ? ESCAPE '\\')
           AND o.id NOT IN (SELECT org_id FROM org_bans WHERE user_id = ?)
         ORDER BY member_count DESC, lower(o.name), o.id LIMIT ? OFFSET ?`,
      )
      .all(like, like, userId, DISCOVER_PAGE + 1, q.cursor) as any[];
    const page = rows.slice(0, DISCOVER_PAGE);
    return {
      communities: page.map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        memberCount: o.member_count,
        photoRev: o.photo_rev ?? null,
        accent: o.accent ?? null,
        bannerRev: o.banner_rev ?? null,
        joinPolicy: o.join_policy === "open" ? "open" : "invite",
        applications: !!o.join_questions,
        joined: authz.orgRole(o.id, userId) !== null,
      })),
      nextCursor: rows.length > DISCOVER_PAGE ? q.cursor + DISCOVER_PAGE : null,
    };
  });

  /** A public community before joining (or one you're in): its profile, rules and the channels everyone can see. */
  app.get("/v1/communities/:id/preview", discoverRate, async (req) => {
    const userId = me(req).userId;
    const { id } = parse(IdParams, req.params);
    requireStanding(db, userId, "join_community");
    const o = db.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as any;
    const member = o ? authz.orgRole(o.id, userId) !== null : false;
    if (!o || (o.visibility !== "public" && !member)) throw notFound("Community not found");
    const channels = (db.prepare("SELECT * FROM conversations WHERE org_id = ? AND type = 'CHANNEL' ORDER BY position, lower(name)").all(id) as ConversationRow[]).filter((c) =>
      visibleToEveryone(ctx, c),
    );
    return {
      community: { ...orgSummary(ctx, o, userId), photoRev: o.photo_rev ?? null },
      channels: channels.map((c) => ({ id: c.id, name: c.name, topic: c.topic, kind: c.kind, voice: !!c.voice, format: c.format ?? "text" })),
      joined: member,
      banned: authz.isBanned(id, userId),
      // Batch B4b: the person's latest application here, if any.
      application: ((r) => (r ? { id: r.id, status: r.status, createdAt: r.created_at } : null))(
        db.prepare("SELECT id, status, created_at FROM join_applications WHERE org_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1").get(id, userId) as
          | { id: string; status: string; created_at: number }
          | undefined,
      ),
    };
  });

  app.post("/v1/communities/:id/join", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const userId = me(req).userId;
    const { id } = parse(IdParams, req.params);
    const o = db.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as any;
    if (!o || o.visibility !== "public") throw notFound("Community not found");
    if (authz.orgRole(id, userId)) return { org: orgSummary(ctx, o, userId), alreadyMember: true };
    requireSyntheticScopeForOrg(db, userId, id);
    if (o.join_policy !== "open") throw forbidden("This community is invite-only: ask a member for an invitation");
    // Batch B4b: a community with questions takes applications instead.
    if (joinQuestions(o)) throw new ApiError(403, "application_required", "This community asks a few questions first: apply to join");
    if (authz.isBanned(id, userId)) throw new ApiError(403, "banned", "You've been banned from this community");
    const t = now();
    if (authz.pausedUntil(id, "invites", t)) throw new ApiError(403, "invites_paused", "This community has paused new members for now. Try again later.");
    db.transaction(() => {
      ctx.entitlements.check("members", (db.prepare("SELECT COUNT(*) n FROM org_members WHERE org_id = ?").get(id) as { n: number }).n, id);
      db.prepare("INSERT OR IGNORE INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)").run(id, userId, t);
      authz.autoJoinScope(id, userId, t);
    })();
    ctx.audit({ actorId: userId, orgId: id, action: "community.join", target: userId });
    noteJoin(ctx, id, t);
    notifyOrg(ctx, id);
    return { org: orgSummary(ctx, db.prepare("SELECT * FROM orgs WHERE id = ?").get(id), userId), alreadyMember: false };
  });

  // ───────────── Bans ─────────────
  app.get("/v1/orgs/:orgId/bans", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, me(req).userId, "members.ban", "Your role doesn't include bans");
    const rows = db
      .prepare(
        `SELECT b.user_id, b.reason, b.banned_at, b.banned_by, u.display_name, u.username, a.display_name AS by_name FROM org_bans b
         JOIN users u ON u.id = b.user_id LEFT JOIN users a ON a.id = b.banned_by WHERE b.org_id = ? ORDER BY b.banned_at DESC LIMIT 500`,
      )
      .all(orgId) as { user_id: string; reason: string | null; banned_at: number; banned_by: string; display_name: string; username: string; by_name: string | null }[];
    return {
      bans: rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, username: r.username, reason: r.reason, bannedAt: r.banned_at, bannedBy: r.banned_by, bannedByName: r.by_name })),
    };
  });

  app.post("/v1/orgs/:orgId/bans", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(BanBody, req.body);
    authz.requireOrgMember(orgId, actor);
    if (body.userId === actor) throw badRequest("You can't ban yourself");
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(body.userId)) throw notFound("User not found");
    const targetRole = authz.orgRole(orgId, body.userId);
    if (!banAllowed(authz.actor(orgId, actor)!, targetRole, targetRole ? authz.permissions(orgId, body.userId) : undefined)) {
      throw forbidden(targetRole === "OWNER" ? "Owners can't be banned" : "You can't ban this person");
    }
    db.prepare("INSERT INTO org_bans (org_id, user_id, reason, banned_by, banned_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET reason = excluded.reason").run(
      orgId,
      body.userId,
      body.reason ?? null,
      actor,
      now(),
    );
    if (targetRole) await removeFromWorkspace(ctx, orgId, body.userId, actor, "banned");
    else ctx.audit({ actorId: actor, orgId, action: "member.ban", target: body.userId });
    return { ok: true };
  });

  app.delete("/v1/orgs/:orgId/bans/:userId", auth, async (req) => {
    const actor = me(req).userId;
    const p = parse(OrgMemberParams, req.params);
    authz.requirePermission(p.orgId, actor, "members.ban", "Your role doesn't include bans");
    const removed = db.prepare("DELETE FROM org_bans WHERE org_id = ? AND user_id = ?").run(p.orgId, p.userId).changes;
    if (!removed) throw notFound("Not banned");
    ctx.audit({ actorId: actor, orgId: p.orgId, action: "member.unban", target: p.userId });
    return { ok: true };
  });

  // ───────────── Guests (round 7, docs/WORKSPACE_C5.md) ─────────────
  app.put("/v1/orgs/:orgId/guest-policy", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const actor = me(req).userId;
    authz.requirePermission(orgId, actor, "workspace.edit", "Only people who can edit the community can change the guest policy");
    const body = parse(GuestPolicyBody, req.body);
    db.prepare("UPDATE orgs SET guests_allowed = ?, guest_max_days = ?, updated_at = ? WHERE id = ?").run(body.guestsAllowed ? 1 : 0, body.guestMaxDays, now(), orgId);
    // A shorter maximum brings current guests' end dates forward; turning guests off doesn't remove anyone by itself.
    if (body.guestMaxDays) {
      const cap = now() + body.guestMaxDays * 86_400_000;
      db.prepare("UPDATE org_members SET expires_at = ? WHERE org_id = ? AND role = 'GUEST' AND (expires_at IS NULL OR expires_at > ?)").run(cap, orgId, cap);
    }
    ctx.audit({ actorId: actor, orgId, action: "org.guest_policy", detail: `${body.guestsAllowed ? "allowed" : "off"} ${body.guestMaxDays ?? "∞"}` });
    return { guestsAllowed: body.guestsAllowed, guestMaxDays: body.guestMaxDays };
  });

  /** A guest's end date (null: none, within the policy's maximum). Members and admins have no end date. */
  app.put("/v1/orgs/:orgId/members/:userId/expiry", auth, async (req) => {
    const p = parse(OrgMemberParams, req.params);
    const actor = me(req).userId;
    if (!authz.can(p.orgId, actor, "members.roles")) throw forbidden("Only people who can change member access can set a guest's end date");
    const role = authz.orgRole(p.orgId, p.userId);
    if (!role) throw notFound("Member not found");
    if (role !== "GUEST") throw badRequest("Only guests have an end date");
    const { expiresAt } = parse(ExpiryBody, req.body);
    const policy = db.prepare("SELECT guest_max_days FROM orgs WHERE id = ?").get(p.orgId) as { guest_max_days: number | null };
    if (expiresAt !== null && expiresAt <= now()) throw badRequest("Pick a date in the future, or remove the guest instead");
    if (policy.guest_max_days && (expiresAt === null || expiresAt > now() + policy.guest_max_days * 86_400_000)) {
      throw conflict(`This community keeps guests for at most ${policy.guest_max_days} days`);
    }
    db.prepare("UPDATE org_members SET expires_at = ? WHERE org_id = ? AND user_id = ?").run(expiresAt, p.orgId, p.userId);
    ctx.audit({ actorId: actor, orgId: p.orgId, action: "member.expiry", target: p.userId });
    return { expiresAt };
  });

  // ───────────── Security actions (batch B4, Discord reference ADMIN-CTRL-007) ─────────────
  /**
   * Pauses joining (by invitation or openly) and new direct messages between members, until a time at most 7 days
   * ahead; null resumes. For people who edit the community or ban members.
   */
  app.put("/v1/orgs/:orgId/security", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const actor = me(req).userId;
    const body = parse(SecurityBody, req.body);
    authz.requireOrgMember(orgId, actor);
    if (!authz.can(orgId, actor, "workspace.edit") && !authz.can(orgId, actor, "members.ban")) throw forbidden("Your role doesn't include security actions");
    const t = now();
    for (const until of [body.invitesPausedUntil, body.dmsPausedUntil]) {
      if (until === undefined || until === null) continue;
      if (until <= t) throw badRequest("Pick a time in the future, or resume instead");
      if (until > t + SECURITY_PAUSE_MAX_MS) throw badRequest("A pause lasts at most 7 days");
    }
    if (body.invitesPausedUntil !== undefined) {
      db.prepare("UPDATE orgs SET invites_paused_until = ? WHERE id = ?").run(body.invitesPausedUntil, orgId);
      ctx.audit({ actorId: actor, orgId, action: body.invitesPausedUntil === null ? "community.invites_resume" : "community.invites_pause", target: orgId });
    }
    if (body.activityAlerts !== undefined) {
      db.prepare("UPDATE orgs SET activity_alerts = ? WHERE id = ?").run(body.activityAlerts ? 1 : 0, orgId);
      ctx.audit({ actorId: actor, orgId, action: body.activityAlerts ? "community.alerts_on" : "community.alerts_off", target: orgId });
    }
    if (body.dmsPausedUntil !== undefined) {
      db.prepare("UPDATE orgs SET dms_paused_until = ? WHERE id = ?").run(body.dmsPausedUntil, orgId);
      ctx.audit({ actorId: actor, orgId, action: body.dmsPausedUntil === null ? "community.dms_resume" : "community.dms_pause", target: orgId });
    }
    notifyOrg(ctx, orgId);
    const alerts = (db.prepare("SELECT activity_alerts FROM orgs WHERE id = ?").get(orgId) as { activity_alerts: number } | undefined)?.activity_alerts ?? 1;
    return { invitesPausedUntil: authz.pausedUntil(orgId, "invites", t), dmsPausedUntil: authz.pausedUntil(orgId, "dms", t), activityAlerts: !!alerts };
  });

  // ───────────── Timeouts (docs/product/MELDIQ_FEATURE_GAP_MATRIX.md MOD-06) ─────────────
  /**
   * Times a member out until [until] (at most 28 days ahead), or ends the timeout (null). While it lasts they can read
   * but not post, share files, or join and talk in voice channels; they are removed from the community's live calls.
   */
  app.put("/v1/orgs/:orgId/members/:userId/timeout", auth, async (req) => {
    const p = parse(OrgMemberParams, req.params);
    const actor = me(req).userId;
    const body = parse(TimeoutBody, req.body);
    authz.requireOrgMember(p.orgId, actor);
    if (p.userId === actor) throw badRequest("You can't time yourself out");
    const targetRole = authz.orgRole(p.orgId, p.userId);
    if (!targetRole) throw notFound("Member not found");
    if (!timeoutAllowed(authz.actor(p.orgId, actor)!, targetRole, authz.permissions(p.orgId, p.userId))) {
      throw forbidden(targetRole === "OWNER" ? "Owners can't be timed out" : "You can't time out this person");
    }
    const t = now();
    if (body.until !== null && body.until <= t) throw badRequest("Pick a time in the future, or end the timeout instead");
    if (body.until !== null && body.until > t + TIMEOUT_MAX_MS) throw badRequest("A timeout lasts at most 28 days");
    db.prepare("UPDATE org_members SET timeout_until = ? WHERE org_id = ? AND user_id = ?").run(body.until, p.orgId, p.userId);
    ctx.audit({
      actorId: actor,
      orgId: p.orgId,
      action: body.until === null ? "member.timeout_end" : "member.timeout",
      target: p.userId,
      detail: body.until === null ? null : `${new Date(body.until).toISOString()}${body.reason ? ` ${body.reason}` : ""}`,
    });
    // Out of the community's live voice calls at once; every app reloads what it may do.
    const voice = db
      .prepare("SELECT c.* FROM calls c JOIN conversations v ON v.id = c.conversation_id WHERE v.org_id = ? AND v.voice = 1 AND c.state != 'ENDED'")
      .all(p.orgId) as CallRow[];
    for (const c of voice) await evictFromCall(ctx, c);
    notifyOrg(ctx, p.orgId);
    // Only the person's own view of each channel changes (posting, voice), so only their devices reload them.
    const channels = db
      .prepare("SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE c.org_id = ? AND m.user_id = ?")
      .all(p.orgId, p.userId) as { id: string }[];
    for (const c of channels) ctx.hub.sendToUser(p.userId, { t: "conv.updated", conversationId: c.id });
    return { userId: p.userId, timeoutUntil: authz.timeoutUntil(p.orgId, p.userId) };
  });

}
