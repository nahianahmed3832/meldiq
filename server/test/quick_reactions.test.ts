import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`quick reaction preferences (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS: backend === "mongodb" ? "preferences" : "",
      });
    });
    afterAll(async () => h?.close());
    it("persists 3–5 distinct choices, preserves older client omissions, isolates accounts and rejects stale writes", async () => {
      const alice = await h.client("quickalice"),
        bob = await h.client("quickbob");
      const base = await alice.req("GET", "/v1/me/preferences/personal");
      const path = "/v1/me/preferences/personal";
      const choices = ["✅", "🔥", "🙏"];
      const saved = await alice.req("PUT", path, {
        baseRev: base.rev,
        prefs: { quickReactions: choices },
      });
      expect(saved.prefs.quickReactions).toEqual(choices);
      expect((await bob.req("GET", path)).prefs.quickReactions).toBeUndefined();
      expect((await alice.req("GET", path)).prefs.quickReactions).toEqual(
        choices,
      );
      const old = await alice.req("PUT", path, {
        baseRev: saved.rev,
        prefs: {},
      });
      expect(old.prefs.quickReactions).toEqual(choices);
      await expectStatus(
        alice.req("PUT", path, {
          baseRev: saved.rev,
          prefs: { quickReactions: ["👍", "❤️", "😂"] },
        }),
        409,
      );
      for (const values of [
        ["👍"],
        ["👍", "👍", "❤️"],
        ["bad", "👍", "❤️"],
        ["👍", "❤️", "✅", "😂", "🔥", "🙏"],
      ])
        await expectStatus(
          alice.req("PUT", path, {
            baseRev: old.rev,
            prefs: { quickReactions: values },
          }),
          400,
        );
      const org = (
        await alice.req("POST", "/v1/orgs", { name: "Quick fixture" })
      ).org.id;
      await expectStatus(
        alice.req("PUT", `/v1/me/preferences/${org}`, {
          baseRev: 0,
          prefs: { quickReactions: choices },
        }),
        400,
      );
    });
  });
