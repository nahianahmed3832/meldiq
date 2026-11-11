import { z } from "zod/v4";
import { zReason } from "./platformAdmin.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const AdminRefundParams = z.object({ id });
export const AdminPaymentQuery = z.object({
  account: id.optional(),
  status: z
    .string()
    .regex(/^[a-z_]{1,32}$/)
    .optional(),
  kind: z.enum(["gift", "spark", "collectible", "invoice"]).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const AdminRefundQuery = z.object({
  account: id.optional(),
  status: z.enum(["reserved", "submitting", "pending", "uncertain", "completed", "failed"]).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const AdminRefundCreate = z.strictObject({
  confirm: z.literal(true),
  requestKey: z.uuid(),
  accountId: id,
  currency: z.literal("USD"),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: zReason,
});
export const AdminRefundReconcile = z.strictObject({
  confirm: z.literal(true),
  reason: zReason,
  providerRef: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,200}$/)
    .optional(),
});
export const SubscriptionCancellation = z.strictObject({ confirmed: z.boolean(), status: z.string(), accessUntil: z.number().nullable(), operationId: z.string() });

export const RefundOperation = z.strictObject({
  id: z.string(),
  purchaseId: z.string(),
  accountId: z.string(),
  mode: z.enum(["test", "live"]),
  currency: z.string(),
  amountMinor: z.number().int(),
  status: z.enum(["reserved", "submitting", "pending", "uncertain", "completed", "failed"]),
  providerRef: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  actorAccountId: z.string(),
  reason: z.string(),
});
export const RefundOperations = z.strictObject({ operations: z.array(RefundOperation), nextCursor: z.string().nullable() });
export const RefundInspection = z.strictObject({
  purchase: z.strictObject({
    id: z.string(),
    kind: z.enum(["gift", "spark", "collectible", "card"]),
    accountId: z.string(),
    orderRef: z.string(),
    paymentRef: z.string(),
    amountMinor: z.number().int(),
    currency: z.string(),
    status: z.string(),
  }),
  mode: z.enum(["test", "live"]),
  checkedAt: z.number(),
  completedMinor: z.number().int(),
  reservedMinor: z.number().int(),
  remainingMinor: z.number().int(),
  operations: z.array(RefundOperation),
  legacyReview: z.boolean(),
  policy: z.string(),
});
export const PaymentPage = z.strictObject({
  payments: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      accountId: z.string().nullable(),
      userId: z.string().nullable(),
      subscriptionId: z.string().nullable(),
      amountMinor: z.number().int(),
      currency: z.string(),
      status: z.string(),
      providerRef: z.string().nullable(),
      createdAt: z.number(),
      canReviewRefund: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
  configuredMode: z.enum(["test", "live"]).nullable(),
  historicalMode: z.literal("unrecorded"),
});

export const AdminCardQuery = z.object({
  account: id.optional(),
  status: z.enum(["pending", "active", "attention", "past_due", "canceled", "paused"]).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const AdminCardChargesQuery = z.object({ cursor: z.string().max(256).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export const AdminCardRecover = z.strictObject({
  confirm: z.literal(true),
  reason: zReason,
  orderRef: z
    .string()
    .regex(/^[A-Za-z0-9]{1,64}$/)
    .optional(),
});
export const CardMandateView = z.strictObject({
  id: z.string(),
  accountId: z.string(),
  userId: z.string().nullable(),
  orgId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  product: z.string(),
  status: z.string(),
  currency: z.string(),
  amountMinor: z.number().int(),
  mode: z.enum(["test", "live"]).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextBillingAt: z.number().nullable(),
  paidThrough: z.number().nullable(),
  cancelAt: z.number().nullable(),
  consentVersion: z.string(),
  consentAt: z.number(),
  card: z.strictObject({ brand: z.string().nullable(), lastFour: z.string().nullable(), expiry: z.string().nullable() }).nullable(),
});
export const CardMandatePage = z.strictObject({ mandates: z.array(CardMandateView), nextCursor: z.string().nullable() });
export const CardChargeView = z.strictObject({
  id: z.string(),
  status: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  orderRef: z.string().nullable(),
  captureRef: z.string().nullable(),
  generation: z.number().int(),
  attempts: z.number().int(),
  processingUntil: z.number().nullable(),
  periodStart: z.number(),
  periodEnd: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const CardMandateDetail = z.strictObject({ mandate: CardMandateView, charges: z.array(CardChargeView), nextCursor: z.string().nullable() });
export const CardRecoveryResult = z.strictObject({
  chargeId: z.string(),
  mandateId: z.string(),
  status: z.string(),
  orderRef: z.string().nullable(),
  captureRef: z.string().nullable(),
  checkedAt: z.number(),
  mode: z.enum(["test", "live"]),
});
