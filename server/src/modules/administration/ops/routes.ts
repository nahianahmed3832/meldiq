import type { FastifyInstance } from "fastify";
import { type AppContext } from "../../../app/context.js";
import { me, requireAuth } from "../../auth/index.js";
import { ConnectorParams, LimitsBody, LimitsParams, UsageQuery } from "../../../shared/contracts/http/admin.js";
import { parse } from "../../../shared/validation/index.js";
import { ENTITLEMENT_KEYS, type EntitlementKey, isEntitlementKey } from "../entitlements.js";
import { badRequest, forbidden, notFound } from "../../../shared/errors.js";
import { CHECKS, checkConnector, connectorReport } from "./connectors.js";
import { healthReport } from "./health.js";

/**
 * Platform operations API (docs/OPERATIONS.md): platform admins only (PLATFORM_ADMIN_USER_IDS), never a workspace
 * role. Health and usage are read-only; the only change here is a workspace's own limits (audited). Nothing here exposes
 * messages, member lists or anyone's data.
 */
export default async function opsRoutes(app: FastifyInstance, ctx: AppContext, version: string) {
  const auth = { preHandler: requireAuth(ctx) };
  const requirePlatformAdmin = (userId: string) => {
    if (!ctx.config.platformAdmins.has(userId)) throw forbidden("Only platform administrators can do that");
  };
  /** A workspace's own limits, as stored (expired ones included). */
  const ownLimits = (orgId: string) =>
    ctx.ws.all<{ key: string; limit_value: number }>("org_entitlements", { where: { org_id: orgId } }).map((r) => ({ key: r.key, limit: r.limit_value }));

  /** Whether the caller is a platform admin (the app shows Service health then). Moved here from the removed apps API. */
  app.get("/v1/platform/me", auth, async (req) => ({ platformAdmin: ctx.config.platformAdmins.has(me(req).userId) }));

  app.get("/v1/admin/health", auth, async (req) => {
    requirePlatformAdmin(me(req).userId);
    return { health: await healthReport(ctx, version) };
  });

  // ───────────── Connector register (docs/CONNECTORS.md) ─────────────
  /** Every outside service with its measured state and the setting names still missing (never values). */
  app.get("/v1/admin/connectors", auth, async (req) => {
    requirePlatformAdmin(me(req).userId);
    return { connectors: await connectorReport(ctx), checkable: CHECKS };
  });

  /** A check that sends nothing to anyone and costs nothing (sign in to SMTP, list storage, FCM token, Mongo ping). */
  app.post("/v1/admin/connectors/:id/check", auth, async (req) => {
    const userId = me(req).userId;
    requirePlatformAdmin(userId);
    const { id } = parse(ConnectorParams, req.params);
    const result = await checkConnector(ctx, id);
    ctx.audit({ actorId: userId, action: "connector.check", target: id, detail: result.ok ? "ok" : result.errorKind });
    return { result, connectors: await connectorReport(ctx) };
  });

  // ───────────── Usage and limits across workspaces (round 7 slice C7, docs/USAGE_AND_PLANS.md) ─────────────
  /** Every workspace with its size and measured usage over [days]: counts only, no content or member names. */
  app.get("/v1/admin/usage", auth, async (req) => {
    requirePlatformAdmin(me(req).userId);
    const { days } = parse(UsageQuery, req.query);
    await ctx.usage.snapshot();
    const totals = new Map(ctx.usage.totals(days).map((r) => [r.orgId, r.metrics]));
    const orgs = ctx.ws.all<{ id: string; name: string; created_at: number }>("orgs", { orderBy: [["created_at", "asc"]] });
    return {
      days,
      workspaces: orgs.map((o) => ({
        id: o.id, name: o.name, createdAt: o.created_at, usage: totals.get(o.id) ?? {},
        limits: ownLimits(o.id),
      })),
    };
  });

  /** A workspace's own limits; null clears one (the server-wide limit, if any, applies again). Audited. */
  app.put("/v1/admin/orgs/:orgId/limits", auth, async (req) => {
    const actor = me(req).userId;
    requirePlatformAdmin(actor);
    const { orgId } = parse(LimitsParams, req.params);
    if (!ctx.ws.get("orgs", { id: orgId })) throw notFound("Workspace not found");
    const { limits } = parse(LimitsBody, req.body);
    const unknown = Object.keys(limits).filter((k) => !isEntitlementKey(k));
    if (unknown.length) throw badRequest(`Unknown limits: ${unknown.join(", ")}`, { known: ENTITLEMENT_KEYS });
    await ctx.entitlements.setLimits(orgId, actor, limits as Partial<Record<EntitlementKey, number | null>>, Date.now());
    ctx.audit({ actorId: actor, orgId, action: "plan.limits", detail: Object.entries(limits).map(([k, v]) => `${k}=${v ?? "default"}`).join(",") });
    return { limits: ownLimits(orgId) };
  });
}
