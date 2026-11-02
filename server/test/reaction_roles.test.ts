import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReactionRolesView } from "../src/shared/contracts/http/reactionRoles.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Reaction roles (community parity batch C, feature "reaction-roles", docs/COMMUNITY_PARITY_API.md › Posting tools):
 * holders of roles.assign pair emoji with roles on a message; reacting gives the role and taking the reaction off takes
 * it back. Never roles with administrative powers or beyond the setter's own. Runs with the community tables in SQLite
 * and in MongoDB.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const STARTUP_MS = 120_000;
const code = (e: { error: { code: string } }) => e.error.code;
let n = 0;
const nextId = (what: string) => `${what}_rr_${++n}_${Date.now()}`;

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const)("reaction roles with communities in %s", (_backend, env) => {
  let h: Harness;
  let owner: GriipClient, assigner: GriipClient, member: GriipClient, other: GriipClient;
  let orgId: string, general: string, offtopic: string, message: string;
  let gamer: string, artist: string, mod: string, emojiKeeper: string;
  const url = (m = message, c = general) => `/v1/orgs/${orgId}/channels/${c}/messages/${m}/reaction-roles`;
  const react = (c: GriipClient, target: string, emoji: string, add = true, conv = general) =>
    c.req("POST", "/v2/messages", { conversationId: conv, messageId: nextId("r"), cls: "control", sentAt: Date.now(), payload: { type: "reaction", target, emoji, add } });
  const holds = (userId: string, roleId: string) => h.ctx.ws.get<{ assigned_by: string }>("org_role_members", { role_id: roleId, user_id: userId })?.assigned_by ?? null;
  const role = async (name: string, permissions: string[]) => (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name, permissions })).role.id as string;
  const patchRole = async (id: string, change: Record<string, unknown>) => {
    const { roles } = await owner.req("GET", `/v1/orgs/${orgId}/roles`);
    return owner.req("PATCH", `/v1/roles/${id}`, { ...change, baseRev: roles.find((r: { id: string }) => r.id === id).rev });
  };

  beforeAll(async () => {
    h = await startServer({ ...env });
    [owner, assigner, member, other] = await Promise.all(["rrowner", "rrassigner", "rrmember", "rrother"].map((x) => h.client(x)));
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Role Call" })).org.id;
    const invite = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 20 })).invite.code;
    for (const c of [assigner, member, other]) await c.req("POST", "/v1/invites/accept", { code: invite });
    gamer = await role("Gamer", []);
    artist = await role("Artist", ["messages.bypass_slowmode"]);
    mod = await role("Mod", ["members.ban"]);
    emojiKeeper = await role("Emoji keeper", ["expressions.manage"]);
    const roleAssigner = await role("Role assigner", ["roles.assign", "roles.view", "messages.bypass_slowmode"]);
    await owner.req("PUT", `/v1/roles/${roleAssigner}/members/${assigner.userId}`);
    general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "roles" })).channel.id;
    offtopic = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "offtopic" })).channel.id;
    message = (await owner.req("POST", "/v2/messages", { conversationId: general, messageId: nextId("m"), cls: "message", sentAt: Date.now(), payload: { type: "text", text: "Pick your roles!" } })).messageId;
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("is advertised and starts empty for anyone in the channel", async () => {
    expect((await member.req("GET", "/v1/server-info")).features).toContain("reaction-roles");
    expect(await member.req("GET", url())).toEqual({ messageId: message, channelId: general, reactionRoles: [], setBy: null, setAt: null });
  });

  it("is set by holders of roles.assign, only with roles they could give and no admin powers", async () => {
    const body = { reactionRoles: [{ emoji: "🎮", roleId: gamer }, { emoji: "🎨", roleId: artist }] };
    expect(code(await expectStatus(member.req("PUT", url(), body), 403))).toBe("forbidden");
    for (const roleId of [mod, emojiKeeper]) {
      const refused = await expectStatus(assigner.req("PUT", url(), { reactionRoles: [{ emoji: "🛡️", roleId }] }), 403);
      expect(refused.error).toMatchObject({ code: "reaction_role_not_givable", details: { roleId } });
    }
    // Owners can't give admin powers this way either.
    expect(code(await expectStatus(owner.req("PUT", url(), { reactionRoles: [{ emoji: "🛡️", roleId: mod }] }), 403))).toBe("reaction_role_not_givable");
    expect(code(await expectStatus(assigner.req("PUT", url(), { reactionRoles: [{ emoji: "🎮", roleId: gamer }, { emoji: "🎮", roleId: artist }] }), 400))).toBe("bad_request");
    expect(code(await expectStatus(assigner.req("PUT", url("m_nowhere"), body), 404))).toBe("not_found");
    expect(code(await expectStatus(assigner.req("PUT", url(message, offtopic), body), 404))).toBe("not_found");
    const v = await assigner.req("PUT", url(), body);
    expect(ReactionRolesView.safeParse(v).success).toBe(true);
    expect(v.reactionRoles).toEqual([
      { emoji: "🎮", roleId: gamer, roleName: "Gamer", roleColor: null },
      { emoji: "🎨", roleId: artist, roleName: "Artist", roleColor: null },
    ]);
    expect(v.setBy).toBe(assigner.userId);
    expect((await member.req("GET", url())).reactionRoles).toHaveLength(2);
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "reaction_roles.set", target: message })).toBe(1);
  });

  it("gives the role on reacting and takes it back when the reaction comes off", async () => {
    await react(member, message, "🎮");
    expect(holds(member.userId, gamer)).toBe("reaction_roles");
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "role.assign", target: `${gamer}:${member.userId}` })).toBe(1);
    await react(member, message, "👍");
    expect(h.ctx.ws.count("org_role_members", { user_id: member.userId })).toBe(1);
    await react(member, message, "🎮", false);
    expect(holds(member.userId, gamer)).toBeNull();
    expect(h.ctx.ws.count("audit_log", { org_id: orgId, action: "role.unassign", target: `${gamer}:${member.userId}` })).toBe(1);
  });

  it("never takes back a role someone gave by hand", async () => {
    await owner.req("PUT", `/v1/roles/${artist}/members/${member.userId}`);
    await react(member, message, "🎨");
    await react(member, message, "🎨", false);
    expect(holds(member.userId, artist)).toBe(owner.userId);
    await owner.req("DELETE", `/v1/roles/${artist}/members/${member.userId}`);
  });

  it("only counts reactions in the message's own channel", async () => {
    await react(other, message, "🎮", true, offtopic);
    expect(holds(other.userId, gamer)).toBeNull();
  });

  it("refuses timed-out members' reactions, so they get nothing", async () => {
    await owner.req("PUT", `/v1/orgs/${orgId}/members/${other.userId}/timeout`, { until: Date.now() + 3_600_000 });
    expect(code(await expectStatus(react(other, message, "🎮"), 403))).toBe("timed_out");
    expect(holds(other.userId, gamer)).toBeNull();
    await owner.req("PUT", `/v1/orgs/${orgId}/members/${other.userId}/timeout`, { until: null });
  });

  it("stops giving a role that gained an administrative power", async () => {
    await patchRole(gamer, { permissions: ["members.timeout"] });
    await react(other, message, "🎮");
    expect(holds(other.userId, gamer)).toBeNull();
    await patchRole(gamer, { permissions: [] });
    await react(other, message, "🎮", false);
  });

  it("goes with a deleted role, and with a deleted message", async () => {
    await patchRole(artist, { archived: true });
    await owner.req("DELETE", `/v1/roles/${artist}`);
    expect((await member.req("GET", url())).reactionRoles.map((r: { emoji: string }) => r.emoji)).toEqual(["🎮"]);
    await owner.req("POST", "/v2/messages", { conversationId: general, messageId: nextId("d"), cls: "control", sentAt: Date.now(), payload: { type: "delete", target: message } });
    expect(h.ctx.ws.count("reaction_roles", { message_id: message })).toBe(0);
  });

  it("can be removed", async () => {
    const m2 = (await owner.req("POST", "/v2/messages", { conversationId: general, messageId: nextId("m"), cls: "message", sentAt: Date.now(), payload: { type: "text", text: "Again" } })).messageId;
    await assigner.req("PUT", url(m2), { reactionRoles: [{ emoji: "🎮", roleId: gamer }] });
    expect(code(await expectStatus(member.req("DELETE", url(m2)), 403))).toBe("forbidden");
    expect(await assigner.req("DELETE", url(m2))).toEqual({ deleted: true });
    expect(await assigner.req("DELETE", url(m2))).toEqual({ deleted: false });
  });
});

describe("reaction roles switched off (REACTION_ROLES=off)", () => {
  it("aren't advertised, answer 503 and give nothing", async () => {
    const h = await startServer({ REACTION_ROLES: "off" });
    try {
      const owner = await h.client("rroff");
      expect((await owner.req("GET", "/v1/server-info")).features).not.toContain("reaction-roles");
      const orgId = (await owner.req("POST", "/v1/orgs", { name: "No Roles" })).org.id;
      const channel = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "chat" })).channel.id;
      const msg = (await owner.req("POST", "/v2/messages", { conversationId: channel, messageId: nextId("m"), cls: "message", sentAt: Date.now(), payload: { type: "text", text: "hi" } })).messageId;
      expect(code(await expectStatus(owner.req("GET", `/v1/orgs/${orgId}/channels/${channel}/messages/${msg}/reaction-roles`), 503))).toBe("feature_disabled");
    } finally {
      await h.close();
    }
  });
});
