import type { RowReader } from "../../../infrastructure/database/rows/types.js";

/** The existing orphan collector must retain registered originals/variants, including inactive collectible assets. */
export function collectibleBlobIsReferenced(
  rows: Pick<RowReader, "get">,
  blob: string,
  at = Date.now(),
): boolean {
  const asset = /^col-([a-f0-9]{64})-[a-z0-9-]{1,32}$/.exec(blob);
  if (asset) return !!rows.get("profile_collectible_assets", { id: asset[1] });
  if (/^col-upload-[a-f0-9-]{36}$/.test(blob)) {
    const upload = rows.get<{ expires_at: number }>(
      "profile_collectible_uploads",
      { id: blob },
    );
    return !!upload && upload.expires_at >= at;
  }
  return false;
}
