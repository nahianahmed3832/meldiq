import type { FastifyInstance } from "fastify";
import { AdminOrgParams, AdminReasonBody, AdminUserParams } from "../../shared/contracts/http/platformAdmin.js";
import {
  AdminControlBody,
  AdminControlParams,
  AdminAdjustBody,
  AdminDaysQuery,
  AdminDeleteUserBody,
  AdminDevicesQuery,
  AdminDeviceTarget,
  AdminDisconnectBody,
  AdminExportParams,
  AdminExportQuery,
  AdminOrgMemberTarget,
  AdminPlanBody,
  AdminPlanMemberBody,
  AdminPlanParams,
  AdminPolicyBody,
  AdminPolicyParams,
  AdminQuotaEffectiveQuery,
  AdminQuotaEventsQuery,
  AdminRangeQuery,
  AdminRuleBody,
  AdminRuleParams,
  AdminSearchQuery,
  AdminSeriesQuery,
  AdminSessionTarget,
  AdminSettingBody,
  AdminSettingParams,
  AdminSiteDetailsBody,
} from "../../shared/contracts/http/platformAdminInsights.js";
import { parse } from "../../shared/validation/index.js";
import { AlertEngine } from "./alerts.js";
import { AdminAnalytics } from "./analyticsView.js";
import type { AdminDeps } from "./dataRoutes.js";
import { AdminControls } from "./controlsAdmin.js";
import { AdminSite } from "./siteAdmin.js";
import { AdminDevices } from "./devicesView.js";
import { Exclusions } from "./exclusions.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import { AdminInsights, liftExpiredSuspensions } from "./insights.js";
import type { Permission } from "./permissions.js";
import { AdminQuotas } from "./quotasAdmin.js";
import { AdminResources } from "./resourcesView.js";
import { AdminSearchExport } from "./searchExport.js";
import { AdminSettings } from "./settingsAdmin.js";

/** Platform Admin 2.0 (meldiq_central_admin/docs/ADMIN_2_ASSESSMENT.md). Every route names its permission. */
export default async function adminInsightsRoutes(app: FastifyInstance, d: AdminDeps) {
  const needs = (permission: Permission) => ({ preHandler: requirePermission(d.auth, d.audit, permission) });
  const exclusions = new Exclusions(d.ctx, d.store);
  const analytics = new AdminAnalytics(d.ctx, exclusions);
  const devices = new AdminDevices(d.ctx, d.store, d.audit, exclusions);
  const quotas = new AdminQuotas(d.ctx, d.audit);
  const insights = new AdminInsights(d.ctx, d.store, d.audit, quotas, exclusions);
  const resources = new AdminResources(d.ctx, d.version);
  const alerts = new AlertEngine(d.ctx, d.store);
  const settings = new AdminSettings(d.ctx, d.audit, alerts, exclusions);
  const controls = new AdminControls(d.ctx, d.audit);
  const site = new AdminSite(d.ctx, d.audit);
  const search = new AdminSearchExport(d.ctx, d.audit, exclusions);

  // The console's minute job: alert rules, temporary suspensions that ended, quota reservations, exclusions for live counts.
  const minute = async () => {
    await alerts.evaluate();
    await liftExpiredSuspensions(d.ctx, d.audit);
    await exclusions.get();
  };
  const tick = d.ctx.config.telemetryTickMs;
  if (tick > 0) {
    const timer = setInterval(() => void d.ctx.metrics.timeJob("console.minute", minute).catch((e) => d.ctx.log.error({ err: e }, "console minute job failed")), tick);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  // ── Analytics ──
  app.get("/admin/v1/analytics/overview", needs("analytics.view"), async (req) => analytics.overview(principal(req), parse(AdminRangeQuery, req.query).range));
  app.get("/admin/v1/analytics/active-users", needs("analytics.view"), async (req) => analytics.activeUsers(parse(AdminDaysQuery, req.query)));
  app.get("/admin/v1/analytics/retention", needs("analytics.view"), async (req) => analytics.retention(parse(AdminDaysQuery, req.query)));
  app.get("/admin/v1/analytics/clients", needs("analytics.view"), async (req) => analytics.clients(parse(AdminDaysQuery, req.query)));
  app.get("/admin/v1/analytics/organizations", needs("analytics.view"), async (req) => analytics.organizations(parse(AdminDaysQuery, req.query)));
  app.get("/admin/v1/analytics/traffic", needs("resources.view"), async (req) => analytics.traffic(parse(AdminDaysQuery, req.query)));

  // ── Live connections ──
  app.get("/admin/v1/presence", needs("analytics.view"), async (req) => devices.presence(parse(AdminRangeQuery, req.query).range));
  app.get("/admin/v1/presence/connections", needs("presence.view"), async () => devices.connections());
  app.post("/admin/v1/presence/disconnect", needs("users.sessions.revoke"), async (req) => {
    const b = parse(AdminDisconnectBody, req.body);
    return devices.disconnect(principal(req), b.userId, b.deviceId, b.reason, metaOf(req));
  });

  // ── Devices and sessions ──
  app.get("/admin/v1/devices", needs("devices.view"), async (req) => devices.inventory(parse(AdminDevicesQuery, req.query)));
  app.get("/admin/v1/users/:userId/devices", needs("devices.view"), async (req) => devices.ofUser(parse(AdminUserParams, req.params).userId));
  app.post("/admin/v1/users/:userId/sessions/:sessionId/revoke", needs("users.sessions.revoke"), async (req) => {
    const { userId, sessionId } = parse(AdminSessionTarget, req.params);
    return devices.revokeSession(principal(req), userId, sessionId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });
  app.post("/admin/v1/users/:userId/devices/:deviceId/revoke", needs("devices.revoke"), async (req) => {
    const { userId, deviceId } = parse(AdminDeviceTarget, req.params);
    return devices.revokeDevice(principal(req), userId, deviceId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });

  // ── People and organizations ──
  app.get("/admin/v1/users/:userId/insights", needs("users.view"), async (req) => insights.user(parse(AdminUserParams, req.params).userId));
  app.post("/admin/v1/users/:userId/verification-email", needs("users.recovery"), async (req) =>
    insights.sendEmail(principal(req), parse(AdminUserParams, req.params).userId, "verification", parse(AdminReasonBody, req.body).reason, metaOf(req)),
  );
  app.post("/admin/v1/users/:userId/password-reset-email", needs("users.recovery"), async (req) =>
    insights.sendEmail(principal(req), parse(AdminUserParams, req.params).userId, "password_reset", parse(AdminReasonBody, req.body).reason, metaOf(req)),
  );
  app.post("/admin/v1/users/:userId/delete", needs("users.delete"), async (req) => {
    const { reason, confirm } = parse(AdminDeleteUserBody, req.body);
    return insights.deleteUser(principal(req), parse(AdminUserParams, req.params).userId, reason, confirm, metaOf(req));
  });
  app.get("/admin/v1/orgs/:orgId/insights", needs("orgs.view"), async (req) => insights.org(parse(AdminOrgParams, req.params).orgId));
  app.post("/admin/v1/orgs/:orgId/members/:userId/remove", needs("orgs.members.manage"), async (req) => {
    const { orgId, userId } = parse(AdminOrgMemberTarget, req.params);
    return insights.removeMember(principal(req), orgId, userId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });

  // ── Resources ──
  app.get("/admin/v1/resources", needs("resources.view"), async () => resources.report());
  app.get("/admin/v1/resources/series", needs("resources.view"), async (req) => {
    const q = parse(AdminSeriesQuery, req.query);
    return resources.series(q.series, q.range);
  });

  // ── Quotas ──
  app.get("/admin/v1/quotas", needs("quotas.view"), async () => quotas.overview());
  app.get("/admin/v1/quotas/effective", needs("quotas.view"), async (req) => {
    const q = parse(AdminQuotaEffectiveQuery, req.query);
    return { quotas: quotas.effective({ type: q.scopeType, id: q.scopeId }) };
  });
  app.get("/admin/v1/quotas/events", needs("quotas.view"), async (req) => quotas.events(parse(AdminQuotaEventsQuery, req.query)));
  app.post("/admin/v1/quotas/policies", needs("quotas.edit"), async (req) => quotas.setPolicy(principal(req), parse(AdminPolicyBody, req.body), metaOf(req)));
  app.post("/admin/v1/quotas/policies/:policyId/remove", needs("quotas.edit"), async (req) =>
    quotas.removePolicy(principal(req), parse(AdminPolicyParams, req.params).policyId, parse(AdminReasonBody, req.body).reason, metaOf(req)),
  );
  app.post("/admin/v1/quotas/plans", needs("quotas.edit"), async (req) => quotas.createPlan(principal(req), parse(AdminPlanBody, req.body), metaOf(req)));
  app.post("/admin/v1/quotas/plans/:planId/members", needs("quotas.edit"), async (req) =>
    quotas.assignPlan(principal(req), parse(AdminPlanParams, req.params).planId, parse(AdminPlanMemberBody, req.body), metaOf(req)),
  );
  app.post("/admin/v1/quotas/plan-members/remove", needs("quotas.edit"), async (req) => quotas.unassignPlan(principal(req), parse(AdminPlanMemberBody, req.body), metaOf(req)));
  app.post("/admin/v1/quotas/adjust", needs("quotas.edit"), async (req) => quotas.adjust(principal(req), parse(AdminAdjustBody, req.body), metaOf(req)));

  // ── Settings and alerts ──
  app.get("/admin/v1/settings", needs("settings.view"), async () => settings.list());
  app.put("/admin/v1/settings/:key", needs("settings.edit"), async (req) => {
    const { value, reason } = parse(AdminSettingBody, req.body);
    return settings.set(principal(req), parse(AdminSettingParams, req.params).key, value, reason, metaOf(req));
  });

  // ── Site and legal details (docs/SITE_DETAILS.md) ──
  app.get("/admin/v1/site", needs("settings.view"), async () => site.view());
  app.put("/admin/v1/site", needs("settings.edit"), async (req) => {
    const { details, reason } = parse(AdminSiteDetailsBody, req.body);
    return site.set(principal(req), details, reason, metaOf(req));
  });

  // ── Platform controls (docs/PLATFORM_CONTROLS.md) ──
  app.get("/admin/v1/controls", needs("settings.view"), async () => controls.list());
  app.put("/admin/v1/controls/:key", needs("controls.edit"), async (req) => {
    const { value, reason } = parse(AdminControlBody, req.body);
    return controls.set(principal(req), parse(AdminControlParams, req.params).key, value, reason, metaOf(req));
  });
  app.get("/admin/v1/alerts", needs("incidents.view"), async () => settings.alertsView());
  app.put("/admin/v1/alerts/:key", needs("alerts.manage"), async (req) => {
    const { reason, ...rule } = parse(AdminRuleBody, req.body);
    return settings.setRule(principal(req), parse(AdminRuleParams, req.params).key, { ...rule, reason }, metaOf(req));
  });
  app.post("/admin/v1/alerts/evaluate", needs("alerts.manage"), async (req) => settings.evaluate(principal(req), metaOf(req)));

  // ── Search and exports ──
  app.get("/admin/v1/search", needs("overview.view"), async (req) => search.search(principal(req), parse(AdminSearchQuery, req.query).q));
  app.get("/admin/v1/exports/:kind", needs("exports.create"), async (req, reply) => {
    const { kind } = parse(AdminExportParams, req.params);
    const out = await search.export(principal(req), kind, parse(AdminExportQuery, req.query), metaOf(req));
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${out.filename}"`).send(out.csv);
  });
}
