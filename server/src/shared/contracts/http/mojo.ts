import { z } from "zod/v4";
import { zReturnTo } from "./billing.js";
import { zCount, zTime } from "./primitives.js";

/**
 * Meldiq Mojo's plans, Meldiq Spark and gifts (docs/MOJO.md). Every limit comes from the server's catalog
 * (modules/billing/perks.ts); what a person has is worked out on the server from verified billing only.
 */
const zPlanKey = z.enum(["free", "go", "plus"]);
const zPresetId = z.enum(["720p30", "720p60", "1080p30", "1080p60", "1440p30"]);
const zId = z.string().min(1).max(64);

export const zPlanPerks = z.strictObject({
  key: zPlanKey,
  name: z.string(),
  listPriceMinor: zCount,
  messageChars: zCount,
  uploadBytes: zCount,
  screen: z.array(zPresetId),
  sparks: zCount,
  badge: z.enum(["go", "plus"]).nullable(),
  check: z.boolean(),
  customItems: zCount,
  bots: zCount,
  botReview: z.enum(["regular", "priority"]),
});

export const zSparkLevel = z.strictObject({
  level: z.number().int().min(0).max(3),
  sparks: zCount,
  emojiSlots: zCount,
  stickerSlots: zCount,
  uploadBytes: zCount.nullable(),
  voiceKbps: zCount,
  screen: z.array(zPresetId),
});

const zPrice = z.strictObject({ currency: z.string(), amountMinor: zCount }).nullable();

export const MojoCatalog = z.strictObject({
  version: z.string(),
  units: z.strictObject({ mb: zCount, gb: zCount }),
  plans: z.array(zPlanPerks),
  screenPresets: z.array(z.strictObject({ id: zPresetId, label: z.string(), width: zCount, height: zCount, fps: zCount })),
  spark: z.strictObject({ listPriceMinor: zCount, interval: z.literal("month"), maxPurchase: zCount, levels: z.array(zSparkLevel) }),
  gifts: z.strictObject({ months: z.array(z.number().int()), noteMax: zCount }),
  /** Whether plan limits apply on this server now (MOJO_ENFORCE: on, or once Mojo is on sale). False: apps keep the old limits. */
  enforced: z.boolean(),
  /** What can be bought now, at the published prices (null: not on sale yet). */
  onSale: z.strictObject({
    mode: z.enum(["test", "live"]).nullable(),
    go: zPrice,
    plus: zPrice,
    spark: zPrice,
    gifts: z.boolean(),
  }),
});

export const zGiftView = z.strictObject({
  id: z.string(),
  planKey: z.enum(["go", "plus"]),
  months: z.number().int(),
  status: z.enum(["pending", "paid", "redeemed", "refunded", "expired", "failed"]),
  note: z.string().nullable(),
  /** The other person: who gave it (received) or who it's for (sent). */
  person: z.strictObject({ userId: z.string().nullable(), name: z.string().nullable() }),
  currency: z.string(),
  amountMinor: zCount,
  paidAt: zTime.nullable(),
  redeemedAt: zTime.nullable(),
});

export const MojoMe = z.strictObject({
  plan: zPlanKey,
  perks: zPlanPerks,
  sparks: z.strictObject({
    included: zCount,
    purchased: zCount,
    total: zCount,
    free: zCount,
    assignments: z.array(
      z.strictObject({ id: z.string(), orgId: z.string(), orgName: z.string().nullable(), assignedAt: zTime, paused: z.boolean(), member: z.boolean() }),
    ),
    /** The Spark add-on subscription, when there is one. */
    subscription: z.strictObject({ quantity: zCount, status: z.string(), renews: z.boolean(), currentPeriodEnd: zTime.nullable() }).nullable(),
  }),
  badge: z.strictObject({ kind: z.enum(["go", "plus"]).nullable(), check: z.boolean(), hidden: z.boolean() }),
  gifts: z.strictObject({ received: z.array(zGiftView), sent: z.array(zGiftView) }),
});

export const OrgSparks = z.strictObject({
  level: z.number().int().min(0).max(3),
  active: zCount,
  /** The next level and how many more Sparks it needs (null at level 3). */
  next: z.strictObject({ level: z.number().int(), needs: zCount }).nullable(),
  perks: zSparkLevel,
  levels: z.array(zSparkLevel),
  /** The asking member's own Sparks here. */
  mine: z.array(z.strictObject({ id: z.string(), assignedAt: zTime, paused: z.boolean() })),
});

export const SparkAssignBody = z.strictObject({ orgId: zId });
export const SparkParams = z.strictObject({ id: zId });
export const SparkAssigned = z.strictObject({ id: z.string(), orgId: z.string(), assignedAt: zTime });
export const SparkCheckoutBody = z.strictObject({ quantity: z.number().int().min(1).max(20), returnTo: zReturnTo.optional() });
export const GiftBody = z.strictObject({
  recipientUserId: zId,
  planKey: z.enum(["go", "plus"]),
  months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
  note: z.string().max(280).nullable().optional(),
  returnTo: zReturnTo.optional(),
});
export const GiftStarted = z.strictObject({ giftId: z.string(), url: z.string().nullable(), expiresAt: zTime });
export const GiftParams = z.strictObject({ id: zId });
export const GiftRedeemed = z.strictObject({ startsAt: zTime, endsAt: zTime });
export const BadgeBody = z.strictObject({ hidden: z.boolean() });
export const BadgeSaved = z.strictObject({ hidden: z.boolean() });
