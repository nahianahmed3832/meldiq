import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TemplatePreview } from "../src/shared/contracts/http/communityTemplates.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Templates from a community (community parity batch E, feature "template-links", docs/COMMUNITY_PARITY_API.md ›
 * Discovery): a template copies channels, categories, roles, overwrites and @everyone defaults, never members; anyone
 * signed in previews the code; a community made from it gets the same layout with roles remapped. Runs with the
 * community tables in SQLite and in MongoDB.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const STARTUP_MS = 120_000;
const code = (e: { error: { code: string } }) => e.error.code;

interface Ch {
  id: string;
  name: string;
  category_id: string | null;
  kind: string;
  voice: number;
  format: string;
  slowmode_sec: number;
  guidelines: string | null;
}

const backends = process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}] as const] : [
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const;
describe.each(backends)("templates from a community with communities in %s", (_backend, env) => {
  let h: Harness;
  let owner: GriipClient, member: GriipClient, outsider: GriipClient;
  let orgId: string, modsRole: string, crewRole: string, category: string, rulesChannel: string, forum: string;
  let tplCode: string;
  const channels = (org: string) => h.ctx.ws.all<Ch>("conversations", { where: { org_id: org, type: "CHANNEL" } });
  const categoryName = (id: string | null) => (id ? h.ctx.ws.get<{ name: string }>("channel_categories", { id })!.name : null);
  const layout = (org: string) =>
    channels(org)
      .map((c) => `${categoryName(c.category_id) ?? "-"}/${c.name}:${c.kind}:${c.voice}:${c.format}:${c.slowmode_sec}`)
      .sort();

  beforeAll(async () => {
    h = await startServer({ ...env });
    [owner, member, outsider] = await Promise.all(["tplowner", "tplmember", "tploutsider"].map((x) => h.client(x)));
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Raid Planners" })).org.id;
    const invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 5 })).invite.code;
    await member.req("POST", "/v1/invites/accept", { code: invite });
    modsRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Mods", color: "#E39B7B", permissions: ["members.timeout"] })).role.id;
    crewRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Crew", color: "#22D3EE", hoist: true })).role.id;
    await owner.req("PUT", `/v1/roles/${crewRole}/extras`, { color2: "#7C3AED", mentionable: true });
    await owner.req("PUT", `/v1/roles/${modsRole}/members/${member.userId}`);
    category = (await owner.req("POST", `/v1/orgs/${orgId}/categories`, { name: "Raids" })).category.id;
    rulesChannel = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "raid-rules", categoryId: category, slowmodeSec: 30, readOnly: true, posterRoleIds: [modsRole] })).channel.id;
    forum = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "raid-ideas", categoryId: category, format: "forum" })).channel.id;
    await owner.req("PATCH", `/v1/conversations/${forum}`, { guidelines: "One idea per post" });
    await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "mod-room", kind: "PRIVATE", categoryId: category });
    await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "raid-voice", voice: true, categoryId: category });
    await owner.req("PUT", `/v1/conversations/${rulesChannel}/overwrites`, { subject: crewRole, allow: ["messages.post"], deny: [] });
    await owner.req("PUT", `/v1/conversations/${rulesChannel}/overwrites`, { subject: `user:${member.userId}`, allow: [], deny: ["messages.post"] });
    await owner.req("PUT", `/v1/categories/${category}/overwrites`, { subject: "everyone", allow: [], deny: ["messages.attach"] });
    await owner.req("PUT", `/v1/orgs/${orgId}/roles/everyone`, { permissions: ["members.view", "channels.view", "messages.post"] });
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("is advertised, and made only by people who can edit the community", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("template-links");
    expect(await owner.req("GET", `/v1/orgs/${orgId}/templates`)).toEqual({ template: null });
    expect(code(await expectStatus(member.req("POST", `/v1/orgs/${orgId}/templates`, {}), 403))).toBe("forbidden");
    expect(code(await expectStatus(outsider.req("GET", `/v1/orgs/${orgId}/templates`), 404))).toBe("not_found");
  });

  it("copies channels, categories and roles under a share code, one per community", async () => {
    const { template } = await owner.req("POST", `/v1/orgs/${orgId}/templates`, { name: "Raid night setup" });
    tplCode = template.code;
    expect(template).toMatchObject({ name: "Raid night setup", uses: 0, outOfDate: false, counts: { categories: 3, channels: channels(orgId).length, roles: 2 } });
    expect(tplCode).toMatch(/^[A-Z2-9]{12}$/);
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/templates`, {}), 409))).toBe("template_exists");
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "community.template" })).toBe(1);
  });

  it("previews by code (any case) for anyone signed in, without members or people's overwrites", async () => {
    const { template } = await outsider.req("GET", `/v1/templates/${tplCode.toLowerCase()}`);
    expect(TemplatePreview.safeParse(template).success).toBe(true);
    expect(template.source).toMatchObject({ id: orgId, name: "Raid Planners" });
    expect(template.roles).toEqual([
      { name: "Mods", color: "#E39B7B" },
      { name: "Crew", color: "#22D3EE" },
    ]);
    const raids = template.categories.find((c: { name: string | null }) => c.name === "Raids");
    expect(raids.channels.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["raid-rules", "raid-ideas", "mod-room", "raid-voice"]));
    const stored = h.ctx.ws.get<{ snapshot: string }>("community_templates", { org_id: orgId })!.snapshot;
    expect(stored).not.toContain(member.userId);
    expect(stored).not.toContain(owner.userId);
    expect(code(await expectStatus(outsider.req("GET", "/v1/templates/NOPE2345NOPE"), 404))).toBe("template_not_found");
  });

  it("builds a new community from the code: same layout, roles remapped, only its owner as member", async () => {
    expect(code(await expectStatus(outsider.req("POST", "/v1/orgs", { name: "Bad Code", templateCode: "ZZZZ2345ZZZZ" }), 404))).toBe("template_not_found");
    const made = (await outsider.req("POST", "/v1/orgs", { name: "My Raids", templateCode: tplCode })).org.id;
    expect(layout(made)).toEqual(layout(orgId));
    expect(h.ctx.ws.count("org_members", { org_id: made })).toBe(1);
    const roles = h.ctx.ws.all<{ id: string; name: string; color: string; hoist: number; permissions: string }>("org_roles", { where: { org_id: made }, orderBy: [["position", "asc"]] });
    expect(roles.map((r) => [r.name, r.color, r.hoist])).toEqual([
      ["Mods", "#E39B7B", 0],
      ["Crew", "#22D3EE", 1],
    ]);
    expect(JSON.parse(roles[0]!.permissions)).toEqual(["members.timeout"]);
    expect(h.ctx.ws.get<{ color2: string; mentionable: number }>("org_role_extras", { role_id: roles[1]!.id })).toMatchObject({ color2: "#7C3AED", mentionable: 1 });
    expect(h.ctx.ws.count("org_role_members", { org_id: made })).toBe(0);
    const rules = channels(made).find((c) => c.name === "raid-rules")!;
    const overwrites = h.ctx.ws.all<{ subject: string; allow: string }>("channel_overwrites", { where: { target_type: "channel", target_id: rules.id } });
    expect(overwrites).toHaveLength(1);
    expect(overwrites[0]).toMatchObject({ subject: roles[1]!.id, allow: JSON.stringify(["messages.post"]) });
    expect(h.ctx.ws.get<{ read_only: number; poster_role_ids: string }>("channel_options", { conversation_id: rules.id })).toMatchObject({ read_only: 1, poster_role_ids: JSON.stringify([roles[0]!.id]) });
    expect(channels(made).find((c) => c.name === "raid-ideas")!.guidelines).toBe("One idea per post");
    const raids = h.ctx.ws.get<{ id: string }>("channel_categories", { org_id: made, name: "Raids" })!;
    expect(h.ctx.ws.all<{ subject: string }>("channel_overwrites", { where: { target_type: "category", target_id: raids.id } }).map((o) => o.subject)).toEqual(["everyone"]);
    const defaults = (org: string) => h.ctx.ws.get<{ added: string; removed: string }>("community_member_defaults", { org_id: org });
    expect(defaults(made)).toMatchObject({ added: defaults(orgId)!.added, removed: defaults(orgId)!.removed });
    expect((await owner.req("GET", `/v1/orgs/${orgId}/templates`)).template.uses).toBe(1);
  });

  it("says when it's out of date, syncs on request, and stops working once deleted", async () => {
    await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "loot-log", categoryId: category });
    expect((await owner.req("GET", `/v1/orgs/${orgId}/templates`)).template.outOfDate).toBe(true);
    const synced = (await owner.req("POST", `/v1/orgs/${orgId}/templates/sync`)).template;
    expect(synced).toMatchObject({ code: tplCode, outOfDate: false });
    expect(await owner.req("DELETE", `/v1/orgs/${orgId}/templates`)).toEqual({ deleted: true });
    expect(code(await expectStatus(outsider.req("GET", `/v1/templates/${tplCode}`), 404))).toBe("template_not_found");
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/templates/sync`), 404))).toBe("template_not_found");
    expect(await owner.req("DELETE", `/v1/orgs/${orgId}/templates`)).toEqual({ deleted: false });
  });
});

describe("templates switched off", () => {
  let h: Harness;
  let owner: GriipClient;
  beforeAll(async () => {
    h = await startServer({ COMMUNITY_TEMPLATE_LINKS: "off" });
    owner = await h.client("tploffowner");
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("hides the feature and answers 503", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("template-links");
    const orgId = (await owner.req("POST", "/v1/orgs", { name: "Off Lab" })).org.id;
    expect(code(await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/templates`, {}), 503))).toBe("feature_disabled");
    expect(code(await expectStatus(owner.req("POST", "/v1/orgs", { name: "From Code", templateCode: "ABCDEFGH2345" }), 503))).toBe("feature_disabled");
  });
});
