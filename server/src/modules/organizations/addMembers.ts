import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { MembersAddBody, OrgParams } from "../../shared/contracts/http/orgs.js";
import { ApiError, forbidden } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { now } from "../../shared/utilities/util.js";
import { me, requireAuth } from "../auth/index.js";
import { availableUser, blockedEitherWay, dmDecision, sharesCommunity } from "../accounts/index.js";
import { sharesDirectConversation } from "../messaging/index.js";
import { notifyOrg } from "./orgsRoutes.js";

export type AddOutcome = "added" | "already_member" | "not_available";

/**
 * Adds existing Meldiq accounts to a community directly, without an invitation (community-first brief §F).
 *
 * Who may: anyone whose role lets them invite members. Whom: people the adder already knows (a connection, a shared
 * conversation or a shared community) who would also accept a direct message from them under their own messaging
 * settings, so their existing consent rule applies here too, and nobody can be pulled into a community by a stranger.
 * Blocked (either way), banned, disabled, unknown and ineligible people all get the same "not_available", so nothing
 * about them is revealed; the adder can send them an invitation instead. Joining-paused communities and member limits
 * apply as for invitations. Each addition is audited, and the added person's apps are told at once (org.updated).
 */
export async function addMembers(ctx: AppContext, orgId: string, actor: string, userIds: string[], t = now()): Promise<{ userId: string; outcome: AddOutcome }[]> {
  const { authz, db } = ctx;
  authz.requireOrgMember(orgId, actor);
  if (!authz.canIssueInvite(orgId, actor, "MEMBER")) throw forbidden("Your role doesn't include adding people");
  if (authz.pausedUntil(orgId, "invites", t)) throw new ApiError(403, "invites_paused", "This community has paused new members for now. Try again later.");
  const results: { userId: string; outcome: AddOutcome }[] = [];
  for (const userId of [...new Set(userIds)]) {
    if (authz.orgRole(orgId, userId)) {
      results.push({ userId, outcome: "already_member" });
      continue;
    }
    if (!(await eligible(ctx, orgId, actor, userId))) {
      results.push({ userId, outcome: "not_available" });
      continue;
    }
    ctx.entitlements.check("members", (db.prepare("SELECT COUNT(*) n FROM org_members WHERE org_id = ?").get(orgId) as { n: number }).n, orgId);
    db.prepare("INSERT INTO org_members (org_id, user_id, role, joined_at, expires_at) VALUES (?, ?, 'MEMBER', ?, NULL)").run(orgId, userId, t);
    authz.autoJoinScope(orgId, userId, t);
    ctx.audit({ actorId: actor, orgId, action: "member.add", target: userId, detail: "MEMBER" });
    results.push({ userId, outcome: "added" });
  }
  if (results.some((r) => r.outcome === "added")) notifyOrg(ctx, orgId);
  return results;
}

async function eligible(ctx: AppContext, orgId: string, actor: string, userId: string): Promise<boolean> {
  if (userId === actor) return false;
  const u = availableUser(ctx, userId);
  // People on other servers join through an invitation on their own server.
  if (!u || u.home_server_id) return false;
  if (blockedEitherWay(ctx, actor, userId) || ctx.authz.isBanned(orgId, userId)) return false;
  if (!(await knows(ctx, actor, userId))) return false;
  return (await dmDecision(ctx, actor, userId)) === "direct";
}

/** A connection, a shared DM or group, or a shared community: never someone found only by their username. */
async function knows(ctx: AppContext, a: string, b: string): Promise<boolean> {
  if ((await ctx.relationships.connection(a, b))?.state === "accepted") return true;
  return sharesCommunity(ctx, a, b) || sharesDirectConversation(ctx, a, b);
}

export default async function addMembersRoutes(app: FastifyInstance, ctx: AppContext) {
  // At most ten requests a minute per person, twenty people each: room to set up a community, not to spam.
  app.post("/v1/orgs/:orgId/members", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const { userIds } = parse(MembersAddBody, req.body);
    return { results: await addMembers(ctx, orgId, me(req).userId, userIds) };
  });
}
