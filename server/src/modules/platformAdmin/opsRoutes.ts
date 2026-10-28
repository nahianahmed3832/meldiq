import type { FastifyInstance } from "fastify";
import {
  AdminAccountParams,
  AdminAuditQuery,
  AdminConnectorParams,
  AdminGrantBody,
  AdminIncidentCreate,
  AdminIncidentNote,
  AdminIncidentParams,
  AdminIncidentPatch,
  AdminIncidentsQuery,
  AdminLimitsBody,
  AdminOrgParams,
  AdminReasonBody,
  AdminRoleBody,
  AdminSessionParams,
} from "../../shared/contracts/http/platformAdmin.js";
import {
  AdminBillingEventParams,
  AdminBillingEventsQuery,
  AdminBillingMetricsQuery,
  AdminMojoAccountParams,
  AdminMojoControlsBody,
  AdminMojoGiftsQuery,
  AdminMojoGrantBody,
  AdminMojoGrantParams,
  AdminMojoGrantsQuery,
  AdminPlanCreate,
  AdminProgramBody,
  AdminPlanMeta,
  AdminBillingPlanParams,
  AdminPlanTerms,
  AdminSubscriptionParams,
  AdminSubscriptionsQuery,
} from "../../shared/contracts/http/platformAdminBilling.js";
import { parse } from "../../shared/validation/index.js";
import { AdminAdmins } from "./admins.js";
import { AdminAuditView } from "./auditView.js";
import { AdminBilling } from "./billing.js";
import type { AdminDeps } from "./dataRoutes.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import { AdminIncidents } from "./incidents.js";
import { AdminInfrastructure } from "./infrastructure.js";
import { AdminMojo } from "./mojo.js";
import type { Permission } from "./permissions.js";

/** Billing status and limits, infrastructure, incidents, the audit viewer and admin management (phase 4). */
export default async function adminOpsRoutes(app: FastifyInstance, d: AdminDeps) {
  const needs = (permission: Permission) => ({ preHandler: requirePermission(d.auth, d.audit, permission) });
  const billing = new AdminBilling(d.ctx, d.audit);
  const mojo = new AdminMojo(d.ctx, d.audit);
  const infra = new AdminInfrastructure(d.ctx, d.audit, d.version);
  const incidents = new AdminIncidents(d.ctx, d.store, d.audit);
  const auditView = new AdminAuditView(d.ctx, d.audit);
  const admins = new AdminAdmins(d.ctx, d.store, d.audit);

  // ── Entitlements and billing status ──
  app.get("/admin/v1/entitlements", needs("entitlements.view"), async () => billing.overview());
  app.put("/admin/v1/orgs/:orgId/limits", needs("entitlements.edit"), async (req) => {
    const { orgId } = parse(AdminOrgParams, req.params);
    const { limits, expiresAt, reason } = parse(AdminLimitsBody, req.body);
    return billing.setLimits(principal(req), orgId, limits, expiresAt, reason, metaOf(req));
  });

  // ── Billing: catalog, subscriptions, provider events, figures (docs/BILLING.md) ──
  app.get("/admin/v1/billing/metrics", needs("billing.view"), async (req) => billing.metrics(parse(AdminBillingMetricsQuery, req.query).days));
  app.get("/admin/v1/billing/plans", needs("billing.view"), async () => billing.plans());
  app.post("/admin/v1/billing/plans", needs("billing.manage"), async (req) => billing.createPlan(principal(req), parse(AdminPlanCreate, req.body), metaOf(req)));
  app.patch("/admin/v1/billing/plans/:planId", needs("billing.manage"), async (req) => {
    const { planId } = parse(AdminBillingPlanParams, req.params);
    return billing.updatePlan(principal(req), planId, parse(AdminPlanMeta, req.body), metaOf(req));
  });
  app.put("/admin/v1/billing/plans/:planId/draft", needs("billing.manage"), async (req) => {
    const { planId } = parse(AdminBillingPlanParams, req.params);
    const { terms, reason } = parse(AdminPlanTerms, req.body);
    return billing.saveDraft(principal(req), planId, terms, reason, metaOf(req));
  });
  app.post("/admin/v1/billing/plans/:planId/publish", needs("billing.manage"), async (req) => {
    const { planId } = parse(AdminBillingPlanParams, req.params);
    return billing.publish(principal(req), planId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });
  app.post("/admin/v1/billing/plans/:planId/archive", needs("billing.manage"), async (req) => {
    const { planId } = parse(AdminBillingPlanParams, req.params);
    return billing.archive(principal(req), planId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });
  app.get("/admin/v1/billing/subscriptions", needs("billing.view"), async (req) => billing.subscriptions(parse(AdminSubscriptionsQuery, req.query)));
  app.get("/admin/v1/billing/subscriptions/:subscriptionId", needs("billing.view"), async (req) => billing.subscription(parse(AdminSubscriptionParams, req.params).subscriptionId));
  app.get("/admin/v1/billing/events", needs("billing.view"), async (req) => billing.events(parse(AdminBillingEventsQuery, req.query)));
  app.post("/admin/v1/billing/events/:eventId/replay", needs("billing.events.replay"), async (req) => {
    const { eventId } = parse(AdminBillingEventParams, req.params);
    return billing.replay(principal(req), eventId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });

  // ── Meldiq Mojo: the trial and invite program, free periods (docs/BILLING.md › Running trials from the console) ──
  app.get("/admin/v1/billing/program", needs("billing.view"), async (req) => mojo.program(principal(req)));
  app.put("/admin/v1/billing/program", needs("billing.manage"), async (req) => mojo.setProgram(principal(req), parse(AdminProgramBody, req.body), metaOf(req)));
  app.get("/admin/v1/billing/grants", needs("billing.view"), async (req) => mojo.grants(principal(req), parse(AdminMojoGrantsQuery, req.query)));
  app.post("/admin/v1/billing/grants", needs("billing.manage"), async (req) => mojo.give(principal(req), parse(AdminMojoGrantBody, req.body), metaOf(req)));
  app.post("/admin/v1/billing/grants/:grantId/end", needs("billing.manage"), async (req) => {
    const { grantId } = parse(AdminMojoGrantParams, req.params);
    return mojo.end(principal(req), grantId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });
  app.get("/admin/v1/billing/accounts/:accountId", needs("billing.view"), async (req) => mojo.account(principal(req), parse(AdminMojoAccountParams, req.params).accountId));
  app.get("/admin/v1/billing/mojo", needs("billing.view"), async () => mojo.controls());
  app.put("/admin/v1/billing/mojo", needs("billing.manage"), async (req) => mojo.setControls(principal(req), parse(AdminMojoControlsBody, req.body), metaOf(req)));
  app.get("/admin/v1/billing/gifts", needs("billing.view"), async (req) => mojo.gifts(principal(req), parse(AdminMojoGiftsQuery, req.query)));
  app.get("/admin/v1/billing/sparks", needs("billing.view"), async () => mojo.sparks());

  // ── Infrastructure ──
  app.get("/admin/v1/infrastructure", needs("health.view"), async () => infra.report());
  app.post("/admin/v1/connectors/:id/check", needs("connectors.check"), async (req) => {
    const { id } = parse(AdminConnectorParams, req.params);
    return infra.check(principal(req), id, metaOf(req));
  });

  // ── Incidents ──
  app.get("/admin/v1/incidents", needs("incidents.view"), async (req) => incidents.list(parse(AdminIncidentsQuery, req.query)));
  app.post("/admin/v1/incidents", needs("incidents.manage"), async (req) => incidents.create(principal(req), parse(AdminIncidentCreate, req.body), metaOf(req)));
  app.get("/admin/v1/incidents/assignees", needs("incidents.manage"), async () => incidents.assignees());
  app.get("/admin/v1/incidents/:incidentId", needs("incidents.view"), async (req) => incidents.detail(parse(AdminIncidentParams, req.params).incidentId));
  app.patch("/admin/v1/incidents/:incidentId", needs("incidents.manage"), async (req) => {
    const { incidentId } = parse(AdminIncidentParams, req.params);
    return incidents.update(principal(req), incidentId, parse(AdminIncidentPatch, req.body), metaOf(req));
  });
  app.post("/admin/v1/incidents/:incidentId/notes", needs("incidents.manage"), async (req) => {
    const { incidentId } = parse(AdminIncidentParams, req.params);
    return incidents.note(principal(req), incidentId, parse(AdminIncidentNote, req.body).body, metaOf(req));
  });

  // ── Audit ──
  app.get("/admin/v1/audit", needs("audit.view"), async (req) => auditView.search(parse(AdminAuditQuery, req.query)));
  app.get("/admin/v1/audit/verify", needs("audit.view"), async () => auditView.verify());

  // ── Admins ──
  app.get("/admin/v1/admins", needs("admins.view"), async () => admins.list());
  app.post("/admin/v1/admins", needs("admins.manage"), async (req) => {
    const { email, role, reason } = parse(AdminGrantBody, req.body);
    return admins.grant(principal(req), email, role, reason, metaOf(req));
  });
  app.patch("/admin/v1/admins/:accountId", needs("admins.manage"), async (req) => {
    const { accountId } = parse(AdminAccountParams, req.params);
    const { role, reason } = parse(AdminRoleBody, req.body);
    return admins.changeRole(principal(req), accountId, role, reason, metaOf(req));
  });
  app.post("/admin/v1/admins/:accountId/revoke", needs("admins.manage"), async (req) => {
    const { accountId } = parse(AdminAccountParams, req.params);
    return admins.revoke(principal(req), accountId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });
  app.post("/admin/v1/admins/:accountId/reset-passkeys", needs("admins.manage"), async (req) => {
    const { accountId } = parse(AdminAccountParams, req.params);
    return admins.resetPasskeys(principal(req), accountId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });
  app.get("/admin/v1/admins/:accountId/sessions", needs("admins.view"), async (req) => admins.sessions(principal(req), parse(AdminAccountParams, req.params).accountId));
  app.post("/admin/v1/admin-sessions/:sessionId/revoke", needs("admins.manage"), async (req) => {
    const { sessionId } = parse(AdminSessionParams, req.params);
    return admins.revokeSession(principal(req), sessionId, parse(AdminReasonBody, req.body).reason, metaOf(req));
  });
}
