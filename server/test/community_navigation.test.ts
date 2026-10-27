import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Batch B2 (docs/product/MELDIQ_IMPLEMENTATION_PLAN.md): a community's own notification settings (default level,
 * suppress @everyone) and per-channel overrides, the order of communities in the rail, and starter templates.
 */
let h: Harness;
let alice: GriipClient, bob: GriipClient;
let orgA: string, orgB: string, orgC: string, general: string, random: string;

const prefsOf = (c: GriipClient, ws: string) => c.req("GET", `/v1/me/preferences/${ws}`);
const put = (c: GriipClient, ws: string, baseRev: number, prefs: object) => c.req("PUT", `/v1/me/preferences/${ws}`, { baseRev, prefs });
const channelsOf = async (c: GriipClient, orgId: string) =>
  ((await c.req("GET", "/v1/conversations")).conversations as { orgId?: string; name?: string; voice?: boolean; format?: string; kind?: string; categoryId?: string }[])
    .filter((x) => x.orgId === orgId);

beforeAll(async () => {
  h = await startServer();
  [alice, bob] = await Promise.all(["alice", "bob"].map((n) => h.client(n)));
  orgA = (await alice.req("POST", "/v1/orgs", { name: "Rail A" })).org.id;
  orgB = (await alice.req("POST", "/v1/orgs", { name: "Rail B" })).org.id;
  orgC = (await bob.req("POST", "/v1/orgs", { name: "Bob's own" })).org.id;
  general = (await alice.req("POST", `/v1/orgs/${orgA}/channels`, { name: "chat", scope: "ORG" })).channel.id;
  random = (await alice.req("POST", `/v1/orgs/${orgA}/channels`, { name: "random", scope: "ORG" })).channel.id;
});
afterAll(async () => h.close());

describe("community notification settings", () => {
  it("advertises the features", async () => {
    expect((await alice.req("GET", "/v1/server-info")).features).toEqual(expect.arrayContaining(["community-preferences", "community-templates"]));
  });

  it("stores a community default level and suppress @everyone, and keeps an explicit 'all' override only when the default isn't 'all'", async () => {
    const r = await put(alice, orgA, 0, {
      community: { level: "mentions", suppressEveryone: true },
      notify: { [general]: "all", [random]: "none" },
    });
    expect(r.prefs.community).toEqual({ level: "mentions", suppressEveryone: true });
    expect(r.prefs.notify).toEqual({ [general]: "all", [random]: "none" });
    // Back to the "all" default: an "all" override says nothing any more, so it goes.
    const back = await put(alice, orgA, r.rev, { community: { level: "all", suppressEveryone: false }, notify: { [general]: "all", [random]: "none" } });
    expect(back.prefs.notify).toEqual({ [random]: "none" });
    expect(back.prefs.community).toEqual({ level: "all", suppressEveryone: false });
  });

  it("keeps the community settings when an older app writes without them", async () => {
    const cur = await prefsOf(alice, orgA);
    await put(alice, orgA, cur.rev, { community: { level: "none", suppressEveryone: true } });
    const later = await prefsOf(alice, orgA);
    const older = await put(alice, orgA, later.rev, { starred: [general] });
    expect(older.prefs.community).toEqual({ level: "none", suppressEveryone: true });
    expect(older.prefs.starred).toEqual([general]);
  });

  it("refuses unknown levels and fields, and doesn't keep community settings in the personal document", async () => {
    const cur = await prefsOf(alice, orgA);
    await expectStatus(put(alice, orgA, cur.rev, { community: { level: "loud" } }), 400);
    await expectStatus(put(alice, orgA, cur.rev, { community: { level: "all", extra: 1 } }), 400);
    const p = await prefsOf(alice, "personal");
    const r = await put(alice, "personal", p.rev, { community: { level: "none" } });
    expect(r.prefs.community).toBeUndefined();
  });

  it("is private to the person", async () => {
    expect((await prefsOf(bob, orgC)).prefs.community).toBeUndefined();
    await expectStatus(prefsOf(bob, orgA), 404);
  });
});

describe("rail order", () => {
  it("keeps the order of the person's own communities only, once each, in the personal document", async () => {
    const p = await prefsOf(alice, "personal");
    const r = await put(alice, "personal", p.rev, { railOrder: [orgB, orgC, orgA, orgB, "o_nothere"] });
    expect(r.prefs.railOrder).toEqual([orgB, orgA]);
    // An older app writing without it keeps it.
    expect((await put(alice, "personal", r.rev, { starred: [] })).prefs.railOrder).toEqual([orgB, orgA]);
  });

  it("isn't kept in a community's document", async () => {
    const cur = await prefsOf(alice, orgA);
    expect((await put(alice, orgA, cur.rev, { railOrder: [orgA] })).prefs.railOrder).toBeUndefined();
  });

  it("refuses malformed ids", async () => {
    const p = await prefsOf(alice, "personal");
    await expectStatus(put(alice, "personal", p.rev, { railOrder: ["../etc"] }), 400);
  });
});

describe("rail folders (API 0.50.0)", () => {
  it("are advertised", async () => {
    expect((await alice.req("GET", "/v1/server-info")).features).toContain("rail-folders");
  });

  it("keeps folders of the person's own communities, each community once, and keeps them when an app leaves them out", async () => {
    const p = await prefsOf(alice, "personal");
    const r = await put(alice, "personal", p.rev, {
      railFolders: [
        { id: "f_games1", name: "Games", color: "#22D3EE", orgIds: [orgA, orgC, orgB] },
        { id: "f_dupes1", name: "Again", orgIds: [orgA] },
        { id: "f_empty1", name: "Not mine", orgIds: [orgC] },
      ],
    });
    expect(r.prefs.railFolders).toEqual([{ id: "f_games1", name: "Games", color: "#22d3ee", orgIds: [orgA, orgB] }]);
    expect((await put(alice, "personal", r.rev, { starred: [] })).prefs.railFolders).toEqual(r.prefs.railFolders);
  });

  it("isn't kept in a community's document, and refuses malformed folders", async () => {
    const cur = await prefsOf(alice, orgA);
    expect((await put(alice, orgA, cur.rev, { railFolders: [{ id: "f_games1", orgIds: [orgA] }] })).prefs.railFolders).toBeUndefined();
    const p = await prefsOf(alice, "personal");
    await expectStatus(put(alice, "personal", p.rev, { railFolders: [{ id: "bad", orgIds: [orgA] }] }), 400);
    await expectStatus(put(alice, "personal", p.rev, { railFolders: [{ id: "f_games2", orgIds: [] }] }), 400);
  });
});

describe("community templates", () => {
  it("lists the templates", async () => {
    const t = await alice.req("GET", "/v1/community-templates");
    expect(t.templates.map((x: { id: string }) => x.id)).toEqual(["starter", "friends", "gaming", "study", "club"]);
    expect(t.templates[2].categories.flatMap((c: { channels: { name: string }[] }) => c.channels.map((ch) => ch.name))).toContain("looking-for-group");
  });

  it("creates a community from a template, with its voice and forum channels", async () => {
    const org = (await alice.req("POST", "/v1/orgs", { name: "Study Hall", template: "study" })).org.id;
    const chans = await channelsOf(alice, org);
    const names = chans.map((c) => c.name).sort();
    expect(names).toEqual(["announcements", "general", "homework-help", "resources", "study-room", "welcome"]);
    expect(chans.find((c) => c.name === "resources")?.format).toBe("forum");
    expect(chans.find((c) => c.name === "study-room")?.voice).toBe(true);
    expect(chans.find((c) => c.name === "announcements")?.kind).toBe("ANNOUNCEMENT");
  });

  it("uses the starter set when no template is named, and refuses unknown templates", async () => {
    const org = (await alice.req("POST", "/v1/orgs", { name: "Plain" })).org.id;
    expect((await channelsOf(alice, org)).map((c) => c.name).sort()).toEqual(["announcements", "general", "introductions", "lounge", "welcome"]);
    await expectStatus(alice.req("POST", "/v1/orgs", { name: "Nope", template: "casino" }), 400);
  });
});
