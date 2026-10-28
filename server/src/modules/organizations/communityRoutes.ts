import { requireStanding } from "../accounts/index.js";
import type { FastifyInstance } from "fastify";
import { requireSyntheticScopeForOrg } from "./syntheticScope.js";
import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { mapByIds } from "../../infrastructure/database/byIds.js";
import { compareText, foldAscii, likeContains } from "../../shared/utilities/sqlText.js";
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
import { evictFromCall, evictRemovedMember } from "../calls/routes.js";
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

/** A community's categories in their order: position, then name ignoring ASCII case, then id (the SQL's order). */
export function categoriesInOrder<T extends CategoryRow>(rows: RowReader, orgId: string): T[] {
  return rows
    .all<T>("channel_categories", { where: { org_id: orgId } })
    .sort((a, b) => a.position - b.position || compareText(foldAscii(a.name), foldAscii(b.name)) || compareText(a.id, b.id));
}

/**
 * The categories [userId] can see in a community, in order: those with a channel they can see, and every category for
 * people who can manage channels (an empty category is only useful to them). With what they may do there.
 */
export function categoryViews(ctx: AppContext, orgId: string, userId: string) {
  const { authz } = ctx;
  const manageAll = authz.can(orgId, userId, "channels.manage");
  const createAll = authz.can(orgId, userId, "channels.create");
  const rows = categoriesInOrder(ctx.ws, orgId);
  return rows
    .map((c) => {
      const perms = authz.categoryPermissions(orgId, c.id, userId);
      const channels = ctx.ws.all<ConversationRow>("conversations", { where: { category_id: c.id, type: "CHANNEL" } });
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
  const { authz } = ctx;
  const lost = await ctx.ws.write((w) => {
    if (!userIds) return authz.reconcileCommunity(w, orgId, now());
    const out = new Map<string, string[]>();
    for (const u of userIds) {
      const removed = authz.revalidateChannelMemberships(w, orgId, u);
      authz.autoJoinScope(w, orgId, u, now());
      if (removed.length) out.set(u, removed);
    }
    return out;
  });
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
  const { db, authz, ws } = ctx;

  const reconcile = (orgId: string) => reconcileAccess(ctx, orgId);

  const loadCategory = (id: string, userId: string): CategoryRow => {
    const c = ws.get<CategoryRow>("channel_categories", { id });
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
    const id = newId("cat");
    const t = now();
    await ws.write((w) => {
      if (w.count("channel_categories", { org_id: orgId }) >= CATEGORY_LIMIT) throw conflict(`A community has at most ${CATEGORY_LIMIT} categories`);
      const last = w.get<{ position: number }>("channel_categories", { org_id: orgId }, [["position", "desc"]]);
      w.insert("channel_categories", { id, org_id: orgId, name, position: (last?.position ?? -1) + 1, created_by: actor, created_at: t, updated_at: t });
    });
    ctx.audit({ actorId: actor, orgId, action: "category.create", target: id, detail: name });
    notifyOrg(ctx, orgId);
    return { category: categoryViews(ctx, orgId, actor).find((c) => c.id === id) };
  });

  app.patch("/v1/categories/:id", auth, async (req) => {
    const actor = me(req).userId;
    const c = loadCategory(parse(IdParams, req.params).id, actor);
    if (!canManageCategory(c, actor)) throw forbidden("You can't manage this category");
    const { name } = parse(CategoryNameBody, req.body);
    await ws.write((w) => w.update("channel_categories", { id: c.id }, { name, updated_at: now() }));
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
    const channels = ws.count("conversations", { category_id: c.id });
    if (channels > 0 && authz.overwrites("category", c.id).length > 0) {
      throw new ApiError(409, "category_has_permissions", "This category's permissions decide who sees its channels. Move its channels out (or delete them) first.");
    }
    await ws.write((w) => {
      w.delete("channel_overwrites", { target_type: "category", target_id: c.id });
      w.delete("channel_categories", { id: c.id });
    });
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
    const known = new Set(ws.all<{ id: string }>("channel_categories", { where: { org_id: orgId } }).map((r) => r.id));
    for (const id of body.categories) if (!known.has(id)) throw badRequest("Unknown category", { categoryId: id });
    let moved = false;
    for (const ch of body.channels) {
      const conv = authz.conversation(ch.id);
      if (!conv || conv.org_id !== orgId || conv.type !== "CHANNEL") throw badRequest("Unknown channel", { channelId: ch.id });
      if (ch.categoryId && !known.has(ch.categoryId)) throw badRequest("Unknown category", { categoryId: ch.categoryId });
      if ((conv.category_id ?? null) !== ch.categoryId) moved = true;
    }
    const perCategory = new Map<string, number>();
    const after = new Map(ws.all<{ id: string; category_id: string | null }>("conversations", { where: { org_id: orgId, type: "CHANNEL" } }).map((r) => [r.id, r.category_id]));
    for (const ch of body.channels) after.set(ch.id, ch.categoryId);
    for (const cat of after.values()) if (cat) perCategory.set(cat, (perCategory.get(cat) ?? 0) + 1);
    for (const [cat, n] of perCategory) if (n > CHANNEL_LIMITS.perCategory) throw conflict(`A category holds at most ${CHANNEL_LIMITS.perCategory} channels`, { categoryId: cat });
    const t = now();
    await ws.write((w) => {
      // The listed categories first, in that order; any not listed keep their order after them.
      if (body.categories.length) {
        const current = categoriesInOrder(w, orgId).map((r) => r.id);
        const order = [...new Set(body.categories), ...current.filter((id) => !body.categories.includes(id))];
        order.forEach((id, i) => w.update("channel_categories", { id }, { position: i, updated_at: t }));
      }
      for (const ch of body.channels) w.update("conversations", { id: ch.id }, { category_id: ch.categoryId, position: ch.position, updated_at: t });
    });
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
      const u = ctx.identity.get<{ display_name: string }>("users", { id: o.subject.slice(USER_PREFIX.length) });
      return { subject: o.subject, kind: "member", label: u?.display_name ?? "Former member", color: null, allow: o.allow, deny: o.deny };
    }
    const r = ws.get<{ name: string; color: string | null }>("org_roles", { id: o.subject, org_id: orgId });
    return { subject: o.subject, kind: "role", label: r?.name ?? "Deleted role", color: r?.color ?? null, allow: o.allow, deny: o.deny };
  };

  const capabilityCatalog = CHANNEL_CAPABILITIES.map((k) => ({ key: k, label: permissionDef(k).label, description: permissionDef(k).description }));

  const listOverwrites = (t: Target) => ({
    overwrites: authz.overwrites(t.type, t.id).map((o) => overwriteView(t.orgId, o)),
    capabilities: t.type === "category" ? capabilityCatalog : capabilityCatalog.filter((c) => c.key !== "channels.create"),
    roles: ws
      .all<{ id: string; name: string; color: string | null }>("org_roles", {
        where: { org_id: t.orgId, archived_at: null },
        orderBy: [
          ["position", "asc"],
          ["name", "asc"],
        ],
      })
      .map((r) => ({ id: r.id, name: r.name, color: r.color })),
    canManage: t.canManage,
  });

  const writeOverwrite = async (type: "category" | "channel", id: string, actor: string, body: OverwriteBody) => {
    const t = targetFor(type, id, actor);
    if (!t.canManage) throw forbidden(type === "category" ? "You can't manage this category" : "You can't manage this channel");
    const subject = body.subject;
    if (subject !== EVERYONE) {
      if (subject.startsWith(USER_PREFIX)) {
        if (!authz.orgRole(t.orgId, subject.slice(USER_PREFIX.length))) throw badRequest("That person isn't in this community");
      } else if (!ws.get("org_roles", { id: subject, org_id: t.orgId, archived_at: null })) {
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
    await ws.write((w) => {
      if (allow.length === 0 && deny.length === 0) {
        w.delete("channel_overwrites", { target_type: type, target_id: id, subject });
      } else {
        const row = { target_type: type, target_id: id, org_id: t.orgId, subject, allow: JSON.stringify(allow), deny: JSON.stringify(deny), updated_by: actor, updated_at: now() };
        w.upsert("channel_overwrites", row, { allow: row.allow, deny: row.deny, updated_by: row.updated_by, updated_at: row.updated_at });
      }
    });
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
    const term = q.q ? q.q.toLowerCase() : "";
    const banned = new Set(ws.all<{ org_id: string }>("org_bans", { where: { user_id: userId } }).map((b) => b.org_id));
    const rows = ws
      .all<any>("orgs", { where: { visibility: "public" } })
      .filter((o) => !banned.has(o.id) && (!term || likeContains(o.name, term) || likeContains(o.description ?? "", term)))
      .map((o) => ({ ...o, member_count: ws.count("org_members", { org_id: o.id }) }))
      .sort((a, b) => b.member_count - a.member_count || compareText(foldAscii(a.name), foldAscii(b.name)) || compareText(a.id, b.id))
      .slice(q.cursor, q.cursor + DISCOVER_PAGE + 1);
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
    requireStanding(ctx.safety, userId, "join_community");
    const o = ws.get<any>("orgs", { id });
    const member = o ? authz.orgRole(o.id, userId) !== null : false;
    if (!o || (o.visibility !== "public" && !member)) throw notFound("Community not found");
    const channels = ws
      .all<ConversationRow>("conversations", { where: { org_id: id, type: "CHANNEL" } })
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || compareText(foldAscii(a.name ?? ""), foldAscii(b.name ?? "")))
      .filter((c) => visibleToEveryone(ctx, c));
    return {
      community: { ...orgSummary(ctx, o, userId), photoRev: o.photo_rev ?? null },
      channels: channels.map((c) => ({ id: c.id, name: c.name, topic: c.topic, kind: c.kind, voice: !!c.voice, format: c.format ?? "text" })),
      joined: member,
      banned: authz.isBanned(id, userId),
      // Batch B4b: the person's latest application here, if any.
      application: ((r) => (r ? { id: r.id, status: r.status, createdAt: r.created_at } : null))(
        ws.get<{ id: string; status: string; created_at: number }>("join_applications", { org_id: id, user_id: userId }, [["created_at", "desc"]]),
      ),
    };
  });

  app.post("/v1/communities/:id/join", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const userId = me(req).userId;
    const { id } = parse(IdParams, req.params);
    const o = ws.get<any>("orgs", { id });
    if (!o || o.visibility !== "public") throw notFound("Community not found");
    if (authz.orgRole(id, userId)) return { org: orgSummary(ctx, o, userId), alreadyMember: true };
    requireSyntheticScopeForOrg(ctx, userId, id);
    if (o.join_policy !== "open") throw forbidden("This community is invite-only: ask a member for an invitation");
    // Batch B4b: a community with questions takes applications instead.
    if (joinQuestions(o)) throw new ApiError(403, "application_required", "This community asks a few questions first: apply to join");
    if (authz.isBanned(id, userId)) throw new ApiError(403, "banned", "You've been banned from this community");
    const t = now();
    if (authz.pausedUntil(id, "invites", t)) throw new ApiError(403, "invites_paused", "This community has paused new members for now. Try again later.");
    await ws.write((w) => {
      ctx.entitlements.check("members", w.count("org_members", { org_id: id }), id);
      w.insert("org_members", { org_id: id, user_id: userId, role: "MEMBER", joined_at: t }, { orIgnore: true });
      authz.autoJoinScope(w, id, userId, t);
    });
    ctx.audit({ actorId: userId, orgId: id, action: "community.join", target: userId });
    await noteJoin(ctx, id, t);
    notifyOrg(ctx, id);
    return { org: orgSummary(ctx, ws.get("orgs", { id }), userId), alreadyMember: false };
  });

  // ───────────── Bans ─────────────
  app.get("/v1/orgs/:orgId/bans", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, me(req).userId, "members.ban", "Your role doesn't include bans");
    const bans = ws.all<{ user_id: string; reason: string | null; banned_at: number; banned_by: string }>("org_bans", { where: { org_id: orgId }, orderBy: [["banned_at", "desc"]] });
    const people = mapByIds<{ id: string; display_name: string; username: string }>(ctx.identity, "users", "id", [...bans.map((b) => b.user_id), ...bans.map((b) => b.banned_by)], "id, display_name, username");
    // An inner join on the banned person (a ban of someone unknown here isn't listed), a left join on who banned them.
    const rows = bans
      .flatMap((b) => {
        const u = people.get(b.user_id);
        return u ? [{ ...b, display_name: u.display_name, username: u.username, by_name: people.get(b.banned_by)?.display_name ?? null }] : [];
      })
      .slice(0, 500);
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
    if (!ctx.identity.get("users", { id: body.userId })) throw notFound("User not found");
    const targetRole = authz.orgRole(orgId, body.userId);
    if (!banAllowed(authz.actor(orgId, actor)!, targetRole, targetRole ? authz.permissions(orgId, body.userId) : undefined)) {
      throw forbidden(targetRole === "OWNER" ? "Owners can't be banned" : "You can't ban this person");
    }
    await ws.write((w) =>
      w.upsert("org_bans", { org_id: orgId, user_id: body.userId, reason: body.reason ?? null, banned_by: actor, banned_at: now() }, { reason: body.reason ?? null }),
    );
    if (targetRole) await removeFromWorkspace(ctx, orgId, body.userId, actor, "banned");
    else ctx.audit({ actorId: actor, orgId, action: "member.ban", target: body.userId });
    return { ok: true };
  });

  app.delete("/v1/orgs/:orgId/bans/:userId", auth, async (req) => {
    const actor = me(req).userId;
    const p = parse(OrgMemberParams, req.params);
    authz.requirePermission(p.orgId, actor, "members.ban", "Your role doesn't include bans");
    const removed = await ws.write((w) => w.delete("org_bans", { org_id: p.orgId, user_id: p.userId }));
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
    await ws.write((w) => {
      w.update("orgs", { id: orgId }, { guests_allowed: body.guestsAllowed ? 1 : 0, guest_max_days: body.guestMaxDays, updated_at: now() });
      // A shorter maximum brings current guests' end dates forward; turning guests off doesn't remove anyone by itself.
      if (body.guestMaxDays) {
        const cap = now() + body.guestMaxDays * 86_400_000;
        w.update("org_members", { org_id: orgId, role: "GUEST", $or: [{ expires_at: null }, { expires_at: { gt: cap } }] }, { expires_at: cap });
      }
    });
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
    const policy = ws.get<{ guest_max_days: number | null }>("orgs", { id: p.orgId })!;
    if (expiresAt !== null && expiresAt <= now()) throw badRequest("Pick a date in the future, or remove the guest instead");
    if (policy.guest_max_days && (expiresAt === null || expiresAt > now() + policy.guest_max_days * 86_400_000)) {
      throw conflict(`This community keeps guests for at most ${policy.guest_max_days} days`);
    }
    await ws.write((w) => w.update("org_members", { org_id: p.orgId, user_id: p.userId }, { expires_at: expiresAt }));
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
      await ws.write((w) => w.update("orgs", { id: orgId }, { invites_paused_until: body.invitesPausedUntil }));
      ctx.audit({ actorId: actor, orgId, action: body.invitesPausedUntil === null ? "community.invites_resume" : "community.invites_pause", target: orgId });
    }
    if (body.activityAlerts !== undefined) {
      await ws.write((w) => w.update("orgs", { id: orgId }, { activity_alerts: body.activityAlerts ? 1 : 0 }));
      ctx.audit({ actorId: actor, orgId, action: body.activityAlerts ? "community.alerts_on" : "community.alerts_off", target: orgId });
    }
    if (body.dmsPausedUntil !== undefined) {
      await ws.write((w) => w.update("orgs", { id: orgId }, { dms_paused_until: body.dmsPausedUntil }));
      ctx.audit({ actorId: actor, orgId, action: body.dmsPausedUntil === null ? "community.dms_resume" : "community.dms_pause", target: orgId });
    }
    notifyOrg(ctx, orgId);
    const alerts = ws.get<{ activity_alerts: number }>("orgs", { id: orgId })?.activity_alerts ?? 1;
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
    await ws.write((w) => w.update("org_members", { org_id: p.orgId, user_id: p.userId }, { timeout_until: body.until }));
    ctx.audit({
      actorId: actor,
      orgId: p.orgId,
      action: body.until === null ? "member.timeout_end" : "member.timeout",
      target: p.userId,
      detail: body.until === null ? null : `${new Date(body.until).toISOString()}${body.reason ? ` ${body.reason}` : ""}`,
    });
    // Out of the community's live voice calls at once; every app reloads what it may do.
    const voiceChannels = ws.all<{ id: string }>("conversations", { where: { org_id: p.orgId, voice: 1 } }).map((r) => r.id);
    for (const c of await ctx.calls.liveIn(voiceChannels)) await evictFromCall(ctx, c);
    notifyOrg(ctx, p.orgId);
    // Only the person's own view of each channel changes (posting, voice), so only their devices reload them.
    const mine = ws.all<{ conversation_id: string }>("conversation_members", { where: { user_id: p.userId } }).map((m) => m.conversation_id);
    const channels = ws.all<{ id: string }>("conversations", { where: { org_id: p.orgId, id: { in: mine } } });
    for (const c of channels) ctx.hub.sendToUser(p.userId, { t: "conv.updated", conversationId: c.id });
    return { userId: p.userId, timeoutUntil: authz.timeoutUntil(p.orgId, p.userId) };
  });

}
