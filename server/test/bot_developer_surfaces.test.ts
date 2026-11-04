import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "bot developer inventories and diagnostics",
  () => {
    let h: Harness,
      owner: GriipClient,
      orgId: string,
      channelId: string,
      voiceId: string,
      botId: string,
      token: string;
    const request = async (
      method: string,
      path: string,
      body?: unknown,
      auth = `Bot ${token}`,
    ) => {
      const response = await fetch(h.baseUrl + path, {
        method,
        headers: {
          authorization: auth,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    beforeAll(async () => {
      h = await startServer();
      owner = await h.client("botdevsurfaces");
      orgId = (
        await owner.req("POST", "/v1/orgs", { name: "Developer inventories" })
      ).org.id;
      channelId = (
        await owner.req("GET", `/v1/orgs/${orgId}/channels`)
      ).channels.find((c: { name: string }) => c.name === "general").id;
      voiceId = (
        await owner.req("POST", `/v1/orgs/${orgId}/channels`, {
          name: "Voice inventory",
          voice: true,
          autoJoin: true,
        })
      ).channel.id;
      const made = await owner.req("POST", "/v2/developer/bots", {
        name: "Inventory bot",
      });
      botId = made.bot.id;
      token = made.token;
      await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
    });
    afterAll(async () => {
      await h?.close();
    });

    it("filters webhook inventory by explicit approval, native roles and current channel visibility without returning secrets", async () => {
      const webhook = await owner.req(
        "POST",
        `/v1/orgs/${orgId}/channels/${channelId}/webhooks`,
        { name: "Inventory hook" },
      );
      expect((await request("GET", "/v2/bot/webhooks")).body.webhooks).toEqual(
        [],
      );
      const permissions = ["webhooks.manage", "voice.connect"];
      await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
        permissions,
        rev: 0,
      });
      await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
        permissions,
        manifestRev: 1,
        rev: 0,
      });
      expect((await request("GET", "/v2/bot/webhooks")).body.webhooks).toEqual(
        [],
      );
      const role = (
        await owner.req("POST", `/v1/orgs/${orgId}/roles`, {
          name: "Integration operator",
          permissions: ["webhooks.manage"],
        })
      ).role;
      await owner.req("PUT", `/v1/roles/${role.id}/members/${botId}`);
      const page = await request("GET", "/v2/bot/webhooks?limit=1");
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect(page.body.webhooks.map((w: { id: string }) => w.id)).toEqual([
        webhook.webhook.id,
      ]);
      expect(JSON.stringify(page.body)).not.toContain(webhook.token);
      expect(JSON.stringify(page.body)).not.toContain("token_hash");
      expect(
        (await request("GET", `/v2/bot/webhooks?after=${webhook.webhook.id}`))
          .body.webhooks,
      ).toEqual([]);
      await owner.req("DELETE", `/v1/roles/${role.id}/members/${botId}`);
      expect((await request("GET", "/v2/bot/webhooks")).body.webhooks).toEqual(
        [],
      );
    });

    it("lists only currently joinable voice rooms and observes an in-flight native access revocation", async () => {
      const page = await request("GET", `/v2/bot/orgs/${orgId}/voice`);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect(page.body.channels).toContainEqual({
        id: voiceId,
        name: "Voice inventory",
        callId: null,
        participants: [],
      });
      expect(page.body.channels.map((c: { id: string }) => c.id)).not.toContain(
        channelId,
      );
      const original = h.ctx.calls.liveIn.bind(h.ctx.calls);
      const read = vi
        .spyOn(h.ctx.calls, "liveIn")
        .mockImplementationOnce(async (ids) => {
          const result = await original(ids);
          await owner.req("PUT", `/v1/conversations/${voiceId}/overwrites`, {
            subject: `user:${botId}`,
            allow: [],
            deny: ["voice.connect"],
          });
          return result;
        });
      try {
        expect(
          (
            await request("GET", `/v2/bot/orgs/${orgId}/voice`)
          ).body.channels.map((c: { id: string }) => c.id),
        ).not.toContain(voiceId);
      } finally {
        read.mockRestore();
      }
      expect((await request("GET", `/v2/bot/orgs/missing/voice`)).status).toBe(
        403,
      );
    });

    it("publishes this server's native capability history and isolates a concurrently retried self-test event", async () => {
      expect(
        (await request("GET", "/v2/bot/changelog")).body.protocolVersion,
      ).toBe(1);
      const testId = randomUUID();
      const replies = await Promise.all(
        [1, 2, 3].map(() => request("POST", "/v2/bot/events/test", { testId })),
      );
      expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(new Set(replies.map((r) => r.body.id)).size).toBe(1);
      expect(replies.filter((r) => !r.body.duplicate)).toHaveLength(1);
      const feed = (await request("GET", "/v2/bot/events")).body;
      expect(
        feed.events.filter((e: { sourceId: string }) => e.sourceId === testId),
      ).toHaveLength(1);
      const otherOwner = await h.client("bototherdiagnostic");
      const other = await otherOwner.req("POST", "/v2/developer/bots", {
        name: "Other diagnostic bot",
      });
      expect(
        (
          await request(
            "GET",
            "/v2/bot/events",
            undefined,
            `Bot ${other.token}`,
          )
        ).body.events,
      ).toEqual([]);
      expect(
        (
          await request("POST", "/v2/bot/events/test", {
            testId,
            payload: "arbitrary",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            "GET",
            "/v2/bot/changelog",
            undefined,
            `Bearer ${token}`,
          )
        ).status,
      ).toBe(401);
    });
  },
);
