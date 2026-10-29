import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_DECORATIONS } from "../src/modules/accounts/decorations/builtins.generated.js";
import { UsernameHolds, USERNAME_HOLD_MS } from "../src/modules/accounts/usernameHolds.js";
import { MemoryUsernameHoldStore } from "../src/modules/accounts/usernameHoldStore.js";
import { DecorationFavorites } from "../src/shared/contracts/http/decorations.js";
import { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Settings parity, batch A (API 0.65.0, docs/SETTINGS_PARITY_API.md): the two-colour theme and the shown badge, leaving
 * several communities, who may add you to group chats, suggested people, old usernames held 7 days, and decoration
 * favourites. Points have their own suite (points.test.ts).
 */

/** Production's MongoDB domains: the new data then lives in MongoDB (new data goes there whenever the server has one). */
const PRODUCTION_DOMAINS = "preferences,reports,relationships,history,accounts,files,relay,billing";

const newOrg = async (owner: GriipClient, name: string) => (await owner.req("POST", "/v1/orgs", { name, visibility: "public", joinPolicy: "invite" })).org.id as string;
const join = async (owner: GriipClient, orgId: string, ...people: GriipClient[]) => {
  const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 50 })).invite.code;
  for (const p of people) await p.req("POST", "/v1/invites/accept", { code });
};
const connect = async (a: GriipClient, b: GriipClient) => {
  await a.req("POST", "/v1/connections", { userId: b.userId });
  await b.req("POST", `/v1/connections/${a.userId}/accept`);
};

describe("settings parity on the default (memory) stores", () => {
  let h: Harness;

  beforeAll(async () => {
    // The production default: only friends may add someone to a group chat.
    h = await startServer({ DEFAULT_GROUP_ADD_POLICY: "friends" });
  });
  afterAll(async () => h.close());

  it("is advertised in the server's features", async () => {
    const { features, version } = await (await h.client("features")).req("GET", "/v1/server-info");
    expect(version).toBe("0.66.1");
    expect(features).toEqual(
      expect.arrayContaining(["profile-theme", "shown-badge", "leave-many", "group-add-policy", "suggested-people", "username-holds", "decoration-favorites", "points"]),
    );
  });

  describe("the two-colour profile theme", () => {
    it("keeps one or two colours, sets the accent to the first, and an accent alone (an older app) clears the theme", async () => {
      const [ada, bob] = await Promise.all([h.client("themeada"), h.client("themebob")]);
      const set = await ada.req("PUT", "/v1/users/me/profile-style", { themeColors: ["#FF8800", "#3355ff"] });
      expect(set.profileStyle).toMatchObject({ themeColors: ["#ff8800", "#3355ff"], accent: "#ff8800" });
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.profileStyle.themeColors).toEqual(["#ff8800", "#3355ff"]);
      expect((await ada.req("PUT", "/v1/users/me/profile-style", { effect: "glow" })).profileStyle.themeColors).toEqual(["#ff8800", "#3355ff"]);
      expect((await ada.req("PUT", "/v1/users/me/profile-style", { accent: "#123456" })).profileStyle).toMatchObject({ accent: "#123456", themeColors: null });
      expect((await ada.req("PUT", "/v1/users/me/profile-style", { themeColors: ["#00aa00"] })).profileStyle).toMatchObject({ accent: "#00aa00", themeColors: ["#00aa00"] });
      await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { themeColors: ["#000000", "#111111", "#222222"] }), 400);
      await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { themeColors: [] }), 400);
      expect((await ada.req("PUT", "/v1/users/me/profile-style", { themeColors: null })).profileStyle.themeColors).toBeNull();
    });
  });

  describe("the badge you show", () => {
    it("takes only a badge the person holds or none, and a badge they lose reads as the default", async () => {
      const [ada, bob] = await Promise.all([h.client("badgeada"), h.client("badgebob")]);
      await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { shownBadge: "bug-hunter" }), 400);
      await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { shownBadge: "artist" }), 400);
      await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { shownBadge: "made-up" }), 400);
      expect((await ada.req("PUT", "/v1/users/me/profile-style", { shownBadge: "none" })).profileStyle.shownBadge).toBe("none");

      const { report } = await ada.req("POST", "/v1/bug-reports", { summary: "Menu stays open", details: "Right-click, then Escape: the menu stays open." });
      await h.ctx.safety.write((w) => w.update("bug_reports", { id: report.id }, { status: "confirmed" }));
      expect((await ada.req("PUT", "/v1/users/me/profile-style", { shownBadge: "bug-hunter" })).profileStyle.shownBadge).toBe("bug-hunter");
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.profileStyle.shownBadge).toBe("bug-hunter");
      expect((await ada.req("GET", "/v1/users/me")).user.profileStyle.shownBadge).toBe("bug-hunter");

      await h.ctx.safety.write((w) => w.update("bug_reports", { id: report.id }, { status: "open" }));
      await ada.req("PUT", "/v1/users/me/profile-style", { effect: "glow" });
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.profileStyle).toMatchObject({ effect: "glow", shownBadge: null });
    });

    it("comes with the level on profiles", async () => {
      const ada = await h.client("levelada");
      expect((await ada.req("GET", "/v1/users/me")).user.level).toBe(1);
    });
  });

  describe("leaving several communities", () => {
    it("leaves the ones the person is in, skips the ones they own, and says which were neither", async () => {
      const [ada, bob] = await Promise.all([h.client("leaveada"), h.client("leavebob")]);
      const own = await newOrg(ada, "Ada's place");
      const [b1, b2, b3] = [await newOrg(bob, "Bob one"), await newOrg(bob, "Bob two"), await newOrg(bob, "Bob three")];
      await join(bob, b1, ada);
      await join(bob, b2, ada);
      const r = await ada.req("POST", "/v2/orgs/leave", { orgIds: [own, b1, b2, b2, b3, "o_missing"] });
      expect(r).toEqual({ left: [b1, b2], skippedOwned: [own], notMember: [b3, "o_missing"] });
      expect(h.ctx.authz.orgRole(b1, ada.userId)).toBeNull();
      expect(h.ctx.authz.orgRole(own, ada.userId)).toBe("OWNER");
      // The same side effects as leaving one: the audit entry and the member list.
      const members = (await bob.req("GET", `/v1/orgs/${b1}/members`)).members.map((m: { userId?: string; id?: string }) => m.userId ?? m.id);
      expect(members).not.toContain(ada.userId);
      expect(h.ctx.ws.count("audit_log", { org_id: b2, action: "member.leave", target: ada.userId })).toBe(1);
    });

    it("takes 1 to 100 communities", async () => {
      const ada = await h.client("leavelimits");
      await expectStatus(ada.req("POST", "/v2/orgs/leave", { orgIds: [] }), 400);
      await expectStatus(ada.req("POST", "/v2/orgs/leave", { orgIds: Array.from({ length: 101 }, (_, i) => `o_${i}`) }), 400);
    });
  });

  describe("who may add you to group chats", () => {
    it("defaults to friends, and is changed with the messaging settings", async () => {
      const ada = await h.client("gaddefault");
      expect(await ada.req("GET", "/v1/users/me/messaging")).toEqual({ dmPolicy: "everyone", requestPolicy: "everyone", groupAddPolicy: "friends", suggestable: true });
      expect(await ada.req("PUT", "/v1/users/me/messaging", { groupAddPolicy: "nobody", suggestable: false })).toMatchObject({ groupAddPolicy: "nobody", suggestable: false });
      expect(await ada.req("PUT", "/v1/users/me/messaging", { dmPolicy: "communities" })).toEqual({ dmPolicy: "communities", requestPolicy: "everyone", groupAddPolicy: "nobody", suggestable: false });
      await expectStatus(ada.req("PUT", "/v1/users/me/messaging", { groupAddPolicy: "contacts" }), 400);
    });

    it("is enforced when a group is made and when someone is added", async () => {
      const [ada, bob, cat, dan] = await Promise.all(["gadada", "gadbob", "gadcat", "gaddan"].map((n) => h.client(n)));
      const refused = await expectStatus(ada.req("POST", "/v1/conversations/group", { name: "Plans", memberIds: [bob.userId, cat.userId] }), 403);
      expect(refused.error).toMatchObject({ code: "group_add_not_allowed", details: { userIds: [bob.userId, cat.userId] } });

      await connect(ada, bob);
      const group = (await ada.req("POST", "/v1/conversations/group", { name: "Plans", memberIds: [bob.userId] })).conversation.id;
      await expectStatus(ada.req("PUT", `/v1/conversations/${group}/members/${cat.userId}`, { role: "MEMBER" }), 403);
      await cat.req("PUT", "/v1/users/me/messaging", { groupAddPolicy: "everyone" });
      await ada.req("PUT", `/v1/conversations/${group}/members/${cat.userId}`, { role: "MEMBER" });

      // "nobody" refuses friends too; changing an existing member's role doesn't ask again.
      await connect(ada, dan);
      await dan.req("PUT", "/v1/users/me/messaging", { groupAddPolicy: "nobody" });
      await expectStatus(ada.req("PUT", `/v1/conversations/${group}/members/${dan.userId}`, { role: "MEMBER" }), 403);
      await cat.req("PUT", "/v1/users/me/messaging", { groupAddPolicy: "nobody" });
      await ada.req("PUT", `/v1/conversations/${group}/members/${cat.userId}`, { role: "ADMIN" });

      // A block refuses whatever the choice.
      await bob.req("PUT", "/v1/users/me/messaging", { groupAddPolicy: "everyone" });
      await bob.req("POST", "/v1/blocks", { userId: ada.userId });
      await expectStatus(ada.req("POST", "/v1/conversations/group", { name: "Again", memberIds: [bob.userId] }), 403);
    });
  });

  describe("suggested people", () => {
    it("lists suggestable people from shared communities, most shared first, never friends, requests or blocks", async () => {
      const [ada, bob, cat, dan, eve, fay, gus] = await Promise.all(["sugada", "sugbob", "sugcat", "sugdan", "sugeve", "sugfay", "suggus"].map((n) => h.client(n)));
      const big = await newOrg(ada, "Big place");
      const small = await newOrg(ada, "Small place");
      await join(ada, big, bob, cat, dan, eve, fay, gus);
      await join(ada, small, cat);
      await connect(ada, bob);
      await dan.req("PUT", "/v1/users/me/messaging", { suggestable: false });
      await ada.req("POST", "/v1/blocks", { userId: eve.userId });
      await gus.req("POST", "/v1/connections", { userId: ada.userId });

      const { people } = await ada.req("GET", "/v2/people/suggested");
      expect(people.map((p: { user: { id: string } }) => p.user.id)).toEqual([cat.userId, fay.userId]);
      expect(people[0]).toMatchObject({ sharedCommunities: 2, user: { username: cat.username } });
      expect(people[1].sharedCommunities).toBe(1);
      expect((await h.client("sugnobody").then((c) => c.req("GET", "/v2/people/suggested"))).people).toEqual([]);
    });
  });

  describe("old usernames", () => {
    it("are held 7 days for their last owner, who can take them back", async () => {
      const [ada, bob] = await Promise.all([h.client("holdada"), h.client("holdbob")]);
      const old = ada.username;
      const renamed = `${old}x`;
      await ada.req("PATCH", "/v1/users/me", { username: renamed });
      expect((await expectStatus(bob.req("PATCH", "/v1/users/me", { username: old }), 409)).error.code).toBe("conflict");
      // Nobody signs up with it either.
      await expectStatus(new GriipClient(h.baseUrl, old).register(), 409);

      // The hourly limit aside, its owner takes it back, and then the name they left is held instead.
      await h.ctx.identity.write((w) => w.update("users", { id: ada.userId }, { username_changed_at: null }));
      expect((await ada.req("PATCH", "/v1/users/me", { username: old })).user.username).toBe(old);
      expect(h.ctx.usernames.heldFromOthers(old, bob.userId)).toBe(false);
      await expectStatus(bob.req("PATCH", "/v1/users/me", { username: renamed }), 409);
    });

    it("are free again after 7 days", async () => {
      let t = Date.parse("2026-11-01T00:00:00Z");
      const holds = new UsernameHolds(new MemoryUsernameHoldStore(), () => t);
      await holds.changed("u_ada", "ada", "ada2");
      expect(holds.heldFromOthers("ADA", "u_bob")).toBe(true);
      expect(holds.heldFromOthers("ada", "u_ada")).toBe(false);
      t += USERNAME_HOLD_MS - 1;
      expect(holds.heldFromOthers("ada", "u_bob")).toBe(true);
      t += 1;
      expect(holds.heldFromOthers("ada", "u_bob")).toBe(false);
    });
  });
});

describe.each([
  ["memory", {}],
  ["mongodb", { MONGODB_DOMAINS: PRODUCTION_DOMAINS }],
] as const)("new settings kept in %s", (backend, env) => {
  let h: Harness;
  let ada: GriipClient, bob: GriipClient;

  beforeAll(async () => {
    h = await startServer({ ...env });
    expect(h.ctx.decorations.favorites.backend).toBe(backend);
    expect(h.ctx.privacyChoices.backend).toBe(backend);
    expect(h.ctx.usernames.store.backend).toBe(backend);
    [ada, bob] = await Promise.all([h.client("keptada"), h.client("keptbob")]);
  });
  afterAll(async () => h.close());

  it("keeps decoration favourites, newest first, once each, up to 200", async () => {
    const own = BUILTIN_DECORATIONS[0].id;
    expect(await ada.req("PUT", `/v2/decorations/favorites/${own}`)).toEqual({ decorationId: own, favorite: true, count: 1 });
    expect((await ada.req("PUT", `/v2/decorations/favorites/${own}`)).count).toBe(1);
    await new Promise((r) => setTimeout(r, 2));
    await ada.req("PUT", "/v2/decorations/favorites/aurora");
    const list = await ada.req("GET", "/v2/decorations/favorites");
    expect(DecorationFavorites.safeParse(list).success).toBe(true);
    expect(list).toEqual({ favorites: ["aurora", own], limit: 200 });
    await expectStatus(ada.req("PUT", "/v2/decorations/favorites/made-up"), 404);
    await expectStatus(ada.req("PUT", "/v2/decorations/favorites/c_0000000000000000"), 404);
    expect(await ada.req("DELETE", "/v2/decorations/favorites/aurora")).toEqual({ decorationId: "aurora", favorite: false, count: 1 });
    expect((await bob.req("GET", "/v2/decorations/favorites")).favorites).toEqual([]);

    for (let i = 0; i < 199; i++) await h.ctx.decorations.favorites.add(bob.userId, `filler-${i}`, i);
    expect((await bob.req("PUT", `/v2/decorations/favorites/${own}`)).count).toBe(200);
    expect((await expectStatus(bob.req("PUT", "/v2/decorations/favorites/aurora"), 409)).error.code).toBe("limit_reached");
    // One already starred stays fine at the limit.
    expect((await bob.req("PUT", `/v2/decorations/favorites/${own}`)).count).toBe(200);
  });

  it("keeps the privacy choices", async () => {
    await ada.req("PUT", "/v1/users/me/messaging", { groupAddPolicy: "everyone", suggestable: false });
    expect(await h.ctx.privacyChoices.get(ada.userId)).toEqual({ groupAddPolicy: "everyone", suggestable: false });
    expect((await ada.req("GET", "/v1/users/me/messaging")).suggestable).toBe(false);
  });

  it("keeps username holds", async () => {
    const old = bob.username;
    await bob.req("PATCH", "/v1/users/me", { username: `${old}y` });
    expect((await h.ctx.usernames.store.live(Date.now())).map((x) => x.username)).toContain(old);
    await expectStatus(ada.req("PATCH", "/v1/users/me", { username: old }), 409);
  });
});
