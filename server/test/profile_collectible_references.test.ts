import { describe, expect, it } from "vitest";
import type { RowReader } from "../src/infrastructure/database/rows/types.js";
import { collectibleBlobIsReferenced } from "../src/modules/accounts/collectibles/assetReferences.js";

describe("collectible assets and the existing orphan collector", () => {
  const hash = "a".repeat(64);
  const stage = "col-upload-11111111-1111-1111-1111-111111111111";
  const records = new Map<string, object>([[`profile_collectible_assets:${hash}`, { id: hash }], [`profile_collectible_uploads:${stage}`, { expires_at: 1000 }]]);
  const rows = { get: (table: string, where: { id: string }) => records.get(`${table}:${where.id}`) } as Pick<RowReader, "get">;
  it("keeps registered originals, static fallbacks and future variants even without an active catalog reference", () => {
    for (const variant of ["original", "full", "poster", "thumbnail", "avif", "future-v2"]) expect(collectibleBlobIsReferenced(rows, `col-${hash}-${variant}`)).toBe(true);
    expect(collectibleBlobIsReferenced(rows, `col-${"b".repeat(64)}-poster`)).toBe(false);
    expect(collectibleBlobIsReferenced(rows, "unrelated-photo-123")).toBe(false);
  });
  it("retains a live signed stage and releases an expired one", () => {
    expect(collectibleBlobIsReferenced(rows, stage, 999)).toBe(true);
    expect(collectibleBlobIsReferenced(rows, stage, 1001)).toBe(false);
  });
});
