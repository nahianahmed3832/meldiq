import type { FastifyInstance } from "fastify";
import { networkKey } from "../../app/middleware/abuse.js";
import { AdminBotsPlusBody } from "../../shared/contracts/http/officialBots.js";
import { AdminOrgParams } from "../../shared/contracts/http/platformAdmin.js";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { orgRecord } from "../organizations/index.js";
import type { AdminDeps } from "./dataRoutes.js";
import { metaOf, principal, requirePermission } from "./guards.js";

const DAY_MS = 86_400_000;
/** The longest a grant may run before it must be made again (a super admin may choose no end), as for limits. */
const MAX_GRANT_DAYS = 366;

/**
 * Bots+ for a community (community parity batch D, docs/COMMUNITY_PARITY_API.md › Official bots): every official
 * bot's Plus extras. Billing for it is off, so platform admins grant and take it away here, with a reason and usually an
 * end date, like a community's own limits. Every change is in the platform audit.
 */
export default async function adminBotsPlusRoutes(app: FastifyInstance, d: AdminDeps) {
  const bots = d.ctx.officialBots;

  app.get("/admin/v1/orgs/:orgId/bots-plus", { preHandler: requirePermission(d.auth, d.audit, "entitlements.view") }, async (req) => {
    const { orgId } = parse(AdminOrgParams, req.params);
    if (!orgRecord(d.ctx.ws, orgId)) throw notFound("No such workspace or community");
    return { botsPlus: bots.plusGrant(orgId) };
  });

  app.put("/admin/v1/orgs/:orgId/bots-plus", { preHandler: requirePermission(d.auth, d.audit, "entitlements.edit") }, async (req) => {
    const { orgId } = parse(AdminOrgParams, req.params);
    const body = parse(AdminBotsPlusBody, req.body);
    const p = principal(req);
    if (!orgRecord(d.ctx.ws, orgId)) throw notFound("No such workspace or community");
    const t = Date.now();
    if (body.enabled) {
      if (body.expiresAt === undefined) throw new ApiError(400, "bad_request", "Choose when Bots+ ends");
      if (body.expiresAt === null && p.grant.role !== "super_admin") throw forbidden("Only a super admin may grant Bots+ with no end date");
      if (body.expiresAt !== null && (body.expiresAt <= t || body.expiresAt > t + MAX_GRANT_DAYS * DAY_MS)) throw new ApiError(400, "bad_request", "The end date must be in the next 366 days");
    }
    const before = bots.plusGrant(orgId);
    await bots.setPlus(orgId, body.enabled ? { by: `platform:${p.account.id}`, expiresAt: body.expiresAt ?? null, reason: body.reason } : null);
    const meta = metaOf(req);
    await d.audit.record({
      action: body.enabled ? "org.bots_plus_grant" : "org.bots_plus_revoke",
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "org",
      targetId: orgId,
      reason: body.reason,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail: { before: before.enabled, until: body.enabled ? (body.expiresAt === null || body.expiresAt === undefined ? "no end" : new Date(body.expiresAt).toISOString()) : null },
    });
    return { botsPlus: bots.plusGrant(orgId) };
  });
}
