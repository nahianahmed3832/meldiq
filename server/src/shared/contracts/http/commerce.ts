import { z } from "zod/v4";
import { route, type RouteContract } from "./route.js";
const order = z.strictObject({ id: z.string(), product: z.string(), subtotalMinor: z.number(), discountMinor: z.number(), taxMinor: z.number(), totalMinor: z.number(), currency: z.string(), taxStatus: z.string(), provider: z.string(), status: z.string(), entitlementStatus: z.string(), createdAt: z.number(), completedAt: z.number().nullable(), providerReference: z.string().nullable(), refundStatus: z.string() });
export const commerceRoutes: readonly RouteContract[] = [
 route({ method: "GET", url: "/v2/billing/orders", auth: true, tag: "Billing", summary: "Owned unified purchase history from verified billing records.", response: z.strictObject({ orders: z.array(order) }) }),
 route({ method: "GET", url: "/v2/billing/orders/:id/receipt", auth: true, tag: "Billing", summary: "Owner-only receipt data, including authoritative payment status.", params: z.strictObject({ id: z.string().min(1).max(150) }), response: order.extend({ receiptNumber: z.string(), paid: z.boolean(), seller: z.string(), statement: z.string() }) }),
 route({ method: "GET", url: "/admin/v1/billing/orders", auth: true, scheme: "console", requires: "admin_console", tag: "Billing", summary: "Billing administrator unified payment ledger.", response: z.strictObject({ orders: z.array(order.extend({ accountId: z.string() })) }) }),
];
