import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  AdminOrgDeleteBody,
  AdminOrgRestriction,
  AdminOrgParams,
  AdminOrgsQuery,
  AdminReasonBody,
  AdminSuspendBody,
  AdminUserParams,
  AdminUsersQuery,
} from "../../shared/contracts/http/platformAdmin.js";
import { parse } from "../../shared/validation/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminAuthService } from "./auth.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import { AdminBilling } from "./billing.js";
import { AdminOrgs } from "./orgs.js";
import { overview } from "./overview.js";
import type { Permission } from "./permissions.js";
import type { PlatformAdminStore } from "./store.js";
import { AdminUsers } from "./users.js";

export interface AdminDeps {
  ctx: AppContext;
  auth: AdminAuthService;
  audit: PlatformAudit;
  store: PlatformAdminStore;
  version: string;
}

/** Overview, people and organisations (phase 3). Every route names its permission; sensitive ones need a reason. */
export default async function adminDataRoutes(app: FastifyInstance, d: AdminDeps) {
  const needs = (permission: Permission) => ({ preHandler: requirePermission(d.auth, d.audit, permission) });
  const users = new AdminUsers(d.ctx, d.store, d.audit);
  const orgs = new AdminOrgs(d.ctx, new AdminBilling(d.ctx, d.audit), d.audit);

  app.get("/admin/v1/overview", needs("overview.view"), async (req) => overview(d.ctx, principal(req), d.version));

  app.get("/admin/v1/users", needs("users.view"), async (req) => users.search(principal(req), parse(AdminUsersQuery, req.query)));

  app.get("/admin/v1/users/:userId", needs("users.view"), async (req) => {
    const { userId } = parse(AdminUserParams, req.params);
    return users.detail(principal(req), userId, metaOf(req));
  });

  app.post("/admin/v1/users/:userId/suspend", needs("users.suspend"), async (req) => {
    const { userId } = parse(AdminUserParams, req.params);
    const { reason, until } = parse(AdminSuspendBody, req.body);
    return users.setSuspended(principal(req), userId, true, reason, metaOf(req), until);
  });

  app.post("/admin/v1/users/:userId/restore", needs("users.restore"), async (req) => {
    const { userId } = parse(AdminUserParams, req.params);
    const { reason } = parse(AdminReasonBody, req.body);
    return users.setSuspended(principal(req), userId, false, reason, metaOf(req));
  });

  app.post("/admin/v1/users/:userId/sessions/revoke", needs("users.sessions.revoke"), async (req) => {
    const { userId } = parse(AdminUserParams, req.params);
    const { reason } = parse(AdminReasonBody, req.body);
    return users.revokeSessions(principal(req), userId, reason, metaOf(req));
  });

  app.delete("/admin/v1/orgs/:orgId", needs("orgs.delete"), async (req) => {
    const { orgId } = parse(AdminOrgParams, req.params);
    return orgs.delete(principal(req), orgId, parse(AdminOrgDeleteBody, req.body), metaOf(req));
  });

  app.post("/admin/v1/orgs/:orgId/restriction", needs("orgs.restrict"), async (req) => {
    const { orgId } = parse(AdminOrgParams, req.params);
    return orgs.restrict(principal(req), orgId, parse(AdminOrgRestriction, req.body), metaOf(req));
  });

  app.get("/admin/v1/orgs", needs("orgs.view"), async (req) => orgs.search(parse(AdminOrgsQuery, req.query)));

  app.get("/admin/v1/orgs/:orgId", needs("orgs.view"), async (req) => {
    const { orgId } = parse(AdminOrgParams, req.params);
    return orgs.detail(orgId);
  });
}
