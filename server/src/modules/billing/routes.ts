import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  BillingOrgParams,
  BillingProviderParams,
  CheckoutBody,
  OwnerBody,
  OwnerCheckoutBody,
  ReferralClaimBody,
} from "../../shared/contracts/http/billing.js";
import { OrgParams } from "../../shared/contracts/http/orgs.js";
import {
  badRequest,
  forbidden,
  notFound,
  unauthorized,
} from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { parse } from "../../shared/validation/index.js";
import { ENTITLEMENT_KEYS } from "../administration/index.js";
import { authenticateRequest, bearer, me, requireAuth } from "../auth/index.js";
import { orgNames } from "../organizations/index.js";
import { resolveEntitlements } from "./entitlements.js";
import type { BillingOwner } from "./owners.js";
import type { CheckoutStarter } from "./service.js";
import { mojoRoutes } from "./mojoRoutes.js";
import { isAddonPlanKey } from "./perks.js";

const WEBHOOK_BODY_LIMIT = 256 * 1024;
/** Starting checkouts and portal sessions calls the provider: a person needs a handful a minute at most. */
const PROVIDER_CALLS_PER_MINUTE = 10;

/** The signed-in account behind a v2 access token (with or without a device: the website has none). */
interface BillingSession {
  accountId: string;
  userId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    billingSession?: BillingSession;
  }
}

/**
 * Billing routes (docs/BILLING.md). Billing authority is the account itself for its own subscription, and an
 * organization's OWNER role for the organization's: members and admins see the plan name and limits (GET
 * /v1/orgs/:id/plan, GET /v2/billing/entitlements) but not invoices, and can't start a checkout.
 */
export default async function billingRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const auth = { preHandler: requireAuth(ctx) };
  const requireOwner = (orgId: string, userId: string) => {
    if (ctx.authz.requireOrgMember(orgId, userId) !== "OWNER")
      throw forbidden("Only the community's owners manage its billing");
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
    ctx.audit({
      actorId: userId,
      orgId,
      action: "billing.checkout",
      target: started.checkoutId,
      detail: planKey,
    });
    return started;
  });

  // ───────────── v2: account sessions (website, web app, every app) ─────────────

  const requireAccount = async (req: FastifyRequest) => {
    const s = await ctx.accounts.service.sessions.authenticate(
      bearer(req),
      now(),
    );
    if (!s) throw unauthorized();
    req.billingSession = { accountId: s.account_id, userId: s.user_id };
    // A personal subscription or free period from before the account had an encryption identity learns it here (quota plans).
    if (s.user_id) {
      await ctx.billing.subscriptions.linkOwnerUser(s.account_id, s.user_id);
      await ctx.billing.grants.linkUser(s.account_id, s.user_id);
    }
  };
  const session = (req: FastifyRequest): BillingSession => {
    if (!req.billingSession) throw unauthorized();
    return req.billingSession;
  };
  const authed = { preHandler: requireAccount };
  /**
   * Meldiq Mojo's own routes take a device session too (browsers and phones linked before email sign-in): the person is
   * then found by their encryption identity, and the account by it when there is one.
   */
  const requireAccountOrDevice = async (req: FastifyRequest) => {
    const s = await ctx.accounts.service.sessions.authenticate(
      bearer(req),
      now(),
    );
    if (s) return requireAccount(req);
    const device = await authenticateRequest(ctx, req);
    if (!device) throw unauthorized();
    req.auth = device;
    const account = await ctx.accounts.store.accountByUserId(device.userId);
    req.billingSession = {
      accountId: account?.id ?? "",
      userId: device.userId,
    };
  };
  const providerCall = {
    preHandler: requireAccount,
    config: {
      rateLimit: { max: PROVIDER_CALLS_PER_MINUTE, timeWindow: "1 minute" },
    },
  };

  /** The owner a request may act for: the account itself, or an organization it owns (404 when it isn't a member). */
  const ownerFor = (
    s: BillingSession,
    orgId: string | undefined,
  ): BillingOwner => {
    if (!orgId) return { kind: "account", accountId: s.accountId };
    if (!s.userId || !ctx.authz.orgRole(orgId, s.userId))
      throw notFound("Organization not found");
    requireOwner(orgId, s.userId);
    return { kind: "org", orgId };
  };

  const starterFor = async (
    s: BillingSession,
    owner: BillingOwner,
  ): Promise<CheckoutStarter> => {
    const account = await ctx.accounts.store.accountById(s.accountId);
    if (!account) throw unauthorized();
    if (!account.email_verified_at)
      throw forbidden("Verify your email address before subscribing");
    const name =
      owner.kind === "org"
        ? (orgNames(ctx.ws, [owner.orgId]).get(owner.orgId) ?? null)
        : account.name || null;
    return {
      accountId: account.id,
      userId: s.userId,
      email: account.email,
      name,
    };
  };

  app.get("/v2/billing/plans", async () => ctx.billing.publicCatalog());

  /** The signed-in account, with its trial recorded the first time it's looked at (trials on, from its sign-up time). */
  const accountWithTrial = async (s: BillingSession) => {
    const account = await ctx.accounts.store.accountById(s.accountId);
    if (!account) throw unauthorized();
    await ctx.billing.grants.ensureSignupTrial({
      accountId: account.id,
      createdAt: account.created_at,
      userId: s.userId,
    });
    return account;
  };

  app.get("/v2/billing/entitlements", authed, async (req) => {
    const s = session(req);
    const account = await accountWithTrial(s);
    const organizations = ctx.accounts.workspaces
      .list(account)
      .workspaces.filter((w) => w.kind === "organization")
      .map((w) => ({ orgId: w.id, name: w.name, role: w.role }));
    const orgLimits = (orgId: string) =>
      ENTITLEMENT_KEYS.map((key) => ({
        key,
        ...ctx.entitlements.limitFor(key, orgId),
      }));
    return resolveEntitlements(
      ctx.billing,
      { accountId: s.accountId, userId: s.userId, organizations },
      orgLimits,
      now(),
    );
  });

  app.get("/v2/billing/account", authed, async (req) => {
    const s = session(req);
    await accountWithTrial(s);
    return ctx.billing.summary({ kind: "account", accountId: s.accountId });
  });

  // Invite links (docs/BILLING.md › Trials and invite links).
  app.get(
    "/v2/billing/referral",
    authed,
    async (req) => await ctx.billing.grants.stats(session(req).accountId),
  );

  app.post("/v2/billing/referral/claim", providerCall, async (req) => {
    const s = session(req);
    const { code } = parse(ReferralClaimBody, req.body);
    const account = await accountWithTrial(s);
    const claimed = await ctx.billing.grants.claim(
      {
        accountId: account.id,
        createdAt: account.created_at,
        userId: s.userId,
      },
      code,
    );
    const inviter = ctx.billing.grants.inviterOf(code);
    ctx.audit({
      actorId: s.userId ?? s.accountId,
      action: "billing.referral",
      target: inviter,
      detail: `inviter_days:${claimed.inviterDays}`,
    });
    for (const accountId of [account.id, inviter])
      if (accountId) ctx.billing.onChange?.({ kind: "account", accountId });
    return claimed;
  });

  app.get("/v2/billing/orgs/:orgId", authed, async (req) => {
    const { orgId } = parse(BillingOrgParams, req.params);
    return ctx.billing.summary(ownerFor(session(req), orgId));
  });

  app.post("/v2/billing/checkout", providerCall, async (req) => {
    const s = session(req);
    const { planKey, orgId, returnTo } = parse(OwnerCheckoutBody, req.body);
    const owner = ownerFor(s, orgId);
    // The Spark add-on has its own route (a quantity): this one buys plans.
    if (isAddonPlanKey(planKey)) throw notFound("No such plan");
    const started = await ctx.billing.startOwnerCheckout(
      owner,
      await starterFor(s, owner),
      planKey,
      { returnUrl: ctx.billing.returnTo(returnTo) },
    );
    ctx.audit({
      actorId: s.userId ?? s.accountId,
      orgId: orgId ?? null,
      action: "billing.checkout",
      target: started.checkoutId,
      detail: planKey,
    });
    return started;
  });

  app.post("/v2/billing/portal", providerCall, async (req) => {
    const s = session(req);
    const { orgId, returnTo } = parse(OwnerBody, req.body ?? {});
    const opened = await ctx.billing.portal(
      ownerFor(s, orgId),
      ctx.billing.returnTo(returnTo),
    );
    ctx.audit({
      actorId: s.userId ?? s.accountId,
      orgId: orgId ?? null,
      action: "billing.portal",
      target: orgId ?? s.accountId,
    });
    return opened;
  });

  app.post("/v2/billing/sync", providerCall, async (req) => {
    const s = session(req);
    const { orgId } = parse(OwnerBody, req.body ?? {});
    return ctx.billing.reconcile(ownerFor(s, orgId));
  });

  // Meldiq Mojo: the catalog, Sparks, gifts and badges (docs/MOJO.md).
  mojoRoutes(app, ctx, {
    authed: { preHandler: requireAccountOrDevice },
    providerCall: { ...providerCall, preHandler: requireAccountOrDevice },
    session,
    starterFor: (s, owner) => starterFor(s, owner),
    userNames: ctx.userNames,
  });

  // Google Play's real-time developer notifications (Pub/Sub push, API 0.55.0): authenticated by Google's OIDC token, not
  // a body signature, so the body is parsed as usual. The notification only says what to ask Google about.
  app.post("/v1/billing/webhooks/google_play", async (req) => {
    if (!ctx.play) throw notFound();
    return ctx.play.notification(req.headers.authorization, req.body);
  });

  // Provider webhooks: no session, the signature is the proof. The body is kept exactly as sent, for the signature.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: WEBHOOK_BODY_LIMIT },
      (_req, body, done) => done(null, body),
    );
    scope.post("/v1/billing/webhooks/:provider", async (req) => {
      const { provider } = parse(BillingProviderParams, req.params);
      if (typeof req.body !== "string")
        throw badRequest("Expected a JSON body");
      return ctx.billing.webhooks.receive(provider, req.headers, req.body);
    });
  });
}
