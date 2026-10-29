import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { OrgMemberParams, OrgParamsNonEmpty } from "../../../shared/contracts/http/community.js";
import { VoiceBanBody, VoiceMuteBody } from "../../../shared/contracts/http/communitySafety.js";
import { badRequest, forbidden, notFound } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { applyVoiceSpeaking, disconnectFromCommunityVoice, evictFromCommunityVoice } from "../../calls/index.js";
import type { OrgRole } from "../authz.js";
import type { Permission } from "../permissions/catalog.js";
import { type Actor, canActOn } from "../permissions/rules.js";
import { banAllowed } from "../roleRules.js";

/**
 * Voice moderation (community parity A2, feature "community-safety", docs/COMMUNITY_SAFETY_API.md): voice bans (people
 * who ban), server mutes (`voice.mute_members`) and disconnecting someone from a voice call (`voice.move_members`).
 */

/**
 * Muting or disconnecting someone else: owners do it to anyone but another owner; holders of [key] to members and guests
 * whose powers they hold (like a timeout).
 */
export function voiceActionAllowed(actor: Actor, targetRole: OrgRole, key: Permission, targetPerms: ReadonlySet<Permission>): boolean {
  if (targetRole === "OWNER") return false;
  if (actor.base === "OWNER") return true;
  if (!actor.perms.has(key)) return false;
  return (targetRole === "MEMBER" || targetRole === "GUEST") && canActOn(actor, { base: targetRole, self: false, perms: targetPerms });
}

export default async function voiceModerationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { authz } = ctx;
  const auth = { preHandler: requireAuth(ctx) };
  const safety = () => ctx.communitySafety;
  const list = (orgId: string) => ({ voiceBans: safety().voice.bans(orgId) });

  /** Their own devices reload the community and its voice channels (whether they may join or talk changed). */
  const tellThem = (orgId: string, userId: string) => {
    ctx.hub.sendToUser(userId, { t: "org.updated", orgId });
    for (const id of authz.conversationIdsOf(orgId)) {
      if (authz.conversation(id)?.voice === 1 && authz.isMember(id, userId)) ctx.hub.sendToUser(userId, { t: "conv.updated", conversationId: id });
    }
  };

  /** The member [targetId] someone with [key] may act on: 400 for themselves, 404 for non-members, 403 otherwise. */
  const requireVoiceTarget = (orgId: string, actorId: string, targetId: string, key: Permission) => {
    authz.requireOrgMember(orgId, actorId);
    if (!authz.can(orgId, actorId, key)) throw forbidden("Your role doesn't include that in voice channels");
    if (targetId === actorId) throw badRequest("You can't do that to yourself");
    const role = authz.orgRole(orgId, targetId);
    if (!role) throw notFound("Member not found");
    if (!voiceActionAllowed(authz.actor(orgId, actorId)!, role, key, authz.permissions(orgId, targetId))) throw forbidden("You can't do that to this person");
  };

  app.get("/v1/orgs/:orgId/voice-bans", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    safety().requireEnabled();
    authz.requirePermission(orgId, me(req).userId, "members.ban", "Your role doesn't include bans");
    return list(orgId);
  });

  app.post("/v1/orgs/:orgId/voice-bans", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const actor = me(req).userId;
    const body = parse(VoiceBanBody, req.body);
    safety().requireEnabled();
    authz.requirePermission(orgId, actor, "members.ban", "Your role doesn't include bans");
    if (body.userId === actor) throw badRequest("You can't ban yourself");
    if (safety().accountCreatedAt(body.userId) === null) throw notFound("User not found");
    const role = authz.orgRole(orgId, body.userId);
    if (!banAllowed(authz.actor(orgId, actor)!, role, role ? authz.permissions(orgId, body.userId) : undefined)) {
      throw forbidden(role === "OWNER" ? "Owners can't be banned" : "You can't ban this person");
    }
    await safety().voice.ban(orgId, body.userId, actor, body.reason ?? null, safety().clock());
    ctx.audit({ actorId: actor, orgId, action: "member.voice_ban", target: body.userId, detail: body.reason ?? null });
    await evictFromCommunityVoice(ctx, orgId);
    tellThem(orgId, body.userId);
    return list(orgId);
  });

  app.delete("/v1/orgs/:orgId/voice-bans/:userId", auth, async (req) => {
    const p = parse(OrgMemberParams, req.params);
    const actor = me(req).userId;
    safety().requireEnabled();
    authz.requirePermission(p.orgId, actor, "members.ban", "Your role doesn't include bans");
    if (!(await safety().voice.unban(p.orgId, p.userId))) throw notFound("Not banned from voice");
    ctx.audit({ actorId: actor, orgId: p.orgId, action: "member.voice_unban", target: p.userId });
    tellThem(p.orgId, p.userId);
    return list(p.orgId);
  });

  app.put("/v1/orgs/:orgId/voice/members/:userId/mute", auth, async (req) => {
    const p = parse(OrgMemberParams, req.params);
    const actor = me(req).userId;
    const { muted } = parse(VoiceMuteBody, req.body);
    safety().requireEnabled();
    requireVoiceTarget(p.orgId, actor, p.userId, "voice.mute_members");
    let devices = 0;
    if (await safety().voice.setMuted(p.orgId, p.userId, muted, actor, safety().clock())) {
      ctx.audit({ actorId: actor, orgId: p.orgId, action: muted ? "member.voice_mute" : "member.voice_unmute", target: p.userId });
      devices = await applyVoiceSpeaking(ctx, p.orgId, p.userId);
      tellThem(p.orgId, p.userId);
    }
    return { userId: p.userId, muted, mutedAt: safety().voice.mutedAt(p.orgId, p.userId), devices };
  });

  app.post("/v1/orgs/:orgId/voice/members/:userId/disconnect", auth, async (req) => {
    const p = parse(OrgMemberParams, req.params);
    const actor = me(req).userId;
    safety().requireEnabled();
    requireVoiceTarget(p.orgId, actor, p.userId, "voice.move_members");
    const disconnected = await disconnectFromCommunityVoice(ctx, p.orgId, p.userId);
    if (disconnected === 0) throw notFound("They aren't in a voice channel call");
    ctx.audit({ actorId: actor, orgId: p.orgId, action: "member.voice_disconnect", target: p.userId });
    return { userId: p.userId, disconnected };
  });
}
