import { z } from "zod/v4";
export const CATEGORIES = ["avatar-frame", "avatar-effect", "background", "banner", "profile-theme", "name-effect", "badge", "particles"] as const;
export const Category = z.enum(CATEGORIES);
export const ItemId = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);
export const AssetId = z.string().regex(/^[a-f0-9]{64}$/);
export const Recipe = z.strictObject({
  colors: z
    .array(z.string().regex(/^#[0-9a-fA-F]{6}$/))
    .min(2)
    .max(2),
  pattern: z.enum(["solid", "orbit", "grid", "prism"]),
  frame: z.enum(["aurora", "ember", "frost", "neon", "sakura", "pixel"]).optional(),
  effect: z.enum(["sparkles", "glow", "stars", "bubbles"]).optional(),
  nameEffect: z.enum(["glow", "shimmer"]).optional(),
  assetId: AssetId.optional(),
});
export const CollectibleLook = z.strictObject({
  id: ItemId,
  name: z.string().max(80),
  category: Category,
  version: z.number().int().positive(),
  recipe: Recipe,
});
export type CollectibleLook = z.infer<typeof CollectibleLook>;
export const CatalogItem = CollectibleLook.extend({
  description: z.string().max(500),
  rarity: z.enum(["common", "rare", "epic", "legendary"]),
  acquisitionType: z.enum(["free", "premium", "event", "purchase"]),
  price: z.number().int().min(0).max(100000000),
  currency: z.enum(["USD", "EMBERS"]),
  isActive: z.boolean(),
  isFeatured: z.boolean(),
  availableFrom: z.number().int().nullable(),
  availableUntil: z.number().int().nullable(),
  supportedPlatforms: z.array(z.enum(["web", "android", "windows", "macos"])).min(1),
}).superRefine((v, c) => {
  if (v.availableFrom !== null && v.availableUntil !== null && v.availableUntil <= v.availableFrom)
    c.addIssue({
      code: "custom",
      message: "Availability end must follow start",
    });
  if (v.acquisitionType === "free" && v.price !== 0)
    c.addIssue({
      code: "custom",
      message: "Free items must have a zero price",
    });
});
export type CatalogItem = z.infer<typeof CatalogItem>;
export const EquipBody = z.strictObject({
  baseStyleRevision: z.string().regex(/^[a-f0-9]{64}$/),
  slots: z.partialRecord(Category, ItemId.nullable()).refine((v) => Object.keys(v).length > 0, "Choose a slot"),
});
export const CatalogQuery = z.object({
  category: Category.optional(),
  q: z.string().trim().max(80).optional(),
  after: ItemId.optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

export const InventoryEntry = z.strictObject({
  user_id: z.string(),
  decoration_id: ItemId,
  acquired_at: z.number().int(),
  acquisition_source: z.string(),
  is_favorite: z.number().int(),
});
export const InventoryResponse = z.strictObject({
  inventory: z.array(InventoryEntry),
});
