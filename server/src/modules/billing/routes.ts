import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { BillingProviderParams, CheckoutBody } from "../../shared/contracts/http/billing.js";
import { OrgParams } from "../../shared/contracts/http/orgs.js";
import { badRequest, forbidden } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";

const WEBHOOK_BODY_LIMIT = 256 * 1024;

/**
 * Billing routes (docs/BILLING.md). Billing authority is an organization's OWNER role: members and admins see the plan
 * name and limits (GET /v1/orgs/:id/plan) but not invoices, and can't start a checkout.
 */
export default async function billingRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const requireOwner = (orgId: string, userId: string) => {
    if (ctx.authz.requireOrgMember(orgId, userId) !== "OWNER") throw forbidden("Only the community's owners manage its billing");
  };

  app.get("/v1/orgs/:orgId/billing", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    requireOwner(orgId, me(req).userId);
    return ctx.billing.orgSummary(orgId);
  });

  app.post("/v1/orgs/:orgId/billing/checkout", auth, async (req) => {
    const { userId } = me(req);
    const { orgId } = parse(OrgParams, req.params);
    requireOwner(orgId, userId);
    const { planKey } = parse(CheckoutBody, req.body);
    const started = await ctx.billing.startCheckout(orgId, userId, planKey);
    ctx.audit({ actorId: userId, orgId, action: "billing.checkout", target: started.checkoutId, detail: planKey });
    return started;
  });

  // Provider webhooks: no session, the signature is the proof. The body is kept exactly as sent, for the signature.
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: WEBHOOK_BODY_LIMIT }, (_req, body, done) => done(null, body));
    scope.post("/v1/billing/webhooks/:provider", async (req) => {
      const { provider } = parse(BillingProviderParams, req.params);
      if (typeof req.body !== "string") throw badRequest("Expected a JSON body");
      return ctx.billing.webhooks.receive(provider, req.headers, req.body);
    });
  });
}
