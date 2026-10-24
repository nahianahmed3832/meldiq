import type { FastifyInstance } from "fastify";
import { requireSyntheticScopeForPeople } from "../accounts/index.js";
import { availableUser, blockedEitherWay, dmDecision, notAvailable, REQUEST_MESSAGE_LIMIT, requireRequestBudget } from "../accounts/relationships/rules.js";
import type { DmRequestRow } from "../accounts/relationships/store.js";
import { mentionAllPermission } from "./mentions.js";
import type { ConversationRow } from "../organizations/authz.js";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import {
  ConversationDeleteBody,
  ConversationListQuery,
  ConversationPatchBody,
  DmBody,
  FORUM_GUIDELINES_MAX,
  FORUM_TAG_LIMIT,
  GroupBody,
  MAX_GROUP,
  MemberParams,
  MemberPutBody,
  SLOWMODE_STEPS,
} from "../../shared/contracts/http/conversations.js";
import { idParams } from "../../shared/contracts/http/primitives.js";
import { appearsOnline, canSeeLastSeen, memberView, type ProfileRow } from "../accounts/profile.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { fedDmId } from "../federation/service.js";
import { userSummary } from "../auth/routes.js";
import { deleteBlobNow, processBlobDeletes, queueBlobDelete } from "../files/routes.js";
import { photoBlobId, readJpegBody, storePhoto } from "../accounts/photos.js";
import { evictRemovedMember } from "../calls/routes.js";
import { reconcileAccess } from "../organizations/communityRoutes.js";
import { notifyConversation } from "../organizations/orgsRoutes.js";
import { deviceDirectory } from "../accounts/usersRoutes.js";

export { FORUM_GUIDELINES_MAX, FORUM_TAG_LIMIT, SLOWMODE_STEPS };

export function conversationView(ctx: AppContext, c: ConversationRow, userId: string) {
  const { db, authz } = ctx;
  const memberCount = (db.prepare("SELECT COUNT(*) n FROM conversation_members WHERE conversation_id = ?").get(c.id) as { n: number }).n;
  const myRole = authz.conversationRole(c.id, userId);
  let members: object[] | undefined;
  if (c.type !== "CHANNEL" || memberCount <= 12) {
    members = (
      db
        .prepare("SELECT u.*, m.role AS conv_role FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY m.joined_at LIMIT 12")
        .all(c.id) as any[]
    ).map((u) => memberView(ctx, userId, u, { ...userSummary(u), role: u.conv_role }));
  }
  const call = db.prepare("SELECT id, video, state, created_at FROM calls WHERE conversation_id = ? AND state != 'ENDED' ORDER BY created_at DESC LIMIT 1").get(c.id) as
    | { id: string; video: number; state: string; created_at: number }
    | undefined;
  // Who is in a voice room right now (shown on the room before joining), at most 12 people.
  const inRoom =
    c.voice && call
      ? (db.prepare("SELECT DISTINCT user_id FROM call_participants WHERE call_id = ? AND left_at IS NULL LIMIT 12").all(call.id) as { user_id: string }[]).map((r) => r.user_id)
      : undefined;
  // Older apps group channels by scope: a channel in a category is shown to them as a team named after the category,
  // so they list categories too. Newer apps read categoryId and position (docs/COMMUNITY_REBUILD_2026-10-21.md §7).
  const category = c.category_id ? (db.prepare("SELECT id, name FROM channel_categories WHERE id = ?").get(c.category_id) as { id: string; name: string } | undefined) : undefined;
  const orgName = c.org_id ? ((db.prepare("SELECT name FROM orgs WHERE id = ?").get(c.org_id) as { name: string } | undefined)?.name ?? null) : null;
  const channel = c.type === "CHANNEL";
  return {
    id: c.id,
    type: c.type,
    orgId: c.org_id,
    scope: channel ? (category ? "TEAM" : "ORG") : null,
    scopeId: channel ? (category?.id ?? null) : null,
    scopeName: channel ? (category?.name ?? orgName) : null,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    position: c.position ?? 0,
    format: c.format ?? "text",
    forumTags: c.format === "forum" ? forumTags(c) : [],
    // Batch B8: a forum's post guidelines, or null.
    guidelines: c.format === "forum" ? ((c as { guidelines?: string | null }).guidelines ?? null) : null,
    kind: c.kind,
    name: c.name,
    topic: c.topic,
    archived: !!c.archived_at,
    // Batch B6b: a group's photo revision (GET /v1/conversations/:id/photo); null without one.
    photoRev: c.type === "GROUP" ? ((c as { photo_rev?: number | null }).photo_rev ?? null) : null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    memberCount,
    members,
    joined: myRole !== null,
    myRole,
    canPost: authz.canPost(c, userId),
    // While this person is timed out in the community: when it ends (the app says why it can't post).
    ...(c.org_id && authz.timeoutUntil(c.org_id, userId) ? { timedOutUntil: authz.timeoutUntil(c.org_id, userId) } : {}),
    canAttach: authz.canAttach(c, userId),
    canManage: authz.canManageConversation(c, userId),
    // Whether this person may switch the channel between public, private and announcement (scope managers only).
    canManageAccess: authz.canManageChannelAccess(c, userId),
    // Whether the app should offer @everyone here (the hourly limit is checked when sending).
    canMentionAll: mentionAllPermission(ctx, c, userId) === null,
    activeCall: call ? { id: call.id, video: !!call.video, state: call.state, startedAt: call.created_at, ...(inRoom ? { participantIds: inRoom } : {}) } : null,
    voice: !!c.voice,
    // Batch B3: slowmode, and for this person whether it applies and when they may post next (null: now).
    ...(c.type === "CHANNEL"
      ? { slowmodeSec: c.slowmode_sec ?? 0, slowmodeExempt: authz.slowmodeExempt(c, userId), nextPostAt: authz.nextPostAt(c, userId, now()) }
      : {}),
    // Voice channels: whether this person may join the call, and talk in it (listen-only otherwise).
    ...(c.voice ? { canConnect: authz.canConnectVoice(c, userId), canSpeak: authz.canSpeakInVoice(c, userId) } : {}),
    federation: federationInfo(ctx, c.id),
  };
}

export interface ForumTag {
  id: string;
  name: string;
}

/** A forum's tags as stored; anything malformed reads as no tags. */
export function forumTags(c: Pick<ConversationRow, "forum_tags">): ForumTag[] {
  try {
    const v: unknown = JSON.parse(c.forum_tags ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((t): t is ForumTag => typeof t?.id === "string" && typeof t?.name === "string").slice(0, FORUM_TAG_LIMIT);
  } catch {
    return [];
  }
}

/**
 * The tags to store from a manager's list: names trimmed, empty and repeated names (ignoring case) dropped, existing ids
 * kept for names that already had one (so posts keep their labels), new ids for new names.
 */
export function nextForumTags(prev: readonly ForumTag[], wanted: readonly { id?: string; name: string }[], makeId: () => string): ForumTag[] {
  const seen = new Set<string>();
  const used = new Set<string>();
  const out: ForumTag[] = [];
  for (const w of wanted) {
    const name = w.name.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    // An id goes to one tag only: a renamed tag keeps its id, and its old name sent again becomes a new tag.
    const keep = prev.find((p) => p.id === w.id && !used.has(p.id)) ?? prev.find((p) => p.name.toLowerCase() === key && !used.has(p.id));
    const id = keep?.id ?? makeId();
    used.add(id);
    out.push({ id, name });
  }
  return out;
}

/** For a conversation with people on other servers: each server's domain, directory state and queued deliveries. */
function federationInfo(ctx: AppContext, convId: string) {
  const rows = ctx.db
    .prepare(
      `SELECT DISTINCT u.home_server_id AS id, p.domain, p.state FROM conversation_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN federation_peers p ON p.server_id = u.home_server_id
       WHERE m.conversation_id = ? AND u.home_server_id IS NOT NULL`,
    )
    .all(convId) as { id: string; domain: string | null; state: string | null }[];
  if (rows.length === 0) return null;
  return {
    servers: rows.map((r) => ({ serverId: r.id, domain: r.domain, state: r.state ?? "unknown", pending: ctx.federation?.pendingFor(r.id) ?? 0 })),
    // Calls are hosted by the caller's server: this server can start one if it has its own media server.
    calls: !!ctx.federation?.callsEnabled(),
  };
}

/**
 * Batch B6: how a message request looks to [userId]: null for none; the recipient sees "pending" (or nothing once they
 * declined: the conversation is hidden from them), the sender always sees "pending" until it's accepted, so a decline
 * isn't revealed. [sent]: the sender's messages so far (at most REQUEST_MESSAGE_LIMIT before an answer).
 */
export function requestView(r: DmRequestRow | null | undefined, userId: string) {
  if (!r) return null;
  const incoming = r.recipient === userId;
  return { state: "pending" as const, incoming, sent: incoming ? undefined : Math.min(r.sent, REQUEST_MESSAGE_LIMIT), limit: REQUEST_MESSAGE_LIMIT };
}

export default async function conversationRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const { db, authz } = ctx;

  app.get("/v1/conversations", auth, async (req) => {
    const { userId } = me(req);
    const { requests } = parse(ConversationListQuery, req.query);
    const rows = db
      .prepare(
        `SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE m.user_id = ? ORDER BY c.updated_at DESC`,
      )
      .all(userId) as ConversationRow[];
    // Batch B6: message requests are marked; ones you declined are left out; ?requests=1 lists only those waiting for you.
    const byConv = new Map((await ctx.relationships.requestsIn(rows.filter((c) => c.type === "DM").map((c) => c.id))).map((r) => [r.conversation_id, r]));
    const shown = rows.filter((c) => {
      const r = byConv.get(c.id);
      if (r && r.recipient === userId && r.state === "declined") return false;
      return requests === "1" ? r?.recipient === userId && r.state === "pending" : true;
    });
    return { conversations: shown.map((c) => ({ ...conversationView(ctx, c, userId), request: requestView(byConv.get(c.id), userId) })) };
  });

  /**
   * How many of a conversation's members are online now (round 3: "# general · 3 online"), for members only. Counts
   * only people whose "last seen" setting lets the viewer see their online state, so the number reveals no one who
   * hides it; the viewer counts too.
   */
  app.get("/v1/conversations/:id/presence", { ...auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    authz.requireMember(id, userId);
    const members = ctx.db
      .prepare("SELECT u.* FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND u.disabled_at IS NULL")
      .all(id) as ProfileRow[];
    const online = members.filter((u) => (u.id === userId || canSeeLastSeen(ctx, userId, u)) && appearsOnline(ctx, u)).length;
    return { online, members: members.length };
  });

  app.get("/v1/conversations/:id", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = authz.conversation(id);
    if (!c) throw notFound("Conversation not found");
    const visible = c.type === "CHANNEL" ? authz.canViewChannel(c, userId) : authz.isMember(c.id, userId);
    if (!visible) throw notFound("Conversation not found");
    const r = c.type === "DM" ? await ctx.relationships.request(c.id) : null;
    if (r && r.recipient === userId && r.state === "declined") throw notFound("Conversation not found");
    return { conversation: { ...conversationView(ctx, c, userId), request: requestView(r, userId) } };
  });

  app.get("/v1/conversations/:id/members", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = authz.conversation(id);
    if (!c || !(c.type === "CHANNEL" ? authz.canViewChannel(c, userId) : authz.isMember(c.id, userId))) throw notFound("Conversation not found");
    const rows = db
      .prepare("SELECT u.*, m.role AS conv_role, m.joined_at FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY m.role, u.display_name")
      .all(id) as any[];
    return {
      members: rows.map((u) =>
        memberView(ctx, userId, u, {
          ...userSummary(u),
          role: u.conv_role,
          joinedAt: u.joined_at,
          orgRole: c.org_id ? authz.orgRole(c.org_id, u.id) : null,
        }),
      ),
    };
  });

  /** Public keys of every active device of every member: what a sender must encrypt to. */
  app.get("/v1/conversations/:id/devices", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    authz.requireMember(id, userId);
    const ids = (db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(id) as { user_id: string }[]).map((r) => r.user_id);
    await ctx.federation?.refreshStale(ids); // remote members' keys come from their home server, refreshed when stale
    // AI agents: members' entries without their devices (a direct conversation's agent is a member, not a recipient
    // anyone must include), and, for clients that show the notice and honour each member's choice, each reader with only
    // its device here (docs/AI_WORKFORCE_2_PLAN.md phase 5). Other clients never see a reader, so never share with it.
    const people = deviceDirectory(ctx, ids).map((u) => (ctx.workforce.readers.isAgent(u.userId) ? { ...u, devices: [], revokedDevices: [] } : u));
    const readers = req.headers["x-meldiq-ai-reader"] === "1" ? ctx.workforce.readers.directory(id) : [];
    return { users: [...people.filter((u) => !readers.some((r) => r.userId === u.userId)), ...readers] };
  });

  app.post("/v1/conversations/dm", auth, async (req) => {
    const { userId } = me(req);
    const { userId: other } = parse(DmBody, req.body);
    if (other === userId) throw badRequest("You can't start a direct conversation with yourself");
    const target = availableUser(ctx, other);
    if (target) requireSyntheticScopeForPeople(db, userId, [other]);
    // Batch B6: unknown, disabled and blocked (either way) all answer the same, so a block isn't revealed.
    if (!target || blockedEitherWay(ctx, userId, other)) throw notAvailable();
    const key = [userId, other].sort().join("|");
    const t = now();
    let c = db.prepare("SELECT * FROM conversations WHERE dm_key = ?").get(key) as ConversationRow | undefined;
    let request: DmRequestRow | null = c ? await ctx.relationships.request(c.id) : null;
    // Opening a DM with someone whose request you had: it's yours now too, a normal DM.
    if (c && request && request.recipient === userId) {
      await ctx.relationships.deleteRequest(c.id);
      request = null;
      notifyConversation(ctx, c.id);
    }
    if (!c) {
      // People on other servers keep their settings there: their server decides.
      const decision = target.home_server_id ? "direct" : await dmDecision(ctx, userId, other);
      if (decision === "refused") throw new ApiError(403, "dm_not_allowed", "This person only accepts messages from people they're connected with");
      if (decision === "request") await requireRequestBudget(ctx, userId, t);
      // Batch B4: a community can pause new DMs between its members. It applies when every community the two share
      // has paused them, and neither of them moderates one of those communities (moderators can still reach people).
      const shared = (db.prepare("SELECT a.org_id FROM org_members a JOIN org_members b ON a.org_id = b.org_id WHERE a.user_id = ? AND b.user_id = ?").all(userId, other) as { org_id: string }[]).map((r) => r.org_id);
      const t0 = now();
      const paused = shared.length > 0 && shared.every((o) => authz.pausedUntil(o, "dms", t0) !== null);
      const moderator = shared.some((o) => authz.can(o, userId, "members.timeout") || authz.can(o, other, "members.timeout"));
      if (paused && !moderator) throw new ApiError(403, "dms_paused", "New direct messages between members of your community are paused for now");
      // With someone on another server, both servers derive the same conversation id from the two user ids.
      if (target.home_server_id && !ctx.federation) throw new ApiError(503, "federation_disabled", "This server doesn't federate");
      const id = target.home_server_id ? fedDmId(key) : newId("c");
      db.transaction(() => {
        db.prepare("INSERT INTO conversations (id, type, dm_key, created_by, created_at, updated_at) VALUES (?, 'DM', ?, ?, ?, ?)").run(id, key, userId, t, t);
        const ins = db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)");
        ins.run(id, userId, t);
        ins.run(id, other, t);
      })();
      c = authz.conversation(id)!;
      if (decision === "request") {
        request = { conversation_id: id, recipient: other, sender: userId, state: "pending", sent: 0, created_at: t, answered_at: null };
        await ctx.relationships.createRequest(request);
      }
      notifyConversation(ctx, id);
    }
    return { conversation: { ...conversationView(ctx, c, userId), request: requestView(request, userId) } };
  });

  // ───────────── Group photo (batch B6b, Discord reference GDM-CTRL-002) ─────────────
  // A JPEG like a community's photo: not end-to-end encrypted (the server can see it, as it sees the group's name).
  // People who can rename the group set or remove it; every member can see it.
  const groupFor = (id: string, userId: string, manage: boolean) => {
    const c = authz.conversation(id);
    if (!c || c.type !== "GROUP" || !authz.isMember(id, userId)) throw notFound("Group not found");
    if (manage && !authz.canManageConversation(c, userId)) throw forbidden("Only the group's admins can change its photo");
    return c as ConversationRow & { photo_rev?: number | null };
  };

  app.put("/v1/conversations/:id/photo", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = groupFor(id, userId, true);
    const buf = await readJpegBody(req, "Group photos");
    const previous = c.photo_rev ?? null;
    const rev = Math.max(now(), (previous ?? 0) + 1);
    await storePhoto(ctx, photoBlobId(id, rev), buf);
    if (db.prepare("UPDATE conversations SET photo_rev = ?, updated_at = ? WHERE id = ?").run(rev, now(), id).changes === 0) {
      await deleteBlobNow(ctx, "profile-photos", photoBlobId(id, rev));
      throw notFound("Group not found");
    }
    if (previous) await deleteBlobNow(ctx, "profile-photos", photoBlobId(id, previous));
    notifyConversation(ctx, id);
    return { photoRev: rev };
  });

  app.delete("/v1/conversations/:id/photo", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = groupFor(id, userId, true);
    if (c.photo_rev) {
      db.prepare("UPDATE conversations SET photo_rev = NULL, updated_at = ? WHERE id = ?").run(now(), id);
      await deleteBlobNow(ctx, "profile-photos", photoBlobId(id, c.photo_rev));
      notifyConversation(ctx, id);
    }
    return { photoRev: null };
  });

  app.get("/v1/conversations/:id/photo", auth, async (req, reply) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = groupFor(id, userId, false);
    const stream = c.photo_rev ? await ctx.blobs.get("profile-photos", photoBlobId(id, c.photo_rev)) : null;
    if (!stream) throw notFound("No photo");
    return reply.header("content-type", "image/jpeg").header("cache-control", "private, max-age=3600").header("etag", `"${c.photo_rev}"`).send(stream);
  });

  app.post("/v1/conversations/group", auth, async (req) => {
    const { userId } = me(req);
    const body = parse(GroupBody, req.body);
    const ids = [...new Set(body.memberIds.filter((m) => m !== userId))];
    // Groups are server-local in this release: people on other servers can't be added (FEDERATION_PROTOCOL.md §7).
    const found = db.prepare(`SELECT id FROM users WHERE disabled_at IS NULL AND home_server_id IS NULL AND id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: string }[];
    if (found.length !== ids.length) throw badRequest("One or more members do not exist or are on another server");
    requireSyntheticScopeForPeople(db, userId, ids);
    const id = newId("c");
    const t = now();
    db.transaction(() => {
      db.prepare("INSERT INTO conversations (id, type, name, created_by, created_at, updated_at) VALUES (?, 'GROUP', ?, ?, ?, ?)").run(id, body.name, userId, t, t);
      db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'ADMIN', ?)").run(id, userId, t);
      const ins = db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)");
      for (const m of ids) ins.run(id, m, t);
    })();
    notifyConversation(ctx, id);
    return { conversation: conversationView(ctx, authz.conversation(id)!, userId) };
  });

  app.patch("/v1/conversations/:id", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = authz.requireMember(id, userId);
    if (!authz.canManageConversation(c, userId)) throw forbidden();
    const body = parse(ConversationPatchBody, req.body);
    if (body.slowmodeSec !== undefined && c.type !== "CHANNEL") throw badRequest("Only channels have slowmode");
    if (body.format !== undefined && (c.type !== "CHANNEL" || c.voice)) throw badRequest("Only text channels can become forums");
    if (body.archived !== undefined && c.type !== "CHANNEL") throw badRequest("Only channels can be archived");
    const nextFormat = body.format ?? c.format ?? "text";
    if (body.forumTags !== undefined && nextFormat !== "forum") throw badRequest("Only forum channels have tags");
    if (body.guidelines !== undefined && nextFormat !== "forum") throw badRequest("Only forum channels have post guidelines");
    const tags = body.forumTags === undefined ? (c.forum_tags ?? null) : JSON.stringify(nextForumTags(forumTags(c), body.forumTags, () => newId("tag")));
    const kindChange = body.kind !== undefined && body.kind !== c.kind;
    if (body.kind !== undefined && c.type !== "CHANNEL") throw badRequest("Only channels have an access mode");
    if (kindChange) {
      // Access mode (docs/WORKSPACE_ADMINISTRATION.md): only the scope's managers, never a channel admin by role alone.
      if (!authz.canManageChannelAccess(c, userId)) throw forbidden("Only people who can change channel access can change who can see and post in it");
      if (c.archived_at && body.archived !== false) throw conflict("This channel is archived. Restore it before changing its access.");
    }
    // Private channels never auto-join; announcement channels always do; a channel made public again auto-joins the
    // people its permissions let see it, as a new channel would. Making a channel private removes nobody.
    const autoJoin = !kindChange ? c.auto_join : body.kind === "PRIVATE" ? 0 : body.kind === "ANNOUNCEMENT" ? 1 : c.kind === "PRIVATE" ? 1 : c.auto_join;
    db.prepare("UPDATE conversations SET name = ?, topic = ?, archived_at = ?, kind = ?, auto_join = ?, format = ?, forum_tags = ?, updated_at = ? WHERE id = ?").run(
      body.name ?? c.name,
      body.topic === undefined ? c.topic : body.topic,
      body.archived === undefined ? c.archived_at : body.archived ? now() : null,
      kindChange ? body.kind : c.kind,
      autoJoin,
      nextFormat,
      tags,
      now(),
      id,
    );
    if (body.guidelines !== undefined) {
      db.prepare("UPDATE conversations SET guidelines = ? WHERE id = ?").run(body.guidelines || null, id);
      if (c.org_id) ctx.audit({ actorId: userId, orgId: c.org_id, action: "channel.guidelines", target: id });
    }
    if (body.slowmodeSec !== undefined && body.slowmodeSec !== (c.slowmode_sec ?? 0)) {
      db.prepare("UPDATE conversations SET slowmode_sec = ? WHERE id = ?").run(body.slowmodeSec, id);
      if (c.org_id) ctx.audit({ actorId: userId, orgId: c.org_id, action: "channel.slowmode", target: id, detail: `${body.slowmodeSec}s` });
    }
    if (c.org_id) {
      if (kindChange) ctx.audit({ actorId: userId, orgId: c.org_id, action: "channel.access", target: id, detail: `${c.kind}→${body.kind}` });
      if (body.archived !== undefined && body.archived !== !!c.archived_at) {
        ctx.audit({ actorId: userId, orgId: c.org_id, action: body.archived ? "channel.archive" : "channel.restore", target: id });
      }
      if (body.name !== undefined || body.topic !== undefined || body.format !== undefined || body.forumTags !== undefined) ctx.audit({ actorId: userId, orgId: c.org_id, action: "channel.update", target: id });
      if (kindChange && body.kind !== "PRIVATE") await reconcileAccess(ctx, c.org_id);
    }
    notifyConversation(ctx, id);
    return { conversation: conversationView(ctx, authz.conversation(id)!, userId) };
  });

  /**
   * Deleting a community channel (docs/product/MELDIQ_ANDROID_INTERACTION_MATRIX.md): people who manage it, after
   * typing its name. Its messages, files, calls and permissions go for everyone, in one transaction; the community and
   * its other channels are untouched. Archiving (PATCH `archived`) is the reversible alternative.
   */
  app.delete("/v1/conversations/:id", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const body = parse(ConversationDeleteBody, req.body ?? {});
    const c = authz.requireMember(id, userId);
    if (c.type !== "CHANNEL" || !c.org_id) throw badRequest("Only community channels can be deleted; leave a group or conversation instead");
    if (!authz.canManageConversation(c, userId)) throw forbidden("Only people who manage this channel can delete it");
    if (body.confirmName.trim().replace(/^#/, "") !== (c.name ?? "").trim()) {
      throw new ApiError(400, "confirm_mismatch", "Type the channel's name exactly as it appears to delete it");
    }
    const orgId = c.org_id;
    // Read before the transaction: the files store may not be SQLite.
    const files = await ctx.files.attachmentIdsIn([id]);
    const result = db
      .transaction(() => {
        if (!db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id)) return null;
        const members = (db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(id) as { user_id: string }[]).map((r) => r.user_id);
        const rooms = (db.prepare("SELECT room_name FROM calls WHERE conversation_id = ? AND state != 'ENDED'").all(id) as { room_name: string }[]).map((r) => r.room_name);
        // Its files and uploads, queued items, and rows without a foreign key to the conversation (members and calls
        // cascade), and its overwrites.
        ctx.files.forgetConversation(id);
        ctx.relay.forgetConversation(id);
        db.prepare("DELETE FROM mention_all_events WHERE conversation_id = ?").run(id);
        db.prepare("DELETE FROM channel_overwrites WHERE target_type = 'channel' AND target_id = ?").run(id);
        db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
        return { members, files, rooms };
      })
      .immediate();
    if (!result) throw notFound("Conversation not found");
    ctx.audit({ actorId: userId, orgId, action: "channel.delete", target: id, detail: `${c.name ?? ""} (${result.files.length} files)` });
    // Apps refresh the channel (now 404, shown as gone) and the community's channel list.
    ctx.hub.sendToUsers(new Set(result.members), { t: "conv.updated", conversationId: id });
    const orgMembers = (db.prepare("SELECT user_id FROM org_members WHERE org_id = ?").all(orgId) as { user_id: string }[]).map((r) => r.user_id);
    ctx.hub.sendToUsers(new Set(orgMembers), { t: "org.updated", orgId });
    for (const room of result.rooms) await ctx.livekit?.deleteRoom(room).catch(() => {});
    await processBlobDeletes(ctx).catch(() => 0);
    return { deleted: true, id, members: result.members.length, files: result.files.length };
  });

  app.post("/v1/conversations/:id/join", auth, async (req) => {
    const { userId } = me(req);
    const { id } = parse(idParams, req.params);
    const c = authz.conversation(id);
    if (!c || c.type !== "CHANNEL" || !authz.canViewChannel(c, userId)) throw notFound("Channel not found");
    if (c.kind === "PRIVATE") throw forbidden("Private channels require an invitation from a channel manager");
    if (c.archived_at) throw conflict("This channel is archived");
    if (!authz.scopeEligible(c, userId)) throw forbidden();
    db.prepare("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)").run(id, userId, now());
    notifyConversation(ctx, id);
    return { conversation: conversationView(ctx, c, userId) };
  });

  app.put("/v1/conversations/:id/members/:userId", auth, async (req) => {
    const actor = me(req).userId;
    const p = parse(MemberParams, req.params);
    const { role } = parse(MemberPutBody, req.body ?? {});
    const c = authz.conversation(p.id);
    if (!c) throw notFound("Conversation not found");
    if (c.type === "DM") throw badRequest("Direct conversations have fixed members");
    if (!authz.canManageConversation(c, actor)) throw forbidden("Only managers of this conversation can add members");
    const target = db.prepare("SELECT id FROM users WHERE id = ? AND disabled_at IS NULL").get(p.userId);
    if (!target) throw notFound("User not found");
    if (c.type === "CHANNEL") {
      const targetOrgRole = authz.orgRole(c.org_id!, p.userId);
      if (!targetOrgRole) throw conflict("That person is not a member of this community");
      if (targetOrgRole !== "GUEST" && !authz.scopeEligible(c, p.userId)) {
        throw conflict("That person can't see this channel: its permissions don't include them");
      }
    } else {
      const n = (db.prepare("SELECT COUNT(*) n FROM conversation_members WHERE conversation_id = ?").get(c.id) as { n: number }).n;
      if (n >= MAX_GROUP && !authz.isMember(c.id, p.userId)) throw conflict(`Groups are limited to ${MAX_GROUP} people`);
    }
    db.prepare(
      "INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, user_id) DO UPDATE SET role = excluded.role",
    ).run(c.id, p.userId, role, now());
    if (c.org_id) ctx.audit({ actorId: actor, orgId: c.org_id, action: "channel.member.add", target: `${c.id}:${p.userId}` });
    notifyConversation(ctx, c.id);
    return { ok: true };
  });

  app.delete("/v1/conversations/:id/members/:userId", auth, async (req) => {
    const actor = me(req).userId;
    const p = parse(MemberParams, req.params);
    const c = authz.conversation(p.id);
    if (!c || !authz.isMember(c.id, actor)) throw notFound("Conversation not found");
    if (c.type === "DM") throw badRequest("You can't leave a direct conversation");
    if (actor !== p.userId && !authz.canManageConversation(c, actor)) throw forbidden();
    // Batch B14b (master prompt §5.2): people leave a community, not one of its channels. Who sees a channel follows
    // community membership and permissions; a manager can still take someone out of a channel.
    if (c.type === "CHANNEL" && c.org_id && actor === p.userId) {
      throw new ApiError(403, "leave_community", "Leave the community instead of one of its channels");
    }
    if (c.type === "CHANNEL" && c.kind === "ANNOUNCEMENT" && actor === p.userId && !authz.canManageConversation(c, actor)) {
      throw forbidden("Announcement channels can't be left");
    }
    db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?").run(c.id, p.userId);
    if (c.type === "GROUP") {
      // Keep at least one admin in a group.
      const admins = (db.prepare("SELECT COUNT(*) n FROM conversation_members WHERE conversation_id = ? AND role = 'ADMIN'").get(c.id) as { n: number }).n;
      if (admins === 0) {
        db.prepare(
          "UPDATE conversation_members SET role = 'ADMIN' WHERE conversation_id = ? AND user_id = (SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at LIMIT 1)",
        ).run(c.id, c.id);
      }
    }
    if (c.org_id) ctx.audit({ actorId: actor, orgId: c.org_id, action: actor === p.userId ? "channel.leave" : "channel.member.remove", target: `${c.id}:${p.userId}` });
    notifyConversation(ctx, c.id, [p.userId]);
    await evictRemovedMember(ctx, p.userId, [c.id]);
    return { ok: true };
  });
}
