import type { FastifyInstance, FastifyRequest } from "fastify";
import { networkKey } from "../../app/middleware/abuse.js";
import { AdminBoostGrant, AdminCancelBody, AdminDiscoveryParams, AdminDiscoveryPatch, AdminDiscoveryRecordParams, AdminPromotedGrant } from "../../shared/contracts/http/discovery.js";
import { ApiError, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import type { AdminDeps } from "./dataRoutes.js";
import { metaOf, principal, requirePermission } from "./guards.js";

/**
 * Discovery in the console (community parity batch E, docs/COMMUNITY_PARITY_API.md › Discovery): see a community's
 * boosts and Promoted bookings, grant either by hand while billing is off (the owner's testing), cancel them, take a
 * community out of Discovery, or mark one as run by Meldiq. Every change needs a reason and is audited.
 */
export default async function adminDiscoveryRoutes(app: FastifyInstance, d: AdminDeps) {
  const discovery = () => d.ctx.discovery;
  const needs = (p: "billing.view" | "billing.manage" | "orgs.members.manage") => ({ preHandler: requirePermission(d.auth, d.audit, p) });

  const record = async (req: FastifyRequest, action: string, targetType: string, targetId: string, reason: string, detail: Record<string, string | number | boolean | null>) => {
    const p = principal(req);
    const meta = metaOf(req);
    await d.audit.record({ action, outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType, targetId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail });
  };
  const actor = (req: FastifyRequest) => `admin:${principal(req).account.id}`;

  app.get("/admin/v1/discovery/orgs/:orgId", needs("billing.view"), async (req) => ({ discovery: discovery().promote.adminView(parse(AdminDiscoveryParams, req.params).orgId) }));

  app.put("/admin/v1/discovery/orgs/:orgId", needs("orgs.members.manage"), async (req) => {
    const { orgId } = parse(AdminDiscoveryParams, req.params);
    const body = parse(AdminDiscoveryPatch, req.body);
    discovery().promote.adminView(orgId);
    const t = discovery().clock();
    await discovery().store.patchSettings(
      orgId,
      {
        ...(body.removed === undefined ? {} : { removed_at: body.removed ? t : null, removed_reason: body.removed ? body.reason : null }),
        ...(body.official === undefined ? {} : { official: body.official ? 1 : 0 }),
      },
      actor(req),
      t,
    );
    await record(req, "discovery.update", "org", orgId, body.reason, { removed: body.removed ?? null, official: body.official ?? null });
    return { discovery: discovery().promote.adminView(orgId) };
  });

  app.post("/admin/v1/discovery/orgs/:orgId/boosts", needs("billing.manage"), async (req) => {
    const { orgId } = parse(AdminDiscoveryParams, req.params);
    const body = parse(AdminBoostGrant, req.body);
    const boost = await discovery().promote.grantBoost(orgId, body.tier, body.weeks, actor(req), body.reason);
    await record(req, "discovery.boost_grant", "org", orgId, body.reason, { boostId: boost.id, tier: body.tier, weeks: body.weeks });
    return { discovery: discovery().promote.adminView(orgId) };
  });

  app.post("/admin/v1/discovery/orgs/:orgId/promoted", needs("billing.manage"), async (req) => {
    const { orgId } = parse(AdminDiscoveryParams, req.params);
    const body = parse(AdminPromotedGrant, req.body);
    const booking = await discovery().promote.grantPromoted(orgId, actor(req), body.reason, body.weekStart);
    await record(req, "discovery.promoted_grant", "org", orgId, body.reason, { bookingId: booking.id, weekStart: booking.week_start });
    return { discovery: discovery().promote.adminView(orgId) };
  });

  const cancel = (table: "discovery_boosts" | "promoted_bookings", action: string) => async (req: FastifyRequest) => {
    const { id } = parse(AdminDiscoveryRecordParams, req.params);
    const body = parse(AdminCancelBody, req.body);
    const row = table === "discovery_boosts" ? discovery().store.boost(id) : discovery().store.booking(id);
    if (!row) throw notFound("Not found");
    if (!(await discovery().store.cancel(table, id))) throw new ApiError(409, "conflict", "That's cancelled already.");
    await record(req, action, "org", row.org_id, body.reason, { id });
    return { discovery: discovery().promote.adminView(row.org_id) };
  };
  app.post("/admin/v1/discovery/boosts/:id/cancel", needs("billing.manage"), cancel("discovery_boosts", "discovery.boost_cancel"));
  app.post("/admin/v1/discovery/promoted/:id/cancel", needs("billing.manage"), cancel("promoted_bookings", "discovery.promoted_cancel"));
}
