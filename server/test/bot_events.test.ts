import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "authorized durable bot event feed",
  () => {
    let h: Harness,
      owner: GriipClient,
      botId: string,
      token: string,
      orgId: string,
      channelId: string;
    let manifestRev = 0,
      approvalRev = 0;
    const permissions = ["events.read", "messages.history", "members.read"];
    const request = async (cursor?: string, limit = 50) => {
      const response = await fetch(
        `${h.baseUrl}/v2/bot/events?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: { authorization: `Bot ${token}` } },
      );
      return { status: response.status, body: await response.json() };
    };
    const approve = async (grants: string[]) => {
      const manifest = await owner.req(
        "PUT",
        `/v2/developer/bots/${botId}/permissions`,
        { permissions: grants, rev: manifestRev },
      );
      manifestRev = manifest.rev;
      const approval = await owner.req(
        "PUT",
        `/v1/orgs/${orgId}/bots/${botId}/permissions`,
        { permissions: grants, manifestRev, rev: approvalRev },
      );
      approvalRev = approval.rev;
    };
    beforeAll(async () => {
      h = await startServer();
      owner = await h.client("eventfeedowner");
      owner.serverMessages = true;
      orgId = (await owner.req("POST", "/v1/orgs", { name: "Feed lab" })).org
        .id;
      channelId = (await owner.req("GET", `/v1/orgs/${orgId}/channels`))
        .channels[0].id;
      const created = await owner.req("POST", "/v2/developer/bots", {
        name: "Feed bot",
      });
      botId = created.bot.id;
      token = created.token;
      await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
      await approve(permissions);
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      await h?.close();
    });

    it("captures real sends, pages stable IDs and resumes without plaintext content or global sequence disclosure", async () => {
      const first = await owner.send(channelId, {
        type: "text",
        text: "private payload stays on native history",
      });
      const second = await owner.send(channelId, {
        type: "text",
        text: "second",
      });
      const page = await request(undefined, 1);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect(page.body).toMatchObject({
        more: true,
        events: [{ type: "message", sourceId: first.messageId, channelId }],
      });
      expect(page.body.events[0]).not.toHaveProperty("seq");
      expect(JSON.stringify(page.body)).not.toContain("private payload");
      const next = await request(page.body.cursor, 1);
      expect(next.body).toMatchObject({
        more: false,
        events: [{ sourceId: second.messageId }],
      });
      expect((await request(next.body.cursor)).body.events).toEqual([]);
    });

    it("filters unrelated and private channels before the limit while advancing an opaque cursor", async () => {
      const start = await request();
      const elsewhere = (
        await owner.req("POST", "/v1/orgs", { name: "Unrelated" })
      ).org.id;
      const otherChannel = (
        await owner.req("GET", `/v1/orgs/${elsewhere}/channels`)
      ).channels[0].id;
      const db = h.ctx.postgres!.database;
      for (let i = 0; i < 3; i++)
        await db.query(
          "SELECT meldiq_private.emit_bot_event('message',$1,$2,NULL,NULL,$3,$4)",
          [elsewhere, otherChannel, `hidden-${i}`, botId],
        );
      const visible = await owner.send(channelId, {
        type: "text",
        text: "visible after hidden events",
      });
      const page = await request(start.body.cursor, 1);
      expect(page.body).toMatchObject({
        more: false,
        events: [{ sourceId: visible.messageId }],
      });
      const privateChannel = (
        await owner.req("POST", `/v1/orgs/${orgId}/channels`, {
          name: "private",
          kind: "PRIVATE",
        })
      ).channel.id;
      await db.query(
        "SELECT meldiq_private.emit_bot_event('message',$1,$2,NULL,NULL,'private-channel',$3)",
        [orgId, privateChannel, botId],
      );
      expect((await request(page.body.cursor)).body.events).toEqual([]);
    });

    it("rechecks permissions after a pending database read and releases no stale events", async () => {
      const start = await request();
      await owner.send(channelId, {
        type: "text",
        text: "revoked while reading",
      });
      const db = h.ctx.postgres!.database,
        original = db.query.bind(db);
      let entered!: () => void, release!: () => void;
      const pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = false;
      const spy = vi
        .spyOn(db, "query")
        .mockImplementation(async (...args: Parameters<typeof db.query>) => {
          const result = await original(...args);
          if (args[0].startsWith("WITH clock") && !held) {
            held = true;
            entered();
            await gate;
          }
          return result;
        });
      try {
        const read = request(start.body.cursor);
        await pending;
        await approve([]);
        release();
        expect((await read).body.events).toEqual([]);
      } finally {
        release();
        spy.mockRestore();
      }
      await approve(permissions);
    });

    it("maps the native reaction add flag and omits private self controls", async () => {
      const start = await request();
      const message = await owner.send(channelId, {
        type: "text",
        text: "react here",
      });
      await owner.send(
        channelId,
        { type: "reaction", target: message.messageId, emoji: "👍", add: true },
        "control",
      );
      await owner.send(
        channelId,
        {
          type: "reaction",
          target: message.messageId,
          emoji: "👍",
          add: false,
        },
        "control",
      );
      const page = await request(start.body.cursor);
      expect(
        page.body.events.map((event: { type: string }) => event.type),
      ).toEqual(["message", "reaction_add", "reaction_remove"]);
      expect(page.body.events[2].data).toMatchObject({
        messageId: message.messageId,
        emoji: "👍",
      });
    });

    it("uses a commit-ordered approval boundary rather than API/DB wall-clock agreement", async () => {
      await approve([]);
      const db = h.ctx.postgres!.database;
      const old = await owner.send(channelId, {
        type: "text",
        text: "before renewed consent",
      });
      // Another installation could already be journaling this community. A targeted fixture captures that old row.
      await db.query(
        "SELECT meldiq_private.emit_bot_event('message',$1,$2,$3,NULL,$4,$5)",
        [orgId, channelId, owner.userId, old.messageId, botId],
      );
      const clock = h.ctx.bots.clock;
      h.ctx.bots.clock = () => Date.now() + 60_000;
      try {
        await approve(permissions);
        const current = await owner.send(channelId, {
          type: "text",
          text: "after consent despite clock skew",
        });
        const page = await request();
        expect(
          page.body.events.map((event: { sourceId: string }) => event.sourceId),
        ).toContain(current.messageId);
        expect(
          page.body.events.map((event: { sourceId: string }) => event.sourceId),
        ).not.toContain(old.messageId);
      } finally {
        h.ctx.bots.clock = clock;
      }
    });

    it("rejects cross-bot/tampered cursors and old credentials after rotation", async () => {
      const page = await request();
      expect(
        (await request(page.body.cursor.slice(0, -5) + "aaaaa")).status,
      ).toBe(400);
      const another = await owner.req("POST", "/v2/developer/bots", {
        name: "Other feed bot",
      });
      const cross = await fetch(
        `${h.baseUrl}/v2/bot/events?cursor=${encodeURIComponent(page.body.cursor)}`,
        { headers: { authorization: `Bot ${another.token}` } },
      );
      expect(cross.status).toBe(400);
      const rotated = await owner.req(
        "POST",
        `/v2/developer/bots/${botId}/token`,
      );
      expect((await request(page.body.cursor)).status).toBe(401);
      token = rotated.token;
      expect((await request(page.body.cursor)).status).toBe(200);
      await owner.req("DELETE", `/v1/orgs/${orgId}/bots/${botId}`);
      expect((await request()).body.events).toEqual([]);
    });
  },
);
