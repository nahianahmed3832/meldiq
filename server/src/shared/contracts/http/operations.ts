import { z } from "zod/v4";
import { zReason } from "./platformAdmin.js";
export const OpsId = z.string().regex(/^[A-Za-z0-9_-]{3,100}$/);
export const OpsQuery = z.object({
  after: OpsId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export const Notice = z.object({
  id: z.string(),
  kind: z.enum(["announcement", "warning"]),
  title: z.string(),
  body: z.string(),
  target_user_id: z.string().nullable(),
  status: z.enum(["draft", "published", "withdrawn"]),
  starts_at: z.number(),
  ends_at: z.number().nullable(),
  version: z.number(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export const NoticeBody = z
  .strictObject({
    title: z.string().trim().min(3).max(120),
    body: z.string().trim().min(5).max(4000),
    kind: z.enum(["announcement", "warning"]),
    targetUserId: OpsId.nullable().default(null),
    startsAt: z.number().int().min(0),
    endsAt: z.number().int().nullable(),
    reason: zReason,
  })
  .refine(
    (x) => x.endsAt === null || x.endsAt > x.startsAt,
    "End must follow start",
  )
  .refine(
    (x) => x.kind !== "warning" || x.targetUserId !== null,
    "Warnings need a recipient",
  );
export const NoticeStateBody = z.strictObject({
  version: z.number().int().positive(),
  status: z.enum(["published", "withdrawn"]),
  reason: zReason,
});
export const Appeal = z.object({
  id: z.string(),
  user_id: z.string(),
  notice_id: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(["open", "escalated", "accepted", "rejected"]),
  decision: z.string().nullable(),
  assigned_to: z.string().nullable(),
  notified_version: z.number(),
  notification_error: z.string().nullable(),
  sync_status: z.string(),
  version: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export const AppealBody = z.strictObject({
  noticeId: OpsId.nullable().default(null),
  subject: z.string().trim().min(3).max(120),
  body: z.string().trim().min(10).max(4000),
});
export const AppealDecision = z.strictObject({
  version: z.number().int().positive(),
  status: z.enum(["escalated", "accepted", "rejected"]),
  decision: z.string().trim().min(10).max(2000),
  assigneeAccountId: OpsId.nullable().optional(),
  reason: zReason,
});
export const PromotionBody = z
  .strictObject({
    product: z.enum(["plus_time", "collectible_discount"]).default("plus_time"),
    discountPercent: z.number().int().min(0).max(90).default(0),
    code: z.string().regex(/^[A-Z0-9-]{4,32}$/),
    title: z.string().trim().min(3).max(120),
    months: z.number().int().min(1).max(12),
    maxRedemptions: z.number().int().min(1).max(100000),
    startsAt: z.number().int().min(0),
    endsAt: z.number().int(),
    enabled: z.boolean(),
    version: z.number().int().min(0),
    reason: zReason,
  })
  .refine((x) => x.endsAt > x.startsAt, "End must follow start")
  .refine(
    (x) => x.product !== "collectible_discount" || x.discountPercent > 0,
    "Choose a discount between 1 and 90 percent",
  );
export const Promotion = z.object({
  product: z.string(),
  discount_percent: z.number(),
  code: z.string(),
  title: z.string(),
  months: z.number(),
  max_redemptions: z.number(),
  redeemed: z.number(),
  enabled: z.number(),
  starts_at: z.number(),
  ends_at: z.number(),
  version: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export const Rollout = z.strictObject({
  percent: z.number().int().min(0).max(100),
  seed: z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/),
  allowUsers: z.array(OpsId).max(100),
  denyUsers: z.array(OpsId).max(100),
});
export const Policy = z.strictObject({
  calls: Rollout,
  uploads: Rollout,
  orgCreation: Rollout,
  fileRetentionDays: z.number().int().min(0).max(3650).nullable(),
  reportRetentionDays: z.number().int().min(30).max(3650).nullable(),
  maxFileBytes: z.number().int().min(1000000).max(1024000000),
  uploadStartsPerHour: z.number().int().min(1).max(1000),
});
export const PolicyBody = z.strictObject({
  version: z.number().int().min(0),
  policy: Policy,
  reason: zReason,
});
export const PolicyView = z.object({
  version: z.number(),
  policy: Policy,
  updatedAt: z.number().nullable(),
});
export const Order = z.object({
  id: z.string(),
  account_id: z.string().nullable(),
  user_id: z.string().nullable(),
  item_id: z.string(),
  item_version: z.number(),
  original_amount_minor: z.number(),
  promotion_code: z.string().nullable(),
  amount_minor: z.number(),
  currency: z.string(),
  provider: z.string(),
  session_ref: z.string().nullable(),
  checkout_url: z.string().nullable(),
  payment_ref: z.string().nullable(),
  status: z.string(),
  sync_status: z.string(),
  request_key: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  expires_at: z.number(),
});
export const Ownership = z.object({
  id: z.string(),
  org_id: z.string(),
  owner_user_id: z.string(),
  target_user_id: z.string(),
  requested_by: z.string(),
  reason: z.string(),
  status: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  completed_at: z.number().nullable(),
});
export const LegacyOperator = z.object({
  userId: z.string(),
  configured: z.boolean(),
  denied: z.boolean(),
  consoleAccountId: z.string().nullable(),
  consoleRole: z.string().nullable(),
  consoleRevoked: z.boolean(),
});
