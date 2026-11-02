import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACHIEVEMENTS } from "../src/modules/points/achievements.js";
import { MELDIQ_PINS } from "../src/modules/accounts/pins/builtins.js";
import {
  CommunityPins,
  MeldiqPinCatalog,
  PinHolders,
  ProfilePin,
} from "../src/shared/contracts/http/pins.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** API 0.64.0 (docs/PROFILE_PINS.md): Meldiq's pins for milestones, and pins communities make and give. */

/** A PNG's chunk structure (IHDR, an optional acTL for [frames], IDAT, IEND): what the parser reads. */
function png(w: number, h: number, frames = 1): Buffer {
  const chunk = (id: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([
      len,
      Buffer.from(id, "latin1"),
      body,
      Buffer.alloc(4),
    ]);
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

const PRODUCTION_DOMAINS =
  "preferences,reports,relationships,history,accounts,files,relay,billing";
type Pin = {
  id: string;
  kind: string;
  name: string;
  community?: { id: string; name: string };
};

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
  ["memory", {}],
  ["mongodb", { MONGODB_DOMAINS: PRODUCTION_DOMAINS }],
] as const)("kept in %s", (backend, env) => {
  let h: Harness;
  let owner: GriipClient,
    admin: GriipClient,
    member: GriipClient,
    outsider: GriipClient;
  let publicOrg: string, privateOrg: string;

  const pinsOf = async (
    viewer: GriipClient,
    who: GriipClient,
  ): Promise<Pin[]> =>
    (await viewer.req("GET", `/v1/users/${who.userId}`)).user.pins ?? [];
  const create = (
    c: GriipClient,
    orgId: string,
    name: string,
    image: Buffer,
    description?: string,
  ) =>
    c.req(
      "POST",
      `/v2/orgs/${orgId}/pins?name=${encodeURIComponent(name)}${description ? `&description=${encodeURIComponent(description)}` : ""}`,
      undefined,
      image,
    );

  beforeAll(async () => {
    h = await startServer({ ...env });
    expect(h.ctx.pins.store.backend).toBe(backend);
    [owner, admin, member, outsider] = await Promise.all(
      ["owner", "admin", "member", "outsider"].map((n) => h.client(n)),
    );
    publicOrg = (await owner.req("POST", "/v1/orgs", { name: "Pin Club" })).org
      .id;
    privateOrg = (await owner.req("POST", "/v1/orgs", { name: "Secret Pins" }))
      .org.id;
    await owner.req("PATCH", `/v1/orgs/${publicOrg}`, {
      visibility: "public",
      joinPolicy: "open",
    });
    for (const orgId of [publicOrg, privateOrg]) {
      const { code } = (
        await owner.req("POST", `/v1/orgs/${orgId}/invites`, {
          role: "MEMBER",
          maxUses: 10,
        })
      ).invite;
      for (const c of [admin, member])
        await c.req("POST", "/v1/invites/accept", { code });
      await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, {
        role: "ADMIN",
      });
    }
  });
  afterAll(async () => h?.close());

  describe("Meldiq's own", () => {
    it("are listed with how each is earned, and anyone can load their images", async () => {
      const c = await member.req("GET", "/v2/pins");
      expect(MeldiqPinCatalog.safeParse(c).success).toBe(true);
      expect(c.pins.map((p: { id: string }) => p.id)).toEqual(
        [...MELDIQ_PINS, ...ACHIEVEMENTS].map((p) => p.id),
      );
      const image = await fetch(`${h.baseUrl}/v2/pins/early-member/image`);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/webp");
      for (const badge of ACHIEVEMENTS) {
        const image = await fetch(`${h.baseUrl}/v2/pins/${badge.id}/image`);
        expect(image.status).toBe(200);
        expect(image.headers.get("content-type")).toBe("image/webp");
      }
      expect(
        (await fetch(`${h.baseUrl}/v2/pins/no-such-pin/image`)).status,
      ).toBe(404);
    });

    it("are earned from milestones: an account made in the beta is an early member", async () => {
      const pins = await pinsOf(outsider, member);
      expect(pins.every((p) => ProfilePin.safeParse(p).success)).toBe(true);
      expect(pins.map((p) => p.id)).toContain("early-member");
      expect(pins.map((p) => p.id)).not.toContain("explorer");
      expect(pins.map((p) => p.id)).not.toContain("one-year");
    });

    it("gives Explorer for five communities and Community builder for owning one of ten members", async () => {
      const ids = (await pinsOf(outsider, owner)).map((p) => p.id);
      expect(ids).not.toContain("explorer");
      expect(ids).not.toContain("founder");
      for (const n of [1, 2, 3])
        await owner.req("POST", "/v1/orgs", { name: `More ${n}` });
      expect((await pinsOf(outsider, owner)).map((p) => p.id)).toContain(
        "explorer",
      );
      const { code } = (
        await owner.req("POST", `/v1/orgs/${publicOrg}/invites`, {
          role: "MEMBER",
          maxUses: 20,
        })
      ).invite;
      const more = await Promise.all(
        Array.from({ length: 7 }, (_, i) => h.client(`joiner${i}`)),
      );
      for (const c of more) await c.req("POST", "/v1/invites/accept", { code });
      expect((await pinsOf(outsider, owner)).map((p) => p.id)).toContain(
        "founder",
      );
    });
  });

  describe("a community's own", () => {
    let pinId: string;

    it("are made by owners and admins only, as a square PNG, WebP or GIF of 64 to 512 px", async () => {
      await expectStatus(
        create(member, publicOrg, "Helper", png(128, 128)),
        403,
      );
      await expectStatus(
        create(outsider, publicOrg, "Helper", png(128, 128)),
        404,
      );
      await expectStatus(create(admin, publicOrg, "Helper", png(128, 96)), 400);
      await expectStatus(create(admin, publicOrg, "Helper", png(32, 32)), 400);
      await expectStatus(
        create(admin, publicOrg, "Helper", Buffer.from("not an image")),
        400,
      );
      await expectStatus(create(admin, publicOrg, "x", png(128, 128)), 400);
      const made = await create(
        admin,
        publicOrg,
        "Top helper",
        png(128, 128, 8),
        "Answered 100 questions",
      );
      expect(made.pin).toMatchObject({
        name: "Top helper",
        description: "Answered 100 questions",
        animated: true,
        holders: 0,
      });
      pinId = made.pin.id;
      const list = await member.req("GET", `/v2/orgs/${publicOrg}/pins`);
      expect(CommunityPins.safeParse(list).success).toBe(true);
      expect(list).toMatchObject({ canManage: false, limit: 30 });
      expect(list.pins.map((p: { id: string }) => p.id)).toEqual([pinId]);
      expect(
        (await admin.req("GET", `/v2/orgs/${publicOrg}/pins`)).canManage,
      ).toBe(true);
      await expectStatus(
        outsider.req("GET", `/v2/orgs/${publicOrg}/pins`),
        404,
      );
      const image = await fetch(`${h.baseUrl}${made.pin.imageUrl}`);
      expect(image.headers.get("content-type")).toBe("image/png");
    });

    it("are given to members by owners and admins, and shown on their profile with the community's name", async () => {
      await expectStatus(
        member.req(
          "PUT",
          `/v2/orgs/${publicOrg}/pins/${pinId}/holders/${member.userId}`,
        ),
        403,
      );
      await expectStatus(
        admin.req(
          "PUT",
          `/v2/orgs/${publicOrg}/pins/${pinId}/holders/${outsider.userId}`,
        ),
        404,
      );
      await admin.req(
        "PUT",
        `/v2/orgs/${publicOrg}/pins/${pinId}/holders/${member.userId}`,
      );
      await admin.req(
        "PUT",
        `/v2/orgs/${publicOrg}/pins/${pinId}/holders/${member.userId}`,
      );
      const holders = await member.req(
        "GET",
        `/v2/orgs/${publicOrg}/pins/${pinId}/holders`,
      );
      expect(PinHolders.safeParse(holders).success).toBe(true);
      expect(holders.holders.map((x: { userId: string }) => x.userId)).toEqual([
        member.userId,
      ]);
      expect(
        (await member.req("GET", `/v2/orgs/${publicOrg}/pins`)).pins[0].holders,
      ).toBe(1);
      const shown = (await pinsOf(outsider, member)).find(
        (p) => p.id === pinId,
      );
      expect(shown).toMatchObject({
        kind: "community",
        name: "Top helper",
        community: { id: publicOrg, name: "Pin Club" },
      });
    });

    it("from a private community are shown only to its members", async () => {
      const secret = (await create(owner, privateOrg, "Insider", png(64, 64)))
        .pin.id;
      await owner.req(
        "PUT",
        `/v2/orgs/${privateOrg}/pins/${secret}/holders/${member.userId}`,
      );
      expect((await pinsOf(outsider, member)).map((p) => p.id)).not.toContain(
        secret,
      );
      expect((await pinsOf(admin, member)).map((p) => p.id)).toContain(secret);
      expect((await pinsOf(member, member)).map((p) => p.id)).toContain(secret);
    });

    it("are taken back, and a deleted pin comes off everyone and its image is gone", async () => {
      await admin.req(
        "DELETE",
        `/v2/orgs/${publicOrg}/pins/${pinId}/holders/${member.userId}`,
      );
      expect((await pinsOf(outsider, member)).map((p) => p.id)).not.toContain(
        pinId,
      );
      await admin.req(
        "PUT",
        `/v2/orgs/${publicOrg}/pins/${pinId}/holders/${member.userId}`,
      );
      await expectStatus(
        member.req("DELETE", `/v2/orgs/${publicOrg}/pins/${pinId}`),
        403,
      );
      await admin.req("DELETE", `/v2/orgs/${publicOrg}/pins/${pinId}`);
      expect((await pinsOf(outsider, member)).map((p) => p.id)).not.toContain(
        pinId,
      );
      expect((await fetch(`${h.baseUrl}/v2/pins/${pinId}/image`)).status).toBe(
        404,
      );
      await expectStatus(
        admin.req("GET", `/v2/orgs/${publicOrg}/pins/${pinId}/holders`),
        404,
      );
    });

    it("stop showing once the holder leaves the community", async () => {
      const kept = (await create(owner, publicOrg, "Veteran", png(64, 64))).pin
        .id;
      await owner.req(
        "PUT",
        `/v2/orgs/${publicOrg}/pins/${kept}/holders/${admin.userId}`,
      );
      expect((await pinsOf(outsider, admin)).map((p) => p.id)).toContain(kept);
      await owner.req(
        "DELETE",
        `/v1/orgs/${publicOrg}/members/${admin.userId}`,
      );
      expect((await pinsOf(outsider, admin)).map((p) => p.id)).not.toContain(
        kept,
      );
    });

    it("survive a restart (they're read back from the store)", async () => {
      const again = await create(
        owner,
        publicOrg,
        "Founding member",
        png(64, 64),
      );
      await owner.req(
        "PUT",
        `/v2/orgs/${publicOrg}/pins/${again.pin.id}/holders/${member.userId}`,
      );
      const fresh = new (
        h.ctx.pins.constructor as new (...a: unknown[]) => typeof h.ctx.pins
      )(h.ctx, h.ctx.pins.store);
      await fresh.load();
      expect(
        fresh.profilePins(member.userId, outsider.userId).map((p) => p.id),
      ).toContain(again.pin.id);
    });
  });
});
