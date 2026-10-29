import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import { OrgParamsNonEmpty } from "../../../shared/contracts/http/community.js";
import { LockBody, SafetySettingsBody } from "../../../shared/contracts/http/communitySafety.js";
import { forbidden } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { me, requireAuth } from "../../auth/index.js";
import { notifyOrg } from "../orgsRoutes.js";
import { LOCK_MS } from "./rules.js";

/**
 * A community's safety settings and its lock (community parity A2, feature "community-safety",
 * docs/COMMUNITY_SAFETY_API.md). The settings are for people who can edit the community; locking and unlocking, like
 * the other Security actions, also for people who can ban.
 */
export default async function communitySafetyRoutes(app: FastifyInstance, ctx: AppContext) {
  const { authz } = ctx;
  const auth = { preHandler: requireAuth(ctx) };
  const safety = () => ctx.communitySafety;

  /** Editors, or people who ban: the Security actions' rule (communityRoutes.ts, PUT /security). */
  const requireSecurity = (orgId: string, userId: string) => {
    authz.requireOrgMember(orgId, userId);
    if (!authz.can(orgId, userId, "workspace.edit") && !authz.can(orgId, userId, "members.ban")) throw forbidden("Your role doesn't include security actions");
  };

  app.get("/v1/orgs/:orgId/safety", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    safety().requireEnabled();
    requireSecurity(orgId, me(req).userId);
    return safety().view(orgId);
  });

  app.put("/v1/orgs/:orgId/safety", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const actor = me(req).userId;
    const body = parse(SafetySettingsBody, req.body);
    safety().requireEnabled();
    authz.requireOrgMember(orgId, actor);
    if (!authz.can(orgId, actor, "workspace.edit")) throw forbidden("Your role doesn't include changing the community's safety settings");
    const changed = await safety().setSettings(orgId, actor, body);
    if (changed.length) {
      ctx.audit({ actorId: actor, orgId, action: "community.safety", target: orgId, detail: changed.join(", ") });
      notifyOrg(ctx, orgId);
    }
    return safety().view(orgId);
  });

  app.put("/v1/orgs/:orgId/lock", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const actor = me(req).userId;
    const { duration } = parse(LockBody, req.body);
    safety().requireEnabled();
    requireSecurity(orgId, actor);
    const until = duration === null ? null : safety().clock() + LOCK_MS[duration];
    const wasLocked = safety().lockedUntil(orgId) !== null;
    if (until !== null || wasLocked) {
      await safety().setLock(orgId, actor, until);
      ctx.audit({ actorId: actor, orgId, action: until === null ? "community.unlock" : "community.lock", target: orgId, detail: duration });
      notifyOrg(ctx, orgId);
    }
    return safety().lockView(orgId);
  });
}
