import { createHash } from "node:crypto";
import type { AppContext } from "../../../app/context.js";
import {
  CatalogItem,
  type CollectibleLook,
  type CATEGORIES,
} from "../../../shared/contracts/http/collectibles.js";
import { ApiError, notFound } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { styleOf, styleRevision, type Style } from "../profileMedia.js";
import {
  announceProfileChange,
  announceOwnSettingsChange,
} from "../profileEvents.js";
import { COLLECTION } from "./builtins.js";
export type Category = (typeof CATEGORIES)[number];
export type Inventory = {
  user_id: string;
  decoration_id: string;
  acquired_at: number;
  acquisition_source: string;
  is_favorite: number;
};
export const INVENTORY = "profile_collectible_inventory";
export const CATALOG = "profile_collectible_catalog";
export const available = (item: CatalogItem, at = now()) =>
  item.isActive &&
  (item.availableFrom === null || item.availableFrom <= at) &&
  (item.availableUntil === null || at < item.availableUntil);
export const lookOf = (item: CatalogItem): CollectibleLook => ({
  id: item.id,
  name: item.name,
  category: item.category,
  version: item.version,
  recipe: item.recipe,
});
export function applySlot(
  s: Style,
  category: Category,
  item: CollectibleLook | null,
): Style {
  const next = { ...s };
  const r = item?.recipe;
  const colors = r?.colors.map((c) => c.toLowerCase());
  switch (category) {
    case "avatar-frame":
      next.decoration = r?.frame ?? null;
      break;
    case "profile-theme":
      next.themeColors = colors ?? null;
      next.accent = colors?.[0] ?? null;
      break;
    case "name-effect":
      next.nameColors = colors ?? null;
      next.nameEffect = r?.nameEffect ?? null;
      break;
    case "particles":
      next.effect = r?.effect ?? null;
      break;
  }
  const looks = (s.collectibles ?? []).filter((x) => x.category !== category);
  if (item) looks.push(item);
  if (looks.length) next.collectibles = looks;
  else delete next.collectibles;
  return next;
}
/** One persisted inventory; equipped recipes are embedded in the existing profile record, never client supplied. */
export class CollectionService {
  constructor(readonly ctx: AppContext) {}
  catalog(): CatalogItem[] {
    const merged = new Map(COLLECTION.map((x) => [x.id, x]));
    for (const row of this.ctx.identity.all<{ metadata: string }>(CATALOG)) {
      const p = CatalogItem.safeParse(JSON.parse(row.metadata));
      if (p.success) merged.set(p.data.id, p.data);
    }
    return [...merged.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }
  item(id: string) {
    const item = this.catalog().find((x) => x.id === id);
    if (!item) throw notFound("Decoration not found");
    return item;
  }
  inventory(userId: string) {
    return this.ctx.identity.all<Inventory>(INVENTORY, {
      where: { user_id: userId },
      orderBy: [
        ["acquired_at", "desc"],
        ["decoration_id", "asc"],
      ],
    });
  }
  state(userId: string) {
    const u = this.ctx.identity.get<{ profile_style: string | null }>("users", {
      id: userId,
    });
    if (!u) throw notFound("User not found");
    return { profileStyle: styleOf(u), styleRevision: styleRevision(u) };
  }
  async acquire(userId: string, id: string, source = "free", operator = false) {
    await this.ctx.identity.write((w) => {
      if (!w.get("users", { id: userId })) throw notFound("User not found");
      const item = this.item(id);
      if (!available(item))
        throw new ApiError(
          409,
          "collectible_unavailable",
          "This decoration is not available",
        );
      if (!operator && item.acquisitionType !== "free")
        throw new ApiError(
          403,
          "acquisition_required",
          "This decoration requires a verified grant",
        );
      if (w.get(INVENTORY, { user_id: userId, decoration_id: id })) return;
      const at = now();
      w.insert(INVENTORY, {
        user_id: userId,
        decoration_id: id,
        acquired_at: at,
        acquisition_source: source,
        is_favorite: 0,
      });
      w.insert("profile_collectible_transactions", {
        id: createHash("sha256")
          .update(userId + ":" + id)
          .digest("hex"),
        user_id: userId,
        decoration_id: id,
        transaction_type: operator ? "grant" : "claim",
        price: 0,
        currency: item.currency,
        payment_reference: null,
        created_at: at,
      });
    });
    this.ctx.audit({
      actorId: userId,
      action: "collectible.acquire",
      detail: id,
    });
    announceOwnSettingsChange(this.ctx, userId);
  }
  async favorite(userId: string, id: string, value: boolean) {
    this.item(id);
    await this.ctx.identity.write((w) => {
      if (!w.get(INVENTORY, { user_id: userId, decoration_id: id }))
        throw new ApiError(403, "not_owned", "Collect this decoration first");
      w.update(
        INVENTORY,
        { user_id: userId, decoration_id: id },
        { is_favorite: value ? 1 : 0 },
      );
    });
    announceOwnSettingsChange(this.ctx, userId);
  }
  async equip(
    userId: string,
    revision: string,
    slots: Partial<Record<Category, string | null>>,
  ) {
    let before: Style | undefined;
    await this.ctx.identity.write((w) => {
      const u = w.get<{ profile_style: string | null }>("users", {
        id: userId,
      });
      if (!u) throw notFound("User not found");
      if (styleRevision(u) !== revision)
        throw new ApiError(
          409,
          "conflict",
          "Your look changed on another device. Reload before applying.",
        );
      before = styleOf(u);
      let next = before;
      for (const [cat, id] of Object.entries(slots) as [
        Category,
        string | null,
      ][]) {
        let chosen: CollectibleLook | null = null;
        if (id) {
          const item = this.item(id);
          if (item.category !== cat)
            throw new ApiError(
              400,
              "wrong_category",
              "Decoration does not fit this slot",
            );
          if (!available(item))
            throw new ApiError(
              409,
              "collectible_unavailable",
              "This decoration is not available",
            );
          if (!w.get(INVENTORY, { user_id: userId, decoration_id: id }))
            throw new ApiError(
              403,
              "not_owned",
              "You can only equip decorations you own",
            );
          chosen = lookOf(item);
        }
        next = applySlot(next, cat, chosen);
      }
      w.update(
        "users",
        { id: userId },
        { profile_style: JSON.stringify(next), updated_at: now() },
      );
    });
    const state = this.state(userId);
    await this.ctx.decorations.worn(
      before?.decoration ?? null,
      state.profileStyle.decoration,
    );
    this.ctx.audit({
      actorId: userId,
      action: "collectible.equip",
      detail: Object.keys(slots).join(","),
    });
    announceProfileChange(this.ctx, userId);
    return state;
  }
  async expireUnavailable() {
    const blocked = new Set(
      this.catalog()
        .filter((x) => !available(x))
        .map((x) => x.id),
    );
    if (!blocked.size) return;
    const changed: string[] = [];
    await this.ctx.identity.write((w) => {
      for (const user of w.all<{ id: string; profile_style: string | null }>(
        "users",
        { where: { profile_style: { ne: null } } },
      )) {
        let s = styleOf(user);
        let dirty = false;
        for (const item of s.collectibles ?? [])
          if (blocked.has(item.id)) {
            s = applySlot(s, item.category, null);
            dirty = true;
          }
        if (dirty) {
          w.update(
            "users",
            { id: user.id },
            { profile_style: JSON.stringify(s), updated_at: now() },
          );
          changed.push(user.id);
        }
      }
    });
    for (const id of changed) announceProfileChange(this.ctx, id);
  }
  async save(item: CatalogItem, expectedVersion?: number) {
    if (
      item.recipe.assetId &&
      !this.ctx.identity.get("profile_collectible_assets", {
        id: item.recipe.assetId,
      })
    )
      throw new ApiError(
        400,
        "unknown_asset",
        "Upload and validate this asset first",
      );
    await this.ctx.identity.write((w) => {
      const previous = w.get<{ metadata: string }>(CATALOG, { id: item.id });
      const builtin = COLLECTION.find((x) => x.id === item.id);
      const old = previous
        ? (JSON.parse(previous.metadata) as CatalogItem)
        : builtin;
      if (old && expectedVersion !== undefined && expectedVersion !== old.version)
        throw new ApiError(409, "conflict", "This catalog item changed. Reload it before saving again");
      if (old && old.category !== item.category)
        throw new ApiError(
          409,
          "conflict",
          "An existing decoration cannot change categories",
        );
      const next = { ...item, version: (old?.version ?? 0) + 1 };
      w.upsert(
        CATALOG,
        { id: item.id, metadata: JSON.stringify(next), updated_at: now() },
        "replace",
      );
      // Refresh embedded public recipes without replacing any other profile fields.
      for (const user of w.all<{ id: string; profile_style: string | null }>(
        "users",
        { where: { profile_style: { ne: null } } },
      )) {
        const s = styleOf(user);
        if (!s.collectibles?.some((x) => x.id === item.id)) continue;
        w.update(
          "users",
          { id: user.id },
          {
            profile_style: JSON.stringify(
              applySlot(
                s,
                item.category,
                available(next) ? lookOf(next) : null,
              ),
            ),
            updated_at: now(),
          },
        );
      }
    });
    // Inventory user_id is deliberately private; use it only to notify its owner/peers.
    for (const row of this.ctx.identity.all<Inventory>(INVENTORY, {
      where: { decoration_id: item.id },
    }))
      announceProfileChange(this.ctx, row.user_id);
  }
}
