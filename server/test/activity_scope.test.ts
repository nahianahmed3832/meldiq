import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * The activity feed only shows members what they could see themselves (T1.8): channels gated to a role by their
 * category's permissions, private channels and calls stay hidden from everyone else.
 */
let h: Harness;
let owner: GriipClient, inA: GriipClient, inB: GriipClient;
let org: string, roleA: string, roleB: string, channelA: string, channelB: string, privateB: string;

async function gatedCategory(name: string, role: string) {
  const id = (await owner.req("POST", `/v1/orgs/${org}/categories`, { name })).category.id;
  await owner.req("PUT", `/v1/categories/${id}/overwrites`, { subject: "everyone", deny: ["channels.view"] });
  await owner.req("PUT", `/v1/categories/${id}/overwrites`, { subject: role, allow: ["channels.view"] });
  return id;
}

beforeAll(async () => {
  h = await startServer();
  owner = await h.client("actowner");
  inA = await h.client("actina");
  inB = await h.client("actinb");
  org = (await owner.req("POST", "/v1/orgs", { name: "Scope Co" })).org.id;
  roleA = (await owner.req("POST", `/v1/orgs/${org}/roles`, { name: "Dhaka", permissions: [], denies: [] })).role.id;
  roleB = (await owner.req("POST", `/v1/orgs/${org}/roles`, { name: "London", permissions: [], denies: [] })).role.id;
  for (const [c, role] of [
    [inA, roleA],
    [inB, roleB],
  ] as const) {
    const code = (await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER", roleId: role })).invite.code;
    await c.req("POST", "/v1/invites/accept", { code });
  }
  const catA = await gatedCategory("Dhaka", roleA);
  const catB = await gatedCategory("London", roleB);
  channelA = (await owner.req("POST", `/v1/orgs/${org}/channels`, { name: "dhaka-layoff-planning", categoryId: catA, voice: true })).channel.id;
  channelB = (await owner.req("POST", `/v1/orgs/${org}/channels`, { name: "london-sales", categoryId: catB })).channel.id;
  privateB = (await owner.req("POST", `/v1/orgs/${org}/channels`, { name: "london-board", categoryId: catB, kind: "PRIVATE" })).channel.id;
  await owner.req("POST", "/v1/calls", { conversationId: channelA });
});
afterAll(async () => h.close());

const feed = async (who: GriipClient) => (await who.req("GET", `/v1/orgs/${org}/activity`)).activity as { action: string; target: string; detail: string }[];
const targets = (items: { target: string }[]) => items.map((a) => a.target);
const text = (items: unknown[]) => JSON.stringify(items);

describe("activity feed respects channel visibility (T1.8)", () => {
  it("a member without the role sees nothing about the gated channels or their calls", async () => {
    const mine = await feed(inB);
    expect(text(mine)).not.toContain("dhaka-layoff-planning");
    expect(targets(mine)).not.toContain(channelA);
    expect(mine.some((a) => a.action === "voice_room.open")).toBe(false);
    // Their own channels and community-level events are still shown.
    expect(targets(mine)).toContain(channelB);
    expect(mine.some((a) => a.action === "invite.accept")).toBe(true);
    // A private channel in their own category they aren't in stays hidden too.
    expect(targets(mine)).not.toContain(privateB);
  });

  it("a member with the role sees its channel and the call in it", async () => {
    const mine = await feed(inA);
    expect(targets(mine)).toContain(channelA);
    expect(mine.some((a) => a.action === "voice_room.open" && a.target === channelA)).toBe(true);
    expect(targets(mine)).not.toContain(channelB);
  });

  it("owners still see everything", async () => {
    expect(targets(await feed(owner))).toEqual(expect.arrayContaining([channelA, channelB, privateB]));
  });

  it("hides older branch and team rows, and rows whose target is gone", async () => {
    await h.ctx.ws.write((w) => {
      w.insert("audit_log", { at: Date.now(), actor_id: owner.userId, org_id: org, action: "team.create", target: "t_old", detail: "Old Row Team" });
      w.insert("audit_log", { at: Date.now(), actor_id: owner.userId, org_id: org, action: "channel.create", target: "c_deleted", detail: "PUBLIC Deleted Channel" });
    });
    const mine = await feed(inA);
    expect(text(mine)).not.toContain("Old Row Team");
    expect(text(mine)).not.toContain("Deleted Channel");
  });
});
