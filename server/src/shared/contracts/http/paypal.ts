import { z } from "zod/v4";

const id = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9_-]+$/);
export const PayPalCheckoutParams = z.strictObject({ id });
export const PayPalCheckoutBody = z.discriminatedUnion("product", [
  z.strictObject({ product: z.literal("plus"), requestKey: z.uuid() }),
  z.strictObject({
    product: z.literal("gift"),
    requestKey: z.uuid(),
    recipientUserId: id,
    months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
    note: z.string().max(500).default(""),
  }),
]);
export const PayPalConfig = z.strictObject({
  provider: z.literal("paypal"),
  environment: z.literal("sandbox"),
  clientId: z.string(),
  subscriptions: z.boolean(),
  cards: z.literal(false),
});
export const PayPalCheckoutView = z.strictObject({
  id,
  product: z.enum(["plus", "gift"]),
  providerRef: z.string().nullable(),
  status: z.string(),
  confirmed: z.boolean(),
  currency: z.literal("USD"),
  amountMinor: z.number().int().nonnegative(),
  interval: z.enum(["month", "one_time"]),
  expiresAt: z.number(),
});
export const PayPalCancelBody = z.strictObject({ confirm: z.literal(true) });
export const PayPalCanceled = z.strictObject({
  confirmed: z.boolean(),
  accessUntil: z.number().nullable(),
  status: z.string(),
});
export const PayPalRefundBody = z.strictObject({
  confirm: z.literal(true),
  reason: z.string().trim().min(8).max(500),
});
export const PayPalRefundResult = z.strictObject({
  status: z.string(),
  reference: z.string().nullable(),
});
const transaction = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  customer: z.string(),
  product: z.string(),
  currency: z.string(),
  amountMinor: z.number(),
  provider: z.string(),
  providerRef: z.string().nullable(),
  status: z.string(),
  refundStatus: z.string(),
  createdAt: z.number(),
  completedAt: z.number().nullable(),
  refundable: z.boolean(),
});
export const PayPalTransactions = z.strictObject({
  transactions: z.array(transaction),
});
export const PayPalHistory = z.strictObject({
  transactions: z.array(transaction),
  subscriptions: z.array(
    z.object({
      id: z.string(),
      providerRef: z.string(),
      status: z.string(),
      currentPeriodEnd: z.number().nullable(),
      cancelAtPeriodEnd: z.boolean(),
      createdAt: z.number(),
    }),
  ),
  history: z.array(
    z.object({
      subscriptionId: z.string(),
      at: z.number(),
      from: z.string().nullable(),
      to: z.string(),
      source: z.string(),
    }),
  ),
});
