import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageKind } from "../src/modules/organizations/expressionsRoutes.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** Batch B9: a community's own emoji and stickers. */
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const apng = Buffer.concat([png, Buffer.from("acTL"), Buffer.alloc(10)]);
const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(7), Buffer.from([0x2c]), Buffer.alloc(5), Buffer.from([0x2c]), Buffer.alloc(5)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(20)]);

let h: Harness;
let owner: GriipClient, manager: GriipClient, member: GriipClient, outsider: GriipClient;
let orgId: string;

beforeAll(async () => {
  h = await startServer();
  [owner, manager, member, outsider] = await Promise.all(["owner", "manager", "member", "outsider"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Emoji Lab" })).org.id;
  const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 5 })).invite.code;
  await manager.req("POST", "/v1/invites/accept", { code });
  await member.req("POST", "/v1/invites/accept", { code });
  const role = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { template: "community_manager" })).role;
  await owner.req("PUT", `/v1/roles/${role.id}/members/${manager.userId}`);
});
afterAll(async () => h.close());

describe("image checks", () => {
  it("know PNG, GIF and WebP, and whether they move", () => {
    expect(imageKind(png)).toEqual({ mime: "image/png", animated: false });
    expect(imageKind(apng)).toEqual({ mime: "image/png", animated: true });
    expect(imageKind(gif)).toEqual({ mime: "image/gif", animated: true });
    expect(imageKind(webp)).toEqual({ mime: "image/webp", animated: false });
    expect(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))).toBeNull();
  });
});

describe("community emoji and stickers", () => {
  let id: string;

  it("are uploaded by people with expressions.manage, with a checked name and image", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toContain("community-expressions");
    await expectStatus(member.req("POST", `/v1/orgs/${orgId}/expressions?name=party`, undefined, png), 403);
    await expectStatus(manager.req("POST", `/v1/orgs/${orgId}/expressions?name=Bad%20Name!`, undefined, png), 400);
    await expectStatus(manager.req("POST", `/v1/orgs/${orgId}/expressions?name=jpeg`, undefined, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), 400);
    await expectStatus(manager.req("POST", `/v1/orgs/${orgId}/expressions?name=huge`, undefined, Buffer.concat([png, Buffer.alloc(300 * 1024)])), 413);
    const e = (await manager.req("POST", `/v1/orgs/${orgId}/expressions?name=Party`, undefined, png)).expression;
    expect(e).toMatchObject({ kind: "emoji", name: "party", animated: false, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    id = e.id;
    await expectStatus(manager.req("POST", `/v1/orgs/${orgId}/expressions?name=party`, undefined, gif), 409);
    const s = (await manager.req("POST", `/v1/orgs/${orgId}/expressions?kind=sticker&name=party`, undefined, gif)).expression;
    expect(s).toMatchObject({ kind: "sticker", animated: true });
  });

  it("are listed and served to members only, and the image matches its hash", async () => {
    const list = (await member.req("GET", `/v1/orgs/${orgId}/expressions`)).expressions;
    expect(list.map((x: { name: string; kind: string }) => `${x.kind}:${x.name}`)).toEqual(["emoji:party", "sticker:party"]);
    expect(Buffer.compare(await member.req("GET", `/v1/expressions/${id}/image`), png)).toBe(0);
    await expectStatus(outsider.req("GET", `/v1/expressions/${id}/image`), 404);
    await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/expressions`), 404);
  });

  it("are renamed and removed by managers", async () => {
    await expectStatus(member.req("PATCH", `/v1/expressions/${id}`, { name: "fiesta" }), 403);
    expect((await manager.req("PATCH", `/v1/expressions/${id}`, { name: "Fiesta" })).expression.name).toBe("fiesta");
    await expectStatus(member.req("DELETE", `/v1/expressions/${id}`), 403);
    await manager.req("DELETE", `/v1/expressions/${id}`);
    await expectStatus(member.req("GET", `/v1/expressions/${id}/image`), 404);
    const audit = (await owner.req("GET", `/v1/orgs/${orgId}/audit?action=expression`)).entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["expression.add", "expression.rename", "expression.remove"]));
  });

  it("are limited per community", async () => {
    await h.ctx.ws.write((w) => {
      for (let i = 0; i < 49; i++) {
        w.insert("community_expressions", {
          id: `emj_fill${i}`,
          org_id: orgId,
          kind: "emoji",
          name: `fill${i}`,
          mime: "image/png",
          animated: 0,
          sha256: "x",
          size: 1,
          created_by: owner.userId,
          created_at: 0,
        });
      }
    });
    await manager.req("POST", `/v1/orgs/${orgId}/expressions?name=last`, undefined, png);
    expect((await expectStatus(manager.req("POST", `/v1/orgs/${orgId}/expressions?name=one_more`, undefined, png), 409)).error.code).toBe("limit_reached");
  });
});

describe("uploads at the same moment", () => {
  it("can't give two emoji the same name (batch B13)", async () => {
    // A fresh community: the tests above fill the first one's emoji limit.
    const fresh = (await owner.req("POST", "/v1/orgs", { name: "Twin Lab" })).org.id;
    const tries = await Promise.allSettled(
      [0, 1, 2].map(() => owner.req("POST", `/v1/orgs/${fresh}/expressions?kind=emoji&name=twin`, undefined, png)),
    );
    expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    const list = (await owner.req("GET", `/v1/orgs/${fresh}/expressions`)).expressions as { name: string }[];
    expect(list.filter((e) => e.name === "twin")).toHaveLength(1);
  });
});
