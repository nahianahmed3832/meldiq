import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { PostgresRelayStore } from "../src/modules/messaging/relay/postgresStore.js";
import { MeldiqBot } from "../sdk/javascript/index.mjs";

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "recipient-controlled bot direct messages",
  () => {
    let h: Harness,
      owner: GriipClient,
      person: GriipClient,
      botId: string,
      token: string,
      conversationId: string;
    const base = () => `/v2/bots/${botId}/direct-messages`;
    const request = async (
      method: string,
      path: string,
      body?: unknown,
      credential = token,
    ) => {
      const response = await fetch(h.baseUrl + path, {
        method,
        headers: {
          authorization: `Bot ${credential}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const consent = async (enabled: boolean) => {
      const review = await person.req("GET", base());
      return person.req("PUT", base(), {
        enabled,
        rev: review.rev,
        manifestRev: review.manifestRev,
        noticeVersion: review.noticeVersion,
      });
    };
    beforeAll(async () => {
      h = await startServer();
      owner = await h.client("botdmowner");
      person = await h.client("botdmrecipient");
      person.serverMessages = true;
      const made = await owner.req("POST", "/v2/developer/bots", {
        name: "Consent helper",
        public: true,
      });
      botId = made.bot.id;
      token = made.token;
    });
    afterAll(async () => {
      await h?.close();
    });

    it("refuses unsolicited outreach and cannot turn community or owner approval into recipient consent", async () => {
      expect(
        (
          await request("POST", `/v2/bot/users/${person.userId}/dm`, {
            content: "Unsolicited",
          })
        ).status,
      ).toBe(404);
      await expectStatus(
        person.req("POST", "/v1/conversations/dm", { userId: botId }),
        404,
      );
      await expectStatus(consent(true), 409);
      await expectStatus(
        owner.req("PUT", base(), {
          enabled: true,
          rev: 0,
          manifestRev: 0,
          noticeVersion: "bot-dm-2026-11-05",
          userId: person.userId,
        }),
        400,
      );
    });

    it("delivers ordinary messages and private ID-only replay only after a revision-checked personal approval", async () => {
      await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
        rev: 0,
        permissions: ["direct_messages"],
      });
      const approved = await consent(true);
      expect(approved.enabled).toBe(true);
      conversationId = approved.conversationId;
      const sent = await request("POST", `/v2/bot/users/${person.userId}/dm`, {
        content: "You enabled this conversation",
        messageId: "bot-dm-first",
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(sent.body.conversationId).toBe(conversationId);
      const client = new MeldiqBot({ apiOrigin: h.baseUrl, token });
      expect(
        (
          await client.sendDirect(
            person.userId,
            "You enabled this conversation",
            { messageId: "bot-dm-first" },
          )
        ).duplicate,
      ).toBe(true);
      await expectStatus(
        person.req("POST", "/v1/calls", { conversationId, video: false }),
        403,
      );
      expect(
        (await person.req("GET", `/v1/conversations/${conversationId}`))
          .conversation.members,
      ).toContainEqual(expect.objectContaining({ id: botId, bot: true }));
      await person.send(
        conversationId,
        { type: "text", text: "Private recipient reply" },
        "message",
        "bot-dm-person-first",
      );
      await person.send(
        conversationId,
        { type: "call_key_request", callId: "private-protocol-control" },
        "control",
        "bot-dm-control",
      );
      const history = await request(
        "GET",
        `/v2/bot/conversations/${conversationId}/messages`,
      );
      expect(history.status, JSON.stringify(history.body)).toBe(200);
      expect(
        history.body.messages.map(
          (m: { payload: { text: string } }) => m.payload.text,
        ),
      ).toContain("Private recipient reply");
      expect(JSON.stringify(history.body)).not.toContain(
        "private-protocol-control",
      );
      const feed = (await request("GET", "/v2/bot/events")).body.events;
      expect(feed).toContainEqual(
        expect.objectContaining({
          type: "dm_message",
          sourceId: "bot-dm-person-first",
          communityId: null,
          channelId: conversationId,
        }),
      );
      expect(JSON.stringify(feed)).not.toContain("Private recipient reply");
      const other = await h.client("botdmunrelated");
      const otherBot = await other.req("POST", "/v2/developer/bots", {
        name: "Other DM bot",
      });
      expect(
        (await request("GET", "/v2/bot/events", undefined, otherBot.token)).body
          .events,
      ).toEqual([]);
    });

    it("blocks both read and send access after revocation and uses a fresh conversation on renewed consent", async () => {
      const old = conversationId;
      const review = await person.req("GET", base());
      await consent(false);
      await expectStatus(
        person.req("PUT", base(), {
          enabled: true,
          rev: review.rev,
          manifestRev: review.manifestRev,
          noticeVersion: review.noticeVersion,
        }),
        409,
      );
      expect(
        (
          await request("POST", `/v2/bot/users/${person.userId}/dm`, {
            content: "Revoked",
          })
        ).status,
      ).toBe(403);
      expect(
        (await request("GET", `/v2/bot/conversations/${old}/messages`)).status,
      ).toBe(403);
      expect((await request("GET", "/v2/bot/events")).body.events).toEqual([]);
      await expectStatus(
        person.send(old, { type: "text", text: "Revoked personal send" }),
        403,
      );
      conversationId = (await consent(true)).conversationId;
      expect(conversationId).not.toBe(old);
      expect(
        (await request("GET", `/v2/bot/conversations/${old}/messages`)).status,
      ).toBe(403);
      expect(
        (await person.req("GET", `/v2/conversations/${old}/messages`)).messages
          .length,
      ).toBeGreaterThan(0);
    });

    it("requires fresh personal review when the developer changes requested access", async () => {
      const old = conversationId;
      await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
        rev: 1,
        permissions: ["direct_messages", "events.read"],
      });
      expect((await person.req("GET", base())).enabled).toBe(false);
      expect(
        (
          await request("POST", `/v2/bot/users/${person.userId}/dm`, {
            content: "Stale approval",
          })
        ).status,
      ).toBe(403);
      conversationId = (await consent(true)).conversationId;
      expect(conversationId).not.toBe(old);
      expect((await request("GET", "/v2/bot/events")).body.events).toEqual([]);
    });

    it("rechecks access after asynchronous history reads and enforces consent again at message commit", async () => {
      const page = h.ctx.messages.page.bind(h.ctx.messages);
      const read = vi
        .spyOn(h.ctx.messages, "page")
        .mockImplementationOnce(async (...args) => {
          const result = await page(...args);
          await consent(false);
          return result;
        });
      try {
        expect(
          (
            await request(
              "GET",
              `/v2/bot/conversations/${conversationId}/messages`,
            )
          ).status,
        ).toBe(403);
      } finally {
        read.mockRestore();
      }
      conversationId = (await consent(true)).conversationId;
      const relay = h.ctx.relay as PostgresRelayStore;
      const add = relay.acceptEvent.bind(relay);
      const write = vi
        .spyOn(relay, "acceptEvent")
        .mockImplementationOnce(async (...args) => {
          await consent(false);
          return add(...args);
        });
      try {
        const result = await request(
          "POST",
          `/v2/bot/users/${person.userId}/dm`,
          {
            content: "Must not commit after revocation",
            messageId: "bot-dm-revocation-race",
          },
        );
        expect(result.status, JSON.stringify(result.body)).toBe(403);
        expect(await h.ctx.messages.get("bot-dm-revocation-race")).toBeNull();
      } finally {
        write.mockRestore();
      }
    });

    it("applies native blocks and current token revocation without entering a person-to-person DM", async () => {
      conversationId = (await consent(true)).conversationId;
      await person.req("POST", "/v1/blocks", { userId: botId });
      expect(
        (
          await request("POST", `/v2/bot/users/${person.userId}/dm`, {
            content: "Blocked",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            "GET",
            `/v2/bot/conversations/${conversationId}/messages`,
          )
        ).status,
      ).toBe(403);
      expect((await request("GET", "/v2/bot/events")).body.events).toEqual([]);
      await person.req("DELETE", `/v1/blocks/${botId}`);
      expect((await person.req("GET", base())).enabled).toBe(false);
      expect(
        (
          await request("POST", `/v2/bot/users/${person.userId}/dm`, {
            content: "Unblocked without new approval",
          })
        ).status,
      ).toBe(403);
      conversationId = (await consent(true)).conversationId;
      const oldToken = token;
      token = (await owner.req("POST", `/v2/developer/bots/${botId}/token`))
        .token;
      expect(
        (
          await request(
            "POST",
            `/v2/bot/users/${person.userId}/dm`,
            { content: "Old token" },
            oldToken,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await request("POST", `/v2/bot/users/${person.userId}/dm`, {
            content: "Current token",
          })
        ).status,
      ).toBe(200);
      const personDm = (
        await person.req("POST", "/v1/conversations/dm", {
          userId: owner.userId,
        })
      ).conversation.id;
      expect(
        (await request("GET", `/v2/bot/conversations/${personDm}/messages`))
          .status,
      ).toBe(403);
    });
    it("keeps synthetic load-test accounts isolated even when personal consent is requested", async () => {
      await h.ctx.identity.write((w) =>
        w.update("users", { id: owner.userId }, { synthetic: 1 }),
      );
      try {
        expect(
          (
            await request(
              "GET",
              `/v2/bot/conversations/${conversationId}/messages`,
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await request("POST", `/v2/bot/users/${person.userId}/dm`, {
              content: "Synthetic owner cannot reach an ordinary person",
            })
          ).status,
        ).toBe(403);
        await expectStatus(consent(true), 403, "synthetic_scope");
      } finally {
        await h.ctx.identity.write((w) =>
          w.update("users", { id: owner.userId }, { synthetic: 0 }),
        );
      }
    });
  },
);
