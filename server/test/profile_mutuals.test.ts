import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/** The profile card's "Member since" and mutual communities (API 0.56.0). */
describe("profile: member since and mutual communities", () => {
  let h: Harness;
  let alice: GriipClient, bob: GriipClient, carol: GriipClient;
  beforeAll(async () => {
    h = await startServer();
    alice = await h.client("alice");
    bob = await h.client("bob");
    carol = await h.client("carol");
  });
  afterAll(async () => h.close());

  it("lists only communities both people are in, with when they joined, and when they joined Meldiq", async () => {
    const shared = (await alice.req("POST", "/v1/orgs", { name: "Shared Lab" })).org.id;
    await alice.req("POST", "/v1/orgs", { name: "Alice Only" });
    const code = (await alice.req("POST", `/v1/orgs/${shared}/invites`, { role: "MEMBER" })).invite.code;
    await bob.req("POST", "/v1/invites/accept", { code });
    const seen = (await alice.req("GET", `/v1/users/${bob.userId}`)).user;
    expect(seen.memberSince).toEqual(expect.any(Number));
    expect(seen.mutualCommunities).toEqual([{ id: shared, name: "Shared Lab", photoRev: null, joinedAt: expect.any(Number) }]);
    // Someone who shares nothing sees no communities; your own profile lists none.
    expect((await carol.req("GET", `/v1/users/${bob.userId}`)).user.mutualCommunities).toEqual([]);
    expect((await bob.req("GET", `/v1/users/${bob.userId}`)).user.mutualCommunities).toEqual([]);
  });
});
