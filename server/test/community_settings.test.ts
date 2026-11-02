import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommunitySettingsView, OnboardingStatus } from "../src/shared/contracts/http/communitySettings.js";
import { NEVER_EXPIRES_AT, NO_USE_LIMIT } from "../src/modules/organizations/invites.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * A community's settings from community parity A3 (feature "community-settings", docs/COMMUNITY_SETTINGS_API.md):
 * never-expiring and standard invite links, a custom invite link at five members, links, a 100-character name, the
 * background tint, and onboarding's "must finish before chatting" with a starting channel. Runs with the community
 * tables in SQLite and in MongoDB.
 */

const PRODUCTION_DOMAINS = "preferences,reports,relationships,history,accounts,files,relay,billing";

let n = 0;
const text = (c: GriipClient, conv: string, words = "hi") => c.send(conv, { type: "text", text: words }, "message", `m_cs_${++n}_${Date.now()}`);
const react = (c: GriipClient, conv: string, target: string) => c.send(conv, { type: "reaction", target, emoji: "👍", add: true }, "control", `r_cs_${++n}_${Date.now()}`);
const read = (c: GriipClient, conv: string, upTo: number) => c.send(conv, { type: "read", upTo }, "control", `d_cs_${++n}_${Date.now()}`);
const code = (e: { error: { code: string } }) => e.error.code;
const QUESTIONS = { enabled: true, prompts: [{ title: "What brings you here?", required: true, options: [{ title: "Games" }, { title: "Art" }] }] };

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: `${PRODUCTION_DOMAINS},workspace,conversations,calls` }],
] as const)("community settings kept in %s", (backend, env) => {
  let h: Harness;
  let owner: GriipClient, admin: GriipClient, member: GriipClient, a: GriipClient, b: GriipClient, late: GriipClient, outsider: GriipClient;
  let orgId: string, invite: string, general: string, secret: string, voice: string;

  beforeAll(async () => {
    h = await startServer({ ...env });
    expect(h.ctx.ws.backend).toBe(backend);
    [owner, admin, member, a, b, late, outsider] = await Promise.all(["csowner", "csadmin", "csmember", "csa", "csb", "cslate", "csout"].map((x) => h.client(x)));
    for (const c of [owner, admin, member, a, b, late, outsider]) c.serverMessages = true;
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Settings Club" })).org.id;
    invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 50 })).invite.code;
    for (const c of [admin, member]) await c.req("POST", "/v1/invites/accept", { code: invite });
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { role: "ADMIN" });
    general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "chat" })).channel.id;
    secret = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "staff", kind: "PRIVATE" })).channel.id;
    voice = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "lounge", voice: true })).channel.id;
  });
  afterAll(async () => h.close());

  it("is advertised in the server's features", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("community-settings");
  });

  it("makes member invitations that never expire and have no use limit; admin and guest ones keep their limits", async () => {
    const { invite: inv } = await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", expiresInHours: null, maxUses: null });
    expect(inv).toMatchObject({ expiresAt: NEVER_EXPIRES_AT, maxUses: NO_USE_LIMIT, neverExpires: true, noUseLimit: true });
    const limited = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite;
    expect(limited).toMatchObject({ neverExpires: false, noUseLimit: false, maxUses: 1 });
    for (const role of ["ADMIN", "GUEST"]) {
      expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/invites`, { role, expiresInHours: null }), 400))).toBe("bad_request");
      expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/invites`, { role, maxUses: null }), 400))).toBe("bad_request");
    }
    const listed = (await owner.req("GET", `/v1/orgs/${orgId}/invites`)).invites.find((x: { id: string }) => x.id === inv.id);
    expect(listed).toMatchObject({ neverExpires: true, noUseLimit: true, status: "active" });
  });

  it("gives each member one standard link that stays the same and is remade once revoked", async () => {
    const first = (await admin.req("POST", `/v1/orgs/${orgId}/invites/standard`)).invite;
    expect(first).toMatchObject({ neverExpires: true, noUseLimit: true, uses: 0 });
    expect((await admin.req("POST", `/v1/orgs/${orgId}/invites/standard`)).invite.code).toBe(first.code);
    await a.req("POST", "/v1/invites/accept", { code: first.code });
    expect((await admin.req("POST", `/v1/orgs/${orgId}/invites/standard`)).invite).toMatchObject({ id: first.id, uses: 1 });
    await admin.req("DELETE", `/v1/invites/${first.id}`);
    // Members without the invite permission get none.
    expect(code(await expectStatus(member.req("POST", `/v1/orgs/${orgId}/invites/standard`), 403))).toBe("forbidden");
    const again = (await admin.req("POST", `/v1/orgs/${orgId}/invites/standard`)).invite;
    expect(again.id).not.toBe(first.id);
    await expectStatus(outsider.req("POST", `/v1/orgs/${orgId}/invites/standard`), 404);
  });

  it("is read and changed only by people who can edit the community", async () => {
    expect(code(await expectStatus(member.req("GET", `/v1/orgs/${orgId}/settings`), 403))).toBe("forbidden");
    expect(code(await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/settings`, { background: "#112233" }), 403))).toBe("forbidden");
    const v = await admin.req("GET", `/v1/orgs/${orgId}/settings`);
    expect(CommunitySettingsView.safeParse(v).success).toBe(true);
    expect(v).toMatchObject({ name: "Settings Club", background: null, links: [], inviteSlug: null, inviteSlugMinMembers: 5, onboardingRequired: false, updatedAt: null });
  });

  it("takes a name of up to 100 characters, the background tint and links, and shows them on the community", async () => {
    const long = "N".repeat(100);
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/settings`, { name: `${long}x` }), 400))).toBe("bad_request");
    const links = [
      { label: "Website", url: "https://example.com" },
      { label: "Rules doc", url: "https://example.com/rules" },
    ];
    for (const bad of [[{ label: "Plain", url: "http://example.com" }], [{ label: "x".repeat(41), url: "https://example.com" }], Array(6).fill(links[0])]) {
      expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/settings`, { links: bad }), 400))).toBe("bad_request");
    }
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/settings`, { background: "blue" }), 400))).toBe("bad_request");
    const v = await owner.req("PUT", `/v1/orgs/${orgId}/settings`, { name: long, background: "#AABBCC", accent: "#112233", links });
    expect(v).toMatchObject({ name: long, background: "#aabbcc", accent: "#112233", links, updatedAt: expect.any(Number) });
    const { org } = await member.req("GET", `/v1/orgs/${orgId}`);
    expect(org).toMatchObject({ name: long, background: "#aabbcc", accent: "#112233", links, inviteSlug: null });
    expect((await outsider.req("POST", "/v1/invites/preview", { code: invite })).org).toMatchObject({ background: "#aabbcc", links });
    // PATCH takes the longer name too, and null clears the tint.
    await owner.req("PATCH", `/v1/orgs/${orgId}`, { name: "Settings Club" });
    expect((await owner.req("PUT", `/v1/orgs/${orgId}/settings`, { background: null })).background).toBeNull();
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "community.settings" })).toBe(2);
  });

  it("claims a custom invite link only at five members, in the allowed form, once across communities", async () => {
    const put = (c: GriipClient, inviteSlug: string | null, org = orgId) => c.req("PUT", `/v1/orgs/${org}/settings`, { inviteSlug });
    const few = await expectStatus(put(owner, "settings-club"), 403);
    expect(few.error).toMatchObject({ code: "invite_slug_needs_members", details: { minMembers: 5 } });
    await b.req("POST", "/v1/invites/accept", { code: invite });
    for (const bad of ["ab", "-club", "club-", "has space", "meldiq", "a".repeat(33), "café"]) {
      expect(code(await expectStatus(put(owner, bad), 400))).toBe("invite_slug_invalid");
    }
    expect((await put(owner, "Settings-Club")).inviteSlug).toBe("settings-club");
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.inviteSlug).toBe("settings-club");
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "community.invite_slug" })).toBe(1);

    const otherOrg = (await outsider.req("POST", "/v1/orgs", { name: "Rival" })).org.id;
    for (const c of [owner, admin, member, a]) await c.req("POST", "/v1/invites/accept", { code: (await outsider.req("POST", `/v1/orgs/${otherOrg}/invites`, { role: "MEMBER", maxUses: 10 })).invite.code });
    expect(code(await expectStatus(put(outsider, "SETTINGS-CLUB", otherOrg), 409))).toBe("invite_slug_taken");
  });

  it("joins through the custom link wherever a code is taken, with the usual rules, until it's changed or cleared", async () => {
    const preview = await late.req("POST", "/v1/invites/preview", { code: "Settings-Club" });
    expect(preview).toMatchObject({ org: { id: orgId }, role: "MEMBER", alreadyMember: false });
    expect((await late.req("GET", "/v1/invites/settings-club/public")).community.memberCount).toBe(5);
    await owner.req("POST", `/v1/orgs/${orgId}/bans`, { userId: outsider.userId });
    expect(code(await expectStatus(outsider.req("POST", "/v1/invites/accept", { code: "settings-club" }), 403))).toBe("banned");
    const joined = await late.req("POST", "/v1/invites/accept", { code: "settings-club" });
    expect(joined).toMatchObject({ org: { id: orgId }, alreadyMember: false });

    await owner.req("PUT", `/v1/orgs/${orgId}/settings`, { inviteSlug: "club-two" });
    expect(code(await expectStatus(late.req("POST", "/v1/invites/preview", { code: "settings-club" }), 404))).toBe("invite_not_found");
    expect((await late.req("POST", "/v1/invites/preview", { code: "club-two" })).alreadyMember).toBe(true);
    await owner.req("PUT", `/v1/orgs/${orgId}/settings`, { inviteSlug: null });
    expect(code(await expectStatus(late.req("POST", "/v1/invites/preview", { code: "club-two" }), 404))).toBe("invite_not_found");
    expect((await owner.req("GET", `/v1/orgs/${orgId}/settings`)).inviteSlug).toBeNull();
    // Freed, so another community may take it.
    await owner.req("PUT", `/v1/orgs/${orgId}/settings`, { inviteSlug: "settings-club" });
  });

  it("only lands people in a text channel everyone can see", async () => {
    for (const bad of [secret, voice, "c_nowhere"]) {
      expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/settings`, { startChannelId: bad }), 400))).toBe("start_channel_invalid");
    }
    expect((await owner.req("PUT", `/v1/orgs/${orgId}/settings`, { startChannelId: general })).startChannelId).toBe(general);
  });

  it("holds back only members who join after 'must finish' is on, until they answer, agree and finish", async () => {
    await owner.req("PUT", `/v1/orgs/${orgId}/onboarding`, QUESTIONS);
    const v = await owner.req("PUT", `/v1/orgs/${orgId}/settings`, { onboardingRequired: true });
    expect(v).toMatchObject({ onboardingRequired: true, onboardingRequiredSince: expect.any(Number) });
    const posted = await text(owner, general, "Welcome");
    // Joined before it was turned on: not held back.
    await text(member, general, "Still here");
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org).toMatchObject({ onboardingRequired: true, onboardingDone: false, mustFinishOnboarding: false, startChannelId: general });

    await late.req("DELETE", `/v1/orgs/${orgId}/members/${late.userId}`);
    await late.req("POST", "/v1/invites/accept", { code: invite });
    expect((await late.req("GET", `/v1/orgs/${orgId}`)).org).toMatchObject({ mustFinishOnboarding: true, onboardingDone: false });
    const refused = await expectStatus(text(late, general), 403);
    expect(refused.error).toMatchObject({ code: "onboarding_not_finished", details: { orgId } });
    expect(code(await expectStatus(react(late, general, posted.messageId), 403))).toBe("onboarding_not_finished");
    await read(late, general, posted.serverTs);
    await text(admin, general, "Admins never wait");

    expect(code(await expectStatus(late.req("POST", `/v1/orgs/${orgId}/onboarding/finish`), 400))).toBe("answer_required");
    const { prompts } = await late.req("GET", `/v1/orgs/${orgId}/onboarding`);
    await late.req("POST", `/v1/orgs/${orgId}/onboarding/answers`, { optionIds: [prompts[0].options[0].id] });
    // The community also asks members to agree to its rules: that comes before finishing.
    await owner.req("PUT", `/v1/orgs/${orgId}/rules`, { channelId: null, required: true, rules: [{ title: "Be kind" }] });
    expect(code(await expectStatus(late.req("POST", `/v1/orgs/${orgId}/onboarding/finish`), 403))).toBe("rules_not_agreed");
    await late.req("POST", `/v1/orgs/${orgId}/rules/agree`);
    const done = await late.req("POST", `/v1/orgs/${orgId}/onboarding/finish`);
    expect(OnboardingStatus.safeParse(done).success).toBe(true);
    expect(done).toMatchObject({ onboardingRequired: true, onboardingDone: true, finishedAt: expect.any(Number), startChannelId: general, mustFinishOnboarding: false });
    await text(late, general, "Done!");
    await react(late, general, posted.messageId);
    // Redoing it moves the time.
    await new Promise((r) => setTimeout(r, 5));
    expect((await late.req("POST", `/v1/orgs/${orgId}/onboarding/finish`)).finishedAt).toBeGreaterThan(done.finishedAt);
    await owner.req("PUT", `/v1/orgs/${orgId}/rules`, { channelId: null, required: false, rules: [] });
  });

  it("asks again after someone leaves and comes back, and stops once 'must finish' is off", async () => {
    await late.req("DELETE", `/v1/orgs/${orgId}/members/${late.userId}`);
    await late.req("POST", "/v1/invites/accept", { code: invite });
    expect(code(await expectStatus(text(late, general), 403))).toBe("onboarding_not_finished");
    await owner.req("PUT", `/v1/orgs/${orgId}/settings`, { onboardingRequired: false });
    await text(late, general, "Free to talk");
    expect(code(await expectStatus(outsider.req("POST", `/v1/orgs/${orgId}/onboarding/finish`), 404))).toBe("not_found");
  });

  it("keeps the personal choice to hide community themes", async () => {
    const { rev } = await member.req("GET", "/v1/me/preferences/personal");
    const put = await member.req("PUT", "/v1/me/preferences/personal", { baseRev: rev, prefs: { starred: [], sections: [], collapsed: [], notify: {}, communityThemes: false } });
    expect(put.prefs.communityThemes).toBe(false);
    // An app that doesn't know the field leaves it out: the choice is kept.
    const kept = await member.req("PUT", "/v1/me/preferences/personal", { baseRev: put.rev, prefs: { starred: [], sections: [], collapsed: [], notify: {} } });
    expect(kept.prefs.communityThemes).toBe(false);
  });
});

describe("community settings switched off (COMMUNITY_SETTINGS=off)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ COMMUNITY_SETTINGS: "off" });
  });
  afterAll(async () => h.close());

  it("isn't advertised, its routes answer 503, custom links don't resolve and nothing is enforced", async () => {
    const [owner, member] = await Promise.all([h.client("csoffowner"), h.client("csoffmember")]);
    expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("community-settings");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "Plain" })).org.id;
    expect(code(await expectStatus(owner.req("GET", `/v1/orgs/${orgId}/settings`), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/settings`, { background: "#000000" }), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/invites/standard`), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", expiresInHours: null }), 503))).toBe("feature_disabled");
    // What was set while it was on stays stored but does nothing.
    const t = Date.now();
    await h.ctx.ws.write((w) => {
      w.insert("invitations", { id: "inv_vanity_off", org_id: orgId, code_hash: "x".repeat(64), code_hint: "lain", role: "MEMBER", max_uses: NO_USE_LIMIT, created_by: owner.userId, created_at: t, expires_at: NEVER_EXPIRES_AT });
      w.insert("community_vanity_invites", { slug: "plain-club", org_id: orgId, invite_id: "inv_vanity_off", claimed_by: owner.userId, claimed_at: t });
      w.insert("community_settings", { org_id: orgId, onboarding_required: 1, onboarding_required_since: 0, updated_at: t, updated_by: owner.userId });
    });
    expect(code(await expectStatus(member.req("POST", "/v1/invites/preview", { code: "plain-club" }), 404))).toBe("invite_not_found");
    expect(h.ctx.communitySettings.mustFinish(orgId, member.userId)).toBe(false);
    const { org } = await owner.req("GET", `/v1/orgs/${orgId}`);
    expect(org.inviteSlug).toBeUndefined();
    expect(org.background).toBeUndefined();
  });
});
