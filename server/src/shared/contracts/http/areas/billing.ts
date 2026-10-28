import {
  AccountEntitlements,
  BillingOrgParams,
  CheckoutStarted,
  OwnerBilling,
  OwnerBody,
  OwnerCheckoutBody,
  PortalSession,
  PublicPlans,
  Reconciled,
  ReferralClaimBody,
  ReferralClaimed,
  ReferralInfo,
} from "../billing.js";
import { route, type RouteContract } from "../route.js";

/**
 * Billing for the signed-in account and the organizations it owns (docs/BILLING.md › API). Account sessions (v2
 * tokens) are enough: the website has no device. Every answer is computed on the server from verified subscriptions.
 */
const tag = "Billing";

export const billingRoutes: readonly RouteContract[] = [
  route({ method: "GET", url: "/v2/billing/plans", tag, summary: "The plans that can be bought now, with their prices (public).", auth: false, response: PublicPlans }),
  route({
    method: "GET",
    url: "/v2/billing/entitlements",
    tag,
    summary: "What the signed-in account has: its own plan and each organization's, with limits. The same answer on every device.",
    auth: true,
    response: AccountEntitlements,
  }),
  route({ method: "GET", url: "/v2/billing/account", tag, summary: "The signed-in account's own subscription, invoices and the personal plans on offer.", auth: true, response: OwnerBilling }),
  route({
    method: "GET",
    url: "/v2/billing/orgs/:orgId",
    tag,
    summary: "An organization's subscription, invoices and the plans on offer (its owners only).",
    auth: true,
    params: BillingOrgParams,
    response: OwnerBilling,
    errors: ["forbidden", "not_found"],
  }),
  route({
    method: "POST",
    url: "/v2/billing/checkout",
    tag,
    summary: "Start a hosted checkout for a plan, for the account or an organization it owns. Paying grants nothing until the provider confirms.",
    auth: true,
    body: OwnerCheckoutBody,
    response: CheckoutStarted,
    errors: ["billing_unavailable", "conflict", "forbidden", "not_found", "unavailable"],
  }),
  route({
    method: "POST",
    url: "/v2/billing/portal",
    tag,
    summary: "Open the provider's customer portal (payment method, invoices, plan changes, cancellation).",
    auth: true,
    body: OwnerBody,
    response: PortalSession,
    errors: ["billing_unavailable", "forbidden", "not_found", "unavailable"],
  }),
  route({
    method: "POST",
    url: "/v2/billing/sync",
    tag,
    summary: "Read the subscription from the provider again (after checkout, or to restore a missed update).",
    auth: true,
    body: OwnerBody,
    response: Reconciled,
    errors: ["billing_unavailable", "forbidden", "not_found", "unavailable"],
  }),
  route({ method: "GET", url: "/v2/billing/referral", tag, summary: "The signed-in account's invite link code and what it has earned.", auth: true, response: ReferralInfo }),
  route({
    method: "POST",
    url: "/v2/billing/referral/claim",
    tag,
    summary: "A new account signed up through an invite link: both get the invite trial (the inviter up to a yearly cap).",
    auth: true,
    body: ReferralClaimBody,
    response: ReferralClaimed,
    errors: ["billing_unavailable", "conflict", "not_found"],
  }),
];
