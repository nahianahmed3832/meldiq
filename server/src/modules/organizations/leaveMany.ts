import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { LeaveOrgsBody } from "../../shared/contracts/http/orgs.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";
import { removeFromWorkspace } from "./orgsRoutes.js";

/** What leaving several communities did. */
export interface LeaveManyResult {
  left: string[];
  skippedOwned: string[];
  notMember: string[];
}

/**
 * Takes [userId] out of each of [orgIds] they belong to, one at a time through the same path as leaving one (so its
 * events, audit entries and member lists are identical). Communities they own are skipped, whoever else owns them.
 */
export async function leaveMany(ctx: AppContext, userId: string, orgIds: readonly string[]): Promise<LeaveManyResult> {
  const out: LeaveManyResult = { left: [], skippedOwned: [], notMember: [] };
  for (const orgId of new Set(orgIds)) {
    const role = ctx.authz.orgRole(orgId, userId);
    if (!role) out.notMember.push(orgId);
    else if (role === "OWNER") out.skippedOwned.push(orgId);
    else {
      await removeFromWorkspace(ctx, orgId, userId, userId, "left");
      out.left.push(orgId);
    }
  }
  return out;
}

/** API 0.65.0 (docs/SETTINGS_PARITY_API.md): Settings › Privacy › leave several communities at once. */
export default async function leaveManyRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post("/v2/orgs/leave", { preHandler: requireAuth(ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { orgIds } = parse(LeaveOrgsBody, req.body);
    return leaveMany(ctx, me(req).userId, orgIds);
  });
}
