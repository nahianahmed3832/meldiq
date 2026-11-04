import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProfileLayout } from "../src/shared/contracts/http/users.js";
import { styleOf } from "../src/modules/accounts/profileMedia.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

let h: Harness;
let owner: GriipClient, viewer: GriipClient;
const layout = { order: ["connections", "links", "about"], hidden: ["connections", "about"] };
beforeAll(async () => {
  h = await startServer();
  [owner, viewer] = await Promise.all([h.client("layoutowner"), h.client("layoutviewer")]);
  await owner.req("PATCH", "/v1/users/me", { aboutMe: "Private profile biography", links: [{ label: "Example", url: "https://example.test/profile" }] });
  await h.ctx.linkedAccounts.accounts.put({ id: `${owner.userId}|steam`, userId: owner.userId, provider: "steam", externalId: "test", name: "Synthetic connection", url: "https://steamcommunity.com/id/synthetic", itemsKind: "recently-played", items: [], visible: true, tokens: null, connectedAt: Date.now(), updatedAt: Date.now(), checkedAt: Date.now() });
});
afterAll(async () => { await h.close(); });

describe("profile section layout", () => {
  it("requires a complete unique order and a unique supported hidden set", () => {
    expect(ProfileLayout.safeParse(layout).success).toBe(true);
    for (const invalid of [
      { order: ["about", "about", "links"], hidden: [] },
      { order: ["about", "links"], hidden: [] },
      { order: ["about", "links", "admin"], hidden: [] },
      { order: ["about", "links", "connections"], hidden: ["about", "about"] },
    ]) expect(ProfileLayout.safeParse(invalid).success).toBe(false);
    expect(styleOf({ profile_style: JSON.stringify({ layout: { order: ["unknown"], hidden: [] } }) }).layout).toBeUndefined();
  });
  it("round-trips independently of old-client style updates and rejects malformed saves", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toContain("profile-layout");
    await owner.req("PUT", "/v1/users/me/profile-style", { layout });
    await owner.req("PUT", "/v1/users/me/profile-style", { accent: "#123456" });
    expect((await owner.req("GET", "/v1/users/me")).user.profileStyle.layout).toEqual(layout);
    await expectStatus(owner.req("PUT", "/v1/users/me/profile-style", { layout: { order: ["about", "about", "links"], hidden: [] } }), 400);
    expect((await owner.req("GET", "/v1/users/me")).user.profileStyle.layout).toEqual(layout);
  });
  it("withholds hidden biography and provider connections from other accounts while retaining owner editing data", async () => {
    const mine = (await owner.req("GET", "/v1/users/me")).user;
    expect(mine.aboutMe).toBe("Private profile biography");
    const ownPublic = (await owner.req("GET", `/v1/users/${owner.userId}`)).user;
    expect(ownPublic.connections).toHaveLength(1);
    const other = (await viewer.req("GET", `/v1/users/${owner.userId}`)).user;
    expect(other.aboutMe).toBeUndefined();
    expect(other.connections).toBeUndefined();
    expect(other.links).toHaveLength(1);
  });
  it("keeps audience restrictions authoritative when sections are shown and permits resetting the layout", async () => {
    await owner.req("PUT", "/v1/users/me/profile-style", { layout: { order: ["about", "links", "connections"], hidden: ["links"] } });
    await owner.req("PUT", "/v1/users/me/privacy", { bio: "nobody" });
    const other = (await viewer.req("GET", `/v1/users/${owner.userId}`)).user;
    expect(other.aboutMe).toBeUndefined();
    expect(other.links).toBeUndefined();
    await owner.req("PUT", "/v1/users/me/profile-style", { layout: null });
    expect((await owner.req("GET", "/v1/users/me")).user.profileStyle.layout).toBeUndefined();
    expect((await owner.req("GET", "/v1/users/me")).user.aboutMe).toBe("Private profile biography");
  });
  it("refuses a stale layout draft without overwriting another device's style", async () => {
    const before = (await owner.req("GET", "/v1/users/me")).user;
    expect(before.styleRevision).toBeTruthy();
    await owner.req("PUT", "/v1/users/me/profile-style", { accent: "#654321" });
    await expectStatus(owner.req("PUT", "/v1/users/me/profile-style", { baseStyleRevision: before.styleRevision, layout }), 409);
    const after = (await owner.req("GET", "/v1/users/me")).user;
    expect(after.profileStyle.accent).toBe("#654321");
    expect(after.profileStyle.layout).toBeUndefined();
  });
});
