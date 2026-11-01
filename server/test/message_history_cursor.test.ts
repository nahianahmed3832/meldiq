import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

for (const backend of ["sqlite", "mongodb"] as const) {
  describe(`ordered message cursors (${backend})`, () => {
    let h: Harness;
    let alice: GriipClient, outsider: GriipClient;
    let dm: string;
    const id = (n: number) => `tie_message_${String(n).padStart(4, "0")}`;
    const ts = 1_700_000_000_000;
    beforeAll(async () => {
      h = await startServer({ MONGODB_DOMAINS: backend === "mongodb" ? "history" : "" });
      alice = await h.client("cursoralice");
      const bob = await h.client("cursorbob");
      outsider = await h.client("cursoroutside");
      dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
      await h.ctx.messages.addMany(Array.from({ length: 125 }, (_, n) => ({
        id: id(n), conversation_id: dm, sender_user_id: bob.userId, sender_device_id: null,
        cls: "message" as const, type: "text", target: null, audience: "all" as const,
        payload: JSON.stringify({ type: "text", text: id(n) }), sent_at: ts, server_ts: ts,
        mention_all: 0 as const, imported_by: null,
      })));
    });
    afterAll(async () => h?.close());

    it("pages every timestamp tie exactly once while newer writes arrive", async () => {
      const found: string[] = [];
      let query = "limit=17";
      for (let n = 0; n < 20; n++) {
        const page = await alice.req("GET", `/v2/conversations/${dm}/messages?${query}`);
        found.push(...page.messages.map((m: { id: string }) => m.id));
        if (!page.more) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        const cursor = page.nextCursor;
        expect(cursor).toEqual({ serverTs: ts, id: page.messages.at(-1).id });
        query = `limit=17&before=${cursor.serverTs}&beforeId=${cursor.id}`;
        if (n === 0) {
          const template = (await h.ctx.messages.get(id(0)))!;
          await h.ctx.messages.add({ ...template, id: "new_message_after_page", server_ts: ts + 1 });
        }
      }
      expect(found).toEqual(Array.from({ length: 125 }, (_, n) => id(124 - n)));
      expect(new Set(found).size).toBe(125);
    });

    it("puts equal-time neighbors on the correct sides of an around window", async () => {
      const page = await alice.req("GET", `/v2/conversations/${dm}/messages?around=${id(60)}&limit=4`);
      expect(page.messages.map((m: { id: string }) => m.id)).toEqual([62, 61, 60, 59, 58].map(id));
      expect(page.nextCursor).toEqual({ serverTs: ts, id: id(58) });
      const older = await alice.req("GET", `/v2/conversations/${dm}/messages?before=${ts}&beforeId=${id(58)}&limit=2`);
      expect(older.messages.map((m: { id: string }) => m.id)).toEqual([57, 56].map(id));
    });

    it("keeps legacy timestamps valid and checks membership and cursor shape", async () => {
      expect((await alice.req("GET", `/v2/conversations/${dm}/messages?before=${ts}&limit=2`)).messages).toEqual([]);
      await expectStatus(outsider.req("GET", `/v2/conversations/${dm}/messages?before=${ts}&beforeId=${id(60)}`), 404);
      await expectStatus(alice.req("GET", `/v2/conversations/${dm}/messages?beforeId=${id(60)}`), 400);
      await expectStatus(alice.req("GET", `/v2/conversations/${dm}/messages?around=${id(60)}&before=${ts}&beforeId=${id(60)}`), 400);
    });
  });
}
