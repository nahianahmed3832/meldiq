import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";

/**
 * Billing for organizations' owners (docs/BILLING.md): the plans that can be bought, a hosted checkout, and the
 * organization's own subscription and invoices. Money is in the currency's minor unit (cents for USD).
 */
export const BillingProviderParams = z.strictObject({ provider: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/) });
export const CheckoutBody = z.strictObject({ planKey: z.string().trim().min(1).max(40) });

export const CheckoutStarted = z.strictObject({
  checkoutId: z.string(),
  /** The provider's hosted page; null for the sandbox provider, which has none. */
  url: z.string().nullable(),
  expiresAt: zTime,
});

const zLimits = z.record(z.string(), zCount);

export const OrgBilling = z.strictObject({
  available: z.boolean(),
  reason: z.string().nullable(),
  subscription: z
    .strictObject({
      plan: z.strictObject({ key: z.string(), name: z.string() }),
      status: z.string(),
      /** entitled | grace (payment failed, plan still applies) | grace_ended | not_entitled */
      standing: z.string(),
      interval: z.enum(["month", "year"]),
      currency: z.string(),
      amountMinor: zCount,
      currentPeriodEnd: zTime.nullable(),
      trialEnd: zTime.nullable(),
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  invoices: z.array(
    z.strictObject({
      status: z.string(),
      currency: z.string(),
      amountDueMinor: zCount,
      amountPaidMinor: zCount,
      amountRefundedMinor: zCount,
      periodStart: zTime.nullable(),
      periodEnd: zTime.nullable(),
      issuedAt: zTime,
      paidAt: zTime.nullable(),
    }),
  ),
  offers: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string(),
      description: z.string(),
      interval: z.enum(["month", "year"]),
      currency: z.string(),
      amountMinor: zCount,
      trialDays: zCount,
      limits: zLimits,
    }),
  ),
});

export const WebhookReceived = z.strictObject({ received: z.literal(true), duplicate: z.boolean(), status: z.string() });

// ───────────── Accounts API v2 (docs/BILLING.md › API): the website, the web app and every app ─────────────

const zStanding = z.enum(["entitled", "grace", "grace_ended", "not_entitled"]);
const zAudience = z.enum(["personal", "organization"]);
const zOrgId = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);

/** Whose billing: omit [orgId] for the signed-in account's own; with it, that organization's (its owners only). */
/** Where the provider's page sends the person back: the web app ("web") or the website ("site", the default). */
export const zReturnTo = z.enum(["web", "site"]);
export const OwnerBody = z.strictObject({ orgId: zOrgId.optional(), returnTo: zReturnTo.optional() });
export const OwnerCheckoutBody = z.strictObject({ planKey: z.string().trim().min(1).max(40), orgId: zOrgId.optional(), returnTo: zReturnTo.optional() });
export const BillingOrgParams = z.strictObject({ orgId: zOrgId });

export const zOffer = z.strictObject({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  audience: zAudience,
  interval: z.enum(["month", "year"]),
  currency: z.string(),
  /** The list price per interval in the currency's minor unit, before any tax the provider adds. */
  amountMinor: zCount,
  trialDays: zCount,
  /** Days the plan still applies after a renewal payment fails, while the provider retries. */
  graceDays: zCount,
  limits: zLimits,
});

/** The public price list (no account needed). Empty while no provider or plan is configured. */
export const PublicPlans = z.strictObject({
  available: z.boolean(),
  mode: z.enum(["test", "live"]).nullable(),
  plans: z.array(zOffer),
  /** Free periods on offer (null while trials are off): every account's trial and the invite-link bonus, in days. */
  trial: z.strictObject({ planKey: z.string(), days: zCount, referralDays: zCount, referralYearlyCapDays: zCount }).nullable(),
});

export const ReferralClaimBody = z.strictObject({ code: z.string().trim().min(6).max(20).regex(/^[A-Za-z0-9]+$/) });
export const ReferralInfo = z.strictObject({
  /** Whether invite links count now (trials on). */
  available: z.boolean(),
  code: z.string(),
  invited: zCount,
  bonusDaysThisYear: zCount,
  yearlyCapDays: zCount,
  daysEach: zCount,
});
export const ReferralClaimed = z.strictObject({ inviteeEndsAt: zTime, inviterDays: zCount });

const zSubscriptionView = OrgBilling.shape.subscription.unwrap();

export const OwnerBilling = z.strictObject({
  available: z.boolean(),
  reason: z.string().nullable(),
  mode: z.enum(["test", "live"]).nullable(),
  subscription: zSubscriptionView.nullable(),
  invoices: OrgBilling.shape.invoices,
  offers: z.array(zOffer),
  /** Whether the provider's customer portal can be opened (a customer exists and the provider has one). */
  portal: z.boolean(),
});

export const PortalSession = z.strictObject({ url: z.string() });
export const Reconciled = z.strictObject({ checked: zCount });

const zGrant = {
  /** The plan that applies now; null: the free tier. */
  plan: z.strictObject({ key: z.string(), name: z.string() }).nullable(),
  /** none: no subscription. grace: a renewal payment failed and the plan applies until accessUntil. */
  standing: z.union([zStanding, z.literal("none")]),
  accessUntil: zTime.nullable(),
  renews: z.boolean().nullable(),
  /** The quota plan (storage and transfer allowances) the subscription puts its owner on. */
  quotaPlanId: z.string().nullable(),
  /** A free period giving the plan (no subscription): the account's trial, an invite, or an invite bonus. */
  trial: z.strictObject({ source: z.enum(["signup", "invite", "invite_bonus"]), endsAt: zTime }).nullable(),
  /** Billing details: the account's own, and an organization's for its owners only. */
  subscription: z
    .strictObject({
      status: z.string(),
      provider: z.string(),
      interval: z.enum(["month", "year"]),
      currentPeriodEnd: zTime.nullable(),
      trialEnd: zTime.nullable(),
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
};

/** GET /v2/billing/entitlements: one answer for every client of the same account (docs/BILLING.md › Entitlements API). */
export const AccountEntitlements = z.strictObject({
  accountId: z.string(),
  billing: z.strictObject({ available: z.boolean(), mode: z.enum(["test", "live"]).nullable() }),
  personal: z.strictObject(zGrant),
  organizations: z.array(
    z.strictObject({
      orgId: z.string(),
      name: z.string(),
      role: z.string(),
      manageBilling: z.boolean(),
      ...zGrant,
      limits: z.array(z.strictObject({ key: z.string(), limit: zCount.nullable(), source: z.string() })),
    }),
  ),
  /** Changes whenever anything above changes. */
  revision: z.string(),
  evaluatedAt: zTime,
});
