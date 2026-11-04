import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SearchResponse } from "../src/shared/contracts/http/serverMessages.js";
import type { MessageEvent } from "../src/modules/messaging/store/messageStore.js";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

const backends = process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"];
for (const backend of backends)
  describe(`filtered message search (${backend})`, () => {
    let h: Harness,
      alice: GriipClient,
      bob: GriipClient,
      outsider: GriipClient,
      cid: string,
      hidden: string;
    const at = Date.now() - 1000000;
    const get = async (query: string, user = bob) => {
      const result = await user.req("GET", `/v2/messages/search?${query}`);
      expect(SearchResponse.safeParse(result).success).toBe(true);
      return result;
    };
    const ids = (p: any) => p.messages.map((m: { id: string }) => m.id);
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS: backend === "mongodb" ? "history" : "",
      });
      [alice, bob, outsider] = await Promise.all(
        ["searchalice", "searchbob", "searchoutsider"].map((n) => h.client(n)),
      );
      cid = (
        await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })
      ).conversation.id;
      hidden = (
        await alice.req("POST", "/v1/conversations/dm", {
          userId: outsider.userId,
        })
      ).conversation.id;
      const event = (
        id: string,
        ts: number,
        payload: object,
        extra: Partial<MessageEvent> = {},
      ): MessageEvent => ({
        id,
        conversation_id: cid,
        sender_user_id: alice.userId,
        sender_device_id: null,
        cls: "message",
        type: "text",
        target: null,
        audience: "all",
        payload: JSON.stringify(payload),
        sent_at: ts,
        server_ts: ts,
        mention_all: 0,
        imported_by: null,
        ...extra,
      });
      const text = (value: string, extra = {}) => ({
        type: "text",
        text: value,
        ...extra,
      });
      const events = Array.from({ length: 180 }, (_, i) =>
        event(
          `search_${String(i).padStart(4, "0")}`,
          at + 1000,
          text(`ordinary ${i}`),
        ),
      );
      for (let i = 0; i < 17; i++)
        events.push(
          event(
            `matching_${String(i).padStart(4, "0")}`,
            at + 10,
            text("older needle https://example.test", {
              attachments: [{ mime: "image/png" }],
              mentions: [bob.userId],
            }),
          ),
        );
      events.push(event("edited_message", at + 20, text("obsolete text")));
      events.push(
        event(
          "edit_control",
          at + 21,
          {
            type: "edit",
            target: "edited_message",
            text: "current needle",
            mentions: [bob.userId],
          },
          { cls: "control", type: "edit", target: "edited_message" },
        ),
      );
      events.push(event("deleted_message", at + 30, text("deleted needle")));
      events.push(
        event(
          "delete_control",
          at + 31,
          { type: "delete", target: "deleted_message" },
          { cls: "control", type: "delete", target: "deleted_message" },
        ),
      );
      events.push(
        event(
          "pin_control",
          at + 40,
          { type: "pin", target: "edited_message", pinned: true },
          { cls: "control", type: "pin", target: "edited_message" },
        ),
      );
      events.push(
        event("hidden_message", at + 50, text("secret needle"), {
          conversation_id: hidden,
        }),
      );
      events.push(
        event(
          "foreign_control",
          at + 51,
          {
            type: "edit",
            target: "edited_message",
            text: "private foreign control",
          },
          {
            conversation_id: hidden,
            cls: "control",
            type: "edit",
            target: "edited_message",
          },
        ),
      );
      events.push(
        event("self_only_message", at + 60, text("self needle"), {
          audience: "self",
        }),
      );
      events.push(
        event(
          "voice_message",
          at + 70,
          text("", { attachments: [{ mime: "audio/ogg", voice: true }] }),
        ),
      );
      events.push(
        event(
          "pdf_message",
          at + 80,
          text("a document", { attachments: [{ mime: "application/pdf" }] }),
        ),
      );
      events.push({
        ...event("bad_json_message", at + 90, {}),
        payload: "broken historical JSON",
      });
      await h.ctx.messages.addMany(events);
    });
    afterAll(async () => h?.close());

    it("filters historical candidates before the page limit and pages equal timestamps without repeats", async () => {
      const found: string[] = [];
      let cursor = "";
      do {
        const page = await get(
          `q=needle&has=image,link&mentions=me&limit=6${cursor}`,
        );
        expect(page.messages).toHaveLength(page.more ? 6 : 5);
        found.push(...ids(page));
        cursor = page.nextCursor
          ? `&cursorTs=${page.nextCursor.serverTs}&cursorId=${page.nextCursor.id}`
          : "";
        expect(page.more).toBe(!!page.nextCursor);
      } while (cursor);
      expect(found).toEqual(
        Array.from(
          { length: 17 },
          (_, i) => `matching_${String(16 - i).padStart(4, "0")}`,
        ),
      );
      expect(new Set(found).size).toBe(17);
    });
    it("searches current edited text, excludes deleted/private content, and returns only scoped changes", async () => {
      expect(ids(await get("q=obsolete"))).toEqual([]);
      const page = await get("q=current&pinned=true");
      expect(ids(page)).toEqual(["edited_message"]);
      expect(page.changes.map((m: any) => m.id)).toEqual([
        "edit_control",
        "pin_control",
      ]);
      expect(ids(await get("q=secret"))).toEqual([]);
      expect(ids(await get("q=self"))).toEqual([]);
      expect(ids(await get("q=self", alice))).toEqual(["self_only_message"]);
      await expectStatus(
        bob.req("GET", `/v2/messages/search?q=needle&conversationId=${hidden}`),
        404,
      );
      expect(ids(await get("q=needle", outsider))).toEqual(["hidden_message"]);
    });
    it("supports filter-only sender, attachment and half-open date ranges", async () => {
      expect(ids(await get(`from=${alice.username}&has=file`))).toEqual([
        "pdf_message",
      ]);
      expect(ids(await get("from=me&has=file"))).toEqual([]);
      expect(ids(await get(`after=${at + 20}&before=${at + 21}`))).toEqual([
        "edited_message",
      ]);
      expect(ids(await get(`after=${at + 21}&before=${at + 20}`))).toEqual([]);
      expect(ids(await get("has=video"))).toEqual([]);
      expect(ids(await get("mentions=me&pinned=true"))).toEqual([
        "edited_message",
      ]);
    });
    it("rejects malformed filters/cursors and does not reveal a forbidden community scope", async () => {
      for (const query of [
        "",
        "q=x&cursorTs=100",
        "has=unknown",
        "pinned=maybe",
        "before=NaN",
        "q=x&limit=101",
      ])
        await expectStatus(bob.req("GET", `/v2/messages/search?${query}`), 400);
      await expectStatus(
        bob.req("GET", "/v2/messages/search?q=x&orgId=org_unknown"),
        404,
      );
    });
    it("applies current suspension and history boundaries before matching and pagination", async () => {
      const deny = vi
        .spyOn(h.ctx.authz, "isMember")
        .mockImplementation(() => false);
      try {
        expect(ids(await get("q=needle"))).toEqual([]);
      } finally {
        deny.mockRestore();
      }
      const since = vi
        .spyOn(h.ctx.authz, "historySince")
        .mockReturnValue(at + 100);
      try {
        expect(ids(await get("q=needle"))).toEqual([]);
      } finally {
        since.mockRestore();
      }
    });
  });
