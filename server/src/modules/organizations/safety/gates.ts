import type { AppContext } from "../../../app/context.js";
import { ApiError } from "../../../shared/errors.js";
import { isBotUser } from "../../accounts/index.js";
import type { ConversationRow } from "../authz.js";
import { isPermission, type Permission } from "../permissions/catalog.js";
import { notifyConversation, notifyOrg } from "../orgsRoutes.js";
import { accountAllowedAt, verificationRefusal } from "./rules.js";

/**
 * Where community safety meets joining and posting (community parity A2, docs/COMMUNITY_SAFETY_API.md): the lock and
 * the account-age gate for joins, the lock and the verification level for posts and reactions, and raid protection's
 * counting. Reached through ctx.communitySafety, so the messaging module never imports this one.
 */

/** "post": messages, edits and pins; "react": reactions and poll votes. Read markers and other changes are never held back. */
export type PostKind = "post" | "react";

/** Another agent's batch adds `messages.manage`; until then nobody holds it. */
const MANAGE_MESSAGES = "messages.manage";

/** Why [userId] can't join [orgId] now (locked, or an account too new), or null. Synchronous: joins check it in their write unit. */
export function joinRefusal(ctx: AppContext, orgId: string, userId: string): ApiError | null {
  const s = ctx.communitySafety;
  const until = s.lockedUntil(orgId);
  if (until !== null) return new ApiError(403, "community_locked", "This community is locked for now: nobody new can join. Try again later.", { until });
  const gate = s.accountGate(orgId);
  if (gate === "off" || s.knownStaff(userId)) return null;
  const createdAt = s.accountCreatedAt(userId);
  const allowedAt = createdAt === null ? null : accountAllowedAt(gate, createdAt, s.clock());
  if (allowedAt === null) return null;
  return new ApiError(403, "account_too_new", "This community doesn't take accounts this new yet. Try again later.", { minAccountAge: gate, allowedAt });
}

/**
 * Moderators, who post while the community is locked: owners and admins, the channel's managers, and holders of
 * `messages.manage` once that key exists.
 */
export function lockExempt(ctx: AppContext, conv: ConversationRow, userId: string): boolean {
  const { authz } = ctx;
  const orgId = conv.org_id!;
  if (authz.isOrgAdmin(orgId, userId) || authz.canManageConversation(conv, userId)) return true;
  return isPermission(MANAGE_MESSAGES) && authz.can(orgId, userId, MANAGE_MESSAGES as Permission);
}

/** Who never waits for the verification level: moderators, anyone holding a custom role, and bots. */
export function verificationExempt(ctx: AppContext, conv: ConversationRow, userId: string, bot: boolean): boolean {
  if (bot || lockExempt(ctx, conv, userId)) return true;
  return ctx.authz.assignedRoles(conv.org_id!, userId).length > 0 || isBotUser(ctx, userId);
}

/** Throws when the lock or the verification level holds [userId] back from this [kind] of change in [conv]. */
export async function admitCommunityPost(ctx: AppContext, conv: ConversationRow, userId: string, kind: PostKind, bot: boolean): Promise<void> {
  const s = ctx.communitySafety;
  if (!s.enabled || conv.type !== "CHANNEL" || !conv.org_id) return;
  const until = kind === "post" && !bot ? s.lockedUntil(conv.org_id) : null;
  if (until !== null && !lockExempt(ctx, conv, userId)) {
    throw new ApiError(403, "community_locked_posting", "This community is locked for now: only moderators can post. You can still read and react.", { until });
  }
  const level = s.verificationLevel(conv.org_id);
  if (level === "none" || verificationExempt(ctx, conv, userId, bot)) return;
  const joinedAt = ctx.ws.get<{ joined_at: number }>("org_members", { org_id: conv.org_id, user_id: userId })?.joined_at ?? 0;
  const facts = { emailVerified: await s.emailVerified(userId), accountCreatedAt: s.accountCreatedAt(userId) ?? 0, joinedAt };
  const refusal = verificationRefusal(level, facts, s.clock());
  if (!refusal) return;
  const message = refusal.reason === "email" ? "Verify your email address to post and react in this community." : "This community asks newcomers to wait a few minutes before posting and reacting.";
  throw new ApiError(403, "verification_required", message, { level, reason: refusal.reason, allowedAt: refusal.allowedAt });
}

/** After someone joined [orgId]: a join flood locks the community (raid protection), audited as automatic. */
export async function noteJoinForRaid(ctx: AppContext, orgId: string): Promise<void> {
  const s = ctx.communitySafety;
  if (!s.raidProtection(orgId) || !s.raid.join(orgId, s.clock())) return;
  const { joins, joinWindowMs, lockMs } = s.raid.limits;
  const until = s.clock() + lockMs;
  if ((s.lockedUntil(orgId) ?? 0) >= until) return;
  await s.setLock(orgId, null, until);
  const detail = `automatic: ${joins} joins within ${joinWindowMs / 1000} s, locked for ${lockMs / 60_000} minutes`;
  ctx.audit({ actorId: null, orgId, action: "community.lock", target: orgId, detail });
  ctx.log.info({ orgId, until }, "community safety: join flood, community locked");
  notifyOrg(ctx, orgId);
}

/** After a message in [conversationId]: a message flood slows the channel down for a while (raid protection). */
export function noteMessageForRaid(ctx: AppContext, conversationId: string, userId: string): void {
  const s = ctx.communitySafety;
  const conv = ctx.authz.conversation(conversationId);
  if (!conv || conv.type !== "CHANNEL" || !conv.org_id || !s.raidProtection(conv.org_id)) return;
  if (!s.raid.post(conv.id, userId, s.clock())) return;
  const { messages, posters, messageWindowMs, slowmodeSec, slowmodeMs } = s.raid.limits;
  if ((conv.slowmode_sec ?? 0) >= slowmodeSec || s.autoSlowmodeSec(conv.id) > 0) return;
  s.startAutoSlowmode(conv.id);
  const detail = `automatic: ${messages} messages from ${posters} people within ${messageWindowMs / 1000} s, ${slowmodeSec} s slowmode for ${slowmodeMs / 60_000} minutes`;
  ctx.audit({ actorId: null, orgId: conv.org_id, action: "channel.auto_slowmode", target: conv.id, detail });
  notifyConversation(ctx, conv.id);
}
