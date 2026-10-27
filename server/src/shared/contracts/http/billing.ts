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
