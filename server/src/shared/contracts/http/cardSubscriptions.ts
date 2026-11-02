import { z } from "zod/v4";
import { route, type RouteContract } from "./route.js";
const id = z.string().min(1).max(150);
const params = z.strictObject({ id });
const product = z.enum(["plus", "bots_plus"]);
const view = z.strictObject({ id, orgId: z.string().nullable(), product, paymentMethodId: id, status: z.string(), currency: z.string(), amountMinor: z.number(), nextBillingAt: z.number().nullable(), paidThrough: z.number().nullable(), cancelAt: z.number().nullable(), processing: z.boolean() });
export const cardSubscriptionRoutes: readonly RouteContract[] = [
 route({ method: "GET", url: "/v2/billing/card-subscriptions", auth: true, tag: "Billing", summary: "Owned card mandates, masked references only.", response: z.strictObject({ subscriptions: z.array(view) }) }),
 route({ method: "GET", url: "/v2/billing/card-subscriptions/quote", auth: true, tag: "Billing", summary: "Server-priced recurring card terms and required consent version.", query: z.strictObject({ product }), response: z.strictObject({ consentVersion: z.string(), amountMinor: z.number(), currency: z.string(), firstBillingAt: z.number() }) }),
 route({ method: "POST", url: "/v2/billing/card-subscriptions", auth: true, tag: "Billing", summary: "Create an owner-bound recurring card mandate with explicit consent; no raw card data.", body: z.strictObject({ product, orgId: id.optional(), paymentMethodId: id, requestKey: z.uuid(), consentVersion: z.string().max(100), acceptRecurring: z.literal(true) }), response: view }),
 route({ method: "POST", url: "/v2/billing/card-subscriptions/:id/cancel", auth: true, tag: "Billing", summary: "Stop future card renewal claims while retaining verified paid time.", params, body: z.strictObject({ confirm: z.literal(true) }), response: view }),
 route({ method: "PUT", url: "/v2/billing/card-subscriptions/:id/payment-method", auth: true, tag: "Billing", summary: "Choose an owned active payment method for subsequent renewals.", params, body: z.strictObject({ paymentMethodId: id }), response: view }),
];
