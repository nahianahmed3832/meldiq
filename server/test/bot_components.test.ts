import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { PostgresRelayStore } from "../src/modules/messaging/relay/postgresStore.js";

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "native bot message components",
  () => {
    let h: Harness,
      owner: GriipClient,
      person: GriipClient,
      outsider: GriipClient,
      orgId: string,
      channelId: string,
      botId: string,
      token: string,
      cardId: string;
    const controls = [
      { type: "button", customId: "confirm", label: "Confirm choice" },
      {
        type: "select",
        customId: "pick",
        label: "Choose a category",
        options: [
          { label: "First", value: "one" },
          { label: "Second", value: "two" },
        ],
      },
      {
        type: "form",
        customId: "feedback",
        label: "Send feedback",
        fields: [{ id: "note", label: "Your feedback", maxLength: 100 }],
      },
    ];
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
    const approve = async (permissions: string[]) => {
      const current = await owner.req(
        "GET",
        `/v1/orgs/${orgId}/bots/${botId}/permissions`,
      );
      await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
        permissions,
        rev: current.rev,
        manifestRev: 1,
      });
    };
    const card = async (messageId = `card-${randomUUID()}`, ttl = 3600) => {
      const made = await request(
        "POST",
        `/v2/bot/channels/${channelId}/messages`,
        {
          content: "Choose what to send to this bot.",
          components: controls,
          componentsTtlSeconds: ttl,
          messageId,
        },
      );
      expect(made.status, JSON.stringify(made.body)).toBe(200);
      return made.body.messageId as string;
    };
    const input = (customId: string, extra: Record<string, unknown> = {}) => ({
      kind: "component",
      channelId,
      botId,
      messageId: cardId,
      customId,
      interactionId: randomUUID(),
      ...extra,
    });
    const submit = (
      customId: string,
      extra: Record<string, unknown> = {},
      actor = person,
    ) => actor.req("POST", "/v2/interactions", input(customId, extra));
    beforeAll(async () => {
      h = await startServer();
      owner = await h.client("componentowner");
      person = await h.client("componentperson");
      outsider = await h.client("componentoutsider");
      owner.serverMessages = person.serverMessages = true;
      orgId = (await owner.req("POST", "/v1/orgs", { name: "Bot controls" }))
        .org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })
      ).invite.code;
      await person.req("POST", "/v1/invites/accept", { code });
      channelId = (
        await owner.req("GET", `/v1/orgs/${orgId}/channels`)
      ).channels.find((c: { name: string }) => c.name === "general").id;
      const made = await owner.req("POST", "/v2/developer/bots", {
        name: "Control helper",
        public: true,
      });
      botId = made.bot.id;
      token = made.token;
      await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
      await Promise.all([owner.connect(), person.connect()]);
    });
    afterAll(async () => {
      await h?.close();
    });

    it("requires advanced posting approval and stores native normalized boxes/links/controls with an expiry", async () => {
      expect(
        (
          await request("POST", `/v2/bot/channels/${channelId}/messages`, {
            content: "Not yet approved",
            components: controls,
          })
        ).status,
      ).toBe(403);
      await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
        rev: 0,
        permissions: ["messages.post"],
      });
      await approve(["messages.post"]);
      cardId = await card();
      const message = (
        await person.req("GET", `/v2/conversations/${channelId}/messages`)
      ).messages.find((m: { id: string }) => m.id === cardId);
      expect(
        message.payload.botComponents.items.map(
          (c: { type: string }) => c.type,
        ),
      ).toEqual(["button", "select", "form"]);
      expect(message.payload.botComponents.expiresAt).toBeGreaterThan(
        Date.now(),
      );
      const rich = await request(
        "POST",
        `/v2/bot/channels/${channelId}/messages`,
        {
          content: "Native rich text",
          embeds: [
            { title: "A box", description: "Validated text", color: "#123456" },
          ],
          buttons: [
            { label: "Project page", url: "https://example.test/project" },
          ],
        },
      );
      expect(rich.status, JSON.stringify(rich.body)).toBe(200);
      const stored = JSON.parse(
        (await h.ctx.messages.get(rich.body.messageId))!.payload,
      );
      expect(stored.embeds[0].color).toBe(0x123456);
      expect(stored.buttons[0]).toMatchObject({
        kind: "link",
        label: "Project page",
      });
      expect(
        (
          await request("POST", `/v2/bot/channels/${channelId}/messages`, {
            content: "Bad URL",
            buttons: [{ label: "Bad", url: "javascript:alert(1)" }],
          })
        ).status,
      ).toBe(400);
      await expectStatus(
        person.send(channelId, {
          type: "text",
          text: "Cannot forge controls",
          botComponents: message.payload.botComponents,
        }),
        400,
      );
    });

    let ids: string[];
    it("accepts all three control types, binds actor/source and deduplicates concurrent retries", async () => {
      const body = input("confirm");
      const duplicates = await Promise.all([
        person.req("POST", "/v2/interactions", body),
        person.req("POST", "/v2/interactions", body),
      ]);
      expect(duplicates.map((r) => r.interaction.id)).toEqual([
        body.interactionId,
        body.interactionId,
      ]);
      expect(duplicates.filter((r) => !r.duplicate)).toHaveLength(1);
      const select = await submit("pick", { values: ["two"] });
      const form = await submit("feedback", {
        fields: { note: "Only the addressed bot receives this private input." },
      });
      ids = [body.interactionId, select.interaction.id, form.interaction.id];
      expect(await h.ctx.bots.store.openCount(botId, Date.now())).toBe(3);
      await expectStatus(
        person.req("POST", "/v2/interactions", {
          ...body,
          customId: "pick",
          values: ["one"],
        }),
        409,
      );
      const events = (await request("GET", "/v2/bot/events")).body.events;
      expect(
        events
          .filter((e: { type: string }) => e.type === "interaction")
          .map((e: { sourceId: string }) => e.sourceId)
          .sort(),
      ).toEqual([...ids].sort());
      expect(JSON.stringify(events)).not.toContain("private input");
    });

    it("rejects invalid choices, unknown fields, disabled controls and guessed or inaccessible targets", async () => {
      await expectStatus(submit("pick", { values: ["not-an-option"] }), 400);
      await expectStatus(submit("pick", { values: ["one", "one"] }), 400);
      await expectStatus(
        submit("feedback", { fields: { note: "Valid", hidden: "Unknown" } }),
        400,
      );
      await expectStatus(submit("feedback", { fields: {} }), 400);
      await expectStatus(submit("missing"), 404);
      await expectStatus(
        submit("confirm", { messageId: "guessed-source" }),
        404,
      );
      await expectStatus(submit("confirm", {}, outsider), 404);
      await expectStatus(submit("confirm", { userId: owner.userId }), 400);
      const disabled = await request(
        "POST",
        `/v2/bot/channels/${channelId}/messages`,
        {
          content: "Disabled control",
          components: [
            {
              type: "button",
              customId: "disabled",
              label: "Unavailable",
              disabled: true,
            },
          ],
        },
      );
      await expectStatus(
        submit("disabled", { messageId: disabled.body.messageId }),
        410,
      );
    });

    it("uses the existing bot poll/reply leases and sends private answers only to their actor", async () => {
      const poll = await request("GET", "/v2/bot/interactions");
      expect(poll.status, JSON.stringify(poll.body)).toBe(200);
      expect(
        poll.body.interactions.map((i: { id: string }) => i.id).sort(),
      ).toEqual([...ids].sort());
      expect(
        poll.body.interactions.find((i: { id: string }) => i.id === ids[1])
          .component.values,
      ).toEqual(["two"]);
      expect(
        poll.body.interactions.find((i: { id: string }) => i.id === ids[2])
          .component.fields.note,
      ).toContain("private input");
      for (const id of ids) {
        expect(
          (
            await request("POST", `/v2/bot/interactions/${id}/reply`, {
              content: "Private control acknowledgement",
              ephemeral: true,
            })
          ).status,
        ).toBe(200);
      }
      await vi.waitFor(() =>
        expect(
          person.events.filter(
            (e: { t: string }) => e.t === "interaction.reply",
          ),
        ).toHaveLength(3),
      );
      expect(
        owner.events.some((e: { t: string }) => e.t === "interaction.reply"),
      ).toBe(false);
      expect(
        person.events.find(
          (e: { interactionId: string }) => e.interactionId === ids[0],
        ).componentLabel,
      ).toBe("Confirm choice");
    });

    it("bounds Unicode form input without leaking it into the event journal and rejects prototype keys", async () => {
      const fields = ["a", "b", "c", "d"].map((id) => ({
        id,
        label: id,
        maxLength: 1000,
      }));
      const made = await request(
        "POST",
        `/v2/bot/channels/${channelId}/messages`,
        {
          content: "Unicode form",
          components: [
            { type: "form", customId: "unicode", label: "Four fields", fields },
          ],
        },
      );
      expect(made.status, JSON.stringify(made.body)).toBe(200);
      const inputs = Object.fromEntries(
        fields.map(({ id }) => [id, "私".repeat(1000)]),
      );
      const submitted = await submit("unicode", {
        messageId: made.body.messageId,
        fields: inputs,
      });
      const poll = await request("GET", "/v2/bot/interactions");
      expect(
        poll.body.interactions.find(
          (i: { id: string }) => i.id === submitted.interaction.id,
        ).component.fields,
      ).toEqual(inputs);
      expect(
        JSON.stringify((await request("GET", "/v2/bot/events")).body),
      ).not.toContain("私");
      expect(
        (
          await request(
            "POST",
            `/v2/bot/interactions/${submitted.interaction.id}/reply`,
            { content: "Received", ephemeral: true },
          )
        ).status,
      ).toBe(200);
      for (const id of ["__proto__", "constructor", "prototype"]) {
        expect(
          (
            await request("POST", `/v2/bot/channels/${channelId}/messages`, {
              content: "Unsafe field",
              components: [
                {
                  type: "form",
                  customId: "bad",
                  label: "Bad",
                  fields: [{ id, label: "Bad" }],
                },
              ],
            })
          ).status,
        ).toBe(400);
      }
    });

    it("applies current text-only channel rules to rich bot content at the native write boundary", async () => {
      await owner.req("PATCH", `/v1/conversations/${channelId}`, {
        textOnly: true,
      });
      try {
        expect(
          (
            await request("POST", `/v2/bot/channels/${channelId}/messages`, {
              content: "Just words",
            })
          ).status,
        ).toBe(200);
        const denied = await request(
          "POST",
          `/v2/bot/channels/${channelId}/messages`,
          { content: "No cards", components: controls },
        );
        expect(denied.status, JSON.stringify(denied.body)).toBe(403);
        expect(denied.body.error.code).toBe("text_only_channel");
      } finally {
        await owner.req("PATCH", `/v1/conversations/${channelId}`, {
          textOnly: false,
        });
      }
      const relay = h.ctx.relay as PostgresRelayStore;
      const accept = relay.acceptEvent.bind(relay);
      const write = vi
        .spyOn(relay, "acceptEvent")
        .mockImplementationOnce(async (...args) => {
          await owner.req("PATCH", `/v1/conversations/${channelId}`, {
            textOnly: true,
          });
          return accept(...args);
        });
      try {
        expect(
          (
            await request("POST", `/v2/bot/channels/${channelId}/messages`, {
              content: "Rules changed",
              components: controls,
            })
          ).status,
        ).toBe(403);
      } finally {
        write.mockRestore();
        await owner.req("PATCH", `/v1/conversations/${channelId}`, {
          textOnly: false,
        });
      }
    });

    it("does not resurrect an in-flight private input after a block and unblock", async () => {
      const add = h.ctx.bots.store.addInteraction.bind(h.ctx.bots.store);
      const write = vi
        .spyOn(h.ctx.bots.store, "addInteraction")
        .mockImplementationOnce(async (...args) => {
          await person.req("POST", "/v1/blocks", { userId: botId });
          await person.req("DELETE", `/v1/blocks/${botId}`);
          return add(...args);
        });
      const body = input("feedback", {
        fields: { note: "Withdraw this in-flight input" },
      });
      try {
        await expectStatus(person.req("POST", "/v2/interactions", body), 409);
      } finally {
        write.mockRestore();
      }
      expect(await h.ctx.bots.store.interaction(body.interactionId)).toBeNull();
    });

    it("withdraws pending controls after source deletion", async () => {
      const pending = await submit("feedback", {
        fields: { note: "Do not release after deletion" },
      });
      expect(
        (await request("DELETE", `/v2/bot/messages/${cardId}`)).status,
      ).toBe(200);
      expect(
        (await request("GET", "/v2/bot/interactions")).body.interactions,
      ).toEqual([]);
      expect(
        (await request("GET", "/v2/bot/events")).body.events.filter(
          (e: { type: string }) => e.type === "interaction",
        ),
      ).toEqual([]);
      expect(
        (
          await request(
            "POST",
            `/v2/bot/interactions/${pending.interaction.id}/reply`,
            { content: "Must not answer", ephemeral: true },
          )
        ).status,
      ).toBe(404);
      cardId = await card();
    });

    it("withdraws private inputs on a block and does not restore them when unblocked", async () => {
      const pending = await submit("feedback", {
        fields: { note: "Withdraw this input when blocked" },
      });
      await person.req("POST", "/v1/blocks", { userId: botId });
      expect(
        await h.ctx.bots.store.interaction(pending.interaction.id),
      ).toBeNull();
      await expectStatus(submit("confirm"), 404);
      await person.req("DELETE", `/v1/blocks/${botId}`);
      expect(
        (
          await request(
            "POST",
            `/v2/bot/interactions/${pending.interaction.id}/reply`,
            { content: "Cannot revive a withdrawn input", ephemeral: true },
          )
        ).status,
      ).toBe(404);
      expect((await submit("confirm")).interaction.id).toEqual(
        expect.any(String),
      );
    });

    it("rechecks approval after asynchronous reads and inside publication's native writer", async () => {
      const pending = await submit("feedback", {
        fields: { note: "Must not release after scope revocation" },
      });
      const get = h.ctx.messages.get.bind(h.ctx.messages);
      const read = vi
        .spyOn(h.ctx.messages, "get")
        .mockImplementationOnce(async (id) => {
          const result = await get(id);
          await approve([]);
          return result;
        });
      try {
        expect(
          (await request("GET", "/v2/bot/interactions")).body.interactions,
        ).toEqual([]);
      } finally {
        read.mockRestore();
      }
      expect(
        (
          await request(
            "POST",
            `/v2/bot/interactions/${pending.interaction.id}/reply`,
            { content: "Revoked", ephemeral: true },
          )
        ).status,
      ).toBe(404);
      await approve(["messages.post"]);
      const relay = h.ctx.relay as PostgresRelayStore;
      const accept = relay.acceptEvent.bind(relay);
      const write = vi
        .spyOn(relay, "acceptEvent")
        .mockImplementationOnce(async (...args) => {
          await approve([]);
          return accept(...args);
        });
      const id = `race-${randomUUID()}`;
      try {
        expect(
          (
            await request("POST", `/v2/bot/channels/${channelId}/messages`, {
              content: "Must not commit",
              components: controls,
              messageId: id,
            })
          ).status,
        ).toBe(403);
        expect(await h.ctx.messages.get(id)).toBeNull();
        expect(await h.ctx.relay.submission(id)).toBeNull();
      } finally {
        write.mockRestore();
        await approve(["messages.post"]);
      }
    });

    it("refuses expired controls and permits personal controls only within the recipient's current consent", async () => {
      const short = await card(undefined, 60);
      const clock = h.ctx.bots.clock;
      h.ctx.bots.clock = () => Date.now() + 61_000;
      try {
        await expectStatus(submit("confirm", { messageId: short }), 410);
      } finally {
        h.ctx.bots.clock = clock;
      }
      await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
        rev: 1,
        permissions: ["messages.post", "direct_messages"],
      });
      const review = await person.req(
        "GET",
        `/v2/bots/${botId}/direct-messages`,
      );
      const granted = await person.req(
        "PUT",
        `/v2/bots/${botId}/direct-messages`,
        {
          enabled: true,
          rev: review.rev,
          manifestRev: review.manifestRev,
          noticeVersion: review.noticeVersion,
        },
      );
      const direct = await request(
        "POST",
        `/v2/bot/users/${person.userId}/dm`,
        { content: "Personal controls", components: controls },
      );
      expect(direct.status, JSON.stringify(direct.body)).toBe(200);
      const invocation = input("confirm", {
        channelId: granted.conversationId,
        messageId: direct.body.messageId,
      });
      const submitted = await person.req(
        "POST",
        "/v2/interactions",
        invocation,
      );
      expect(
        (await request("GET", "/v2/bot/events")).body.events,
      ).toContainEqual(
        expect.objectContaining({
          type: "interaction",
          sourceId: submitted.interaction.id,
          channelId: granted.conversationId,
        }),
      );
      const updated = await person.req(
        "GET",
        `/v2/bots/${botId}/direct-messages`,
      );
      await person.req("PUT", `/v2/bots/${botId}/direct-messages`, {
        enabled: false,
        rev: updated.rev,
        manifestRev: updated.manifestRev,
        noticeVersion: updated.noticeVersion,
      });
      expect(
        (await request("GET", "/v2/bot/interactions")).body.interactions,
      ).not.toContainEqual(
        expect.objectContaining({ id: submitted.interaction.id }),
      );
      expect(
        (await request("GET", "/v2/bot/events")).body.events,
      ).not.toContainEqual(
        expect.objectContaining({ sourceId: submitted.interaction.id }),
      );
    });

    it("enforces the shared pending limit atomically under concurrent creation", async () => {
      const at = Date.now();
      await h.ctx.postgres!.database.query(
        "DELETE FROM meldiq.bot_interactions WHERE bot_id=$1",
        [botId],
      );
      await h.ctx.postgres!.database.query(
        `INSERT INTO meldiq.bot_interactions(id,bot_id,user_id,org_id,conversation_id,command,state,created_at,expires_at,options)
      SELECT 'capacity-'||n,$1,$2,$3,$4,'capacity','pending',$5,$6,'{}'::jsonb FROM generate_series(1,499) n`,
        [botId, person.userId, orgId, channelId, at, at + 900_000],
      );
      const item = {
        botId,
        userId: person.userId,
        orgId,
        conversationId: channelId,
        command: "capacity",
        options: {},
        state: "pending" as const,
        createdAt: at,
        expiresAt: at + 900_000,
        deliveredAt: null,
        repliedAt: null,
      };
      const result = await Promise.allSettled([
        h.ctx.bots.store.addInteraction({ ...item, id: randomUUID() }),
        h.ctx.bots.store.addInteraction({ ...item, id: randomUUID() }),
      ]);
      expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(result.find((r) => r.status === "rejected")).toMatchObject({
        reason: { statusCode: 429, code: "rate_limited" },
      });
      expect(await h.ctx.bots.store.openCount(botId, at)).toBe(500);
    });

    it("cleans expired private interaction data without a command, poll or connected bot", async () => {
      const clock = h.ctx.bots.clock;
      h.ctx.bots.clock = () => Date.now() + 2 * 60 * 60_000;
      try {
        await h.ctx.bots.interactions.maintain();
      } finally {
        h.ctx.bots.clock = clock;
      }
      expect(await h.ctx.bots.store.openCount(botId, Date.now())).toBe(0);
      expect(
        (
          await h.ctx.postgres!.database.query(
            "SELECT id FROM meldiq.bot_interactions WHERE bot_id=$1",
            [botId],
          )
        ).rows,
      ).toEqual([]);
    });
  },
);
