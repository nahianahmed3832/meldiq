import { z } from "zod/v4";
export const Presentation = z.enum(["banner", "card", "modal"]);
export const Trigger = z.enum(["consistent_usage", "near_limit", "exclusive_feature", "subscription_settings", "explore", "milestone"]);
const duration = z.number().int().min(0).max(365);
export const Campaign = z.object({
 id: z.string().regex(/^[a-z0-9_-]{1,64}$/), name: z.string().min(1).max(100), active: z.boolean(),
 heading: z.string().min(1).max(120), description: z.string().min(1).max(600),
 image: z.string().regex(/^\/promotion-assets\/[a-zA-Z0-9_./-]+$/).nullable().default(null),
 presentation: Presentation, trigger: Trigger, minAccountDays: duration.default(3),
 minSessions: z.number().int().min(3).max(100).default(3), minActiveDays: z.number().int().min(2).max(90).default(2),
 minSessionSeconds: z.number().int().min(60).max(3600).default(60),
 maxImpressions: z.number().int().min(0).max(3).default(3), maxPopups: z.number().int().min(0).max(1).default(1),
 gapDays: z.number().int().min(7).max(365).default(7), dismissalDays: z.number().int().min(14).max(365).default(14),
 snoozeDays: z.number().int().min(30).max(365).default(30),
 startsAt: z.number().int().nonnegative().nullable().default(null), endsAt: z.number().int().nonnegative().nullable().default(null),
 regions: z.array(z.string().regex(/^[A-Z]{2}$/)).max(100).default([]),
 cta: z.string().min(1).max(60).default("Get Meldiq Plus"), destination: z.literal("/settings/mojo").default("/settings/mojo"),
 eligiblePlans: z.tuple([z.literal("free")]).default(["free"]),
 experiment: z.object({ id: z.string().max(64), treatmentPercent: z.number().int().min(0).max(100), treatmentHeading: z.string().min(1).max(120) }).nullable().default(null),
}).strict().refine(c => c.minAccountDays >= 3 && (c.startsAt === null || c.endsAt === null || c.endsAt > c.startsAt), "Invalid campaign age or dates");
export type CampaignConfig = z.infer<typeof Campaign>;
export const PromotionSettings = z.object({ enabled: z.boolean(), popupsEnabled: z.boolean(), campaigns: z.array(Campaign).max(20) }).strict().refine(s => new Set(s.campaigns.map(c => c.id)).size === s.campaigns.length, "Campaign IDs must be unique");
export type Settings = z.infer<typeof PromotionSettings>;
export const DEFAULT_CAMPAIGN: CampaignConfig = Campaign.parse({ id: "open-internet-plus", name: "Support an open internet", active: false,
 heading: "Help keep Meldiq running", description: "We believe communication and sharing should remain accessible. Your Meldiq Plus subscription helps support the infrastructure, bandwidth, storage, and development behind an independent community platform.",
 presentation: "banner", trigger: "consistent_usage" });
export const DEFAULT_SETTINGS: Settings = { enabled: false, popupsEnabled: false, campaigns: [DEFAULT_CAMPAIGN] };
const sessionId = z.string().uuid();
export const ActivityBody = z.object({ sessionId, onboardingComplete: z.boolean(), active: z.boolean() }).strict();
export const ClaimBody = z.object({ sessionId, trigger: Trigger, screen: z.enum(["home", "subscription_settings"]), safe: z.boolean() }).strict();
export const EventBody = z.object({ sessionId, impressionId: z.string().min(1).max(150), event: z.enum(["dismiss", "snooze", "click", "pricing_visit", "complaint", "impression"]) }).strict();
export const OptOutBody = z.object({ optOut: z.boolean() }).strict();

export const PromotionView = z.strictObject({ id: z.string(), campaignId: z.string(), presentation: Presentation, heading: z.string(), description: z.string(), image: z.string().nullable(), cta: z.string(), destination: z.literal("/settings/mojo"), amountMinor: z.number().int().positive(), currency: z.literal("USD"), interval: z.literal("month"), expiresAt: z.number() });
export const PromotionClaim = z.strictObject({ promotion: PromotionView.nullable() });
export const PromotionCurrent = z.strictObject({ active: z.boolean(), expiresAt: z.number().optional() });
export const PromotionId = z.strictObject({ id: z.string().min(1).max(150) });
export const PromotionAdminBody = z.strictObject({ settings: PromotionSettings, revision: z.number().int().nonnegative(), reason: z.string().min(5).max(500) });
export const PromotionAdminResult = z.strictObject({ settings: PromotionSettings, revision: z.number().int().nonnegative(), metrics: z.record(z.string(), z.unknown()) });
