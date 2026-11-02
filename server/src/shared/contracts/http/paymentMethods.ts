import { z } from "zod/v4";
import { route, type RouteContract } from "./route.js";
const method = z.strictObject({ id: z.string(), brand: z.string(), lastFour: z.string().regex(/^\d{4}$/), expiry: z.string().nullable(), createdAt: z.number() });
const params = z.strictObject({ id: z.string().min(1).max(150).regex(/^[A-Za-z0-9_-]+$/) });
export const paymentMethodRoutes: readonly RouteContract[] = [
 route({ method: "GET", url: "/v2/billing/payment-methods", tag: "Billing", summary: "Owner-only masked saved card information; never provider token IDs.", auth: true, response: z.strictObject({ available: z.boolean(), methods: z.array(method) }) }),
 route({ method: "POST", url: "/v2/billing/payment-methods/setups", tag: "Billing", summary: "Create an owner-bound, expiring hosted-card setup.", auth: true, body: z.strictObject({ requestKey: z.uuid() }), response: z.strictObject({ id: z.string(), setupToken: z.string(), expiresAt: z.number() }) }),
 route({ method: "POST", url: "/v2/billing/payment-methods/setups/:id/complete", tag: "Billing", summary: "Verify the stored setup with PayPal and encrypt the saved payment token.", auth: true, params, body: z.strictObject({}), response: method }),
 route({ method: "DELETE", url: "/v2/billing/payment-methods/:id", tag: "Billing", summary: "Remove an owned unused saved payment method.", auth: true, params, response: z.strictObject({ removed: z.literal(true) }) }),
];
