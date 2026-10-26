import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Adding existing accounts to a community directly (community-first brief §F): only people the adder knows who'd accept
 * a direct message from them; the server enforces who may add; strangers, blocks and bans all look the same.
 */
let h: Harness;
let owner: GriipClient, friend: GriipClient, stranger: GriipClient, blocker: GriipClient, choosy: GriipClient, banned: GriipClient, guest: GriipClient, outsider: GriipClient;
let orgId: string;

const add = (by: GriipClient, userIds: string[], org = orgId) => by.req("POST", `/v1/orgs/${org}/members`, { userIds });
const outcome = async (by: GriipClient, who: GriipClient) => (await add(by, [who.userId])).results[0].outcome;
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 0;
  }
};
const memberIds = async () => ((await owner.req("GET", `/v1/orgs/${orgId}/members`)).members as { id?: string; userId?: string }[]).map((m) => m.userId ?? m.id);

beforeAll(async () => {
  h = await startServer();
  [owner, friend, stranger, blocker, choosy, banned, guest, outsider] = await Promise.all(["maowner", "mafriend", "mastranger", "mablocker", "machoosy", "mabanned", "maguest", "maoutsider"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Adders Club" })).org.id;
  // People the owner knows: a DM with each, except the stranger.
  for (const c of [friend, blocker, choosy, banned]) await owner.req("POST", "/v1/conversations/dm", { userId: c.userId });
  await blocker.req("POST", "/v1/blocks", { userId: owner.userId });
  await choosy.req("PUT", "/v1/users/me/messaging", { dmPolicy: "connections" });
  const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "GUEST" })).invite.code;
  await guest.req("POST", "/v1/invites/accept", { code });
  await friend.connect();
});
afterAll(async () => h.close());

describe("adding members directly", () => {
  it("adds someone the owner knows; they're told at once and are a member", async () => {
    const from = friend.events.length;
    expect(await outcome(owner, friend)).toBe("added");
    await friend.waitFor(() => friend.events.slice(from).find((e) => e.t === "org.updated" && e.orgId === orgId));
    expect(await memberIds()).toContain(friend.userId);
    expect((await friend.req("GET", "/v1/orgs")).orgs.map((o: { id: string }) => o.id)).toContain(orgId);
  });

  it("says already_member for a member, once per person however often they're listed", async () => {
    const r = await add(owner, [friend.userId, friend.userId]);
    expect(r.results).toEqual([{ userId: friend.userId, outcome: "already_member" }]);
  });

  it("refuses strangers, people who blocked the adder and people whose settings want a request, all alike", async () => {
    expect(await outcome(owner, stranger)).toBe("not_available");
    expect(await outcome(owner, blocker)).toBe("not_available");
    expect(await outcome(owner, choosy)).toBe("not_available");
    expect(await outcome(owner, owner)).toBe("already_member");
    const r = await add(owner, ["u_doesnotexist"]);
    expect(r.results[0].outcome).toBe("not_available");
    const members = await memberIds();
    for (const c of [stranger, blocker, choosy]) expect(members).not.toContain(c.userId);
  });

  it("refuses someone banned from the community", async () => {
    await owner.req("POST", `/v1/orgs/${orgId}/bans`, { userId: banned.userId });
    expect(await outcome(owner, banned)).toBe("not_available");
  });

  it("enforces who may add on the server: guests and outsiders can't", async () => {
    expect(await status(add(guest, [stranger.userId]))).toBe(403);
    expect([403, 404]).toContain(await status(add(outsider, [friend.userId])));
  });

  it("is refused while the community has paused new members", async () => {
    await owner.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: Date.now() + 3_600_000 });
    expect(await status(add(owner, [stranger.userId]))).toBe(403);
    await owner.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: null });
  });

  it("validates the request: at least one and at most twenty people", async () => {
    // Checked before anything else, from a device with requests to spare (limits are per device).
    expect(await status(add(stranger, []))).toBe(400);
    expect(await status(add(stranger, Array.from({ length: 21 }, (_, i) => `u_${i}`)))).toBe(400);
  });

  it("limits each device to ten requests a minute", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push(await status(add(outsider, [friend.userId])));
    expect(codes.at(-1)).toBe(429);
  });

  it("records each addition in the audit log", () => {
    const rows = h.ctx.db.prepare("SELECT target FROM audit_log WHERE org_id = ? AND action = 'member.add'").all(orgId) as { target: string }[];
    expect(rows.map((r) => r.target)).toEqual([friend.userId]);
  });
});
