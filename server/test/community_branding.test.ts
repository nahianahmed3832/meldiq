import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** API 0.44.0 (docs/COMMUNITY_BRANDING.md): a community's accent colour and banner. */
let h: Harness;
let owner: GriipClient, admin: GriipClient, member: GriipClient, outsider: GriipClient;
let orgId: string, privateOrg: string, code: string;

/** A GIF of [frames] frames of [w] × [h] (see profile_media.test.ts): enough for the server's parser. */
function gif(w: number, h: number, frames: number): Buffer {
  const head = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])]);
  const frame = Buffer.concat([Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]), Buffer.from([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0]), Buffer.from([2, 2, 0x44, 0x01, 0])]);
  return Buffer.concat([head, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}

const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n), Buffer.from([0xff, 0xd9])]);

beforeAll(async () => {
  h = await startServer();
  [owner, admin, member, outsider] = await Promise.all(["owner", "admin", "member", "outsider"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Brand Lab" })).org.id;
  privateOrg = (await owner.req("POST", "/v1/orgs", { name: "Quiet Brand" })).org.id;
  code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 10 })).invite.code;
  for (const c of [admin, member]) await c.req("POST", "/v1/invites/accept", { code });
  await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { role: "ADMIN" });
});
afterAll(async () => h.close());

describe("community branding", () => {
  it("is advertised, and a community without any keeps Meldiq's theme (nulls)", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toContain("community-branding");
    const org = (await owner.req("GET", "/v1/orgs")).orgs.find((o: { id: string }) => o.id === orgId);
    expect(org).toMatchObject({ accent: null, bannerRev: null });
  });

  it("sets an accent (stored in lower case) for owners and admins only, and puts the theme back with null", async () => {
    await expectStatus(member.req("PATCH", `/v1/orgs/${orgId}`, { accent: "#ff0066" }), 403);
    await expectStatus(outsider.req("PATCH", `/v1/orgs/${orgId}`, { accent: "#ff0066" }), 404);
    expect((await admin.req("PATCH", `/v1/orgs/${orgId}`, { accent: "#FF0066" })).org.accent).toBe("#ff0066");
    // Other changes leave it alone, and it's what every member sees.
    expect((await owner.req("PATCH", `/v1/orgs/${orgId}`, { description: "We brand things" })).org.accent).toBe("#ff0066");
    expect((await member.req("GET", "/v1/orgs")).orgs.find((o: { id: string }) => o.id === orgId).accent).toBe("#ff0066");
    expect((await owner.req("PATCH", `/v1/orgs/${orgId}`, { accent: null })).org.accent).toBeNull();
    await owner.req("PATCH", `/v1/orgs/${orgId}`, { accent: "#22d3ee" });
  });

  it("refuses anything that isn't a #rrggbb colour", async () => {
    for (const bad of ["red", "#fff", "#12345g", "url(x)", "#1234567", "rgb(1,2,3)", 7]) await expectStatus(owner.req("PATCH", `/v1/orgs/${orgId}`, { accent: bad }), 400);
    expect((await owner.req("GET", "/v1/orgs")).orgs.find((o: { id: string }) => o.id === orgId).accent).toBe("#22d3ee");
  });

  it("stores a banner per revision for people who edit the community; members read it, outsiders don't", async () => {
    await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/banner`, undefined, jpeg(2000)), 403);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/banner`, undefined, Buffer.from("not a jpeg at all")), 400);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/banner`, undefined, jpeg(1024 * 1024 + 10)), 413);
    const first = jpeg(4000);
    const { bannerRev } = await admin.req("PUT", `/v1/orgs/${orgId}/banner`, undefined, first);
    expect(bannerRev).toEqual(expect.any(Number));
    expect((await member.req("GET", "/v1/orgs")).orgs.find((o: { id: string }) => o.id === orgId).bannerRev).toBe(bannerRev);
    expect(Buffer.compare(await member.req("GET", `/v1/orgs/${orgId}/banner`), first)).toBe(0);
    await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/banner`), 404);
    // A new one replaces it under a new revision.
    const second = jpeg(3000);
    const next = (await owner.req("PUT", `/v1/orgs/${orgId}/banner`, undefined, second)).bannerRev;
    expect(next).toBeGreaterThan(bannerRev);
    expect(Buffer.compare(await member.req("GET", `/v1/orgs/${orgId}/banner`), second)).toBe(0);
  });

  it("is shown on Discover and readable by anyone signed in once the community is public", async () => {
    await owner.req("PATCH", `/v1/orgs/${orgId}`, { visibility: "public", joinPolicy: "open" });
    const card = (await outsider.req("GET", "/v1/communities/discover?q=Brand%20Lab")).communities.find((c: { id: string }) => c.id === orgId);
    expect(card).toMatchObject({ accent: "#22d3ee", bannerRev: expect.any(Number) });
    expect((await outsider.req("GET", `/v1/orgs/${orgId}/banner`)).length).toBeGreaterThan(0);
    const icon = jpeg(2000);
    await owner.req("PUT", `/v1/orgs/${orgId}/photo`, undefined, icon);
    expect(Buffer.compare(await outsider.req("GET", `/v1/orgs/${orgId}/photo`), icon)).toBe(0);
    expect((await fetch(`${h.baseUrl}/v1/orgs/${orgId}/photo`)).status).toBe(401);
    await owner.req("PATCH", `/v1/orgs/${orgId}`, { visibility: "private" });
    await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/photo`), 404);
    await owner.req("PATCH", `/v1/orgs/${orgId}`, { visibility: "public" });
    expect((await outsider.req("GET", `/v1/communities/${orgId}/preview`)).community).toMatchObject({ accent: "#22d3ee" });
    await owner.req("DELETE", `/v1/orgs/${orgId}/photo`);
  });

  it("comes with an invitation: in the app's preview and on the public invite page, with the banner", async () => {
    expect((await outsider.req("POST", "/v1/invites/preview", { code })).org).toMatchObject({ accent: "#22d3ee", bannerRev: expect.any(Number) });
    const anon = await fetch(`${h.baseUrl}/v1/invites/${code}/public`).then((r) => r.json());
    expect(anon.community).toMatchObject({ name: "Brand Lab", accent: "#22d3ee", banner: true });
    const res = await fetch(`${h.baseUrl}/v1/invites/${code}/banner`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect((await fetch(`${h.baseUrl}/v1/invites/AAAA-BBBB-CCCC/banner`)).status).toBe(404);
  });

  it("is removed cleanly; a community without a banner answers 404, and other communities are untouched", async () => {
    await expectStatus(member.req("DELETE", `/v1/orgs/${orgId}/banner`), 403);
    expect((await owner.req("DELETE", `/v1/orgs/${orgId}/banner`)).bannerRev).toBeNull();
    await expectStatus(member.req("GET", `/v1/orgs/${orgId}/banner`), 404);
    expect((await fetch(`${h.baseUrl}/v1/invites/${code}/public`).then((r) => r.json())).community.banner).toBe(false);
    expect((await owner.req("GET", "/v1/orgs")).orgs.find((o: { id: string }) => o.id === privateOrg)).toMatchObject({ accent: null, bannerRev: null });
    await expectStatus(owner.req("GET", `/v1/orgs/${privateOrg}/banner`), 404);
  });

  it("shows the community's icon on the public invite page (API 0.46.0), only through a usable code", async () => {
    expect((await fetch(`${h.baseUrl}/v1/invites/${code}/public`).then((r) => r.json())).community.photo).toBe(false);
    expect((await fetch(`${h.baseUrl}/v1/invites/${code}/photo`)).status).toBe(404);
    const icon = jpeg(3000);
    await owner.req("PUT", `/v1/orgs/${orgId}/photo`, undefined, icon);
    expect((await fetch(`${h.baseUrl}/v1/invites/${code}/public`).then((r) => r.json())).community.photo).toBe(true);
    const res = await fetch(`${h.baseUrl}/v1/invites/${code}/photo`);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), icon)).toBe(0);
    expect((await fetch(`${h.baseUrl}/v1/invites/AAAA-BBBB-CCCC/photo`)).status).toBe(404);
  });

  it("takes an animated GIF icon and banner (API 0.64.0) and serves them as GIFs, checking their size and frames", async () => {
    const icon = gif(256, 256, 12);
    await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/photo`, undefined, icon), 403);
    await owner.req("PUT", `/v1/orgs/${orgId}/photo`, undefined, icon);
    const res = await fetch(`${h.baseUrl}/v1/invites/${code}/photo`);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), icon)).toBe(0);
    expect(Buffer.compare(await member.req("GET", `/v1/orgs/${orgId}/photo`), icon)).toBe(0);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/photo`, undefined, gif(2000, 2000, 2)), 400);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/photo`, undefined, gif(64, 64, 601)), 400);

    const banner = gif(1200, 480, 20);
    await owner.req("PUT", `/v1/orgs/${orgId}/banner`, undefined, banner);
    const b = await fetch(`${h.baseUrl}/v1/invites/${code}/banner`);
    expect(b.headers.get("content-type")).toBe("image/gif");
    expect(Buffer.compare(Buffer.from(await b.arrayBuffer()), banner)).toBe(0);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/banner`, undefined, gif(4000, 480, 2)), 400);
    // A still JPEG afterwards is served as a JPEG again.
    await owner.req("PUT", `/v1/orgs/${orgId}/banner`, undefined, jpeg(2000));
    expect((await fetch(`${h.baseUrl}/v1/invites/${code}/banner`)).headers.get("content-type")).toBe("image/jpeg");
  });
});
