import type { FastifyInstance, FastifyReply } from "fastify";
import { markSyntheticOrg } from "./syntheticScope.js";
import { type ConversationRow, parsePermissionList } from "./authz.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import {
  ChannelCreateBody,
  ChannelListQuery,
  COMMUNITY_TEMPLATE_IDS,
  InviteCodeBody,
  InviteCodeParams,
  InviteCreateBody,
  InviteIdParams,
  MemberSearchQuery,
  MemberUpdateBody,
  OrgCreateBody,
  OrgDeleteBody,
  OrgMemberParams,
  OrgParams,
  OrgUpdateBody,
} from "../../shared/contracts/http/orgs.js";
import { memberView } from "../accounts/profile.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { humanCode, newId, now, sha256Hex } from "../../shared/utilities/util.js";
import { activityAlert, noteJoin } from "./activityAlerts.js";
import { joinQuestions } from "./applicationsRoutes.js";
import { guideOf } from "./guideRoutes.js";
import { onboardingOn } from "./onboardingRoutes.js";
import { INVITE_PROBLEMS, inviteAlreadySatisfied, joinOrgByInvite, lookupOrgInvite, orgInviteProblem } from "./invites.js";
import { userSummary } from "../auth/routes.js";
import { deleteBlobNow, processBlobDeletes, queueBlobDelete } from "../files/routes.js";
import { bannerBlobId, MAX_BANNER_BYTES, photoBlobId, readJpegBody, storePhoto } from "../accounts/photos.js";
import { evictRemovedMember } from "../calls/routes.js";
import { conversationView } from "../messaging/conversationsRoutes.js";
import { orgRoleChangeRefusal, removalAllowed, titleChangeAllowed } from "./roleRules.js";
import { createCommunityStart, type TemplateId, templateList } from "./communityStart.js";
import { roleAssignmentRefusal } from "./permissions/rules.js";
import { categoryViews } from "./communityRoutes.js";

/** The contract's template ids are the ones communityStart.ts creates (checked when the server compiles). */
const templateIdsMatch: [(typeof COMMUNITY_TEMPLATE_IDS)[number]] extends [TemplateId] ? ([TemplateId] extends [(typeof COMMUNITY_TEMPLATE_IDS)[number]] ? true : never) : never = true;
void templateIdsMatch;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

export type InviteStatus = "active" | "revoked" | "expired" | "used_up";

/** An invitation's one state at [t]: revoked, else expired, else used up, else active. */
export function inviteStatus(r: { revoked_at: number | null; expires_at: number; uses: number; max_uses: number }, t: number): InviteStatus {
  if (r.revoked_at) return "revoked";
  if (r.expires_at <= t) return "expired";
  if (r.uses >= r.max_uses) return "used_up";
  return "active";
}

/** At most this many channels in one community and in one category (Discord's documented 50 per category). */
export const CHANNEL_LIMITS = { perCommunity: 500, perCategory: 50 } as const;

export function orgSummary(ctx: AppContext, org: any, userId: string) {
  const role = ctx.authz.orgRole(org.id, userId);
  const memberCount = (ctx.db.prepare("SELECT COUNT(*) n FROM org_members WHERE org_id = ?").get(org.id) as { n: number }).n;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    description: org.description,
    myRole: role,
    memberCount,
    createdAt: org.created_at,
    // The organisation's avatar revision (GET /v1/orgs/:orgId/photo), null without one.
    photoRev: org.photo_rev ?? null,
    // API 0.44.0 (docs/COMMUNITY_BRANDING.md): its accent colour and banner, null for Meldiq's standard look.
    accent: org.accent ?? null,
    bannerRev: org.banner_rev ?? null,
    // API 0.46.0: the tag members may wear by their names.
    tag: org.tag ?? null,
    // Round 7 guest policy (docs/WORKSPACE_C5.md).
    guestsAllowed: org.guests_allowed === undefined ? true : !!org.guests_allowed,
    guestMaxDays: org.guest_max_days ?? null,
    // Every workspace is a community since the rebuild; the field stays for apps that read it.
    kind: "community",
    visibility: org.visibility === "public" ? "public" : "private",
    joinPolicy: org.join_policy === "open" ? "open" : "invite",
    rules: org.rules ?? null,
    // Batch B4: Security actions that are running (null otherwise).
    invitesPausedUntil: ctx.authz.pausedUntil(org.id, "invites", Date.now()),
    dmsPausedUntil: ctx.authz.pausedUntil(org.id, "dms", Date.now()),
    // Batch B4b: join applications (the questions, or null), activity alerts (on/off), and a recent alert (moderators).
    joinQuestions: joinQuestions(org),
    // Batch B8b: the community guide (members only), and whether onboarding questions are on.
    guide: ctx.authz.orgRole(org.id, userId) ? guideOf(ctx, org, userId) : null,
    onboarding: onboardingOn(ctx, org.id),
    activityAlerts: org.activity_alerts === undefined ? true : !!org.activity_alerts,
    activityAlert: activityAlert(ctx, org, userId, Date.now()),
  };
}

/**
 * Takes someone out of a community with everything that hangs off the membership (roles, channels, member overwrites,
 * meeting invitations, personal arrangement), tells everyone concerned and records why: "left", "removed" or "banned"
 * by [actorId], or "expired" (a guest's end date, actorId null). Callers check permissions first.
 */
export async function removeFromWorkspace(ctx: AppContext, orgId: string, userId: string, actorId: string | null, reason: "left" | "removed" | "expired" | "banned") {
  const { db, authz } = ctx;
  const role = authz.orgRole(orgId, userId);
  if (!role) return;
  const affected: string[] = [];
  db.transaction(() => {
    db.prepare("DELETE FROM channel_overwrites WHERE org_id = ? AND subject = ?").run(orgId, `user:${userId}`);
    db.prepare("DELETE FROM meeting_participants WHERE user_id = ? AND meeting_id IN (SELECT id FROM meetings WHERE org_id = ?)").run(userId, orgId);
    db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").run(orgId, userId);
    affected.push(...authz.revalidateChannelMemberships(orgId, userId));
  })();
  // Their arrangement of this community (starred, sections) goes with them.
  await ctx.prefs.deleteForMember(userId, orgId);
  const action = { left: "member.leave", removed: "member.remove", expired: "member.expire", banned: "member.ban" }[reason];
  ctx.audit({ actorId, orgId, action, target: userId });
  notifyOrg(ctx, orgId);
  for (const c of affected) notifyConversation(ctx, c, [userId]);
  ctx.hub.sendToUser(userId, { t: "org.updated", orgId });
  await evictRemovedMember(ctx, userId, affected);
}

/** Members who should be told that something in this org changed. */
function orgMemberIds(ctx: AppContext, orgId: string): string[] {
  return (ctx.db.prepare("SELECT user_id FROM org_members WHERE org_id = ?").all(orgId) as { user_id: string }[]).map((r) => r.user_id);
}

export function notifyOrg(ctx: AppContext, orgId: string) {
  ctx.hub.sendToUsers(orgMemberIds(ctx, orgId), { t: "org.updated", orgId });
}

export function notifyConversation(ctx: AppContext, convId: string, extraUserIds: string[] = []) {
  const ids = (ctx.db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(convId) as { user_id: string }[]).map(
    (r) => r.user_id,
  );
  ctx.hub.sendToUsers(new Set([...ids, ...extraUserIds]), { t: "conv.updated", conversationId: convId });
}

export default async function orgRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const { authz, db } = ctx;

  const ownerCount = (orgId: string): number =>
    (db.prepare("SELECT COUNT(*) n FROM org_members WHERE org_id = ? AND role = 'OWNER'").get(orgId) as { n: number }).n;

  // ───────────── Organisations ─────────────
  app.post("/v1/orgs", auth, async (req) => {
    const { userId } = me(req);
    const body = parse(OrgCreateBody, req.body);
    // Idempotent: the app sends one request id per create form, so a retry or a double tap returns the first result.
    if (body.requestId) {
      const prior = db.prepare("SELECT * FROM orgs WHERE created_by = ? AND create_request_id = ?").get(userId, body.requestId);
      if (prior) return { org: orgSummary(ctx, prior, userId) };
    }
    // One person owning two workspaces with the same name can't tell them apart: refuse, and point at the existing one.
    const sameName = db
      .prepare(
        `SELECT o.id FROM orgs o JOIN org_members m ON m.org_id = o.id AND m.user_id = ? AND m.role = 'OWNER'
          WHERE lower(trim(o.name)) = lower(trim(?)) LIMIT 1`,
      )
      .get(userId, body.name) as { id: string } | undefined;
    if (sameName) throw new ApiError(409, "org_name_taken", `You already own a community called "${body.name.trim()}". Open it, or choose another name.`, { orgId: sameName.id });
    const id = newId("o");
    const t = now();
    let slug = slugify(body.name);
    if (db.prepare("SELECT 1 FROM orgs WHERE slug = ?").get(slug)) slug = `${slug}-${humanCode(4).toLowerCase()}`;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO orgs (id, name, slug, description, created_by, created_at, updated_at, create_request_id, kind, visibility, join_policy, rules)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'community', ?, ?, ?)`,
      ).run(id, body.name, slug, body.description ?? null, userId, t, t, body.requestId ?? null, body.visibility ?? "private", body.joinPolicy ?? "invite", body.rules ?? null);
      db.prepare("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'OWNER', ?)").run(id, userId, t);
      // A community a synthetic load-test account creates is a load-test community: the only kind such accounts join.
      markSyntheticOrg(db, id, userId);
    })();
    ctx.audit({ actorId: userId, orgId: id, action: "org.create", target: id, detail: `visibility=${body.visibility ?? "private"}` });
    // A community starts with its welcome, announcements, general, introductions and lounge channels in two
    // categories, so the first member who joins finds somewhere to go.
    createCommunityStart(ctx, id, userId, body.template);
    return { org: orgSummary(ctx, db.prepare("SELECT * FROM orgs WHERE id = ?").get(id), userId) };
  });

  // The starter templates a new community can begin with (batch B2): categories and channel names, for the create form.
  app.get("/v1/community-templates", auth, async () => ({ templates: templateList() }));

  app.get("/v1/orgs", auth, async (req) => {
    const { userId } = me(req);
    const rows = db
      .prepare("SELECT o.* FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.name")
      .all(userId);
    return { orgs: rows.map((o) => orgSummary(ctx, o, userId)) };
  });

  /** Full navigable structure visible to the caller: branches → departments → teams, plus permissions. */
  app.get("/v1/orgs/:orgId", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    const role = authz.requireOrgMember(orgId, userId);
    const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId);
    const perms = authz.permissions(orgId, userId);
    const channelCount = (
      db.prepare("SELECT COUNT(*) n FROM conversations WHERE org_id = ? AND type = 'CHANNEL' AND archived_at IS NULL").get(orgId) as { n: number }
    ).n;
    const categories = categoryViews(ctx, orgId, userId);
    return {
      org: orgSummary(ctx, org, userId),
      // Branches, departments and teams became roles and categories (docs/COMMUNITY_REBUILD_2026-10-21.md). Empty lists
      // stay because Android 0.3.0 and older require these fields.
      branches: [],
      departments: [],
      teams: [],
      categories,
      stats: { members: orgSummary(ctx, org, userId).memberCount, teams: 0, channels: channelCount, branches: 0, categories: categories.length },
      permissions: {
        canManageOrg: perms.has("workspace.edit"),
        canInvite: perms.has("members.invite"),
        canCreateChannels: perms.has("channels.create") || categories.some((c) => c.canCreateChannels),
        canManageChannels: perms.has("channels.manage"),
        canBan: perms.has("members.ban"),
        canViewDirectory: perms.has("members.view"),
        isOwner: role === "OWNER",
        // Everyone may leave except the last owner, who must make someone else an owner first.
        canLeave: role !== "OWNER" || ownerCount(orgId) > 1,
        // Archived branches and teams are gone with them; false for apps that still ask.
        canRestore: false,
        // Custom roles (2026-10-19, docs/WORKSPACE_ROLES.md). Additive: older apps ignore them.
        canViewRoles: perms.has("roles.view"),
        canManageRoles: perms.has("roles.manage"),
        canAssignRoles: perms.has("roles.assign"),
        canViewAudit: perms.has("audit.view"),
        canViewUsage: perms.has("workspace.usage.view"),
        // Apps, workflows, groups, developer keys and policies were removed; false for apps that still ask.
        canViewApps: false,
        canManageWorkflows: false,
        canManageGroups: false,
        canManageDevelopers: false,
        canManageApps: false,
        canManagePolicies: false,
        canTransferOwnership: perms.has("workspace.transfer"),
        effective: [...perms].sort(),
      },
      // The custom roles the caller holds here (name and colour, for their own profile).
      myRoles: authz.assignedRoles(orgId, userId).map((r) => ({ id: r.id, name: r.name, color: r.color })),
    };
  });

  app.patch("/v1/orgs/:orgId", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, userId, "workspace.edit", "Only people who can edit the workspace can do that");
    const body = parse(OrgUpdateBody, req.body);
    const o = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId) as any;
    // Listing a community publicly or opening it to anyone changes who can find and enter it: owners decide that.
    const opening = (body.visibility && body.visibility !== o.visibility) || (body.joinPolicy && body.joinPolicy !== o.join_policy);
    if (opening && authz.orgRole(orgId, userId) !== "OWNER") throw forbidden("Only owners can change who can find and join this community");
    db.prepare("UPDATE orgs SET name = ?, description = ?, visibility = ?, join_policy = ?, rules = ?, accent = ?, tag = ?, updated_at = ? WHERE id = ?").run(
      body.name ?? o.name,
      body.description === undefined ? o.description : body.description,
      body.visibility ?? o.visibility,
      body.joinPolicy ?? o.join_policy,
      body.rules === undefined ? o.rules : body.rules,
      body.accent === undefined ? o.accent : (body.accent?.toLowerCase() ?? null),
      body.tag === undefined ? (o.tag ?? null) : (body.tag?.toUpperCase() ?? null),
      now(),
      orgId,
    );
    const recolored = body.accent !== undefined && (body.accent?.toLowerCase() ?? null) !== (o.accent ?? null);
    ctx.audit({ actorId: userId, orgId, action: "org.update", detail: opening ? `visibility=${body.visibility ?? o.visibility} join=${body.joinPolicy ?? o.join_policy}` : undefined });
    if (recolored) ctx.audit({ actorId: userId, orgId, action: "org.accent", detail: body.accent?.toLowerCase() ?? "removed" });
    if (body.tag !== undefined && (body.tag?.toUpperCase() ?? null) !== (o.tag ?? null)) ctx.audit({ actorId: userId, orgId, action: "org.tag", detail: body.tag?.toUpperCase() ?? "removed" });
    notifyOrg(ctx, orgId);
    return { org: orgSummary(ctx, db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId), userId) };
  });

  // ───────────── Organization avatar (2026-10-19, docs/WORKSPACE_ADMINISTRATION.md) ─────────────
  // A JPEG like people's photos, stored per revision. Owners and admins set it; every member can see it. It isn't
  // end-to-end encrypted: like the organisation's name, the server can see it.
  app.put("/v1/orgs/:orgId/photo", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, userId, "workspace.edit", "Only people who can edit the workspace can change its photo");
    const buf = await readJpegBody(req, "Workspace photos");
    const previous = (db.prepare("SELECT photo_rev FROM orgs WHERE id = ?").get(orgId) as { photo_rev: number | null } | undefined)?.photo_rev ?? null;
    const rev = Math.max(now(), (previous ?? 0) + 1);
    await storePhoto(ctx, photoBlobId(orgId, rev), buf);
    // The organisation may have been deleted while the photo uploaded: then the new blob is removed again.
    if (db.prepare("UPDATE orgs SET photo_rev = ?, updated_at = ? WHERE id = ?").run(rev, now(), orgId).changes === 0) {
      await deleteBlobNow(ctx, "profile-photos", photoBlobId(orgId, rev));
      throw notFound("Organization not found");
    }
    if (previous) await deleteBlobNow(ctx, "profile-photos", photoBlobId(orgId, previous));
    ctx.audit({ actorId: userId, orgId, action: "org.photo" });
    notifyOrg(ctx, orgId);
    return { photoRev: rev };
  });

  app.delete("/v1/orgs/:orgId/photo", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, userId, "workspace.edit", "Only people who can edit the workspace can change its photo");
    const previous = (db.prepare("SELECT photo_rev FROM orgs WHERE id = ?").get(orgId) as { photo_rev: number | null }).photo_rev;
    db.prepare("UPDATE orgs SET photo_rev = NULL, updated_at = ? WHERE id = ?").run(now(), orgId);
    if (previous) {
      await deleteBlobNow(ctx, "profile-photos", photoBlobId(orgId, previous));
      ctx.audit({ actorId: userId, orgId, action: "org.photo", detail: "removed" });
      notifyOrg(ctx, orgId);
    }
    return { photoRev: null };
  });

  app.get("/v1/orgs/:orgId/photo", auth, async (req, reply) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    authz.requireOrgMember(orgId, userId);
    const rev = (db.prepare("SELECT photo_rev FROM orgs WHERE id = ?").get(orgId) as { photo_rev: number | null }).photo_rev;
    const stream = rev ? await ctx.blobs.get("profile-photos", photoBlobId(orgId, rev)) : null;
    if (!stream) throw notFound("No photo");
    return reply.header("content-type", "image/jpeg").header("cache-control", "private, max-age=3600").header("etag", `"${rev}"`).send(stream);
  });

  // ───────────── Community banner (API 0.44.0, docs/COMMUNITY_BRANDING.md) ─────────────
  // A wide JPEG stored per revision beside the photo. Whoever can edit the community sets it; members see it, and so
  // does anyone signed in when the community is listed publicly (Discover shows it). Like the name, it isn't encrypted.
  app.put("/v1/orgs/:orgId/banner", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, userId, "workspace.edit", "Only people who can edit the community can change its banner");
    const buf = await readJpegBody(req, "Banners", MAX_BANNER_BYTES);
    const previous = (db.prepare("SELECT banner_rev FROM orgs WHERE id = ?").get(orgId) as { banner_rev: number | null } | undefined)?.banner_rev ?? null;
    const rev = Math.max(now(), (previous ?? 0) + 1);
    await storePhoto(ctx, bannerBlobId(orgId, rev), buf);
    // The community may have been deleted while the banner uploaded: then the new blob is removed again.
    if (db.prepare("UPDATE orgs SET banner_rev = ?, updated_at = ? WHERE id = ?").run(rev, now(), orgId).changes === 0) {
      await deleteBlobNow(ctx, "profile-photos", bannerBlobId(orgId, rev));
      throw notFound("Organization not found");
    }
    if (previous) await deleteBlobNow(ctx, "profile-photos", bannerBlobId(orgId, previous));
    ctx.audit({ actorId: userId, orgId, action: "org.banner" });
    notifyOrg(ctx, orgId);
    return { bannerRev: rev };
  });

  app.delete("/v1/orgs/:orgId/banner", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    authz.requirePermission(orgId, userId, "workspace.edit", "Only people who can edit the community can change its banner");
    const previous = (db.prepare("SELECT banner_rev FROM orgs WHERE id = ?").get(orgId) as { banner_rev: number | null }).banner_rev;
    db.prepare("UPDATE orgs SET banner_rev = NULL, updated_at = ? WHERE id = ?").run(now(), orgId);
    if (previous) {
      await deleteBlobNow(ctx, "profile-photos", bannerBlobId(orgId, previous));
      ctx.audit({ actorId: userId, orgId, action: "org.banner", detail: "removed" });
      notifyOrg(ctx, orgId);
    }
    return { bannerRev: null };
  });

  const sendBanner = async (reply: FastifyReply, orgId: string, rev: number | null, cache: string) => {
    const stream = rev ? await ctx.blobs.get("profile-photos", bannerBlobId(orgId, rev)) : null;
    if (!stream) throw notFound("No banner");
    return reply.header("content-type", "image/jpeg").header("cache-control", cache).header("etag", `"${rev}"`).send(stream);
  };

  app.get("/v1/orgs/:orgId/banner", auth, async (req, reply) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    const o = db.prepare("SELECT visibility, banner_rev FROM orgs WHERE id = ?").get(orgId) as { visibility: string; banner_rev: number | null } | undefined;
    // Members, or anyone signed in for a community listed in Discover (which shows it); otherwise it doesn't exist.
    if (!o || (o.visibility !== "public" && !authz.orgRole(orgId, userId)) || authz.isBanned(orgId, userId)) throw notFound("No banner");
    return sendBanner(reply, orgId, o.banner_rev, "private, max-age=3600");
  });

  // ───────────── Deleting an organization (2026-10-17, docs/WORKSPACES.md › Deleting a workspace) ─────────────
  // Owners only, after typing the organization's exact name. One immediate transaction removes the organization with
  // its branches, departments, teams, invitations, memberships and channels (and the channels' calls, queued messages
  // and files); people's accounts, direct messages, groups and other organizations are untouched. A retried request
  // with the same requestId gets the same answer; anything else afterwards gets 404.
  app.delete("/v1/orgs/:orgId", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(OrgDeleteBody, req.body ?? {});
    const previous = () =>
      db.prepare("SELECT * FROM org_deletions WHERE org_id = ?").get(orgId) as
        | { deleted_by: string; request_id: string | null; members: number; channels: number; files: number }
        | undefined;
    const replay = () => {
      const d = previous();
      if (d && body.requestId && d.request_id === body.requestId && d.deleted_by === actor) {
        return { deleted: true, orgId, members: d.members, channels: d.channels, files: d.files };
      }
      throw notFound("Organization not found");
    };
    if (previous()) return replay();
    const role = authz.requireOrgMember(orgId, actor);
    if (role !== "OWNER") throw forbidden("Only an owner can delete the organization");
    const org = db.prepare("SELECT name FROM orgs WHERE id = ?").get(orgId) as { name: string };
    if (body.confirmName.trim() !== org.name.trim()) throw new ApiError(400, "confirm_mismatch", "Type the organization's name exactly as it appears to delete it");
    // The files store may not be SQLite: what the channels hold is read before the transaction (and their records go
    // inside it, through ctx.files.forgetConversation).
    const files = await ctx.files.attachmentIdsIn(authz.conversationIdsOf(orgId));

    const result = db
      .transaction(() => {
        // Checked again inside the write lock: a concurrent delete may have just finished.
        if (!db.prepare("SELECT 1 FROM orgs WHERE id = ?").get(orgId)) return null;
        if (authz.orgRole(orgId, actor) !== "OWNER") return null;
        const members = (db.prepare("SELECT user_id FROM org_members WHERE org_id = ?").all(orgId) as { user_id: string }[]).map((r) => r.user_id);
        const channels = (db.prepare("SELECT id FROM conversations WHERE org_id = ?").all(orgId) as { id: string }[]).map((r) => r.id);
        const channelMembers = new Map<string, string[]>();
        const rooms: string[] = [];
        for (const c of channels) {
          channelMembers.set(c, (db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(c) as { user_id: string }[]).map((r) => r.user_id));
          rooms.push(...(db.prepare("SELECT room_name FROM calls WHERE conversation_id = ? AND state != 'ENDED'").all(c) as { room_name: string }[]).map((r) => r.room_name));
          // Rows without a foreign key to the conversation; its files' bytes are scheduled for deletion and its open
          // uploads abandoned (their objects or parts are removed by the retention job).
          ctx.relay.forgetConversation(c);
          ctx.files.forgetConversation(c);
          db.prepare("DELETE FROM mention_all_events WHERE conversation_id = ?").run(c);
        }
        const photoRev = (db.prepare("SELECT photo_rev FROM orgs WHERE id = ?").get(orgId) as { photo_rev: number | null }).photo_rev;
        if (photoRev) queueBlobDelete(ctx, "profile-photos", photoBlobId(orgId, photoRev));
        const bannerRev = (db.prepare("SELECT banner_rev FROM orgs WHERE id = ?").get(orgId) as { banner_rev: number | null }).banner_rev;
        if (bannerRev) queueBlobDelete(ctx, "profile-photos", bannerBlobId(orgId, bannerRev));
        // Batch B9: the community's own emoji and stickers.
        for (const e of db.prepare("SELECT id FROM community_expressions WHERE org_id = ?").all(orgId) as { id: string }[]) queueBlobDelete(ctx, "profile-photos", e.id);
        // Cascades to org_members, roles, categories, overwrites, bans, invitations, the old branch and team rows, and
        // the community's conversations (members, attachment rows, calls and call participants).
        db.prepare("DELETE FROM orgs WHERE id = ?").run(orgId);
        db.prepare(
          "INSERT INTO org_deletions (org_id, name_sha256, deleted_by, deleted_at, request_id, members, channels, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(orgId, sha256Hex(org.name), actor, now(), body.requestId ?? null, members.length, channels.length, files.length);
        return { members, channelMembers, files, rooms };
      })
      .immediate();
    if (!result) return replay();
    await ctx.prefs.deleteForWorkspace(orgId);
    await ctx.reports.deleteForOrg(orgId);

    ctx.audit({
      actorId: actor,
      orgId,
      action: "org.delete",
      target: orgId,
      detail: JSON.stringify({ members: result.members.length, channels: result.channelMembers.size, files: result.files.length }),
    });
    // Every device updates: apps from before this change refresh the organization list and each channel (now 404, so
    // they show it as left); newer apps also get org.deleted.
    for (const [c, ids] of result.channelMembers) ctx.hub.sendToUsers(new Set(ids), { t: "conv.updated", conversationId: c });
    ctx.hub.sendToUsers(new Set(result.members), { t: "org.updated", orgId });
    ctx.hub.sendToUsers(new Set(result.members), { t: "org.deleted", orgId });
    for (const room of result.rooms) await ctx.livekit?.deleteRoom(room).catch(() => {});
    await processBlobDeletes(ctx).catch(() => 0);
    return { deleted: true, orgId, members: result.members.length, channels: result.channelMembers.size, files: result.files.length };
  });

  /** Archived branches and teams went with them (docs/COMMUNITY_REBUILD_2026-10-21.md); empty for apps that still ask. */
  app.get("/v1/orgs/:orgId/archived", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    authz.requireOrgMember(orgId, me(req).userId);
    return { branches: [], teams: [] };
  });

  // ───────────── Membership & roles ─────────────
  app.get("/v1/orgs/:orgId/members", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    const role = authz.requireOrgMember(orgId, userId);
    if (role === "GUEST") throw forbidden("Guests cannot browse the member list");
    if (!authz.can(orgId, userId, "members.view")) throw forbidden("Your role doesn't include the member directory");
    const { q } = parse(MemberSearchQuery, req.query);
    const like = q ? `%${q.toLowerCase().replace(/[%_\\]/g, (c) => "\\" + c)}%` : "%";
    const rows = db
      .prepare(
        `SELECT u.*, m.role AS org_role, m.title, m.expires_at, m.timeout_until FROM org_members m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = ? AND (lower(u.display_name) LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
         ORDER BY CASE m.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 WHEN 'MEMBER' THEN 2 ELSE 3 END, u.display_name LIMIT 500`,
      )
      .all(orgId, like, like) as any[];
    // Custom roles (docs/WORKSPACE_ROLES.md): names and colours only; what each grants is on GET /v1/orgs/:id/roles.
    const roleRows = db
      .prepare(
        `SELECT m.user_id, r.id, r.name, r.color, r.hoist, r.position FROM org_role_members m JOIN org_roles r ON r.id = m.role_id
         WHERE m.org_id = ? AND r.archived_at IS NULL ORDER BY r.position, r.name`,
      )
      .all(orgId) as { user_id: string; id: string; name: string; color: string | null; hoist: number; position: number }[];
    return {
      members: rows.map((u) =>
        memberView(ctx, userId, u, {
          ...userSummary(u),
          orgRole: u.org_role,
          title: u.title,
          // Round 7: a guest's membership end date (docs/WORKSPACE_C5.md), null without one.
          expiresAt: u.expires_at ?? null,
          // A timeout still running (docs/product/MELDIQ_FEATURE_GAP_MATRIX.md MOD-06), null without one.
          timeoutUntil: u.timeout_until && u.timeout_until > now() ? u.timeout_until : null,
          // Empty since branches and teams became roles; kept for apps that read them.
          branches: [],
          teams: [],
          // Batch B12: [hoist] roles head their own group in the member list, in role order ([position]).
          customRoles: roleRows
            .filter((r) => r.user_id === u.id)
            .map((r) => ({ id: r.id, name: r.name, color: r.color, ...(r.hoist === 1 ? { hoist: true, position: r.position } : {}) })),
        }),
      ),
    };
  });

  app.patch("/v1/orgs/:orgId/members/:userId", auth, async (req) => {
    const actor = me(req).userId;
    const p = parse(OrgMemberParams, req.params);
    const body = parse(MemberUpdateBody, req.body);
    authz.requireOrgMember(p.orgId, actor);
    const actorNow = authz.actor(p.orgId, actor)!;
    const targetRole = authz.orgRole(p.orgId, p.userId);
    if (!targetRole) throw notFound("Member not found");
    const self = actor === p.userId;
    const targetPerms = authz.permissions(p.orgId, p.userId);
    // Rules in roles.ts (docs/WORKSPACE_ADMINISTRATION.md, WORKSPACE_ROLES.md): owners manage everything but keep one
    // owner; admins (and `members.roles`) switch members and guests, admins may step down; nobody else changes roles.
    if (body.role && body.role !== targetRole) {
      // The actor must reach the person both as they are and as they'd be (a guest's held roles count again once promoted).
      const reach = new Set([...targetPerms, ...authz.permissionsAs(p.orgId, p.userId, body.role)]);
      const refusal = orgRoleChangeRefusal(actorNow, targetRole, body.role, self, ownerCount(p.orgId), reach);
      if (refusal) throw refusal.status === 409 ? conflict(refusal.message) : forbidden(refusal.message);
    }
    if (body.title !== undefined && !titleChangeAllowed(actorNow, targetRole, self, targetPerms)) {
      throw forbidden("You can't change this person's title");
    }
    const removedFrom: string[] = [];
    db.transaction(() => {
      if (body.role) db.prepare("UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?").run(body.role, p.orgId, p.userId);
      if (body.title !== undefined) db.prepare("UPDATE org_members SET title = ? WHERE org_id = ? AND user_id = ?").run(body.title, p.orgId, p.userId);
      if (body.role) {
        // Guests only keep what a manager grants them explicitly after the demotion.
        if (body.role === "GUEST" && targetRole !== "GUEST") removedFrom.push(...authz.demoteToGuest(p.orgId, p.userId));
        else removedFrom.push(...authz.revalidateChannelMemberships(p.orgId, p.userId));
        authz.autoJoinScope(p.orgId, p.userId, now());
      }
    })();
    if (body.role) ctx.audit({ actorId: actor, orgId: p.orgId, action: "member.role", target: p.userId, detail: `${targetRole}→${body.role}` });
    notifyOrg(ctx, p.orgId);
    // The person's devices drop the channels; members refresh them. Envelopes still addressed to
    // the person's devices are refused by the recipient-set check (409 device_mismatch).
    for (const c of removedFrom) notifyConversation(ctx, c, [p.userId]);
    await evictRemovedMember(ctx, p.userId, removedFrom);
    return { ok: true };
  });

  app.delete("/v1/orgs/:orgId/members/:userId", auth, async (req) => {
    const actor = me(req).userId;
    const p = parse(OrgMemberParams, req.params);
    const actorRole = authz.requireOrgMember(p.orgId, actor);
    const targetRole = authz.orgRole(p.orgId, p.userId);
    if (!targetRole) throw notFound("Member not found");
    const self = actor === p.userId;
    if (!self && !removalAllowed(authz.actor(p.orgId, actor)!, targetRole, authz.permissions(p.orgId, p.userId))) {
      throw forbidden(
        actorRole === "ADMIN"
          ? "Admins cannot remove owners or admins"
          : authz.can(p.orgId, actor, "members.remove")
            ? "You can't remove someone who holds powers you don't have"
            : "Only owners and admins can remove people",
      );
    }
    if (targetRole === "OWNER" && ownerCount(p.orgId) <= 1) throw conflict("Transfer ownership before the last owner leaves");
    await removeFromWorkspace(ctx, p.orgId, p.userId, actor, self ? "left" : "removed");
    return { ok: true };
  });

  // ───────────── Invitations ─────────────
  app.post("/v1/orgs/:orgId/invites", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(InviteCreateBody, req.body);
    const actorRole = authz.requireOrgMember(orgId, actor);
    const policy = db.prepare("SELECT guests_allowed, guest_max_days FROM orgs WHERE id = ?").get(orgId) as { guests_allowed: number; guest_max_days: number | null } | undefined;
    if (body.role === "GUEST" && policy && !policy.guests_allowed) throw conflict("This community doesn't allow guests");
    if (body.role !== "GUEST" && body.guestDays) throw badRequest("Only guest invitations have an end date");
    const guestDays = body.role === "GUEST" ? (policy?.guest_max_days ? Math.min(body.guestDays ?? policy.guest_max_days, policy.guest_max_days) : (body.guestDays ?? null)) : null;
    if (body.branchId || body.teamId) throw badRequest("Branches and teams are now roles: invite with a role instead");
    if (body.role === "ADMIN" && actorRole !== "OWNER") throw forbidden("Only owners can invite admins");
    if (!authz.canIssueInvite(orgId, actor, body.role)) throw forbidden("Your role doesn't include inviting people");
    const grantRoleId = body.roleId ?? null;
    if (grantRoleId) {
      if (body.role === "GUEST") throw badRequest("Guest invitations can't give a role");
      const r = db.prepare("SELECT permissions, denies FROM org_roles WHERE id = ? AND org_id = ? AND archived_at IS NULL").get(grantRoleId, orgId) as
        | { permissions: string; denies: string }
        | undefined;
      if (!r) throw badRequest("Unknown role");
      // The same rule as assigning it to someone by hand.
      const refusal = roleAssignmentRefusal(authz.actor(orgId, actor)!, { base: "MEMBER", perms: new Set(), self: false }, {
        permissions: parsePermissionList(r.permissions),
        denies: parsePermissionList(r.denies),
      });
      if (refusal) throw new ApiError(refusal.status, refusal.code, refusal.message);
    }
    const code = humanCode(12);
    const id = newId("inv");
    const t = now();
    const expiresAt = t + body.expiresInHours * 3600_000;
    db.prepare(
      `INSERT INTO invitations (id, org_id, code_hash, code_hint, role, branch_id, team_id, max_uses, created_by, created_at, expires_at, guest_days, grant_role_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, sha256Hex(code), code.slice(-4), body.role, body.maxUses, actor, t, expiresAt, guestDays, grantRoleId);
    ctx.audit({ actorId: actor, orgId, action: "invite.create", target: id, detail: body.role });
    return {
      invite: { id, code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`, role: body.role, branchId: null, teamId: null, roleId: grantRoleId, maxUses: body.maxUses, uses: 0, expiresAt, guestDays },
    };
  });

  app.get("/v1/orgs/:orgId/invites", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    authz.requireOrgMember(orgId, actor);
    const isAdmin = authz.can(orgId, actor, "members.invites.manage");
    const rows = db
      .prepare("SELECT i.*, u.display_name AS creator_name FROM invitations i LEFT JOIN users u ON u.id = i.created_by WHERE i.org_id = ? ORDER BY i.created_at DESC LIMIT 100")
      .all(orgId) as any[];
    const t = now();
    return {
      invites: rows
        .filter((r) => isAdmin || r.created_by === actor)
        .map((r) => ({
          id: r.id,
          hint: r.code_hint,
          role: r.role,
          branchId: null,
          teamId: null,
          roleId: r.grant_role_id ?? null,
          maxUses: r.max_uses,
          uses: r.uses,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          revokedAt: r.revoked_at,
          active: inviteStatus(r, t) === "active",
          // One state, in this order: revoked beats expired beats used up (docs/WORKSPACE_ADMINISTRATION.md).
          status: inviteStatus(r, t),
          createdBy: r.created_by,
          createdByName: r.creator_name ?? null,
        })),
    };
  });

  app.delete("/v1/invites/:id", auth, async (req) => {
    const actor = me(req).userId;
    const { id } = parse(InviteIdParams, req.params);
    const inv = db.prepare("SELECT * FROM invitations WHERE id = ?").get(id) as any;
    if (!inv) throw notFound("Invite not found");
    authz.requireOrgMember(inv.org_id, actor);
    if (inv.created_by !== actor && !authz.can(inv.org_id, actor, "members.invites.manage")) throw forbidden();
    db.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id);
    ctx.audit({ actorId: actor, orgId: inv.org_id, action: "invite.revoke", target: id });
    return { ok: true };
  });

  /** The usable invitation for [code]; otherwise 404 with a code saying why (not found, revoked, expired, used up, unavailable). */
  const findInvite = (code: string) => {
    const inv = lookupOrgInvite(db, code);
    const problem = orgInviteProblem(authz, inv);
    if (problem) throw new ApiError(404, problem, INVITE_PROBLEMS[problem]);
    return inv!;
  };

  const inviteRate = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.post("/v1/invites/preview", inviteRate, async (req) => {
    const { code } = parse(InviteCodeBody, req.body);
    const inv = findInvite(code);
    const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(inv.org_id) as any;
    return {
      // Same org shape as everywhere else (the app decodes it with the same model; without the slug it refused the response).
      org: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        description: org.description,
        rules: org.rules ?? null,
        memberCount: (db.prepare("SELECT COUNT(*) n FROM org_members WHERE org_id = ?").get(org.id) as { n: number }).n,
        accent: org.accent ?? null,
        bannerRev: org.banner_rev ?? null,
      },
      role: inv.role,
      branch: null,
      team: null,
      grantRole: inv.grant_role_id ? ((db.prepare("SELECT id, name, color FROM org_roles WHERE id = ? AND archived_at IS NULL").get(inv.grant_role_id) as { id: string; name: string; color: string | null } | undefined) ?? null) : null,
      alreadyMember: !!authz.orgRole(inv.org_id, me(req).userId),
      banned: authz.isBanned(inv.org_id, me(req).userId),
      invitesPaused: !!authz.pausedUntil(inv.org_id, "invites", now()),
    };
  });

  /**
   * Batch B4b: what the meldiq.app/invite page shows before anyone signs in. Only the community's name, description and
   * size, never its channels or members; the same problem codes as the signed-in preview. Rate limited per address.
   */
  app.get("/v1/invites/:code/public", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { code } = parse(InviteCodeParams, req.params);
    const inv = findInvite(code);
    const org = db.prepare("SELECT id, name, description, accent, banner_rev, photo_rev FROM orgs WHERE id = ?").get(inv.org_id) as {
      id: string;
      name: string;
      description: string | null;
      accent: string | null;
      banner_rev: number | null;
      photo_rev: number | null;
    };
    return {
      community: {
        name: org.name,
        description: org.description,
        memberCount: (db.prepare("SELECT COUNT(*) n FROM org_members WHERE org_id = ?").get(org.id) as { n: number }).n,
        accent: org.accent ?? null,
        banner: org.banner_rev !== null,
        photo: org.photo_rev !== null,
      },
      invitesPaused: !!authz.pausedUntil(inv.org_id, "invites", now()),
    };
  });

  /** The invitation's community banner (API 0.44.0), for the invite page and the app's preview: a usable code only. */
  app.get("/v1/invites/:code/banner", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { code } = parse(InviteCodeParams, req.params);
    const inv = findInvite(code);
    const rev = (db.prepare("SELECT banner_rev FROM orgs WHERE id = ?").get(inv.org_id) as { banner_rev: number | null } | undefined)?.banner_rev ?? null;
    return sendBanner(reply, inv.org_id, rev, "public, max-age=300");
  });

  /** The invitation's community icon (API 0.46.0), for the invite page: a usable code only, like the banner. */
  app.get("/v1/invites/:code/photo", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { code } = parse(InviteCodeParams, req.params);
    const inv = findInvite(code);
    const rev = (db.prepare("SELECT photo_rev FROM orgs WHERE id = ?").get(inv.org_id) as { photo_rev: number | null } | undefined)?.photo_rev ?? null;
    const stream = rev ? await ctx.blobs.get("profile-photos", photoBlobId(inv.org_id, rev)) : null;
    if (!stream) throw notFound("No photo");
    return reply.header("content-type", "image/jpeg").header("cache-control", "public, max-age=300").header("etag", `"${rev}"`).send(stream);
  });

  app.post("/v1/invites/accept", inviteRate, async (req) => {
    const userId = me(req).userId;
    const { code } = parse(InviteCodeBody, req.body);
    const t = now();
    // One transaction: two taps (or two people racing for the last use) can't both pass the checks and over-use it.
    const result = db.transaction(() => {
      const known = lookupOrgInvite(db, code);
      // Already joined through this invite (a retry or a double tap): succeed again without using it up, even if
      // that first accept took its last use. Grants nothing the person doesn't already have.
      if (known && inviteAlreadySatisfied(authz, db, known, userId)) return { orgId: known.org_id, inviteId: known.id, role: authz.orgRole(known.org_id, userId)!, repeated: true };
      return { ...joinOrgByInvite(ctx, findInvite(code), userId, t), repeated: false };
    })();
    if (!result.repeated) {
      ctx.audit({ actorId: userId, orgId: result.orgId, action: "invite.accept", target: result.inviteId, detail: result.role });
      notifyOrg(ctx, result.orgId);
      noteJoin(ctx, result.orgId, t);
    }
    return { org: orgSummary(ctx, db.prepare("SELECT * FROM orgs WHERE id = ?").get(result.orgId), userId), alreadyMember: result.repeated };
  });

  // ───────────── Channels ─────────────
  app.post("/v1/orgs/:orgId/channels", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(ChannelCreateBody, req.body);
    authz.requireOrgMember(orgId, actor);
    if (body.scope !== "ORG") throw badRequest("Branches and teams are now roles and categories: create the channel in a category");
    if (body.voice && body.kind === "ANNOUNCEMENT") throw badRequest("A voice channel can be public or private, not an announcement channel");
    if (body.voice && body.format === "forum") throw badRequest("A voice channel can't be a forum");
    const categoryId = body.categoryId ?? null;
    if (categoryId) {
      if (!db.prepare("SELECT 1 FROM channel_categories WHERE id = ? AND org_id = ?").get(categoryId, orgId)) throw badRequest("Unknown category");
      if (!authz.can(orgId, actor, "channels.create") && !authz.categoryPermissions(orgId, categoryId, actor).has("channels.create")) {
        throw forbidden("You can't create channels in this category");
      }
      const inCategory = (db.prepare("SELECT COUNT(*) n FROM conversations WHERE category_id = ?").get(categoryId) as { n: number }).n;
      if (inCategory >= CHANNEL_LIMITS.perCategory) throw conflict(`A category holds at most ${CHANNEL_LIMITS.perCategory} channels`);
    } else if (!authz.can(orgId, actor, "channels.create")) {
      throw forbidden("Your role doesn't include creating channels");
    }
    const total = (db.prepare("SELECT COUNT(*) n FROM conversations WHERE org_id = ? AND type = 'CHANNEL'").get(orgId) as { n: number }).n;
    if (total >= CHANNEL_LIMITS.perCommunity) throw conflict(`A community has at most ${CHANNEL_LIMITS.perCommunity} channels`);
    const id = newId("c");
    const t = now();
    // Public channels are joined by everyone who may see them unless the creator opts out (autoJoin: false).
    const autoJoin = body.kind === "ANNOUNCEMENT" ? true : body.kind === "PRIVATE" ? false : body.autoJoin ?? true;
    const position = ((db.prepare("SELECT MAX(position) p FROM conversations WHERE org_id = ? AND type = 'CHANNEL' AND category_id IS ?").get(orgId, categoryId) as { p: number | null }).p ?? -1) + 1;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations (id, type, org_id, scope, scope_id, kind, name, topic, auto_join, created_by, created_at, updated_at, voice, category_id, position, format)
         VALUES (?, 'CHANNEL', ?, 'ORG', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, orgId, body.kind, body.name, body.topic ?? null, autoJoin ? 1 : 0, actor, t, t, body.voice ? 1 : 0, categoryId, position, body.format);
      db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'ADMIN', ?)").run(id, actor, t);
      const conv = authz.conversation(id)!;
      const addIds = new Set(body.memberIds);
      if (autoJoin) {
        for (const r of db.prepare("SELECT user_id FROM org_members WHERE org_id = ?").all(orgId) as { user_id: string }[]) addIds.add(r.user_id);
      }
      for (const uid of addIds) {
        if (uid === actor) continue;
        const explicit = body.memberIds.includes(uid);
        const role = authz.orgRole(orgId, uid);
        // Explicitly listed people may be added to a private channel (and guests anywhere); everyone else must be able
        // to see the channel through its permissions.
        const eligible = authz.scopeEligible(conv, uid) || (explicit && (role === "GUEST" || (body.kind === "PRIVATE" && role !== null && authz.channelPermissions(conv, uid).has("channels.view"))));
        if (eligible) {
          db.prepare("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)").run(id, uid, t);
        } else if (explicit) {
          throw conflict("Cannot add someone who can't see this channel", { userId: uid });
        }
      }
    })();
    ctx.audit({ actorId: actor, orgId, action: body.voice ? "voice_room.create" : "channel.create", target: id, detail: `${body.kind} ${body.name}` });
    notifyConversation(ctx, id);
    notifyOrg(ctx, orgId);
    return { channel: conversationView(ctx, authz.conversation(id)!, actor) };
  });

  /** Browse channels visible to the caller (joined + joinable public ones). */
  app.get("/v1/orgs/:orgId/channels", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    authz.requireOrgMember(orgId, actor);
    const { q, includeArchived } = parse(ChannelListQuery, req.query);
    const rows = db
      .prepare("SELECT * FROM conversations WHERE org_id = ? AND type = 'CHANNEL' ORDER BY name")
      .all(orgId) as ConversationRow[];
    return {
      channels: rows
        .filter((c) => (includeArchived === "true" || !c.archived_at) && authz.canViewChannel(c, actor))
        .filter((c) => !q || (c.name ?? "").toLowerCase().includes(q.toLowerCase()) || (c.topic ?? "").toLowerCase().includes(q.toLowerCase()))
        .map((c) => conversationView(ctx, c, actor)),
    };
  });

  // ───────────── Activity ─────────────
  // Non-admins see an event only if they could see its target in the org structure (GET /v1/orgs/:id)
  // or the conversation itself. The target is looked up live, so older audit rows without any scope
  // information are filtered the same way; a target that no longer exists is hidden.
  const activityVisibleTo = (r: { action: string; target: string | null }, viewer: string, orgId: string): boolean => {
    const target = r.target ?? "";
    switch (r.action) {
      case "category.create":
        // Only categories the viewer is shown (one with a channel they can see, or one they manage).
        return categoryViews(ctx, orgId, viewer).some((c) => c.id === target);
      case "channel.create":
      case "channel.access":
      case "voice_room.create": {
        const c = authz.conversation(target);
        return !!c && authz.canViewChannel(c, viewer);
      }
      case "call.start":
      case "voice_room.open":
        return authz.isMember(target, viewer);
      case "invite.accept":
      case "community.join":
      case "member.leave":
        return true; // joining and leaving are community-level, like the member list
      default:
        return false;
    }
  };
  app.get("/v1/orgs/:orgId/activity", auth, async (req) => {
    const actor = me(req).userId;
    const { orgId } = parse(OrgParams, req.params);
    const role = authz.requireOrgMember(orgId, actor);
    if (role === "GUEST") throw forbidden();
    const isAdmin = authz.can(orgId, actor, "audit.view");
    const rows = db.prepare("SELECT * FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT 500").all(orgId) as any[];
    const names = new Map<string, string>();
    const nameOf = (id: string | null) => {
      if (!id) return null;
      if (!names.has(id)) names.set(id, (db.prepare("SELECT display_name FROM users WHERE id = ?").get(id) as any)?.display_name ?? "Someone");
      return names.get(id)!;
    };
    return {
      activity: rows
        .filter((r) => isAdmin || activityVisibleTo(r, actor, orgId))
        .slice(0, 60)
        .map((r) => ({ id: r.id, at: r.at, action: r.action, actorId: r.actor_id, actorName: nameOf(r.actor_id), target: r.target, detail: r.detail })),
    };
  });
}
