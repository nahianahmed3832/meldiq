import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pngInfo } from "../src/modules/accounts/mediaFormats.js";
import { BUILTIN_DECORATIONS } from "../src/modules/accounts/decorations/builtins.generated.js";
import { DecorationCatalog, MyDecorations } from "../src/shared/contracts/http/decorations.js";
import { AdminDecorationDecided, AdminDecorationsPage } from "../src/shared/contracts/http/platformAdmin.js";
import { MemoryMailer } from "./support/accounts.js";
import { ADMIN_ORIGIN, type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** API 0.60.0 (docs/PROFILE_DECORATIONS.md): Meldiq's own decorations, and ones people send in for review. */

/** A PNG's chunk structure (IHDR, an optional acTL for [frames], IDAT, IEND): what the parser reads. */
function png(w: number, h: number, frames = 1): Buffer {
  const chunk = (id: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(id, "latin1"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames, 0);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(frames > 1 ? [chunk("acTL", actl)] : []),
    chunk("IDAT", Buffer.alloc(16)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("the PNG parser", () => {
  it("reads the size and an animated PNG's frames, and refuses broken files", () => {
    expect(pngInfo(png(512, 512))).toEqual({
      width: 512,
      height: 512,
      frames: 1,
    });
    expect(pngInfo(png(256, 256, 12))).toEqual({
      width: 256,
      height: 256,
      frames: 12,
    });
    expect(pngInfo(png(512, 512).subarray(0, 40))).toBeNull();
  });
});

/** Production's MongoDB domains: submissions then live in MongoDB (new data goes there whenever the server has one). */
const PRODUCTION_DOMAINS = "preferences,reports,relationships,history,accounts,files,relay,billing";

describe.each([
  ["memory", {}],
  ["mongodb", { MONGODB_DOMAINS: PRODUCTION_DOMAINS }],
] as const)("kept in %s", (backend, env) => {
  let h: Harness;
  let ada: GriipClient, bob: GriipClient, cat: GriipClient;
  const mailer = new MemoryMailer();
  let support: ConsoleAdmin, billing: ConsoleAdmin;
  const REASON = "Uses someone else's artwork";

  beforeAll(async () => {
    h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, ...env }, { mailer });
    expect(h.ctx.decorations.store.backend).toBe(backend);
    [ada, bob, cat] = await Promise.all(["ada", "bob", "cat"].map((n) => h.client(n)));
    await ada.req("POST", "/v1/conversations/dm", { userId: bob.userId });
    support = await consoleAdmin(h, mailer, "support_admin", "decosupport");
    billing = await consoleAdmin(h, mailer, "billing_admin", "decobilling");
  });
  afterAll(async () => h.close());

  const submit = (c: GriipClient, name: string, image: Buffer, original = true) =>
    c.req("POST", `/v2/decorations?name=${encodeURIComponent(name)}${original ? "&original=true" : ""}`, undefined, image);
  const decide = (id: string, body: Record<string, string>, who = support) => who.browser.expect(200, "POST", `/admin/v1/decorations/${id}/decision`, body);
  const publicImage = (id: string) => fetch(`${h.baseUrl}/v2/decorations/${id}/image`);

  describe("Meldiq's own decorations", () => {
    it("are listed with the classic frames and the template, and anyone can load their images", async () => {
      const c = await ada.req("GET", "/v2/decorations");
      expect(DecorationCatalog.safeParse(c).success).toBe(true);
      expect(c.classic).toEqual(["aurora", "ember", "frost", "neon", "sakura", "pixel"]);
      expect(c.decorations.slice(0, BUILTIN_DECORATIONS.length).map((d: { id: string }) => d.id)).toEqual(BUILTIN_DECORATIONS.map((d) => d.id));
      expect(c.decorations.find((d: { id: string }) => d.id === "flames")).toMatchObject({
        name: "Flames",
        kind: "meldiq",
        animated: true,
        creator: null,
        imageUrl: "/v2/decorations/flames/image",
      });
      const image = await publicImage("flames");
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/webp");
      expect((await fetch(`${h.baseUrl}/v2/decorations/template`)).headers.get("content-type")).toBe("image/png");
      expect((await publicImage("no-such-thing")).status).toBe(404);
    });

    it("are worn like the classic frames; an unknown one is refused", async () => {
      expect(
        (
          await ada.req("PUT", "/v1/users/me/profile-style", {
            decoration: "crown",
          })
        ).profileStyle.decoration,
      ).toBe("crown");
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.profileStyle.decoration).toBe("crown");
      expect(
        (
          await ada.req("PUT", "/v1/users/me/profile-style", {
            decoration: "aurora",
          })
        ).profileStyle.decoration,
      ).toBe("aurora");
      await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { decoration: "made-up" }), 400);
      await expectStatus(
        ada.req("PUT", "/v1/users/me/profile-style", {
          decoration: "c_0000000000000000",
        }),
        400,
      );
    });
  });

  describe("sending one in", () => {
    it("takes a square PNG, WebP or GIF of 128 to 1024 px, with the maker's word that it's theirs", async () => {
      await expectStatus(submit(cat, "Wide", png(600, 400)), 400);
      await expectStatus(submit(cat, "Tiny", png(64, 64)), 400);
      await expectStatus(submit(cat, "Huge", png(2048, 2048)), 400);
      await expectStatus(submit(cat, "Not mine", png(512, 512), false), 400);
      await expectStatus(submit(cat, "x", png(512, 512)), 400);
      await expectStatus(submit(cat, "Text", Buffer.from("hello")), 400);
      const { submission } = await submit(cat, "Moon ring", png(512, 512, 8));
      expect(submission).toMatchObject({
        name: "Moon ring",
        status: "pending",
        animated: true,
        reason: null,
        wearers: 0,
      });
      expect(submission.id).toMatch(/^c_[a-z0-9]{16}$/);
    });

    it("stays out of sight until it's approved; its maker can see it and withdraw it", async () => {
      const { submission } = await submit(cat, "Withdrawn", png(256, 256));
      expect((await publicImage(submission.id)).status).toBe(404);
      expect((await ada.req("GET", "/v2/decorations")).decorations.some((d: { id: string }) => d.id === submission.id)).toBe(false);
      expect(Buffer.isBuffer(await cat.req("GET", `/v2/decorations/mine/${submission.id}/image`))).toBe(true);
      await expectStatus(ada.req("GET", `/v2/decorations/mine/${submission.id}/image`), 404);
      await expectStatus(ada.req("DELETE", `/v2/decorations/mine/${submission.id}`), 404);
      await cat.req("DELETE", `/v2/decorations/mine/${submission.id}`);
      expect((await cat.req("GET", "/v2/decorations/mine")).submissions.some((s: { id: string }) => s.id === submission.id)).toBe(false);
    });

    it("allows three waiting at once, six for an artist", async () => {
      await submit(cat, "Second", png(512, 512));
      await submit(cat, "Third", png(512, 512));
      const mine = await cat.req("GET", "/v2/decorations/mine");
      expect(MyDecorations.safeParse(mine).success).toBe(true);
      expect(mine).toMatchObject({
        artist: false,
        pendingLimit: 3,
        pending: 3,
      });
      const full = await expectStatus(submit(cat, "Fourth", png(512, 512)), 409);
      expect(full.error.code).toBe("limit_reached");
    });
  });

  describe("review in the admin console", () => {
    it("is for support and operations admins, not billing admins", async () => {
      await billing.browser.expect(403, "GET", "/admin/v1/decorations");
      const page = await support.browser.expect(200, "GET", "/admin/v1/decorations");
      expect(AdminDecorationsPage.safeParse(page).success).toBe(true);
      expect(page.decorations.map((d: { name: string }) => d.name)).toEqual(["Third", "Second", "Moon ring"]);
      expect(page.decorations[0]).toMatchObject({
        status: "pending",
        creator: { userId: cat.userId, artist: false },
      });
      const image = await support.browser.req("GET", `/admin/v1/decorations/${page.decorations[0].id}/image`);
      expect(image.status).toBe(200);
      expect(image.headers["content-type"]).toBe("image/png");
      expect(image.headers["content-security-policy"]).toContain("sandbox");
    });

    it("approves one: it joins the catalog with its maker, its maker gets the Artist badge and room for six", async () => {
      const moon = (await support.browser.expect(200, "GET", "/admin/v1/decorations")).decorations.find((d: { name: string }) => d.name === "Moon ring");
      const decided = await decide(moon.id, { decision: "approve" });
      expect(AdminDecorationDecided.safeParse(decided).success).toBe(true);
      expect(decided.decoration.status).toBe("approved");
      expect(h.ctx.platform.get<any>("platform_audit", { action: "decoration.approve" }, [["id", "desc"]])).toMatchObject({ target_id: moon.id, actor_role: "support_admin" });
      await support.browser.expect(409, "POST", `/admin/v1/decorations/${moon.id}/decision`, { decision: "approve" });

      const listed = (await ada.req("GET", "/v2/decorations")).decorations.find((d: { id: string }) => d.id === moon.id);
      expect(listed).toMatchObject({
        name: "Moon ring",
        kind: "community",
        animated: true,
        creator: { userId: cat.userId },
      });
      const image = await publicImage(moon.id);
      expect(image.status).toBe(200);
      expect(image.headers.get("cache-control")).toContain("immutable");
      expect((await ada.req("GET", `/v1/users/${cat.userId}`)).user.decorationArtist).toBe(true);
      expect((await cat.req("GET", `/v1/users/${ada.userId}`)).user.decorationArtist).toBeUndefined();
      expect((await ada.req("GET", `/v2/users/${cat.userId}/decorations`)).decorations.map((d: { id: string }) => d.id)).toEqual([moon.id]);
      expect(await cat.req("GET", "/v2/decorations/mine")).toMatchObject({
        artist: true,
        pendingLimit: 6,
        pending: 2,
      });
    });

    it("turns one down with a reason its maker sees", async () => {
      const second = (await support.browser.expect(200, "GET", "/admin/v1/decorations")).decorations.find((d: { name: string }) => d.name === "Second");
      await support.browser.expect(400, "POST", `/admin/v1/decorations/${second.id}/decision`, { decision: "reject" });
      await decide(second.id, { decision: "reject", reason: REASON });
      expect((await cat.req("GET", "/v2/decorations/mine")).submissions.find((s: { id: string }) => s.id === second.id)).toMatchObject({ status: "rejected", reason: REASON });
      expect((await publicImage(second.id)).status).toBe(404);
    });

    it("counts who wears one, and taking it down takes it off them", async () => {
      const moon = (await ada.req("GET", "/v2/decorations")).decorations.find((d: { name: string }) => d.name === "Moon ring");
      await ada.req("PUT", "/v1/users/me/profile-style", {
        decoration: moon.id,
      });
      await bob.req("PUT", "/v1/users/me/profile-style", {
        decoration: moon.id,
      });
      await bob.req("PUT", "/v1/users/me/profile-style", {
        decoration: "halo",
      });
      expect((await cat.req("GET", "/v2/decorations/mine")).submissions.find((s: { id: string }) => s.id === moon.id).wearers).toBe(1);

      await decide(moon.id, { decision: "remove", reason: REASON });
      expect((await ada.req("GET", "/v1/users/me")).user.profileStyle?.decoration ?? null).toBeNull();
      expect((await ada.req("GET", "/v2/decorations")).decorations.some((d: { id: string }) => d.id === moon.id)).toBe(false);
      expect((await publicImage(moon.id)).status).toBe(404);
      const mine = await cat.req("GET", "/v2/decorations/mine");
      expect(mine.submissions.find((s: { id: string }) => s.id === moon.id)).toMatchObject({ status: "removed", reason: REASON, wearers: 0 });
      expect(mine.artist).toBe(false);
      await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { decoration: moon.id }), 400);
    });
  });
});
