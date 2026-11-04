import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { partnerView, type PartnerRow } from "../organizations/index.js";
import { OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
import { PartnerReview } from "../../shared/contracts/http/partners.js";
import { parse } from "../../shared/validation/index.js";
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
} from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
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
    const rows = d.ctx.ws.all<PartnerRow>("org_partner_applications", {
      where: {
        status: "submitted",
        ...(q.after ? { org_id: { gt: q.after } } : {}),
      },
      orderBy: [["org_id", "asc"]],
      limit: q.limit + 1,
    });
    return {
      applications: rows.slice(0, q.limit).map(partnerView),
      nextAfter: rows.length > q.limit ? rows[q.limit - 1].org_id : null,
    };
  });
  app.put("/admin/v1/partner-applications/:orgId", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params),
      body = parse(PartnerReview, req.body),
      p = principal(req);
    const application = await d.ctx.ws.write((w) => {
      const prior = w.get<PartnerRow>("org_partner_applications", {
        org_id: orgId,
      });
      if (!prior) throw notFound("Application not found");
      if (
        p.account.user_id === prior.submitted_by ||
        (p.account.user_id &&
          d.ctx.authz.orgRole(orgId, p.account.user_id) === "OWNER")
      )
        throw forbidden("Another operator must review this application");
      if (prior.rev !== body.baseRev)
        throw new ApiError(
          409,
          "stale_revision",
          "This application changed. Reload before reviewing.",
        );
      if (prior.status !== "submitted")
        throw conflict("This application was already reviewed");
      const next = {
        ...prior,
        status: body.status,
        rev: prior.rev + 1,
        reviewed_at: now(),
        reviewed_by: p.account.id,
        review_note: body.reason,
      };
      w.update("org_partner_applications", { org_id: orgId }, next);
      return partnerView(next);
    });
    await d.audit.record({
      action: "partner.review",
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "org",
      targetId: orgId,
      reason: body.reason,
      requestId: metaOf(req).requestId,
      detail: { status: application.status, rev: application.rev },
    });
    return { application };
  });
}
