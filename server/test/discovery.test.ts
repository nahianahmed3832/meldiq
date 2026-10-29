import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStartOf, WEEK_MS } from "../src/modules/organizations/discovery/promote.js";
import { DiscoverListing, DiscoverySettings, PromoteView } from "../src/shared/contracts/http/discovery.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Discovery and Promote (community parity batch E, features "discovery-listing" and "discovery-promote",
 * docs/COMMUNITY_PARITY_API.md › Discovery): who's listed (5 members unless boosted), the order (boost tier, then
 * members), search, what never shows (private, turned off, locked, removed, a name passing for Meldiq's), the Promoted
 * row with its views, clicks and joins, the Promote page, and buying while billing is off. Runs with the community
 * tables in SQLite and in MongoDB.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const STARTUP_MS = 120_000;
const code = (e: { error: { code: string } }) => e.error.code;
const ids = (cards: { id: string }[]) => cards.map((c) => c.id);

describe.each([
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const)("discovery with communities in %s", (_backend, env) => {
  let h: Harness;
  let owner: GriipClient, small: GriipClient, other: GriipClient, viewer: GriipClient, joiner: GriipClient;
  let members: GriipClient[];
  let big: string, tiny: string, named: string;
  const discover = async (c: GriipClient, query = "") => {
    const page = await c.req("GET", `/v1/discover${query}`);
    expect(DiscoverListing.safeParse(page).success).toBe(true);
    return page;
  };
  const listed = async (query = "") => ids((await discover(viewer, query)).communities);
  const olderApps = async (q: string) => ids((await viewer.req("GET", `/v1/communities/discover?q=${encodeURIComponent(q)}`)).communities);
  const settings = (orgId: string, c: GriipClient = owner) => c.req("GET", `/v1/orgs/${orgId}/discovery`);
  const publicCommunity = async (c: GriipClient, name: string) => (await c.req("POST", "/v1/orgs", { name, visibility: "public", joinPolicy: "open" })).org.id as string;

  beforeAll(async () => {
    h = await startServer({ ...env });
    [owner, small, other, viewer, joiner] = await Promise.all(["dsowner", "dssmall", "dsother", "dsviewer", "dsjoiner"].map((x) => h.client(x)));
    members = await Promise.all(["dsm1", "dsm2", "dsm3", "dsm4", "dsm5"].map((x) => h.client(x)));
    big = await publicCommunity(owner, "Board Game Nights");
    tiny = await publicCommunity(small, "Tiny Chess Club");
    named = await publicCommunity(other, "Official Raid Club");
    for (const m of members) await m.req("POST", `/v1/communities/${big}/join`);
    for (const m of members.slice(0, 4)) await m.req("POST", `/v1/communities/${named}/join`);
    await members[0]!.req("POST", `/v1/communities/${tiny}/join`);
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("lists public communities from 5 members; older apps still find small ones", async () => {
    expect((await viewer.req("GET", "/v1/server-info")).features).toEqual(expect.arrayContaining(["discovery-listing", "discovery-promote", "bot-directory", "template-links"]));
    const page = await discover(viewer);
    expect(ids(page.communities)).toEqual([big]);
    expect(page.promoted).toEqual([]);
    expect(page.communities[0]).toMatchObject({ name: "Board Game Nights", memberCount: 6, label: null, joined: false, official: false, tags: [], joinPolicy: "open" });
    expect((await discover(members[0]!)).communities[0].joined).toBe(true);
    expect(await olderApps("Tiny Chess")).toEqual([tiny]);
    expect(await settings(tiny, small)).toMatchObject({ listed: false, reason: "too_few_members", memberCount: 2, minMembers: 5, discoverable: true });
  });

  it("lets people who can edit the community set the card line and up to 5 tags", async () => {
    expect(code(await expectStatus(members[0]!.req("GET", `/v1/orgs/${big}/discovery`), 403))).toBe("forbidden");
    expect(code(await expectStatus(viewer.req("PUT", `/v1/orgs/${big}/discovery`, { tags: ["x"] }), 404))).toBe("not_found");
    for (const bad of [{ tags: ["no_underscores"] }, { tags: ["a", "b", "c", "d", "e", "f"] }, { tags: ["x".repeat(25)] }, { description: "x".repeat(301) }, {}]) {
      expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${big}/discovery`, bad), 400))).toBe("bad_request");
    }
    const saved = await owner.req("PUT", `/v1/orgs/${big}/discovery`, { description: "Weekly board games, all welcome", tags: ["Board Games", "strategy", "board  games", "co-op"] });
    expect(DiscoverySettings.safeParse(saved).success).toBe(true);
    expect(saved).toMatchObject({ description: "Weekly board games, all welcome", tags: ["board games", "strategy", "co-op"], listed: true, reason: null });
    expect((await discover(viewer)).communities[0]).toMatchObject({ description: "Weekly board games, all welcome", tags: ["board games", "strategy", "co-op"] });
    expect(h.ctx.ws.count("audit_log", { org_id: big, action: "community.discovery" })).toBe(1);
  });

  it("searches names, descriptions and tags, and filters by tag", async () => {
    expect(await listed("?q=weekly")).toEqual([big]);
    expect(await listed("?q=STRATEGY")).toEqual([big]);
    expect(await listed("?q=nights")).toEqual([big]);
    expect(await listed("?q=chess")).toEqual([]);
    expect(await listed("?tag=Co-Op")).toEqual([big]);
    expect(await listed("?tag=strat")).toEqual([]);
  });

  it("never shows communities turned off, private, locked, removed or with a name passing for Meldiq's", async () => {
    await owner.req("PUT", `/v1/orgs/${big}/discovery`, { discoverable: false });
    expect(await listed()).toEqual([]);
    expect(await olderApps("Board Game")).toEqual([]);
    expect((await settings(big)).reason).toBe("turned_off");
    await owner.req("PUT", `/v1/orgs/${big}/discovery`, { discoverable: true });

    await owner.req("PUT", `/v1/orgs/${big}/lock`, { duration: "15m" });
    expect(await listed()).toEqual([]);
    expect((await settings(big)).reason).toBe("locked");
    await owner.req("PUT", `/v1/orgs/${big}/lock`, { duration: null });

    await owner.req("PATCH", `/v1/orgs/${big}`, { visibility: "private" });
    expect((await settings(big)).reason).toBe("private");
    await owner.req("PATCH", `/v1/orgs/${big}`, { visibility: "public" });

    await h.ctx.discovery.store.patchSettings(big, { removed_at: Date.now(), removed_reason: "spam" }, "admin:test", Date.now());
    expect(await listed()).toEqual([]);
    expect(await olderApps("Board Game")).toEqual([]);
    await h.ctx.discovery.store.patchSettings(big, { removed_at: null, removed_reason: null }, "admin:test", Date.now());
    expect(await listed()).toEqual([big]);

    expect((await other.req("GET", `/v1/orgs/${named}/discovery`)).reason).toBe("name_blocked");
    await h.ctx.discovery.store.patchSettings(named, { official: 1 }, "admin:test", Date.now());
    const page = await discover(viewer);
    expect(ids(page.communities)).toEqual([big, named]);
    expect(page.communities[1].official).toBe(true);
  });

  it("puts boosted communities first by tier, the biggest boost counting, and lists them under 5 members", async () => {
    const p = h.ctx.discovery.promote;
    await p.grantBoost(tiny, "super", 1, "admin:test", "testing");
    let page = await discover(viewer);
    expect(ids(page.communities)).toEqual([tiny, big, named]);
    expect(page.communities[0].label).toBe("super");
    await p.grantBoost(big, "boost", 1, "admin:test", "testing");
    expect(await listed()).toEqual([tiny, big, named]);
    await p.grantBoost(big, "mega", 1, "admin:test", "testing");
    page = await discover(viewer);
    expect(ids(page.communities)).toEqual([big, tiny, named]);
    expect(page.communities.map((c: { label: string | null }) => c.label)).toEqual(["mega", "super", null]);
    for (const b of h.ctx.ws.all<{ id: string }>("discovery_boosts", { where: { org_id: big } })) await h.ctx.discovery.store.cancel("discovery_boosts", b.id);
    expect(await listed()).toEqual([tiny, big, named]);
  });

  it("shows a Promoted row on the home page only, counting views, clicks and joins from Discover", async () => {
    const booking = await h.ctx.discovery.promote.grantPromoted(tiny, "admin:test", "testing");
    expect(booking.week_start).toBe(weekStartOf(Date.now()));
    const home = await discover(viewer);
    expect(home.promoted).toHaveLength(1);
    expect(home.promoted[0]).toMatchObject({ id: tiny, label: "promoted" });
    expect((await discover(viewer, "?q=chess")).promoted).toEqual([]);
    expect((await discover(viewer, "?cursor=30")).promoted).toEqual([]);
    await viewer.req("POST", `/v1/discover/${tiny}/click`);
    await joiner.req("POST", `/v1/discover/${tiny}/click`);
    await joiner.req("POST", `/v1/communities/${tiny}/join`);
    await members[1]!.req("POST", `/v1/communities/${tiny}/join`);
    expect(code(await expectStatus(viewer.req("POST", "/v1/discover/o_nowhere/click"), 404))).toBe("not_found");
    expect(h.ctx.discovery.store.booking(booking.id)).toMatchObject({ views: 1, clicks: 2, joins: 1 });
  });

  it("shows the Promote page to editors, with prices, rank, the next spot and weekly visitors", async () => {
    expect(code(await expectStatus(members[0]!.req("GET", `/v1/orgs/${big}/promote`), 403))).toBe("forbidden");
    const view = await owner.req("GET", `/v1/orgs/${big}/promote`);
    expect(PromoteView.safeParse(view).success).toBe(true);
    const next = weekStartOf(Date.now()) + WEEK_MS;
    expect(view).toMatchObject({
      billing: { available: false },
      currency: "usd",
      tiers: [
        { tier: "boost", weeklyCents: 399, guaranteedTop: null },
        { tier: "super", weeklyCents: 799, guaranteedTop: null },
        { tier: "mega", weeklyCents: 1299, guaranteedTop: 100 },
      ],
      boost: null,
      rank: 2,
      listed: true,
      promoted: { weeklyCents: 2999, spotsPerWeek: 4, nextSpot: { startsAt: next, endsAt: next + WEEK_MS, spotsLeft: 4 }, allTaken: false, bookings: [] },
    });
    expect(view.boosts.map((b: { state: string }) => b.state)).toEqual([]);
    expect(view.visitors.weekly).toBeGreaterThanOrEqual(2);
    const tinyView = await small.req("GET", `/v1/orgs/${tiny}/promote`);
    expect(tinyView).toMatchObject({ boost: { tier: "super", source: "grant", state: "active" }, rank: 1 });
    expect(tinyView.promoted.bookings).toEqual([expect.objectContaining({ source: "grant", views: 1, clicks: 2, joins: 1 })]);
  });

  it("answers 503 billing_unavailable for purchases while billing is off, and promoted_full when every spot is taken", async () => {
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${big}/promote/boost`, { tier: "mega" }), 503))).toBe("billing_unavailable");
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${big}/promote/promoted`, {}), 503))).toBe("billing_unavailable");
    expect(code(await expectStatus(members[0]!.req("POST", `/v1/orgs/${big}/promote/boost`, { tier: "boost" }), 403))).toBe("forbidden");
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${big}/promote/promoted`, { weekStart: weekStartOf(Date.now()) + 3 }), 400))).toBe("bad_request");
    const fillers = await Promise.all([1, 2, 3, 4].map((n) => publicCommunity(other, `Filler ${n}`)));
    const first = weekStartOf(Date.now()) + WEEK_MS;
    for (let w = 0; w < 8; w++) {
      for (const org of fillers) {
        const start = first + w * WEEK_MS;
        const row = { id: `pmb_fill_${org}_${w}`, org_id: org, week_start: start, state: "active" as const, source: "grant" as const, price_cents: 0, starts_at: start, ends_at: start + WEEK_MS, views: 0, clicks: 0, joins: 0, note: null, created_by: "admin:test", created_at: Date.now() };
        expect(await h.ctx.discovery.store.addBooking(row, 4)).toBe(true);
      }
    }
    const view = await owner.req("GET", `/v1/orgs/${big}/promote`);
    expect(view.promoted).toMatchObject({ nextSpot: null, allTaken: true });
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${big}/promote/promoted`, {}), 409))).toBe("promoted_full");
  });
});

describe("discovery switched off", () => {
  let h: Harness;
  let owner: GriipClient;
  beforeAll(async () => {
    h = await startServer({ DISCOVERY: "off" });
    owner = await h.client("dsoffowner");
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("hides the features, answers 503, and leaves the older route as it was", async () => {
    const features = (await owner.req("GET", "/v1/server-info")).features;
    expect(features).not.toContain("discovery-listing");
    expect(features).toContain("community-discovery");
    expect(features).not.toContain("discovery-promote");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "Quiet Lab", visibility: "public", joinPolicy: "open" })).org.id;
    expect(code(await expectStatus(owner.req("GET", "/v1/discover"), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("GET", `/v1/orgs/${orgId}/promote`), 503))).toBe("feature_disabled");
    expect(ids((await owner.req("GET", "/v1/communities/discover?q=Quiet")).communities)).toEqual([orgId]);
  });
});
