import type { BoostTier } from "../../../shared/contracts/http/discovery.js";
import { ApiError } from "../../../shared/errors.js";

/** What someone is buying from Promote: a week of boost, or one Promoted week. */
export type PromoteOrder =
  | { kind: "boost"; orgId: string; buyerId: string; tier: BoostTier; priceCents: number; currency: string }
  | { kind: "promoted"; orgId: string; buyerId: string; weekStart: number; priceCents: number; currency: string };

/**
 * Where Promote takes payment (docs/COMMUNITY_PARITY_API.md › Discovery › Billing). The billing module sells plans and
 * Sparks as subscriptions; one-off weekly purchases need their own checkout kind there, so until that exists nothing
 * here takes money. A real adapter starts the provider's checkout for [order] (recording the boost or booking as
 * 'pending', made 'active' by the provider's webhook) and returns the page to send the buyer to.
 */
export interface PromoteCheckout {
  readonly available: boolean;
  /** Why buying is off, in plain words (null when it's on). */
  readonly reason: string | null;
  start(order: PromoteOrder): Promise<{ url: string }>;
}

const OFF_REASON = "Promote can't take payments yet. Meldiq will open it when billing is switched on.";

/** The checkout while billing is off: every purchase answers 503 billing_unavailable. */
export const NO_CHECKOUT: PromoteCheckout = {
  available: false,
  reason: OFF_REASON,
  start: async () => {
    throw new ApiError(503, "billing_unavailable", OFF_REASON);
  },
};
