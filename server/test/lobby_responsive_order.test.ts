import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`responsive lobby order (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS:
          backend === "mongodb" ? "workspace,conversations,files,calls" : "",
      });
    });
    afterAll(async () => h?.close());
    it("preserves independent orders on partial saves, validates complete keys and permissions, rejects stale writes and explicitly links orders", async () => {
      expect(
        (
          await (
            await h.client("lobbycapability")
          ).req("GET", "/v1/server-info")
        ).features,
      ).toContain("lobby-responsive-order");
      const owner = await h.client("lobbyorder"),
        member = await h.client("lobbyreader");
      const org = (
        await owner.req("POST", "/v1/orgs", {
          name: "Responsive order fixture",
        })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      const path = `/v1/orgs/${org}/lobby/settings`;
      let state = await owner.req("GET", path);
      const initial = state.settings.sections.map((s: any) => s.key);
      await expectStatus(
        member.req("PUT", path, { rev: 0, phoneOrder: [...initial].reverse() }),
        403,
      );
      for (const phoneOrder of [
        [],
        [...initial.slice(1), initial[1]],
        [...initial.slice(1), "foreign_card"],
      ])
        await expectStatus(owner.req("PUT", path, { rev: 0, phoneOrder }), 400);
      state = await owner.req("PUT", path, {
        rev: state.rev,
        sections: [...state.settings.sections].reverse(),
      });
      expect(state.settings.phoneOrder).toEqual(initial);
      const desktop = state.settings.sections;
      const phone = [...initial.slice(1), initial[0]];
      state = await owner.req("PUT", path, {
        rev: state.rev,
        phoneOrder: phone,
      });
      expect(state.settings.sections).toEqual(desktop);
      await expectStatus(
        owner.req("PUT", path, { rev: state.rev - 1, phoneOrder: initial }),
        409,
      );
      // An older client's unrelated edit omits both new fields.
      state = await owner.req("PUT", path, {
        rev: state.rev,
        about: "Independent layout fixture",
      });
      expect(state.settings.phoneOrder).toEqual(phone);
      state = await owner.req("PUT", path, {
        rev: state.rev,
        ordersLinked: true,
      });
      expect(state.settings.ordersLinked).toBe(true);
      expect((await member.req("GET", path)).settings.sections).toEqual(
        desktop,
      );
      state = await owner.req("PUT", path, {
        rev: state.rev,
        ordersLinked: false,
        phoneOrder: desktop.map((s: any) => s.key),
      });
      expect(state.settings.phoneOrder).toEqual(desktop.map((s: any) => s.key));
      expect(state.settings.ordersLinked).toBe(false);
    });
  });
