import fs from "node:fs/promises";
import type { AppContext } from "../../../app/context.js";
import { processAsset } from "./assets.js";
import { CATALOG, INVENTORY } from "./service.js";
import { COLLECTION } from "./builtins.js";
import { PlatformAudit } from "../../platformAdmin/index.js";
/** Launch-only seed: never replaces operator overrides or changes a design anybody already owns. */
export async function seedCollectionArtwork(
  ctx: Pick<AppContext, "identity" | "platform" | "blobs">,
  directory: string,
) {
  const id = "blue-horizon";
  if (
    ctx.identity.get(CATALOG, { id }) ||
    ctx.identity.get(INVENTORY, { decoration_id: id })
  )
    return { id, skipped: true };
  const source = await fs.readFile(`${directory}/blue-horizon.svg`);
  const asset = await processAsset(ctx, source);
  const item = COLLECTION.find((x) => x.id === id)!;
  await ctx.identity.write((w) => {
    if (w.get(CATALOG, { id }) || w.get(INVENTORY, { decoration_id: id }))
      throw new Error(
        "Catalog changed during launch seeding; operator edits preserved",
      );
    w.insert(CATALOG, {
      id,
      metadata: JSON.stringify({
        ...item,
        version: item.version + 1,
        recipe: { ...item.recipe, assetId: asset.id },
      }),
      updated_at: Date.now(),
    });
  });
  await new PlatformAudit(ctx.platform).record({
    action: "collectible.launch-artwork",
    outcome: "success",
    actorRole: "operator",
    targetType: "collectible",
    targetId: id,
    reason: "Publish original Meldiq launch artwork",
    detail: { assetId: asset.id },
  });
  return { id, assetId: asset.id, variants: Object.keys(asset.variants) };
}
