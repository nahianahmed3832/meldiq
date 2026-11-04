import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createServer } from "node:http";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { MeldiqBot, MeldiqBotError } from "../sdk/javascript/index.mjs";

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "first-party native bot clients",
  () => {
    let h: Harness,
      owner: GriipClient,
      orgId: string,
      channelId: string,
      botId: string,
      token: string,
      client: MeldiqBot;
    beforeAll(async () => {
      h = await startServer();
      owner = await h.client("sdkowner");
      owner.serverMessages = true;
      orgId = (await owner.req("POST", "/v1/orgs", { name: "SDK lab" })).org.id;
      channelId = (
        await owner.req("GET", `/v1/orgs/${orgId}/channels`)
      ).channels.find(
        (channel: { name: string }) => channel.name === "general",
      ).id;
      const made = await owner.req("POST", "/v2/developer/bots", {
        name: "SDK helper",
      });
      botId = made.bot.id;
      token = made.token;
      await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
      const permissions = ["events.read", "messages.history"];
      await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
        permissions,
        rev: 0,
      });
      await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
        permissions,
        manifestRev: 1,
        rev: 0,
      });
      client = new MeldiqBot({ apiOrigin: h.baseUrl, token });
    });
    afterAll(async () => {
      await h?.close();
    });

    it("uses the real HTTP API with native idempotent sends and no public token field", async () => {
      expect((await client.me()).bot.id).toBe(botId);
      expect(
        (await client.communities()).communities.map(
          (org: { id: string }) => org.id,
        ),
      ).toContain(orgId);
      expect(
        (
          await client.send(channelId, "SDK send", {
            messageId: "sdk-repeat-message",
          })
        ).duplicate,
      ).toBe(false);
      expect(
        (
          await client.send(channelId, "SDK send", {
            messageId: "sdk-repeat-message",
          })
        ).duplicate,
      ).toBe(true);
      expect(
        (await client.events()).events.some(
          (event: { sourceId: string }) =>
            event.sourceId === "sdk-repeat-message",
        ),
      ).toBe(true);
      expect(
        (
          await client.uploadAvatar(
            Buffer.from(
              "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
              "base64",
            ),
          )
        ).avatarMedia.kind,
      ).toBe("gif");
      expect(JSON.stringify(client)).not.toContain(token);
      await expect(client.request("GET", "/v2/account")).rejects.toThrow(
        "Only native",
      );
      await expect(
        client.request("GET", "/v2/bot/%2e%2e/%2e%2e/v2/account"),
      ).rejects.toThrow("Only native");
      await expect(
        client.request("GET", "https://unrelated.invalid/v2/bot/me"),
      ).rejects.toThrow("Only native");
      await expect(
        client.request("POST", `/v2/bot/orgs/${orgId}/channels`, {
          body: { name: "unapproved-sdk-action" },
        }),
      ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    });

    it("can await a gateway RPC inside a batch and checkpoints only after handling it", async () => {
      let gateway: Awaited<ReturnType<MeldiqBot["openGateway"]>>;
      let processing = false,
        handled = false;
      const id = "sdk-gateway-message";
      gateway = await client.openGateway({
        onBatch: async (events: { sourceId: string }[]) => {
          if (!events.some((event) => event.sourceId === id)) return;
          processing = true;
          expect((await gateway.request("self")).bot.id).toBe(botId);
          processing = false;
          handled = true;
        },
        onCursor: () => {
          expect(processing).toBe(false);
        },
      });
      try {
        await vi.waitFor(() => expect(typeof gateway.cursor).toBe("string"));
        const before = gateway.cursor;
        await owner.send(
          channelId,
          { type: "text", text: "SDK gateway callback" },
          "message",
          id,
        );
        await vi.waitFor(() => expect(handled).toBe(true));
        await vi.waitFor(() => expect(gateway.cursor).not.toBe(before));
        gateway.setPresence("idle");
        await vi.waitFor(() =>
          expect(h.ctx.bots.presenceOf(botId)).toBe("idle"),
        );
        expect(
          h.ctx.hub
            .connections()
            .some((connection) => connection.userId === botId),
        ).toBe(false);
        await expect(gateway.request("arbitrary_http")).rejects.toThrow(
          "Use native HTTP",
        );
      } finally {
        gateway.close();
        await gateway.closed;
      }
    });

    it("keeps the last successful checkpoint when a handler fails and permits replay of the unhandled event", async () => {
      const cursor = (await client.events()).cursor;
      const id = "sdk-failing-handler";
      let checkpoint = cursor;
      let failedBatchCheckpoint: string | undefined;
      const gateway = await client.openGateway({
        cursor,
        onCursor: (next: string) => {
          checkpoint = next;
        },
        onBatch: async (events: { sourceId: string }[]) => {
          if (events.some((event) => event.sourceId === id)) {
            failedBatchCheckpoint = checkpoint;
            throw new Error("private handler details must not escape");
          }
        },
      });
      await vi.waitFor(() => expect(typeof gateway.cursor).toBe("string"));
      const committed = gateway.cursor;
      await owner.send(
        channelId,
        { type: "text", text: "SDK replay after handler failure" },
        "message",
        id,
      );
      const closed = await gateway.closed;
      expect(closed.error).toMatchObject({ code: "consumer_failed" });
      expect(String(closed.error)).not.toContain("private handler details");
      expect(failedBatchCheckpoint).toBeDefined();
      expect(gateway.cursor).toBe(failedBatchCheckpoint);
      // Successful empty batches may renew the opaque cursor after `committed`.
      // Both the earlier checkpoint and the client's final one must replay the
      // event whose handler failed.
      for (const replayCursor of [committed, gateway.cursor]) {
        expect(
          (await client.events({ cursor: replayCursor })).events.some(
            (event: { sourceId: string }) => event.sourceId === id,
          ),
        ).toBe(true);
      }
    });

    it("surfaces revocation instead of automatically reconnecting with the old credential", async () => {
      const gateway = await client.openGateway();
      const rotated = await owner.req(
        "POST",
        `/v2/developer/bots/${botId}/token`,
      );
      expect((await gateway.closed).error).toMatchObject({ status: 401 });
      await expect(client.me()).rejects.toBeInstanceOf(MeldiqBotError);
      token = rotated.token;
      client = new MeldiqBot({ apiOrigin: h.baseUrl, token });
    });

    it("runs the Python standard-library client against the same real API", async () => {
      const program = `import json, os, sys\nsys.path.insert(0, os.environ['MELDIQ_TEST_SDK_DIR'])\nfrom meldiq_bot import MeldiqBot\nbot=MeldiqBot(os.environ['MELDIQ_TEST_API'],os.environ['MELDIQ_TEST_BOT_TOKEN'])\nprofile=bot.me()\nsent=bot.send(os.environ['MELDIQ_TEST_CHANNEL'],'Python SDK send',message_id='python-sdk-message')\nrejected=False\ntry: bot.request('GET','/v2/bot/%2e%2e/%2e%2e/v2/account')\nexcept ValueError: rejected=True\nprint(json.dumps({'id':profile['bot']['id'],'duplicate':sent['duplicate'],'pathRejected':rejected,'tokenInRepr':os.environ['MELDIQ_TEST_BOT_TOKEN'] in repr(bot),'python':list(sys.version_info[:3])}))`;
      const result = await promisify(execFile)("python3", ["-c", program], {
        env: {
          ...process.env,
          MELDIQ_TEST_SDK_DIR: path.resolve(
            import.meta.dirname,
            "../sdk/python",
          ),
          MELDIQ_TEST_API: h.baseUrl,
          MELDIQ_TEST_BOT_TOKEN: token,
          MELDIQ_TEST_CHANNEL: channelId,
        },
        timeout: 30_000,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        id: botId,
        duplicate: false,
        pathRejected: true,
        tokenInRepr: false,
      });
    });

    it("sends native interactive controls through both source clients", async () => {
      const permissions = ["events.read", "messages.history", "messages.post"];
      await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
        permissions,
        rev: 1,
      });
      await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
        permissions,
        manifestRev: 2,
        rev: 1,
      });
      const sent = await client.send(channelId, "SDK button", {
        components: [{ type: "button", customId: "confirm", label: "Confirm" }],
        componentsTtlSeconds: 60,
      });
      expect(
        JSON.parse((await h.ctx.messages.get(sent.messageId))!.payload)
          .botComponents.items[0].customId,
      ).toBe("confirm");
      const program = `import os,sys,json
sys.path.insert(0,os.environ['MELDIQ_TEST_SDK_DIR'])
from meldiq_bot import MeldiqBot
bot=MeldiqBot(os.environ['MELDIQ_TEST_API'],os.environ['MELDIQ_TEST_BOT_TOKEN'])
sent=bot.send(os.environ['MELDIQ_TEST_CHANNEL'],'Python SDK form',components=[{'type':'form','customId':'note','label':'Note','fields':[{'id':'note','label':'Note'}]}],components_ttl_seconds=60)
print(json.dumps({'messageId':sent['messageId']}))`;
      const result = await promisify(execFile)("python3", ["-c", program], {
        env: {
          ...process.env,
          MELDIQ_TEST_SDK_DIR: path.resolve(
            import.meta.dirname,
            "../sdk/python",
          ),
          MELDIQ_TEST_API: h.baseUrl,
          MELDIQ_TEST_BOT_TOKEN: token,
          MELDIQ_TEST_CHANNEL: channelId,
        },
        timeout: 30_000,
      });
      const payload = JSON.parse(
        (await h.ctx.messages.get(JSON.parse(result.stdout).messageId))!
          .payload,
      );
      expect(payload.botComponents.items[0]).toMatchObject({
        type: "form",
        customId: "note",
      });
    });

    it("does not follow a redirect carrying the bot authorization header", async () => {
      let destinationRequests = 0;
      const destination = createServer((_req, res) => {
        destinationRequests++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((resolve) =>
        destination.listen(0, "127.0.0.1", resolve),
      );
      const address = destination.address() as { port: number };
      const redirect = createServer((_req, res) => {
        res.writeHead(302, {
          location: `http://127.0.0.1:${address.port}/v2/bot/me`,
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "redirect_refused",
              message: "Redirect not allowed",
            },
          }),
        );
      });
      await new Promise<void>((resolve) =>
        redirect.listen(0, "127.0.0.1", resolve),
      );
      try {
        const origin = `http://127.0.0.1:${(redirect.address() as { port: number }).port}`;
        await expect(
          new MeldiqBot({ apiOrigin: origin, token }).me(),
        ).rejects.toMatchObject({ code: "network_error" });
        const program = `import os,sys\nsys.path.insert(0,os.environ['MELDIQ_TEST_SDK_DIR'])\nfrom meldiq_bot import MeldiqBot,MeldiqBotError\ntry: MeldiqBot(os.environ['MELDIQ_TEST_API'],os.environ['MELDIQ_TEST_BOT_TOKEN']).me()\nexcept MeldiqBotError as error: print(error.status)\n`;
        const result = await promisify(execFile)("python3", ["-c", program], {
          env: {
            ...process.env,
            MELDIQ_TEST_SDK_DIR: path.resolve(
              import.meta.dirname,
              "../sdk/python",
            ),
            MELDIQ_TEST_API: origin,
            MELDIQ_TEST_BOT_TOKEN: token,
          },
          timeout: 30_000,
        });
        expect(result.stdout.trim()).toBe("302");
        expect(destinationRequests).toBe(0);
      } finally {
        redirect.closeAllConnections();
        destination.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) => redirect.close(() => resolve())),
          new Promise<void>((resolve) => destination.close(() => resolve())),
        ]);
      }
    });
  },
);
