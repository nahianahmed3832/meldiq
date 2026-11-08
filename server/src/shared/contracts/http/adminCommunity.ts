import { z } from "zod/v4";
import { zReason } from "./platformAdmin.js";
import { PingRole, PingRoleUpdate } from "./pingRoles.js";
import { PartnerEligibility, PartnerApplication } from "./partners.js";
import { UNLISTED_REASONS } from "./discovery.js";

export const AdminCommunity = z.strictObject({
  voiceClips: z.strictObject({
    requested: z.boolean(),
    blocked: z.boolean(),
    available: z.boolean(),
    effective: z.boolean(),
  }),
  pingRoles: z.strictObject({
    rev: z.number().int().nonnegative(),
    roles: z.array(PingRole),
  }),
  expressions: z.strictObject({
    emojiUsed: z.number().int().nonnegative(),
    emojiSlots: z.number().int().nonnegative(),
    stickerUsed: z.number().int().nonnegative(),
    stickerSlots: z.number().int().nonnegative(),
    stickerMaxBytes: z.number().int().positive(),
    stickerMaxDimension: z.number().int().positive(),
  }),
  discovery: z.strictObject({
    enabled: z.boolean(),
    listed: z.boolean(),
    discoverable: z.boolean(),
    reason: z.enum(UNLISTED_REASONS).nullable(),
    tags: z.array(z.string()),
  }),
});

export const AdminCommunityChange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("voice_clips"), blocked: z.boolean(), reason: zReason }),
  PingRoleUpdate.extend({ kind: z.literal("ping_roles"), reason: zReason }),
]);

export const AdminPartnerDetail = z.strictObject({
  name: z.string(),
  eligibility: PartnerEligibility.nullable(),
  application: PartnerApplication.nullable(),
});

export const AdminPartnerRevoke = z.strictObject({
  baseRev: z.number().int().positive(),
  reason: zReason,
});

export const AdminCommunityOffers = z.strictObject({
  currency: z.literal("USD"),
  offers: z.array(z.strictObject({
    id: z.enum(["supercharge", "boost", "super", "mega", "promoted"]),
    cents: z.number().int().positive(),
    interval: z.enum(["MONTH", "WEEK"]),
    min: z.number().int().positive(),
    max: z.number().int().positive(),
    checkoutAvailable: z.boolean(),
  })),
});
