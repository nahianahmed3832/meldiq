import { seedCollectionArtwork } from "../src/modules/accounts/collectibles/seedAssets.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { startServer, type Harness, expectStatus } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { MemoryMailer } from "./support/accounts.js";
import {
  ADMIN_ORIGIN,
  consoleAdmin,
  type ConsoleAdmin,
} from "./support/adminConsole.js";
import { CollectionService } from "../src/modules/accounts/collectibles/service.js";
import {
  boundedBlob,
  processAsset,
} from "../src/modules/accounts/collectibles/assets.js";
import { styleOf } from "../src/modules/accounts/profileMedia.js";
const ALL =
  "preferences,reports,relationships,history,accounts,files,relay,billing,platform,federation,calls,workspace,conversations,safety,ephemeral,identity";
describe.each([
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: ALL }],
] as const)("profile collection (%s)", (_backend, env) => {
  let h: Harness,
    ada: GriipClient,
    bob: GriipClient,
    admin: ConsoleAdmin,
    support: ConsoleAdmin;
  const mailer = new MemoryMailer();
  beforeAll(async () => {
    h = await startServer(
      { ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, ...env },
      { mailer },
    );
    [ada, bob] = await Promise.all([
      h.client("collectionada"),
      h.client("collectionbob"),
    ]);
    admin = await consoleAdmin(h, mailer, "super_admin", "collectsuper");
    support = await consoleAdmin(h, mailer, "support_admin", "collectsupport");
  }, 120000);
  afterAll(async () => {
    await h?.close();
  }, 120000);
  const state = () => ada.req("GET", "/v2/users/me/profile-customization");
  const equip = async (slots: Record<string, string | null>, rev?: string) =>
    ada.req("PATCH", "/v2/users/me/profile-customization", {
      baseStyleRevision: rev ?? (await state()).styleRevision,
      slots,
    });
  it("publishes original launch artwork once and preserves catalog overrides", async () => {
    const first = await seedCollectionArtwork(h.ctx, "assets/collectibles");
    expect(first.assetId).toMatch(/^[a-f0-9]{64}$/);
    expect(await seedCollectionArtwork(h.ctx, "assets/collectibles")).toEqual({
      id: "blue-horizon",
      skipped: true,
    });
    expect(
      new CollectionService(h.ctx).item("blue-horizon").recipe.assetId,
    ).toBe(first.assetId);
  });
  it("requires authentication and paginates every category without duplicates", async () => {
    expect((await fetch(h.baseUrl + "/v2/profile-collectibles")).status).toBe(
      401,
    );
    expect(
      (await ada.req("GET", "/v2/profile-collectibles/categories")).categories,
    ).toHaveLength(8);
    expect((await ada.req("GET", "/v2/auth/social/config")).providers).toEqual(
      [],
    );
    const a = await ada.req(
      "GET",
      "/v2/profile-collectibles?limit=2&category=avatar-frame",
    );
    const b = await ada.req(
      "GET",
      "/v2/profile-collectibles?limit=2&category=avatar-frame&after=" + a.next,
    );
    expect(a.items).toHaveLength(2);
    expect(b.items).toHaveLength(1);
    expect(new Set([...a.items, ...b.items].map((x) => x.id)).size).toBe(3);
    expect(
      (await ada.req("GET", "/v2/profile-collectibles?q=nightwave")).items
        .length,
    ).toBeGreaterThan(0);
  });
  it("preserves an existing profile and refuses unowned and forged recipes", async () => {
    await ada.req("PUT", "/v1/users/me/profile-style", {
      accent: "#123456",
      nameFont: "mono",
    });
    await expectStatus(equip({ "avatar-frame": "ion-halo" }), 403);
    await expectStatus(
      ada.req("PATCH", "/v2/users/me/profile-customization", {
        baseStyleRevision: "a".repeat(64),
        slots: { banner: "blue-horizon" },
        recipe: { assetId: "evil" },
      }),
      400,
    );
    expect((await state()).profileStyle).toMatchObject({
      accent: "#123456",
      nameFont: "mono",
    });
  });
  it("claims atomically once, persists ownership and never accepts a client price", async () => {
    await Promise.all(
      [1, 2, 3].map(() =>
        ada.req("POST", "/v2/users/me/profile-collectibles/ion-halo/claim", {
          price: 0,
        }),
      ),
    );
    expect(new CollectionService(h.ctx).inventory(ada.userId)).toHaveLength(1);
    expect(
      h.ctx.identity.count("profile_collectible_transactions", {
        user_id: ada.userId,
        decoration_id: "ion-halo",
      }),
    ).toBe(1);
    await expectStatus(
      ada.req(
        "POST",
        "/v2/users/me/profile-collectibles/violet-circuit/claim",
        { price: 0, paymentReference: "forged" },
      ),
      403,
    );
  });
  it("keeps favorites private and equips owned slots with a revision check", async () => {
    await ada.req("PUT", "/v2/users/me/profile-collectibles/ion-halo/favorite");
    expect(
      (await ada.req("GET", "/v2/users/me/profile-collectibles")).inventory[0]
        .is_favorite,
    ).toBe(1);
    expect(
      (await bob.req("GET", "/v2/users/me/profile-collectibles")).inventory,
    ).toEqual([]);
    const rev = (await state()).styleRevision;
    const result = await equip({ "avatar-frame": "ion-halo" }, rev);
    expect(result.profileStyle.decoration).toBe("aurora");
    expect(result.profileStyle.collectibles[0].id).toBe("ion-halo");
    await expectStatus(equip({ "avatar-frame": null }, rev), 409);
    const publicProfile = (await bob.req("GET", `/v1/users/${ada.userId}`))
      .user;
    expect(publicProfile.profileStyle.collectibles[0].id).toBe("ion-halo");
    expect(publicProfile).not.toHaveProperty("inventory");
    expect(publicProfile).not.toHaveProperty("transactions");
    await ada.req(
      "DELETE",
      "/v2/users/me/profile-collectibles/ion-halo/favorite",
    );
  });
  it("filters ownership, favorites and recent acquisitions before pagination", async () => {
    await ada.req("PUT", "/v2/users/me/profile-collectibles/ion-halo/favorite");
    await ada.req(
      "POST",
      "/v2/users/me/profile-collectibles/blue-horizon/claim",
    );
    const first = await ada.req(
      "GET",
      "/v2/profile-collectibles?filter=recent&limit=1",
    );
    expect(first.items[0].id).toBe("blue-horizon");
    const second = await ada.req(
      "GET",
      "/v2/profile-collectibles?filter=recent&limit=1&after=" + first.next,
    );
    expect(second.items[0].id).toBe("ion-halo");
    expect(second.next).toBeNull();
    expect(
      (
        await ada.req(
          "GET",
          "/v2/profile-collectibles?filter=favorites&limit=1",
        )
      ).items.map((x) => x.id),
    ).toEqual(["ion-halo"]);
    expect(
      (await bob.req("GET", "/v2/profile-collectibles?filter=owned")).items,
    ).toEqual([]);
    expect(
      (
        await ada.req("GET", "/v2/profile-collectibles?filter=unowned")
      ).items.some((x) => x.id === "ion-halo"),
    ).toBe(false);
    await ada.req(
      "DELETE",
      "/v2/users/me/profile-collectibles/ion-halo/favorite",
    );
  });
  it("rolls back mixed invalid updates and reconciles old-client changes", async () => {
    const previous = await state();
    await expectStatus(
      equip({ "avatar-frame": null, banner: "afterglow" }),
      403,
    );
    expect(await state()).toEqual(previous);
    await expectStatus(equip({ banner: "ion-halo" }), 400);
    await ada.req("PUT", "/v1/users/me/profile-style", { decoration: "frost" });
    expect((await state()).profileStyle.collectibles ?? []).toEqual([]);
  });
  it("enforces super-admin catalog editing, supports grants and deactivation", async () => {
    expect(
      (await support.browser.req("GET", "/admin/v1/profile-collectibles"))
        .status,
    ).toBe(403);
    const item = (
      await admin.browser.expect(200, "GET", "/admin/v1/profile-collectibles")
    ).items.find((x) => x.id === "violet-circuit");
    await admin.browser.expect(
      200,
      "PUT",
      "/admin/v1/profile-collectibles/violet-circuit",
      { ...item, isFeatured: true },
    );
    await admin.browser.expect(
      200,
      "POST",
      "/admin/v1/profile-collectibles/violet-circuit/grant",
      { userId: ada.userId, reason: "Event reward for test" },
    );
    expect(
      new CollectionService(h.ctx)
        .inventory(ada.userId)
        .find((x) => x.decoration_id === "violet-circuit")?.acquisition_source,
    ).toBe("admin");
    expect(
      h.ctx.platform
        .all<{ reason: string }>("platform_audit", {
          where: { action: "collectible.grant" },
        })
        .at(-1)?.reason,
    ).toBe("Event reward for test");
    await equip({ "avatar-frame": "violet-circuit" });
    await admin.browser.expect(
      200,
      "DELETE",
      "/admin/v1/profile-collectibles/violet-circuit",
    );
    expect((await state()).profileStyle.collectibles ?? []).toEqual([]);
    expect(
      new CollectionService(h.ctx)
        .inventory(ada.userId)
        .some((x) => x.decoration_id === "violet-circuit"),
    ).toBe(true);
  });
  it("publishes only profile notices and handles seasonal expiry without deleting ownership", async () => {
    await ada.req("POST", "/v1/conversations/dm", { userId: bob.userId });
    await bob.connect();
    const seen = () =>
      bob.events.filter(
        (x: { t: string; userId?: string }) =>
          x.t === "user.updated" && x.userId === ada.userId,
      ).length;
    const before = seen();
    await equip({ "avatar-frame": "ion-halo" });
    await bob.waitFor(() => seen() > before);
    const event = bob.events.find(
      (x: { t: string; userId?: string }) =>
        x.t === "user.updated" && x.userId === ada.userId,
    );
    expect(event).not.toHaveProperty("inventory");
    const service = new CollectionService(h.ctx);
    const item = service.item("ion-halo");
    await service.save({ ...item, availableUntil: Date.now() + 1000 });
    await service.expireUnavailable();
    expect(
      service.inventory(ada.userId).some((x) => x.decoration_id === "ion-halo"),
    ).toBe(true);
    await service.save({ ...item, availableUntil: Date.now() - 1 });
    await service.expireUnavailable();
    expect((await state()).profileStyle.collectibles ?? []).toEqual([]);
    await expectStatus(equip({ "avatar-frame": "ion-halo" }), 409);
    await service.save({ ...item, availableUntil: null });
    await bob.disconnect();
  });
  it("decodes raster assets, generates static fallbacks, enforces safe types and cache validators", async () => {
    await expect(
      processAsset(h.ctx, Buffer.from('<svg onload="alert(1)"></svg>')),
    ).rejects.toThrow();
    const image = await sharp({
      create: {
        width: 512,
        height: 256,
        channels: 4,
        background: { r: 20, g: 50, b: 150, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const asset = await processAsset(h.ctx, image);
    expect(asset.variants).toHaveProperty("thumbnail");
    expect(asset.variants).toHaveProperty("avif");
    expect(asset.frames).toBe(1);
    const item = new CollectionService(h.ctx).item("blue-horizon");
    await new CollectionService(h.ctx).save({
      ...item,
      recipe: { ...item.recipe, assetId: asset.id },
    });
    const res = await fetch(
      h.baseUrl + `/v2/profile-collectibles/assets/${asset.id}/poster`,
    );
    expect(res.status).toBe(200);
    const cdn = await fetch(
      h.baseUrl + `/v2/profile-collectibles/assets/${asset.id}/poster.webp`,
    );
    expect(cdn.status).toBe(200);
    expect(cdn.headers.get("content-type")).toContain("image/webp");
    expect(cdn.headers.get("etag")).toBe(res.headers.get("etag"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    const cached = await fetch(
      h.baseUrl + `/v2/profile-collectibles/assets/${asset.id}/poster`,
      { headers: { "if-none-match": res.headers.get("etag")! } },
    );
    expect(cached.status).toBe(304);
    const rotated = await sharp({
      create: { width: 128, height: 64, channels: 3, background: "#123456" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const oriented = await processAsset(h.ctx, rotated);
    const poster = await sharp(
      await boundedBlob(h.ctx, oriented.variants.poster.blob, 6 * 1024 * 1024),
    ).metadata();
    expect([poster.width, poster.height]).toEqual([64, 128]);
    expect(
      styleOf(h.ctx.identity.get("users", { id: ada.userId }) ?? {}).nameFont,
    ).toBe("mono");
  }, 60000);
});
