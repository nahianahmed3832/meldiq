import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * API 0.46.0 (docs/PROFILE_MEDIA.md › Name styles and community tags): name fonts, colours and effects; a community's
 * tag worn by members' names; member lists carry the style and tag; a whole community muted for a while.
 */
let h: Harness;
let owner: GriipClient, member: GriipClient, outsider: GriipClient;
let orgId: string, otherOrg: string, channelId: string;

const prefsOf = (c: GriipClient, ws: string) => c.req("GET", `/v1/me/preferences/${ws}`);
const put = (c: GriipClient, ws: string, baseRev: number, prefs: object) => c.req("PUT", `/v1/me/preferences/${ws}`, { baseRev, prefs });

beforeAll(async () => {
  h = await startServer();
  [owner, member, outsider] = await Promise.all(["owner", "member", "outsider"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Tag Lab" })).org.id;
  otherOrg = (await outsider.req("POST", "/v1/orgs", { name: "Elsewhere" })).org.id;
  const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 5 })).invite.code;
  await member.req("POST", "/v1/invites/accept", { code });
  channelId = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "general-chat", scope: "ORG", kind: "PUBLIC" })).channel.id;
  await member.req("POST", `/v1/conversations/${channelId}/join`).catch(() => undefined);
});
afterAll(async () => h.close());

describe("name styles and community tags", () => {
  it("are advertised", async () => {
    const { features, version } = await owner.req("GET", "/v1/server-info");
    expect(features).toEqual(expect.arrayContaining(["name-styles", "community-tags", "community-mute"]));
    expect(version).toBe("0.56.0");
  });

  it("lets owners set a 2 to 4 character tag, stored in capitals, and members can't", async () => {
    await expectStatus(member.req("PATCH", `/v1/orgs/${orgId}`, { tag: "mc" }), 403);
    await expectStatus(owner.req("PATCH", `/v1/orgs/${orgId}`, { tag: "toolong" }), 400);
    await expectStatus(owner.req("PATCH", `/v1/orgs/${orgId}`, { tag: "a!" }), 400);
    expect((await owner.req("PATCH", `/v1/orgs/${orgId}`, { tag: "mc", accent: "#22c55e" })).org.tag).toBe("MC");
    expect((await member.req("GET", "/v1/orgs")).orgs.find((o: { id: string }) => o.id === orgId).tag).toBe("MC");
  });

  it("keeps a name style: font, colours (lower case) and effect; unknown fonts are refused", async () => {
    await expectStatus(member.req("PUT", "/v1/users/me/profile-style", { nameFont: "comic" }), 400);
    await expectStatus(member.req("PUT", "/v1/users/me/profile-style", { nameColors: [] }), 400);
    await expectStatus(member.req("PUT", "/v1/users/me/profile-style", { nameColors: ["#111111", "#222222", "#333333", "#444444"] }), 400);
    const { profileStyle } = await member.req("PUT", "/v1/users/me/profile-style", { nameFont: "pixel", nameColors: ["#FF00AA", "#22D3EE"], nameEffect: "glow" });
    expect(profileStyle).toMatchObject({ nameFont: "pixel", nameColors: ["#ff00aa", "#22d3ee"], nameEffect: "glow", decoration: null });
    // Changing one part keeps the others.
    expect((await member.req("PUT", "/v1/users/me/profile-style", { decoration: "neon" })).profileStyle).toMatchObject({ nameFont: "pixel", decoration: "neon" });
  });

  it("wears only a tag of a community you're in, and shows it with the name in profiles and member lists", async () => {
    await expectStatus(member.req("PUT", "/v1/users/me/profile-style", { tagOrgId: otherOrg }), 400);
    await member.req("PUT", "/v1/users/me/profile-style", { tagOrgId: orgId });
    const tag = { orgId, text: "MC", color: "#22c55e" };
    expect((await outsider.req("GET", `/v1/users/${member.userId}`)).user.tag).toEqual(tag);
    expect((await member.req("GET", "/v1/users/me")).tag ?? (await member.req("GET", "/v1/users/me")).user?.tag).toEqual(tag);
    const listed = (await owner.req("GET", `/v1/orgs/${orgId}/members`)).members.find((m: { id: string }) => m.id === member.userId);
    expect(listed).toMatchObject({ tag, profileStyle: { nameFont: "pixel", nameEffect: "glow" } });
    const inChannel = (await owner.req("GET", `/v1/conversations/${channelId}/members`)).members.find((m: { id: string }) => m.id === member.userId);
    if (inChannel) expect(inChannel.tag).toEqual(tag);
  });

  it("drops the tag when the community removes it or the person leaves", async () => {
    await owner.req("PATCH", `/v1/orgs/${orgId}`, { tag: null });
    expect((await outsider.req("GET", `/v1/users/${member.userId}`)).user.tag).toBeUndefined();
    await owner.req("PATCH", `/v1/orgs/${orgId}`, { tag: "MC" });
    expect((await outsider.req("GET", `/v1/users/${member.userId}`)).user.tag?.text).toBe("MC");
    await member.req("POST", `/v1/orgs/${orgId}/leave`).catch(() => member.req("DELETE", `/v1/orgs/${orgId}/members/${member.userId}`));
    expect((await outsider.req("GET", `/v1/users/${member.userId}`)).user.tag).toBeUndefined();
  });

  it("mutes a whole community for a while; an app that leaves the mute out keeps it, and an ended one is dropped", async () => {
    const until = Date.now() + 3_600_000;
    const doc = await prefsOf(owner, orgId);
    const first = await put(owner, orgId, doc.rev, { ...doc.prefs, community: { level: "mentions", suppressEveryone: false, mutedUntil: until } });
    expect(first.prefs.community).toEqual({ level: "mentions", suppressEveryone: false, mutedUntil: until });
    // An older app writes the community settings without the mute: it stays.
    const second = await put(owner, orgId, first.rev, { ...first.prefs, community: { level: "all", suppressEveryone: true } });
    expect(second.prefs.community).toEqual({ level: "all", suppressEveryone: true, mutedUntil: until });
    // Unmuting is an explicit null; a mute in the past is dropped.
    const third = await put(owner, orgId, second.rev, { ...second.prefs, community: { level: "all", suppressEveryone: true, mutedUntil: null } });
    expect(third.prefs.community.mutedUntil).toBeUndefined();
    const fourth = await put(owner, orgId, third.rev, { ...third.prefs, community: { level: "all", suppressEveryone: true, mutedUntil: Date.now() - 1000 } });
    expect(fourth.prefs.community.mutedUntil).toBeUndefined();
  });
});
