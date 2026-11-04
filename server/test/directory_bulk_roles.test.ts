import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`member directory and atomic selection (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS:
          backend === "mongodb" ? "workspace,conversations,files,calls" : "",
      });
    });
    afterAll(async () => h?.close());
    it("filters before deterministic paging and reports true totals; validates every bulk target before any change", async () => {
      const owner = await h.client("directoryowner"),
        manager = await h.client("directorymanager"),
        higher = await h.client("directoryhigher"),
        outsider = await h.client("directoryoutside"),
        guest = await h.client("directoryguest");
      const org = (
        await owner.req("POST", "/v1/orgs", {
          name: "Directory acceptance fixture",
        })
      ).org.id;
      const invite = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, {
          role: "MEMBER",
          maxUses: 30,
        })
      ).invite.code;
      const members = [];
      for (let i = 0; i < 12; i++) {
        const client = await h.client(`directory${i}`, "Page Person");
        await client.req("POST", "/v1/invites/accept", { code: invite });
        members.push(client);
      }
      for (const client of [manager, higher])
        await client.req("POST", "/v1/invites/accept", { code: invite });
      const guestCode = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "GUEST" })
      ).invite.code;
      await guest.req("POST", "/v1/invites/accept", { code: guestCode });
      const path = `/v1/orgs/${org}/members`;
      const ids: string[] = [];
      let after: string | null = null,
        firstCursor = "";
      do {
        const page = await owner.req(
          "GET",
          `${path}?q=Page&limit=3${after ? `&after=${after}` : ""}`,
        );
        expect(page.total).toBe(12);
        expect(page.ownerCount).toBe(1);
        expect(page.members).toHaveLength(3);
        ids.push(...page.members.map((m: any) => m.id));
        after = page.nextAfter;
        if (!firstCursor) firstCursor = after!;
      } while (after);
      expect(new Set(ids).size).toBe(12);
      expect(new Set(ids)).toEqual(new Set(members.map((m) => m.userId)));
      await expectStatus(
        owner.req("GET", `${path}?q=Other&after=${firstCursor}`),
        400,
      );
      await expectStatus(guest.req("GET", path), 403);
      await expectStatus(outsider.req("GET", path), 404);
      expect((await owner.req("GET", `${path}?role=GUEST&limit=3`)).total).toBe(
        1,
      );
      const role = (
        await owner.req("POST", `/v1/orgs/${org}/roles`, {
          name: "Selected role",
          permissions: [],
        })
      ).role;
      const delegate = (
        await owner.req("POST", `/v1/orgs/${org}/roles`, {
          name: "Assign lower roles",
          permissions: ["roles.assign"],
        })
      ).role;
      const strong = (
        await owner.req("POST", `/v1/orgs/${org}/roles`, {
          name: "Higher capability",
          permissions: ["channels.manage"],
        })
      ).role;
      await owner.req(
        "PUT",
        `/v1/roles/${delegate.id}/members/${manager.userId}`,
      );
      await owner.req("PUT", `/v1/roles/${strong.id}/members/${higher.userId}`);
      const bulk = `/v1/roles/${role.id}/members/bulk`,
        chosen = members.slice(0, 2).map((m) => m.userId);
      await expectStatus(
        owner.req("POST", bulk, {
          userIds: [chosen[0], owner.userId],
          add: true,
        }),
        403,
      );
      expect(h.ctx.ws.count("org_role_members", { role_id: role.id })).toBe(0);
      await expectStatus(
        manager.req("POST", bulk, {
          userIds: [chosen[0], higher.userId],
          add: true,
        }),
        403,
      );
      expect(h.ctx.ws.count("org_role_members", { role_id: role.id })).toBe(0);
      await expectStatus(
        owner.req("POST", bulk, {
          userIds: [chosen[0], outsider.userId],
          add: true,
        }),
        404,
      );
      await expectStatus(
        owner.req("POST", bulk, { userIds: [chosen[0], chosen[0]], add: true }),
        400,
      );
      await expectStatus(
        owner.req("POST", bulk, {
          userIds: Array.from({ length: 51 }, (_, i) => `fake_${i}`),
          add: true,
        }),
        400,
      );
      expect(
        (await manager.req("POST", bulk, { userIds: chosen, add: true }))
          .changed,
      ).toEqual(chosen);
      expect(
        (await manager.req("POST", bulk, { userIds: chosen, add: true }))
          .changed,
      ).toEqual([]);
      await vi.waitFor(() =>
        expect(
          h.ctx.ws.count("audit_log", { org_id: org, action: "role.assign" }),
        ).toBe(4),
      );
      const filtered = await owner.req(
        "GET",
        `${path}?roleId=${role.id}&limit=1`,
      );
      expect(filtered.total).toBe(2);
      expect(filtered.members).toHaveLength(1);
      expect(filtered.nextAfter).toBeTruthy();
      await owner.req(
        "DELETE",
        `/v1/roles/${delegate.id}/members/${manager.userId}`,
      );
      await expectStatus(
        manager.req("POST", bulk, { userIds: chosen, add: false }),
        403,
      );
      expect(
        (await owner.req("POST", bulk, { userIds: chosen, add: false }))
          .changed,
      ).toEqual(chosen);
      expect((await owner.req("GET", `${path}?roleId=${role.id}`)).total).toBe(
        0,
      );
    }, 60000);
  });
