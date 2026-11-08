import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import {
  listPartnerApplications,
  notifyOrg,
  partnerEligibility,
  partnerView,
  type PartnerRow,
  reviewPartnerApplication,
} from "../organizations/index.js";
import { OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
import { AdminPartnerRevoke } from "../../shared/contracts/http/adminCommunity.js";
import { notFound } from "../../shared/errors.js";
import { PartnerReview } from "../../shared/contracts/http/partners.js";
import { parse } from "../../shared/validation/index.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import type { AdminDeps } from "./dataRoutes.js";
export default async function partnerAdminRoutes(
  app: FastifyInstance,
  d: AdminDeps,
) {
  const auth = {
    preHandler: requirePermission(d.auth, d.audit, "partners.review"),
  };
  app.get("/admin/v1/partner-applications", auth, async (req) => {
    const q = parse(
      z.object({
        after: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    return listPartnerApplications(d.ctx, q);
  });
  app.get("/admin/v1/partner-applications/:orgId", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const org = d.ctx.ws.get<{ name: string }>("orgs", { id: orgId, kind: "community" });
    if (!org) throw notFound("Community not found");
    const owner = d.ctx.ws.get<{ user_id: string }>("org_members", { org_id: orgId, role: "OWNER" });
    const application = d.ctx.ws.get<PartnerRow>("org_partner_applications", { org_id: orgId });
    return {
      name: org.name,
      eligibility: owner && d.ctx.identity.get("users", { id: owner.user_id }) ? partnerEligibility(d.ctx, orgId, owner.user_id) : null,
      application: application ? partnerView(application) : null,
    };
  });
  const decide = async (
    req: FastifyRequest,
    body: { baseRev: number; status: "approved" | "declined"; reason: string },
    revoke = false,
  ) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const p = principal(req);
    const application = await reviewPartnerApplication(
      d.ctx,
      orgId,
      { accountId: p.account.id, userId: p.account.user_id },
      body,
      revoke ? "approved" : "submitted",
    );
    await d.audit.record({
      action: revoke ? "partner.revoke" : "partner.review",
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "org",
      targetId: orgId,
      reason: body.reason,
      requestId: metaOf(req).requestId,
      detail: { status: application.status, rev: application.rev },
    });
    notifyOrg(d.ctx, orgId);
    return { application };
  };
  app.put("/admin/v1/partner-applications/:orgId", auth, async (req) => decide(req, parse(PartnerReview, req.body)));
  app.post("/admin/v1/partner-applications/:orgId/revoke", auth, async (req) =>
    decide(req, { ...parse(AdminPartnerRevoke, req.body), status: "declined" }, true),
  );
}
