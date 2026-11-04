import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`recipient-only request notes (${backend})`, () => {
    let h: Harness, alice: GriipClient, bob: GriipClient, outsider: GriipClient;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS: backend === "mongodb" ? "relationships" : "",
      });
      [alice, bob, outsider] = await Promise.all(
        ["notealice", "notebob", "noteout"].map((n) => h.client(n)),
      );
    });
    afterAll(async () => h?.close());
    const lists = (c: GriipClient) => c.req("GET", "/v1/connections");
    it("returns a note only to its intended recipient and clears it on acceptance", async () => {
      const note = "Hello <script>literal text</script> 😀";
      await alice.req("POST", "/v1/connections", { userId: bob.userId, note });
      expect((await lists(bob)).incoming[0].note).toBe(note);
      expect((await lists(alice)).outgoing[0]).not.toHaveProperty("note");
      expect(JSON.stringify(await lists(outsider))).not.toContain(note);
      await expectStatus(
        outsider.req("POST", `/v1/connections/${alice.userId}/accept`),
        404,
      );
      await bob.req("POST", `/v1/connections/${alice.userId}/accept`);
      expect(
        (await h.ctx.relationships.connection(alice.userId, bob.userId))
          ?.request_note,
      ).toBeNull();
      expect(JSON.stringify(await lists(bob))).not.toContain(note);
      await alice.req("DELETE", `/v1/connections/${bob.userId}`);
    });
    it("retains the first note for duplicate sends and deletes notes on decline/cancel/block", async () => {
      for (const action of ["decline", "cancel", "block"]) {
        await alice.req("POST", "/v1/connections", {
          userId: bob.userId,
          note: "First note",
        });
        await alice.req("POST", "/v1/connections", {
          userId: bob.userId,
          note: "Replacement should be ignored",
        });
        expect((await lists(bob)).incoming[0].note).toBe("First note");
        if (action === "block") {
          await bob.req("POST", "/v1/blocks", { userId: alice.userId });
          await bob.req("DELETE", `/v1/blocks/${alice.userId}`);
        } else
          await (action === "cancel" ? alice : bob).req(
            "DELETE",
            `/v1/connections/${action === "cancel" ? bob.userId : alice.userId}`,
          );
        expect(
          await h.ctx.relationships.connection(alice.userId, bob.userId),
        ).toBeNull();
      }
    });
    it("accepts simultaneous crossed requests without regression or retained notes", async () => {
      await Promise.all([
        alice.req("POST", "/v1/connections", {
          userId: bob.userId,
          note: "Alice note",
        }),
        bob.req("POST", "/v1/connections", {
          userId: alice.userId,
          note: "Bob note",
        }),
      ]);
      expect(
        await h.ctx.relationships.connection(alice.userId, bob.userId),
      ).toMatchObject({ state: "accepted", request_note: null });
      expect((await lists(alice)).connected.map((u: any) => u.id)).toEqual([
        bob.userId,
      ]);
      expect((await lists(bob)).connected.map((u: any) => u.id)).toEqual([
        alice.userId,
      ]);
      await alice.req("DELETE", `/v1/connections/${bob.userId}`);
    });
    it("validates 300 Unicode code points and persists nothing when privacy denies the request", async () => {
      await expectStatus(
        alice.req("POST", "/v1/connections", {
          userId: bob.userId,
          note: "😀".repeat(301),
        }),
        400,
      );
      await bob.req("PUT", "/v1/users/me/messaging", {
        requestPolicy: "nobody",
      });
      await expectStatus(
        alice.req("POST", "/v1/connections", {
          userId: bob.userId,
          note: "Denied note",
        }),
        403,
      );
      expect(
        await h.ctx.relationships.connection(alice.userId, bob.userId),
      ).toBeNull();
      await bob.req("PUT", "/v1/users/me/messaging", {
        requestPolicy: "everyone",
      });
      await alice.req("POST", "/v1/connections", {
        userId: bob.userId,
        note: "😀".repeat(300),
      });
      expect((await lists(bob)).incoming[0].note).toBe("😀".repeat(300));
      await alice.req("DELETE", `/v1/connections/${bob.userId}`);
    });
  });
