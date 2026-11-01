import { createHash, randomBytes } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import {
  ADMIN_ORIGIN,
  consoleAdmin,
  type ConsoleAdmin,
} from "./support/adminConsole.js";
import { MemoryMailer } from "./support/accounts.js";
const bucket = process.env.MELDIQ_PROFILE_LIVE_S3_BUCKET;
const prefix = `orbit/profile-probe-${randomBytes(8).toString("hex")}/`;
describe.skipIf(!bucket)(
  "live S3 profile asset lifecycle (isolated synthetic prefix)",
  () => {
    let h: Harness, admin: ConsoleAdmin;
    beforeAll(async () => {
      const mailer = new MemoryMailer();
      h = await startServer(
        {
          ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN,
          STORAGE_BACKEND: "s3",
          S3_BUCKET: bucket!,
          S3_REGION: "ap-southeast-1",
          S3_PREFIX: prefix,
        },
        { mailer },
      );
      admin = await consoleAdmin(h, mailer, "super_admin", "liveassetprobe");
    }, 60000);
    afterAll(async () => {
      if (!h) return;
      for await (const blob of h.ctx.blobs.listIds("profile-photos"))
        await h.ctx.blobs.delete("profile-photos", blob.id);
      await h.close();
    }, 60000);
    it("enforces checksum and no-overwrite, processes safe SVG, keeps S3 private and serves cacheable WebP", async () => {
      const body = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="26" fill="#06b6d4"/></svg>',
      );
      const signed = await admin.browser.expect(
        200,
        "POST",
        "/admin/v1/profile-collectibles/uploads",
        {
          size: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      );
      const preflight = await fetch(signed.upload.url, {
        method: "OPTIONS",
        headers: {
          origin: "https://admin.meldiq.app",
          "access-control-request-method": "PUT",
          "access-control-request-headers": Object.keys(signed.upload.headers)
            .filter((x) => x !== "content-length")
            .join(","),
        },
      });
      expect(preflight.status).toBe(200);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(
        "https://admin.meldiq.app",
      );
      expect(
        (
          await fetch(signed.upload.url, {
            method: "PUT",
            headers: signed.upload.headers,
            body: Buffer.alloc(body.length),
          })
        ).status,
      ).toBe(400);
      const put = await fetch(signed.upload.url, {
        method: "PUT",
        headers: {
          ...signed.upload.headers,
          origin: "https://admin.meldiq.app",
        },
        body,
      });
      expect(put.status).toBe(200);
      expect(put.headers.get("x-amz-server-side-encryption")).toBe("AES256");
      expect(
        (
          await fetch(signed.upload.url, {
            method: "PUT",
            headers: signed.upload.headers,
            body,
          })
        ).status,
      ).toBe(412);
      const unsigned = new URL(signed.upload.url);
      unsigned.search = "";
      expect((await fetch(unsigned)).status).toBe(403);
      const done = await admin.browser.expect(
        200,
        "POST",
        `/admin/v1/profile-collectibles/uploads/${signed.id}/complete`,
        {},
      );
      expect(done.asset.format).toBe("svg");
      expect(Object.keys(done.asset.variants).sort()).toEqual([
        "avif",
        "full",
        "original",
        "poster",
        "thumbnail",
      ]);
      const item = (
        await admin.browser.expect(200, "GET", "/admin/v1/profile-collectibles")
      ).items.find((x) => x.id === "blue-horizon");
      await admin.browser.expect(
        200,
        "PUT",
        "/admin/v1/profile-collectibles/blue-horizon",
        { ...item, recipe: { ...item.recipe, assetId: done.asset.id } },
      );
      const url =
        h.baseUrl +
        `/v2/profile-collectibles/assets/${done.asset.id}/poster.webp`;
      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toContain("image/webp");
      expect(first.headers.get("cache-control")).toContain(
        "public, max-age=86400",
      );
      await first.arrayBuffer();
      expect(
        (
          await fetch(url, {
            headers: { "if-none-match": first.headers.get("etag")! },
          })
        ).status,
      ).toBe(304);
      expect(h.ctx.identity.count("profile_collectible_uploads")).toBe(0);
      console.log(
        JSON.stringify({
          bucket,
          prefix,
          signedPut: "passed",
          checksumRejection: "passed",
          overwriteRejection: "passed",
          s3Private: true,
          optimizedVariants: 4,
          conditionalGet: 304,
        }),
      );
    }, 60000);
  },
);
