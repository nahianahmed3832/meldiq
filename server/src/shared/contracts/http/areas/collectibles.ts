import { z } from "zod/v4";
import { CATEGORIES, CatalogItem, CatalogQuery, Category, EquipBody, ItemId, InventoryResponse, AssetId } from "../collectibles.js";
import { ProfileStyle } from "../users.js";
import { route, type RouteContract } from "../route.js";
const state = z.strictObject({
  profileStyle: ProfileStyle,
  styleRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
const ok = z.strictObject({ ok: z.literal(true) });
const params = z.object({ id: ItemId });
const user = (r: Omit<RouteContract, "tag" | "auth">) => route({ ...r, tag: "Profile collection", auth: true });
const admin = (r: Omit<RouteContract, "tag" | "auth" | "scheme" | "requires">) =>
  route({
    ...r,
    tag: "Profile collection admin",
    auth: true,
    scheme: "console",
    requires: "admin_console",
  });
const asset = z.object({
  id: AssetId,
  width: z.number(),
  height: z.number(),
  frames: z.number(),
  format: z.string(),
  variants: z.record(z.string(), z.object({ blob: z.string(), type: z.string(), bytes: z.number() })),
});
export const collectibleRoutes: RouteContract[] = [
  user({
    method: "GET",
    url: "/v2/profile-collectibles/categories",
    summary: "Collectible slots supported by all Meldiq clients.",
    response: z.strictObject({ categories: z.array(Category) }),
  }),
  user({
    method: "GET",
    url: "/v2/profile-collectibles",
    summary: "Active collectible catalog with stable ID pagination and search.",
    query: CatalogQuery,
    response: z.strictObject({
      items: z.array(CatalogItem),
      next: ItemId.nullable(),
    }),
  }),
  user({
    method: "GET",
    url: "/v2/profile-collectibles/:id",
    summary: "Collectible details and acquisition requirements.",
    params,
    response: z.strictObject({ item: CatalogItem }),
  }),
  user({
    method: "GET",
    url: "/v2/users/me/profile-collectibles",
    summary: "Private owned inventory, favorites and acquisition timestamps.",
    response: InventoryResponse,
  }),
  user({
    method: "POST",
    url: "/v2/users/me/profile-collectibles/:id/claim",
    summary: "Idempotently claim a free item. No client price or payment data accepted.",
    params,
    response: InventoryResponse,
  }),
  ...(["PUT", "DELETE"] as const).map((method) =>
    user({
      method,
      url: "/v2/users/me/profile-collectibles/:id/favorite",
      summary: "Set or remove a private owned-item favorite.",
      params,
      response: ok,
    }),
  ),
  user({
    method: "GET",
    url: "/v2/users/me/profile-customization",
    summary: "Canonical profile style and optimistic concurrency revision.",
    response: state,
  }),
  user({
    method: "PATCH",
    url: "/v2/users/me/profile-customization",
    summary: "Atomically equip or clear owned slots. Publish existing profile update event.",
    body: EquipBody,
    response: state,
    errors: ["not_owned", "wrong_category", "collectible_unavailable", "conflict"],
  }),
  route({
    method: "GET",
    url: "/v2/profile-collectibles/assets/:id/:variant",
    tag: "Profile collection",
    auth: false,
    summary: "Approved active asset variant, ETag and bounded public caching.",
    binary: "response",
    response: z.unknown(),
  }),
  admin({
    method: "GET",
    url: "/admin/v1/profile-collectibles",
    summary: "Super administrator catalog including inactive entries.",
    response: z.object({ items: z.array(CatalogItem) }),
  }),
  admin({
    method: "PUT",
    url: "/admin/v1/profile-collectibles/:id",
    summary: "Create/update catalog metadata and refresh equipped recipes. Super administrator only.",
    params,
    body: CatalogItem,
    response: z.object({ item: CatalogItem }),
  }),
  admin({
    method: "DELETE",
    url: "/admin/v1/profile-collectibles/:id",
    summary: "Deactivate an item and unequip it without deleting ownership history.",
    params,
    response: ok,
  }),
  admin({
    method: "POST",
    url: "/admin/v1/profile-collectibles/:id/grant",
    summary: "Audited promotional entitlement grant. No payment is simulated.",
    params,
    body: z.strictObject({
      userId: z.string().min(1).max(64),
      reason: z.string().trim().min(4).max(300),
    }),
    response: ok,
  }),
  admin({
    method: "POST",
    url: "/admin/v1/profile-collectibles/assets",
    summary: "Validate and transcode an administrator raster upload.",
    binary: "request",
    response: z.object({ asset }),
  }),
  admin({
    method: "GET",
    url: "/admin/v1/profile-collectibles/assets/:id/:variant",
    summary: "Uncached private asset review.",
    binary: "response",
    response: z.unknown(),
  }),
  admin({
    method: "POST",
    url: "/admin/v1/profile-collectibles/uploads",
    summary: "Sign an exact-size SHA-256-bound S3 upload valid for five minutes.",
    body: z.strictObject({
      size: z.number().int().min(1).max(6291456),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    response: z.object({
      id: z.string(),
      upload: z.object({
        method: z.literal("PUT"),
        url: z.string(),
        headers: z.record(z.string(), z.string()),
        expiresAt: z.number(),
      }),
    }),
  }),
  admin({
    method: "POST",
    url: "/admin/v1/profile-collectibles/uploads/:id/complete",
    summary: "Verify uploader, expiry, bytes and checksum before decoding and publishing variants.",
    response: z.object({ asset }),
  }),
];
