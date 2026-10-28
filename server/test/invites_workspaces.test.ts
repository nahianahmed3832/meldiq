import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteEmptyOrg, findDuplicateOrgs, keepReason } from "../src/modules/organizations/orgRepair.js";
import { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

// Physical-device defects (2026-10-16): a valid invite code showed "Unexpected server response" on the joining phone,
// and the person who couldn't join ended up owning five identical "GriipBuddy" workspaces.

let h: Harness;
let owner: GriipClient;
let orgId: string;

const invite = async (by: GriipClient, org: string, body: object = {}) => (await by.req("POST", `/v1/orgs/${org}/invites`, body)).invite;

beforeAll(async () => {
  h = await startServer();
  owner = await h.client("inviteowner");
  orgId = (await owner.req("POST", "/v1/orgs", { name: "GriipBuddy", description: "test" })).org.id;
});
afterAll(async () => h.close());

describe("invite preview and accept (phase 1)", () => {
  it("the preview's org has the same shape as every other org response (id, name, slug)", async () => {
    const joiner = await h.client("previewer");
    const { code } = await invite(owner, orgId);
    const preview = await joiner.req("POST", "/v1/invites/preview", { code });
    // The Android OrgDto requires id, name and slug; without the slug the app rejected a valid code.
    expect(preview.org).toMatchObject({ id: orgId, name: "GriipBuddy", slug: expect.any(String), description: "test" });
    expect(preview.org.slug.length).toBeGreaterThan(0);
    expect(preview.role).toBe("MEMBER");
    expect(preview.alreadyMember).toBe(false);
  });

  it("accepts the code however it was typed: lower case, without dashes, with spaces", async () => {
    const { code } = await invite(owner, orgId, { maxUses: 3 });
    const variants = [code.toLowerCase(), code.replace(/-/g, ""), ` ${code.replace(/-/g, " ")} `];
    for (const v of variants) {
      const c = await h.client("typed");
      expect((await c.req("POST", "/v1/invites/preview", { code: v })).org.id).toBe(orgId);
      const r = await c.req("POST", "/v1/invites/accept", { code: v });
      expect(r.org).toMatchObject({ id: orgId, myRole: "MEMBER" });
    }
  });

  it("says why a code can't be used: unknown, revoked, expired, used up, or its creator lost the right", async () => {
    const c = await h.client("refused");
    const unknown = await expectStatus(c.req("POST", "/v1/invites/preview", { code: "ABCD-EFGH-JKMN" }), 404);
    expect(unknown.error.code).toBe("invite_not_found");

    const revoked = await invite(owner, orgId);
    await owner.req("DELETE", `/v1/invites/${revoked.id}`);
    expect((await expectStatus(c.req("POST", "/v1/invites/accept", { code: revoked.code }), 404)).error.code).toBe("invite_revoked");

    const expired = await invite(owner, orgId);
    await h.ctx.ws.write((w) => w.update("invitations", { id: expired.id }, { expires_at: Date.now() - 1 }));
    const e = await expectStatus(c.req("POST", "/v1/invites/preview", { code: expired.code }), 404);
    expect(e.error.code).toBe("invite_expired");
    expect(e.error.message).toMatch(/expired/i);

    const single = await invite(owner, orgId, { maxUses: 1 });
    await (await h.client("first")).req("POST", "/v1/invites/accept", { code: single.code });
    expect((await expectStatus(c.req("POST", "/v1/invites/accept", { code: single.code }), 404)).error.code).toBe("invite_used_up");

    // An admin's invite stops working once they're no longer an admin (T3.1).
    const admin = await h.client("demoted");
    await admin.req("POST", "/v1/invites/accept", { code: (await invite(owner, orgId, { role: "ADMIN" })).code });
    const byAdmin = await invite(admin, orgId, { role: "MEMBER" });
    await owner.req("PATCH", `/v1/orgs/${orgId}/members/${admin.userId}`, { role: "MEMBER" });
    expect((await expectStatus(c.req("POST", "/v1/invites/accept", { code: byAdmin.code }), 404)).error.code).toBe("invite_unavailable");

    // None of the refusals joined anyone.
    expect((await c.req("GET", "/v1/orgs")).orgs).toHaveLength(0);
  });

  it("needs a signed-in user", async () => {
    const { code } = await invite(owner, orgId);
    const anon = new GriipClient(h.baseUrl, "anon", "Anon");
    await expectStatus(anon.req("POST", "/v1/invites/accept", { code }), 401);
    await expectStatus(anon.req("POST", "/v1/invites/preview", { code }), 401);
  });

  it("a double tap or retry joins once, uses the invite once, and succeeds both times", async () => {
    const inv = await invite(owner, orgId, { maxUses: 1 });
    const c = await h.client("doubletap");
    const [a, b] = await Promise.all([
      c.req("POST", "/v1/invites/accept", { code: inv.code }),
      c.req("POST", "/v1/invites/accept", { code: inv.code }),
    ]);
    expect(a.org.id).toBe(orgId);
    expect(b.org.id).toBe(orgId);
    expect([a.alreadyMember, b.alreadyMember].sort()).toEqual([false, true]);
    // A later retry (the last use is gone) still succeeds for the person who already joined.
    expect((await c.req("POST", "/v1/invites/accept", { code: inv.code })).alreadyMember).toBe(true);
    const row = h.ctx.ws.get<{ uses: number }>("invitations", { id: inv.id })!;
    expect(row.uses).toBe(1);
    const memberships = { n: h.ctx.ws.count("org_members", { org_id: orgId, user_id: c.userId }) };
    expect(memberships.n).toBe(1);
    expect((await c.req("GET", "/v1/orgs")).orgs.map((o: any) => o.id)).toEqual([orgId]);
  });

  it("two people racing for an invite's last use: exactly one joins", async () => {
    const inv = await invite(owner, orgId, { maxUses: 1 });
    const [x, y] = [await h.client("racer"), await h.client("racer")];
    const results = await Promise.allSettled([x.req("POST", "/v1/invites/accept", { code: inv.code }), y.req("POST", "/v1/invites/accept", { code: inv.code })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.body.error.code).toBe("invite_used_up");
  });

  it("an invite that would upgrade a member is not 'already satisfied'", async () => {
    const guest = await h.client("upgraded");
    await guest.req("POST", "/v1/invites/accept", { code: (await invite(owner, orgId, { role: "GUEST" })).code });
    const r = await guest.req("POST", "/v1/invites/accept", { code: (await invite(owner, orgId, { role: "MEMBER" })).code });
    expect(r.alreadyMember).toBe(false);
    expect(r.org.myRole).toBe("MEMBER");
  });

  it("registration with an unusable org invite says why (invite-only servers)", async () => {
    const gated = await startServer({ REGISTRATION_MODE: "invite" });
    try {
      const o = new GriipClient(gated.baseUrl, "gatedowner", "Owner");
      const reg = await (await import("../src/modules/organizations/invites.js")).createRegistrationInvite(gated.ctx.identity, { maxUses: 1, days: 1 });
      await o.register(reg.code);
      const org = (await o.req("POST", "/v1/orgs", { name: "Gated" })).org.id;
      const inv = await invite(o, org);
      await gated.ctx.ws.write((w) => w.update("invitations", { id: inv.id }, { expires_at: Date.now() - 1 }));
      const body = await expectStatus(new GriipClient(gated.baseUrl, "lateperson", "Late").register(inv.code), 403);
      expect(body.error.code).toBe("invalid_invite");
      expect(body.error.message).toMatch(/expired/i);
      expect(body.error.details).toEqual({ reason: "invite_expired" });
    } finally {
      await gated.close();
    }
  });
});

describe("creating a workspace is idempotent (phase 3)", () => {
  it("the same request id returns the same workspace, even for simultaneous taps", async () => {
    const c = await h.client("creator");
    const requestId = "req-" + "a".repeat(20);
    const [a, b] = await Promise.all([
      c.req("POST", "/v1/orgs", { name: "Acme", requestId }),
      c.req("POST", "/v1/orgs", { name: "Acme", requestId }),
    ]);
    expect(a.org.id).toBe(b.org.id);
    const again = await c.req("POST", "/v1/orgs", { name: "Acme", requestId });
    expect(again.org.id).toBe(a.org.id);
    const list = (await c.req("GET", "/v1/orgs")).orgs;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.org.id, name: "Acme", myRole: "OWNER", memberCount: 1 });
  });

  it("refuses a second workspace with a name its owner already uses, pointing at the first", async () => {
    const c = await h.client("samename");
    const first = (await c.req("POST", "/v1/orgs", { name: "GriipBuddy" })).org;
    for (const name of ["GriipBuddy", " griipbuddy "]) {
      const body = await expectStatus(c.req("POST", "/v1/orgs", { name, requestId: crypto.randomUUID() }), 409);
      expect(body.error.code).toBe("org_name_taken");
      expect(body.error.details).toEqual({ orgId: first.id });
    }
    expect((await c.req("GET", "/v1/orgs")).orgs).toHaveLength(1);
    // Other people may use the same name, and the owner may use another one.
    expect((await (await h.client("othersame")).req("POST", "/v1/orgs", { name: "GriipBuddy" })).org.id).not.toBe(first.id);
    await c.req("POST", "/v1/orgs", { name: "GriipBuddy Dhaka" });
    expect((await c.req("GET", "/v1/orgs")).orgs).toHaveLength(2);
  });

  it("an account in one workspace lists exactly one workspace", async () => {
    const c = await h.client("single");
    await c.req("POST", "/v1/orgs", { name: "Solo", requestId: crypto.randomUUID() });
    const lists = await Promise.all([1, 2, 3].map(() => c.req("GET", "/v1/orgs")));
    for (const l of lists) expect(l.orgs.map((o: any) => o.name)).toEqual(["Solo"]);
  });
});

describe("operator repair of existing duplicates (phase 3)", () => {
  it("lists same-name workspaces and removes only provably empty ones", async () => {
    const c = await h.client("legacy");
    const ws = h.ctx.ws;
    // Duplicates as an older server made them (no request id, no name check): insert directly.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `o_legacy${i}`;
      await ws.write((w) => {
        w.insert("orgs", { id, name: "GriipBuddy", slug: `griipbuddy-legacy${i}`, created_by: c.userId, created_at: 1000 + i, updated_at: 1000 + i });
        w.insert("org_members", { org_id: id, user_id: c.userId, role: "OWNER", joined_at: 1000 + i });
      });
      ids.push(id);
    }
    // The first one is in use: someone joined it through an invite.
    const used = await invite(c, ids[0]);
    await (await h.client("colleague")).req("POST", "/v1/invites/accept", { code: used.code });
    // The second has an owner-only channel; the third is completely empty.
    await c.req("POST", `/v1/orgs/${ids[1]}/channels`, { name: "notes", scope: "ORG" });

    const group = (await findDuplicateOrgs(h.ctx)).find((g) => g.ownerId === c.userId)!;
    expect(group.orgs.map((o) => o.id)).toEqual(ids);
    expect(group.orgs.map((o) => o.removable)).toEqual([false, true, true]);
    expect(await keepReason(h.ctx, ids[0])).toMatch(/members|joined/);

    await expect(deleteEmptyOrg(h.ctx, ids[0])).rejects.toThrow(/refusing/);
    await deleteEmptyOrg(h.ctx, ids[2]);
    await deleteEmptyOrg(h.ctx, ids[1]);
    expect(ws.count("conversations", { org_id: ids[1] })).toBe(0);
    expect((await c.req("GET", "/v1/orgs")).orgs.map((o: any) => o.id)).toEqual([ids[0]]);
    expect((await findDuplicateOrgs(h.ctx)).find((g) => g.ownerId === c.userId)).toBeUndefined();
  });
});
