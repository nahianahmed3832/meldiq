import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
const MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
describe.each([
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: MONGO }],
] as const)("Yapin roadmap integration (%s)", (_name, env) => {
  let h: Harness;
  let owner: GriipClient, member: GriipClient, outsider: GriipClient, guest: GriipClient;
  let org: string, ch: string;
  const profile = (c: GriipClient, target = member.userId) => c.req("GET", `/v1/orgs/${org}/members/${target}/profile`);
  const empty = { aboutMe: null, pronouns: null, theme: null };
  beforeAll(async () => {
    h = await startServer({ ...env });
    [owner, member, outsider, guest] = await Promise.all(["roadowner", "roadmember", "roadoutside", "roadguest"].map((n) => h.client(n)));
    org = (await owner.req("POST", "/v1/orgs", { name: "Roadmap Lab" })).org.id;
    for (const [c, role] of [
      [member, "MEMBER"],
      [guest, "GUEST"],
    ] as const) {
      const code = (await owner.req("POST", `/v1/orgs/${org}/invites`, { role })).invite.code;
      await c.req("POST", "/v1/invites/accept", { code });
    }
    ch = (
      await owner.req("POST", `/v1/orgs/${org}/channels`, {
        name: "general",
        scope: "ORG",
      })
    ).channel.id;
  }, 120000);
  afterAll(async () => {
    await h?.close();
  });
  it("advertises the completed feature capabilities", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toEqual(
      expect.arrayContaining(["profile-revisions", "community-profiles", "expression-preferences", "permission-preview", "attachment-proxy", "bot-diagnostics"]),
    );
  });
  it("syncs bounded expression lists, preserves them for old writers, and refuses stale writes", async () => {
    const path = "/v1/me/preferences/personal";
    const initial = await member.req("GET", path);
    const first = await member.req("PUT", path, {
      baseRev: initial.rev,
      prefs: {
        expressionFavorites: ["emj_wave", "emj_wave"],
        expressionRecents: ["stk_hi"],
      },
    });
    expect(first.prefs.expressionFavorites).toEqual(["emj_wave"]);
    const legacy = await member.req("PUT", path, {
      baseRev: first.rev,
      prefs: { starred: [] },
    });
    expect(legacy.prefs.expressionFavorites).toEqual(["emj_wave"]);
    expect(legacy.prefs.expressionRecents).toEqual(["stk_hi"]);
    await expectStatus(
      member.req("PUT", path, {
        baseRev: first.rev,
        prefs: { expressionFavorites: [] },
      }),
      409,
    );
    await expectStatus(
      member.req("PUT", path, {
        baseRev: legacy.rev,
        prefs: { expressionFavorites: ["https://private.example/token"] },
      }),
      400,
    );
    await expectStatus(
      member.req("PUT", path, {
        baseRev: legacy.rev,
        prefs: {
          expressionFavorites: Array.from({ length: 101 }, (_, i) => `emj_${i}`),
        },
      }),
      400,
    );
    expect((await outsider.req("GET", path)).prefs.expressionFavorites).toBeUndefined();
  });
  it("keeps community overrides scoped, private and revision protected", async () => {
    expect(await profile(member)).toMatchObject({
      rev: 0,
      own: true,
      profile: empty,
    });
    const path = `/v1/orgs/${org}/members/${member.userId}/profile`;
    const data = {
      aboutMe: "Community biography",
      pronouns: "they/them",
      theme: ["#123456", "#abcdef"],
    };
    const saved = await member.req("PUT", path, { baseRev: 0, profile: data });
    expect(saved).toMatchObject({ rev: 1, profile: data });
    expect((await profile(owner)).profile).toMatchObject(data);
    expect((await member.req("GET", "/v1/users/me")).user.aboutMe).not.toBe(data.aboutMe);
    await expectStatus(outsider.req("GET", path), 404);
    await expectStatus(owner.req("PUT", path, { baseRev: 1, profile: empty }), 403);
    await expectStatus(member.req("PUT", path, { baseRev: 0, profile: empty }), 409);
    await expectStatus(
      member.req("PUT", path, {
        baseRev: 1,
        profile: { ...data, theme: ["url(javascript:alert(1))"] },
      }),
      400,
    );
    await member.req("PUT", "/v1/users/me/privacy", { bio: "nobody" });
    const hidden = await profile(owner);
    expect(hidden.profile).not.toHaveProperty("aboutMe");
    expect(hidden.profile).not.toHaveProperty("pronouns");
    expect((await profile(member)).profile.aboutMe).toBe(data.aboutMe);
    await member.req("PUT", path, { baseRev: 1, profile: empty });
    expect((await profile(member)).profile).toEqual(empty);
  });
  it("prevents two concurrent community editors from losing a revision", async () => {
    const path = `/v1/orgs/${org}/members/${member.userId}/profile`;
    const rev = (await profile(member)).rev;
    const results = await Promise.allSettled(
      ["one", "two"].map((aboutMe) =>
        member.req("PUT", path, {
          baseRev: rev,
          profile: { ...empty, aboutMe },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await profile(member)).rev).toBe(rev + 1);
  });
  it("rejects stale global profile saves without overwriting newer details", async () => {
    const before = (await member.req("GET", "/v1/users/me")).user;
    expect(before.profileRevision).toMatch(/^[a-f0-9]{64}$/);
    const saved = await member.req("PATCH", "/v1/users/me", {
      baseProfileRevision: before.profileRevision,
      aboutMe: "Latest global bio",
    });
    expect(saved.user.profileRevision).not.toBe(before.profileRevision);
    await expectStatus(
      member.req("PATCH", "/v1/users/me", {
        baseProfileRevision: before.profileRevision,
        aboutMe: "Stale draft",
      }),
      409,
    );
    expect((await member.req("GET", "/v1/users/me")).user.aboutMe).toBe("Latest global bio");
    await member.req("PATCH", "/v1/users/me", { statusEmoji: "🌿" }); // legacy writers remain compatible
  });
  it("simulates actual member and role channel permissions without changing access", async () => {
    const role = (
      await owner.req("POST", `/v1/orgs/${org}/roles`, {
        name: "Read only",
        denies: ["messages.post", "members.view"],
      })
    ).role;
    await owner.req("PUT", `/v1/roles/${role.id}/members/${member.userId}`);
    const path = `/v1/conversations/${ch}/permission-preview`;
    const actual = await owner.req("GET", `${path}?userId=${member.userId}`);
    const simulated = await owner.req("GET", `${path}?roleId=${role.id}`);
    expect(actual.capabilities.find((c: any) => c.key === "messages.post").allowed).toBe(false);
    expect(simulated.capabilities.find((c: any) => c.key === "messages.post").allowed).toBe(false);
    expect(actual.steps).toHaveLength(3);
    const category = (
      await owner.req("POST", `/v1/orgs/${org}/categories`, {
        name: "Preview category",
      })
    ).category;
    const categoryPreview = await owner.req("GET", `/v1/categories/${category.id}/permission-preview?userId=${member.userId}`);
    expect(categoryPreview.steps).toHaveLength(2);
    await owner.req("PUT", `/v1/conversations/${ch}/overwrites`, {
      subject: "everyone",
      allow: [],
      deny: ["messages.attach"],
    });
    const updated = await owner.req("GET", `${path}?userId=${member.userId}`);
    expect(updated.capabilities.find((c: any) => c.key === "messages.attach").allowed).toBe(false);
    const held = h.ctx.authz.channelPermissions(h.ctx.authz.conversation(ch)!, member.userId);
    for (const c of updated.capabilities) expect(c.allowed).toBe(held.has(c.key));
    expect((await member.req("GET", path)).subject).toBe(member.userId);
    await expectStatus(member.req("GET", `${path}?userId=${owner.userId}`), 403);
    await expectStatus(guest.req("GET", `${path}?userId=${owner.userId}`), 404);
    await expectStatus(outsider.req("GET", path), 404);
    await expectStatus(owner.req("GET", `${path}?roleId=${role.id}&userId=${member.userId}`), 400);
    expect(h.ctx.authz.assignedRoles(org, member.userId).map((r) => r.id)).toContain(role.id);
  });
  it("exposes bot diagnostics only to community editors and bounds metadata history", async () => {
    const path = `/v1/orgs/${org}/official-bots/helper/diagnostics`;
    await expectStatus(member.req("GET", path), 403);
    await expectStatus(outsider.req("GET", path), 404);
    for (let i = 0; i < 55; i++) await h.ctx.officialBots.recordOutcome(org, "helper", "message", i === 54 ? "failed" : "ok");
    const data = await owner.req("GET", path);
    expect(data.events).toHaveLength(50);
    expect(data.checks.some((c: any) => c.label === "Runtime")).toBe(true);
    expect(data.events.some((e: any) => e.outcome === "failed")).toBe(true);
    expect(Object.keys(data.events[0]).sort()).toEqual(["at", "id", "kind", "outcome"]);
    await h.ctx.officialBots.safely(
      "helper",
      {
        kind: "message",
        orgId: org,
        at: Date.now(),
        conversationId: ch,
        userId: member.userId,
        messageId: "never-record-me",
        payload: { text: "secret" },
      },
      async () => {
        throw new Error("private-token");
      },
    );
    const after = await owner.req("GET", path);
    expect(JSON.stringify(after)).not.toContain("private-token");
    expect(JSON.stringify(after)).not.toContain("secret");
  });
  it("requires membership for same-origin attachment streaming and supports ranges", async () => {
    const data = Buffer.from("protected media bytes");
    const uploaded = await owner.req("POST", `/v1/attachments?conversationId=${ch}`, undefined, data);
    const response = await fetch(`${h.baseUrl}/v1/attachments/${uploaded.id}?proxy=1`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    const range = await fetch(`${h.baseUrl}/v1/attachments/${uploaded.id}?proxy=1`, {
      headers: { Authorization: `Bearer ${owner.token}`, Range: "bytes=2-8" },
    });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(data.subarray(2, 9));
    const refused = await fetch(`${h.baseUrl}/v1/attachments/${uploaded.id}?proxy=1`, { headers: { Authorization: `Bearer ${outsider.token}` } });
    expect(refused.status).toBe(404);
  });
});
