import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessageEvent } from "../src/modules/messaging/store/messageStore.js";
import { CollectionResponse } from "../src/shared/contracts/http/messageCollections.js";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`authoritative forum pages (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS: backend === "mongodb" ? "history" : "",
      });
    });
    afterAll(async () => h?.close());
    it("pages all roots, uses visible reply activity and current edited tags/text, and never exposes private/deleted roots", async () => {
      const owner = await h.client("forumowner"),
        member = await h.client("forummember"),
        outsider = await h.client("forumoutside");
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Forum fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      const cid = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "forum",
          format: "forum",
          scope: "ORG",
        })
      ).channel.id;
      const at = Date.now() - 100000;
      const event = (
        id: string,
        ts: number,
        payload: object,
        extra: Partial<MessageEvent> = {},
      ): MessageEvent => ({
        id,
        conversation_id: cid,
        sender_user_id: owner.userId,
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
      const events = Array.from({ length: 61 }, (_, i) =>
        event(`forumroot_${String(i).padStart(4, "0")}`, at + 100, {
          type: "text",
          text: `Root ${i}`,
          title: `Title ${i}`,
          tags: ["tag_one"],
        }),
      );
      events.push(
        event("root_bumped", at, {
          type: "text",
          text: "old root",
          tags: ["old_tag"],
        }),
      );
      events.push(
        event(
          "edit_bumped",
          at + 1,
          {
            type: "edit",
            target: "root_bumped",
            text: "edited root",
            title: "Current title",
            tags: ["tag_one", "tag_two"],
          },
          { cls: "control", type: "edit", target: "root_bumped" },
        ),
      );
      events.push(
        event(
          "edit_text_later",
          at + 2,
          { type: "edit", target: "root_bumped", text: "Later body" },
          { cls: "control", type: "edit", target: "root_bumped" },
        ),
      );
      events.push(
        event("reply_to_bumped", at + 500, {
          type: "text",
          text: "visible reply",
          threadRoot: "root_bumped",
        }),
      );
      events.push(
        event("deleted_reply", at + 700, {
          type: "text",
          text: "deleted reply",
          threadRoot: "root_bumped",
        }),
      );
      events.push(
        event(
          "delete_the_reply",
          at + 701,
          { type: "delete", target: "deleted_reply" },
          { cls: "control", type: "delete", target: "deleted_reply" },
        ),
      );
      events.push(
        event(
          "private_reply",
          at + 900,
          { type: "text", text: "private reply", threadRoot: "root_bumped" },
          { audience: "self" },
        ),
      );
      events.push(
        event(
          "private_root",
          at + 800,
          { type: "text", text: "private root" },
          { audience: "self" },
        ),
      );
      events.push(
        event("deleted_root", at + 1000, {
          type: "text",
          text: "deleted root",
        }),
      );
      events.push(
        event(
          "delete_the_root",
          at + 1001,
          { type: "delete", target: "deleted_root" },
          { cls: "control", type: "delete", target: "deleted_root" },
        ),
      );
      events.push({
        ...event("bad_forum_json", at + 1002, {}),
        payload: "malformed",
      });
      await h.ctx.messages.addMany(events);
      const path = `/v2/conversations/${cid}/message-collections`;
      const read = async (q: string) => {
        const p = await member.req("GET", `${path}?kind=forum&${q}`);
        expect(CollectionResponse.safeParse(p).success).toBe(true);
        return p;
      };
      const first = await read("limit=50&sort=latest");
      expect(first.messages).toHaveLength(50);
      expect(first.messages[0].id).toBe("root_bumped");
      expect(first.threads[0]).toEqual({
        rootId: "root_bumped",
        replyCount: 1,
        lastReplyTs: at + 500,
      });
      const next = await read(
        `limit=50&sort=latest&before=${first.nextCursor.serverTs}&beforeId=${first.nextCursor.id}`,
      );
      expect(next.messages).toHaveLength(12);
      expect(next.more).toBe(false);
      expect(
        new Set([...first.messages, ...next.messages].map((m) => m.id)).size,
      ).toBe(62);
      expect((await read("sort=newest&limit=1")).messages[0].id).toBe(
        "forumroot_0060",
      );
      expect((await read("q=old%20root")).messages).toEqual([]);
      expect(
        (
          await read("q=Current%20title&tags=tag_one,tag_two&match=all")
        ).messages.map((m) => m.id),
      ).toEqual(["root_bumped"]);
      expect((await read("tags=old_tag")).messages).toEqual([]);
      expect((await read("q=private")).messages).toEqual([]);
      expect(
        first.changes.every(
          (c) => c.conversationId === cid && c.payload.text !== "private reply",
        ),
      ).toBe(true);
      await expectStatus(outsider.req("GET", `${path}?kind=forum`), 404);
      await expectStatus(
        member.req("GET", `${path}?kind=main&sort=latest`),
        400,
      );
      await owner.req("PUT", `/v1/conversations/${cid}/overwrites`, {
        subject: `user:${member.userId}`,
        allow: [],
        deny: ["channels.view"],
      });
      await expectStatus(member.req("GET", `${path}?kind=forum`), 404);
    });
  });
