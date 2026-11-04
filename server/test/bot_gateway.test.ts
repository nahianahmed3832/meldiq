import WebSocket from "ws";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { logUrl } from "../src/app/server.js";
import { BotGatewayServerFrame } from "../src/shared/contracts/botGateway.js";

type Frame = Record<string, any>;
describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "separate scoped bot gateway",
  () => {
    let h: Harness,
      owner: GriipClient,
      botId: string,
      token: string,
      orgId: string,
      channelId: string;
    const sockets = new Set<WebSocket>();
    function connect(query = "") {
      const ws = new WebSocket(
        h.baseUrl.replace("http", "ws") + "/v2/bot/gateway" + query,
      );
      const frames: Frame[] = [],
        waiters = new Set<() => void>();
      let closeCode: number | undefined;
      sockets.add(ws);
      ws.on("message", (raw) => {
        frames.push(BotGatewayServerFrame.parse(JSON.parse(raw.toString())));
        for (const wake of waiters) wake();
      });
      ws.on("close", (code) => {
        closeCode = code;
        sockets.delete(ws);
        for (const wake of waiters) wake();
      });
      ws.on("error", () => {});
      const wait = <T>(read: () => T | undefined): Promise<T> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(check);
            reject(
              new Error(`Gateway wait timed out: ${JSON.stringify(frames)}`),
            );
          }, 7_000);
          const check = () => {
            const value = read();
            if (value !== undefined) {
              clearTimeout(timer);
              waiters.delete(check);
              resolve(value);
            }
          };
          waiters.add(check);
          check();
        });
      return {
        ws,
        frames,
        frame: (op: string) => wait(() => frames.find((f) => f.op === op)),
        event: (sourceId: string) =>
          wait(() =>
            frames.find(
              (f) =>
                f.op === "events" &&
                f.events.some((event: Frame) => event.sourceId === sourceId),
            ),
          ),
        close: () => wait(() => closeCode),
      };
    }
    async function identify(cursor?: string) {
      const connection = connect();
      await connection.frame("hello");
      connection.ws.send(
        JSON.stringify({
          op: cursor ? "resume" : "identify",
          token,
          ...(cursor ? { cursor } : {}),
        }),
      );
      await connection.frame(cursor ? "resumed" : "ready");
      await connection.frame("events");
      return connection;
    }
    beforeAll(async () => {
      h = await startServer({ WS_AUTH_TIMEOUT_MS: "1000" });
      owner = await h.client("gatewayowner");
      owner.serverMessages = true;
      orgId = (await owner.req("POST", "/v1/orgs", { name: "Gateway lab" })).org
        .id;
      channelId = (await owner.req("GET", `/v1/orgs/${orgId}/channels`))
        .channels[0].id;
      const made = await owner.req("POST", "/v2/developer/bots", {
        name: "Gateway bot",
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
    });
    afterAll(async () => {
      for (const socket of sockets) socket.terminate();
      await h?.close();
    });

    it("identifies, acknowledges heartbeat/presence, and never creates a human device connection", async () => {
      const connection = await identify();
      expect(connection.frames[0]).toMatchObject({
        op: "hello",
        version: 1,
        maxFrameBytes: 8192,
      });
      connection.ws.send(JSON.stringify({ op: "heartbeat", nonce: "test-1" }));
      expect(await connection.frame("heartbeat_ack")).toMatchObject({
        nonce: "test-1",
        cursor: expect.stringMatching(/^be1\./),
      });
      connection.ws.send(JSON.stringify({ op: "presence", status: "idle" }));
      expect(await connection.frame("presence_ack")).toMatchObject({
        status: "idle",
      });
      expect(h.ctx.bots.presenceOf(botId)).toBe("idle");
      expect(
        h.ctx.hub.connections().filter((item) => item.userId === botId),
      ).toEqual([]);
      connection.ws.send(
        JSON.stringify({
          op: "request",
          requestId: "identity-check",
          action: "self",
        }),
      );
      expect(await connection.frame("response")).toMatchObject({
        requestId: "identity-check",
        ok: true,
        data: { bot: { id: botId } },
      });
      connection.ws.close();
      await connection.close();
      await vi.waitFor(() =>
        expect(h.ctx.bots.presenceOf(botId)).toBeUndefined(),
      );
    });

    it("delivers a real send, resumes from its opaque cursor and delivers the next send once", async () => {
      const first = await identify();
      const sent = await owner.send(channelId, {
        type: "text",
        text: "first gateway message",
      });
      const delivered = await first.event(sent.messageId);
      expect(
        delivered.events.find(
          (event: Frame) => event.sourceId === sent.messageId,
        ),
      ).toMatchObject({ type: "message", channelId });
      first.ws.close();
      await first.close();
      const resumed = await identify(delivered.cursor);
      expect(
        resumed.frames
          .filter((f) => f.op === "events")
          .flatMap((f) => f.events),
      ).not.toContainEqual(
        expect.objectContaining({ sourceId: sent.messageId }),
      );
      const next = await owner.send(channelId, {
        type: "text",
        text: "after resume",
      });
      await resumed.event(next.messageId);
      expect(
        resumed.frames
          .filter((f) => f.op === "events")
          .flatMap((f) => f.events)
          .filter((event: Frame) => event.sourceId === next.messageId),
      ).toHaveLength(1);
      resumed.ws.close();
      await resumed.close();
    });

    it("refuses human credentials, binary frames and token-bearing URLs without logging their query", async () => {
      const human = connect();
      await human.frame("hello");
      human.ws.send(JSON.stringify({ op: "identify", token: owner.token }));
      expect(await human.close()).toBe(4401);
      const binary = connect();
      await binary.frame("hello");
      binary.ws.send(Buffer.from("{}"));
      expect(await binary.close()).toBe(4400);
      const url = connect("?token=must-never-be-logged");
      expect(await url.close()).toBe(4503);
      expect(logUrl("/v2/bot/gateway?token=must-never-be-logged")).toBe(
        "/v2/bot/gateway",
      );
    });

    it("caps concurrent bot sessions and closes a silent unauthenticated socket", async () => {
      const first = await identify(),
        second = await identify();
      const third = connect();
      await third.frame("hello");
      third.ws.send(JSON.stringify({ op: "identify", token }));
      expect(await third.close()).toBe(4429);
      first.ws.close();
      second.ws.close();
      await Promise.all([first.close(), second.close()]);
      expect(await connect().close()).toBe(4401);
    });

    it("closes promptly on rotation and installation revocation; old credentials cannot resume", async () => {
      const prior = await identify();
      const cursor = (await prior.frame("events")).cursor;
      const rotated = await owner.req(
        "POST",
        `/v2/developer/bots/${botId}/token`,
      );
      expect(await prior.close()).toBe(4401);
      const old = connect();
      await old.frame("hello");
      old.ws.send(JSON.stringify({ op: "resume", token, cursor }));
      expect(await old.close()).toBe(4401);
      token = rotated.token;
      const current = await identify(cursor);
      await owner.req("DELETE", `/v1/orgs/${orgId}/bots/${botId}`);
      expect(await current.close()).toBe(4401);
    });
  },
);
