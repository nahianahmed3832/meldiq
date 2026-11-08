import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { ApiError } from "../../../shared/errors.js";
import { cents } from "./paypal.js";
import type { PayPalApi, PayPalEnvironment } from "./paypalApi.js";

export const COMMUNITY_OFFERS = {
  supercharge: {
    cents: 299,
    interval: "MONTH",
    min: 1,
    max: 14,
    quantity: true,
  },
  boost: { cents: 399, interval: "WEEK", min: 1, max: 1, quantity: false },
  super: { cents: 799, interval: "WEEK", min: 1, max: 1, quantity: false },
  mega: { cents: 1299, interval: "WEEK", min: 1, max: 1, quantity: false },
  promoted: { cents: 2999, interval: "WEEK", min: 1, max: 1, quantity: false },
} as const;
export type CommunityOffer = keyof typeof COMMUNITY_OFFERS;
const planRef = z.string().regex(/^P-[A-Z0-9]+$/);
const productRef = z.string().regex(/^PROD-[A-Z0-9]+$/);
const amount = z.object({ value: z.string(), currency_code: z.literal("USD") });
const plan = z.object({
  id: planRef,
  product_id: productRef,
  status: z.literal("ACTIVE"),
  quantity_supported: z.boolean().default(false),
  billing_cycles: z
    .array(
      z.object({
        tenure_type: z.literal("REGULAR"),
        sequence: z.literal(1),
        total_cycles: z.literal(0),
        frequency: z.object({
          interval_unit: z.enum(["WEEK", "MONTH"]),
          interval_count: z.literal(1),
        }),
        pricing_scheme: z.object({
          fixed_price: amount,
          tiers: z.array(z.unknown()).length(0).optional(),
        }),
      }),
    )
    .length(1),
  payment_preferences: z
    .object({
      setup_fee: amount.optional(),
      auto_bill_outstanding: z.boolean().optional(),
      payment_failure_threshold: z.number().optional(),
    })
    .optional(),
  taxes: z.object({ percentage: z.string() }).optional(),
});
const agreement = z.object({
  id: z.string().regex(/^I-[A-Z0-9]+$/),
  plan_id: planRef,
  quantity: z
    .string()
    .regex(/^\d{1,2}$/)
    .optional(),
  custom_id: z.string(),
  status: z.string(),
});
const approval = z.object({
  id: agreement.shape.id,
  links: z.array(z.object({ rel: z.string(), href: z.string().url() })),
});
const unavailable = () =>
  new ApiError(
    409,
    "billing_unavailable",
    "PayPal terms do not match the configured community offer.",
  );

export function communityQuote(offer: CommunityOffer, quantity: number) {
  const terms = COMMUNITY_OFFERS[offer];
  if (
    !terms ||
    !Number.isSafeInteger(quantity) ||
    quantity < terms.min ||
    quantity > terms.max
  )
    throw unavailable();
  return {
    offer,
    quantity,
    currency: "USD" as const,
    amountMinor: quantity * terms.cents,
    interval: terms.interval,
  };
}

/** Sandbox qualification for future checkout and fulfillment. There is no live checkout entry point. */
export class CommunityPayPal {
  constructor(
    private readonly api: PayPalApi,
    private readonly environment: PayPalEnvironment,
    private readonly productId: string,
    private readonly planIds: Readonly<Record<CommunityOffer, string>>,
  ) {}

  async verify(offer: CommunityOffer): Promise<string> {
    const id = planRef.parse(this.planIds[offer]);
    const expected = COMMUNITY_OFFERS[offer];
    const response = plan.safeParse(
      await this.api.request("GET", `/v1/billing/plans/${id}`),
    );
    if (!response.success) throw unavailable();
    const remote = response.data;
    const cycle = remote.billing_cycles[0]!;
    if (
      remote.id !== id ||
      remote.product_id !== this.productId ||
      remote.quantity_supported !== expected.quantity ||
      cycle.frequency.interval_unit !== expected.interval ||
      cents(cycle.pricing_scheme.fixed_price.value) !== expected.cents ||
      (remote.payment_preferences?.setup_fee &&
        cents(remote.payment_preferences.setup_fee.value) !== 0) ||
      (remote.payment_preferences?.auto_bill_outstanding ?? false) ||
      Number(remote.taxes?.percentage ?? 0) !== 0
    )
      throw unavailable();
    return id;
  }

  async createSandboxApproval(
    offer: CommunityOffer,
    quantity: number,
    reference: string,
    returnUrl: string,
    cancelUrl: string,
  ) {
    if (
      this.environment !== "sandbox" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(reference)
    )
      throw unavailable();
    for (const target of [returnUrl, cancelUrl]) {
      const url = new URL(target);
      if (url.protocol !== "https:" || url.username || url.password)
        throw unavailable();
    }
    const quote = communityQuote(offer, quantity);
    const planId = await this.verify(offer);
    const response = approval.parse(
      await this.api.request(
        "POST",
        "/v1/billing/subscriptions",
        {
          plan_id: planId,
          custom_id: reference,
          ...(offer === "supercharge" ? { quantity: String(quantity) } : {}),
          application_context: {
            brand_name: "Meldiq",
            shipping_preference: "NO_SHIPPING",
            user_action: "SUBSCRIBE_NOW",
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
        createHash("sha256")
          .update(`community:${reference}`)
          .digest("hex")
          .slice(0, 32),
      ),
    );
    const link = response.links.find(({ rel }) => rel === "approve");
    const url = link && new URL(link.href);
    if (
      !url ||
      url.protocol !== "https:" ||
      url.hostname !== "www.sandbox.paypal.com" ||
      url.username ||
      url.password
    )
      throw unavailable();
    return {
      ...quote,
      reference,
      subscriptionId: response.id,
      approvalUrl: url.toString(),
    };
  }

  /** Correlates a provider agreement with a durable quote before a webhook handler considers its settled transaction. */
  async verifyAgreement(
    offer: CommunityOffer,
    quantity: number,
    reference: string,
    subscriptionId: string,
  ) {
    communityQuote(offer, quantity);
    const id = agreement.shape.id.parse(subscriptionId);
    const data = agreement.parse(
      await this.api.request("GET", `/v1/billing/subscriptions/${id}`),
    );
    if (
      data.id !== id ||
      data.plan_id !== this.planIds[offer] ||
      data.custom_id !== reference ||
      Number(data.quantity ?? "1") !== quantity
    )
      throw unavailable();
    return { status: data.status };
  }
}
