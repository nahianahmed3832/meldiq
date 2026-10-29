import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plainRules } from "../src/modules/organizations/rules/service.js";
import { RulesView } from "../src/shared/contracts/http/communityRules.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * A community's rules channel and its rules (API 0.65.0, feature "rules-channel", docs/SETTINGS_PARITY_API.md): only
 * people who can edit the community post in the rules channel (everyone reads and reacts), and a community can ask
 * members to agree to the rules before they post or react anywhere in it. Runs on memory and on MongoDB.
 */

const PRODUCTION_DOMAINS = "preferences,reports,relationships,history,accounts,files,relay,billing";
const RULES = [
  { title: "Be kind", description: "No hate, harassment or slurs." },
  { title: "No spam", description: "Ads and invites only in #promote." },
  { title: "Keep it safe for work" },
];

let n = 0;
const text = (c: GriipClient, conv: string, words = "hi") => c.send(conv, { type: "text", text: words }, "message", `m_rules_${++n}_${Date.now()}`);
const react = (c: GriipClient, conv: string, target: string) => c.send(conv, { type: "reaction", target, emoji: "👍", add: true }, "control", `r_rules_${++n}_${Date.now()}`);
const read = (c: GriipClient, conv: string, upTo: number) => c.send(conv, { type: "read", upTo }, "control", `d_rules_${++n}_${Date.now()}`);
const code = (e: { error: { code: string } }) => e.error.code;

describe.each([
  ["memory", {}],
  ["mongodb", { MONGODB_DOMAINS: PRODUCTION_DOMAINS }],
] as const)("rules channel kept in %s", (backend, env) => {
  let h: Harness;
  let owner: GriipClient, admin: GriipClient, member: GriipClient, other: GriipClient;
  let orgId: string, rules: string, general: string, voice: string, secret: string, forum: string, invite: string;

  beforeAll(async () => {
    h = await startServer({ ...env });
    expect(h.ctx.communityRules.store.backend).toBe(backend);
    [owner, admin, member, other] = await Promise.all(["rowner", "radmin", "rmember", "rother"].map((x) => h.client(x)));
    // Messages go through the server (POST /v2/messages), as today's apps send them: it reads each change's type.
    for (const c of [owner, admin, member, other]) c.serverMessages = true;
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Rule Makers" })).org.id;
    invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [admin, member]) await c.req("POST", "/v1/invites/accept", { code: invite });
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { role: "ADMIN" });
    rules = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "rules", kind: "ANNOUNCEMENT" })).channel.id;
    general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "chat" })).channel.id;
    voice = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "lounge", voice: true })).channel.id;
    secret = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "staff", kind: "PRIVATE" })).channel.id;
    forum = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "ideas", format: "forum" })).channel.id;
  });
  afterAll(async () => h.close());

  it("is advertised in the server's features", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("rules-channel");
  });

  it("starts empty, and the community view says nothing about it until it's set", async () => {
    const v = await member.req("GET", `/v1/orgs/${orgId}/rules`);
    expect(v).toEqual({ channelId: null, required: false, rules: [], updatedAt: null, agreedAt: null, mustAgree: false });
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.rulesChannel).toBeUndefined();
    await expectStatus(other.req("GET", `/v1/orgs/${orgId}/rules`), 404);
  });

  it("is set by people who can edit the community, with a channel that suits", async () => {
    const body = { channelId: rules, required: false, rules: RULES };
    expect(code(await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/rules`, body), 403))).toBe("forbidden");
    for (const bad of [voice, secret, forum, "c_nowhere"]) {
      expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/rules`, { ...body, channelId: bad }), 400))).toBe("rules_channel_invalid");
    }
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/rules`, { ...body, required: true, rules: [] }), 400))).toBe("bad_request");
    const v = await admin.req("PUT", `/v1/orgs/${orgId}/rules`, body);
    expect(RulesView.safeParse(v).success).toBe(true);
    expect(v).toMatchObject({ channelId: rules, required: false, mustAgree: false, agreedAt: null });
    expect(v.rules.map((r: { title: string; description: string | null }) => [r.title, r.description])).toEqual([
      ["Be kind", "No hate, harassment or slurs."],
      ["No spam", "Ads and invites only in #promote."],
      ["Keep it safe for work", null],
    ]);
    // Ids are kept when the list is saved again, so editors can reorder and edit.
    const again = await owner.req("PUT", `/v1/orgs/${orgId}/rules`, { ...body, rules: [...v.rules].reverse() });
    expect(again.rules.map((r: { id: string }) => r.id)).toEqual([...v.rules].reverse().map((r: { id: string }) => r.id));
    await owner.req("PUT", `/v1/orgs/${orgId}/rules`, { ...body, rules: v.rules });
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "community.rules" })).toBeGreaterThanOrEqual(3);
  });

  it("shows on the community and in its plain rules for the preview and older apps", async () => {
    const { org } = await member.req("GET", `/v1/orgs/${orgId}`);
    expect(org.rulesChannel).toEqual({ channelId: rules, required: false, count: 3, agreedAt: null, mustAgree: false });
    expect(org.rules).toBe(plainRules((await member.req("GET", `/v1/orgs/${orgId}/rules`)).rules));
    expect(org.rules).toMatch(/^1\. Be kind\nNo hate, harassment or slurs\.\n\n2\. No spam/);
  });

  it("only lets people who can edit the community post there; everyone reads and reacts", async () => {
    const posted = await text(admin, rules, "Welcome! Read these first.");
    expect(code(await expectStatus(text(member, rules), 403))).toBe("rules_channel");
    await react(member, rules, posted.messageId);
    await read(member, rules, posted.serverTs);
    expect((await member.req("GET", `/v1/conversations/${rules}`)).conversation.canPost).toBe(false);
    expect((await owner.req("GET", `/v1/conversations/${rules}`)).conversation.canPost).toBe(true);
    // Elsewhere nothing changed.
    await text(member, general);
  });

  it("asks members to agree before they post or react, once it's required", async () => {
    const before = await text(owner, general, "Hello all");
    const v = await owner.req("PUT", `/v1/orgs/${orgId}/rules`, { channelId: rules, required: true, rules: RULES });
    expect(v).toMatchObject({ required: true, mustAgree: false });
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.rulesChannel).toMatchObject({ required: true, mustAgree: true, agreedAt: null });

    const refused = await expectStatus(text(member, general), 403);
    expect(refused.error).toMatchObject({ code: "rules_not_agreed", details: { orgId } });
    expect(code(await expectStatus(react(member, general, before.messageId), 403))).toBe("rules_not_agreed");
    // Read markers still flow, and people who can edit the community never have to agree.
    await read(member, general, before.serverTs);
    await text(admin, general, "Mods can still talk");

    const agreed = await member.req("POST", `/v1/orgs/${orgId}/rules/agree`);
    expect(agreed).toMatchObject({ mustAgree: false, agreedAt: expect.any(Number) });
    await text(member, general, "Thanks, I read them");
    await react(member, general, before.messageId);
    // Agreeing again keeps the first time.
    expect((await member.req("POST", `/v1/orgs/${orgId}/rules/agree`)).agreedAt).toBe(agreed.agreedAt);
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.rulesChannel).toMatchObject({ mustAgree: false, agreedAt: agreed.agreedAt });
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "community.rules_agreed", target: member.userId })).toBe(1);
  });

  it("asks again after someone leaves and comes back", async () => {
    await other.req("POST", "/v1/invites/accept", { code: invite });
    expect((await other.req("GET", `/v1/orgs/${orgId}/rules`)).mustAgree).toBe(true);
    await other.req("POST", `/v1/orgs/${orgId}/rules/agree`);
    await other.req("DELETE", `/v1/orgs/${orgId}/members/${other.userId}`);
    await other.req("POST", "/v1/invites/accept", { code: invite });
    expect((await other.req("GET", `/v1/orgs/${orgId}/rules`)).mustAgree).toBe(true);
    expect(code(await expectStatus(text(other, general), 403))).toBe("rules_not_agreed");
  });

  it("forgets an archived rules channel, and turning the requirement off opens posting again", async () => {
    await owner.req("PATCH", `/v1/conversations/${rules}`, { archived: true });
    expect((await member.req("GET", `/v1/orgs/${orgId}/rules`)).channelId).toBeNull();
    await owner.req("PATCH", `/v1/conversations/${rules}`, { archived: false });
    expect((await member.req("GET", `/v1/orgs/${orgId}/rules`)).channelId).toBe(rules);
    await owner.req("PUT", `/v1/orgs/${orgId}/rules`, { channelId: rules, required: false, rules: RULES });
    await text(other, general, "Now I can talk");
  });

  it("survives a restart (read back from the store)", async () => {
    const fresh = new (h.ctx.communityRules.constructor as new (...a: unknown[]) => typeof h.ctx.communityRules)(h.ctx, h.ctx.communityRules.store, true);
    await fresh.load();
    expect(fresh.view(orgId, member.userId)).toMatchObject({ channelId: rules, rules: [{ title: "Be kind" }, { title: "No spam" }, { title: "Keep it safe for work" }] });
    expect(fresh.agreedAt(orgId, member.userId)).toEqual(expect.any(Number));
  });

  it("removing the channel and the rules clears the plain copy it wrote", async () => {
    const v = await owner.req("PUT", `/v1/orgs/${orgId}/rules`, { channelId: null, required: false, rules: [] });
    expect(v).toMatchObject({ channelId: null, rules: [] });
    const { org } = await member.req("GET", `/v1/orgs/${orgId}`);
    expect(org.rules).toBeNull();
    expect(org.rulesChannel).toBeUndefined();
    // The old rules channel is an ordinary announcement channel again.
    expect(code(await expectStatus(text(member, rules), 403))).toBe("forbidden");
  });
});

describe("rules channel switched off (COMMUNITY_RULES=off)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ COMMUNITY_RULES: "off" });
  });
  afterAll(async () => h.close());

  it("isn't advertised, its routes answer 503, and nothing stored is enforced", async () => {
    const [owner, member] = await Promise.all([h.client("offowner"), h.client("offmember")]);
    expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("rules-channel");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "No Rules" })).org.id;
    await member.req("POST", "/v1/invites/accept", { code: (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code });
    expect(code(await expectStatus(owner.req("GET", `/v1/orgs/${orgId}/rules`), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/rules`, { channelId: null, required: false, rules: [] }), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/rules/agree`), 503))).toBe("feature_disabled");
    // Rules a community set while it was on are kept but not enforced.
    await h.ctx.communityRules.store.put({ orgId, channelId: null, required: true, rules: [{ id: "r1", title: "Be kind", description: null }], updatedAt: 1, updatedBy: owner.userId });
    await h.ctx.communityRules.load();
    expect(h.ctx.communityRules.mustAgree(orgId, member.userId)).toBe(false);
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.rulesChannel).toBeUndefined();
  });
});

describe("plainRules", () => {
  it("numbers the rules, puts descriptions under titles and stays within 4,000 characters", () => {
    expect(plainRules([{ id: "a", title: "One", description: "First" }, { id: "b", title: "Two", description: null }])).toBe("1. One\nFirst\n\n2. Two");
    const long = plainRules(Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, title: "x".repeat(100), description: "y".repeat(1000) })));
    expect(long.length).toBe(4000);
    expect(long.endsWith("…")).toBe(true);
  });
});
