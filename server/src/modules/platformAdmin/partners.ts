import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import {
  listPartnerApplications,
  reviewPartnerApplication,
} from "../organizations/index.js";
import { OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
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
  app.put("/admin/v1/partner-applications/:orgId", auth, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params),
      body = parse(PartnerReview, req.body),
      p = principal(req);
    const application = await reviewPartnerApplication(
      d.ctx,
      orgId,
      { accountId: p.account.id, userId: p.account.user_id },
      body,
    );
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
