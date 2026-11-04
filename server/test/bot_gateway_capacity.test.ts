import WebSocket from "ws";
import fs from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BotGatewayServerFrame } from "../src/shared/contracts/botGateway.js";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

/** Real loopback sockets and PostgreSQL. This is bounded admission/fan-out qualification, not a hosting benchmark. */
describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "bot gateway concurrent capacity",
  () => {
    let h: Harness, owner: GriipClient, channelId: string;
    const bots: { id: string; token: string }[] = [];
    const connections = new Set<ReturnType<typeof connect>>();
    const baseline: number[] = [];

    function connect(bot: { token: string }, address: string) {
      const socket = new WebSocket(
        h.baseUrl.replace("http", "ws") + "/v2/bot/gateway",
        {
          // Only the owned loopback test server trusts this simulated proxy. No production proxy policy changes.
          headers: { "x-forwarded-for": address },
        },
      );
      const state = {
        socket,
        hello: false,
        ready: false,
        closed: 0,
        invalid: false,
        sourceIds: new Set<string>(),
        batches: 0,
      };
      connections.add(state);
      const heartbeat = setInterval(() => {
        if (state.ready && socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ op: "heartbeat" }));
      }, 5_000);
      socket.on("message", (raw) => {
        const frame = BotGatewayServerFrame.safeParse(
          JSON.parse(raw.toString()),
        );
        if (!frame.success) {
          state.invalid = true;
          return;
        }
        if (frame.data.op === "hello") {
          state.hello = true;
          socket.send(JSON.stringify({ op: "identify", token: bot.token }));
        } else if (frame.data.op === "ready") state.ready = true;
        else if (frame.data.op === "events") {
          state.batches++;
          for (const event of frame.data.events)
            if (event.type === "message" && event.sourceId)
              state.sourceIds.add(event.sourceId);
        }
      });
      socket.on("close", (code) => {
        state.closed = code;
        clearInterval(heartbeat);
        connections.delete(state);
      });
      socket.on("error", () => {
        state.invalid = true;
      });
      return state;
    }

    async function settle(state: ReturnType<typeof connect>) {
      await vi.waitFor(() => expect(state.ready || !!state.closed).toBe(true), {
        timeout: 20_000,
        interval: 20,
      });
      return state;
    }

    async function closeAll() {
      const current = [...connections];
      for (const state of current) state.socket.close();
      await vi.waitFor(() => expect(connections.size).toBe(0), {
        timeout: 10_000,
      });
    }

    beforeAll(async () => {
      h = await startServer({ TRUST_PROXY: "loopback", WORKFLOW_TICK_MS: "0" });
      expect(h.ctx.postgres).toBeDefined();
      expect(h.ctx.ws.backend).toBe("postgres");
      owner = await h.client("gatewaycapacityowner");
      owner.serverMessages = true;
      const orgId = (
        await owner.req("POST", "/v1/orgs", { name: "Gateway capacity lab" })
      ).org.id;
      channelId = (await owner.req("GET", `/v1/orgs/${orgId}/channels`))
        .channels[0].id;
      for (let i = 0; i < 20; i++) {
        const started = performance.now();
        await owner.send(channelId, {
          type: "text",
          text: "Synthetic baseline message",
        });
        baseline.push(performance.now() - started);
      }
      // Keep the actual two-bot personal plan limit; no paid grants, quota override or synthetic admin bypass.
      let developer = owner;
      for (let i = 0; i < 51; i++) {
        if (i > 0 && i % 2 === 0)
          developer = await h.client(`gatewaycapacity${i}`);
        const made = await developer.req("POST", "/v2/developer/bots", {
          name: `Capacity helper ${i}`,
          public: true,
        });
        const permissions = ["events.read", "messages.history"];
        await developer.req(
          "PUT",
          `/v2/developer/bots/${made.bot.id}/permissions`,
          { permissions, rev: 0 },
        );
        // Provision fixtures through the ordinary owner-authorized domain services. This qualifies gateway
        // admission/fan-out rather than the separate HTTP installation/review rate limits.
        await h.ctx.bots.install(owner.userId, orgId, made.bot.id);
        await h.ctx.bots.permissions.approve(owner.userId, orgId, made.bot.id, {
          permissions: ["events.read", "messages.history"],
          manifestRev: 1,
          rev: 0,
        });
        bots.push({ id: made.bot.id, token: made.token });
      }
    }, 180_000);
    afterEach(closeAll);
    afterAll(async () => {
      await closeAll();
      await h?.close();
    });

    it("applies independent per-bot and per-address limits during concurrent identification", async () => {
      const admitted = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          settle(connect(bots[Math.floor(i / 2)], "198.18.0.1")),
        ),
      );
      expect(
        admitted.every(
          (state) => state.ready && !state.invalid && !state.closed,
        ),
      ).toBe(true);
      const addressLimited = await settle(connect(bots[4], "198.18.0.1"));
      expect(addressLimited).toMatchObject({
        hello: false,
        ready: false,
        closed: 4429,
      });
      const botLimited = await settle(connect(bots[0], "198.18.0.2"));
      expect(botLimited).toMatchObject({
        hello: true,
        ready: false,
        closed: 4429,
      });
      expect(connections.size).toBe(8);
    }, 60_000);

    it("fans out to 100 authenticated sockets, refuses the 101st and releases every slot", async () => {
      const admitted = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          settle(
            connect(
              bots[Math.floor(i / 2)],
              `198.18.1.${1 + Math.floor(i / 8)}`,
            ),
          ),
        ),
      );
      expect(
        admitted.every(
          (state) => state.ready && !state.invalid && !state.closed,
        ),
      ).toBe(true);
      const overflow = await settle(connect(bots[50], "198.18.2.1"));
      expect(overflow).toMatchObject({
        hello: false,
        ready: false,
        closed: 4429,
      });
      const samples: number[] = [],
        ids: string[] = [];
      const started = performance.now();
      for (let i = 0; i < 40; i++) {
        const at = performance.now();
        const message = await owner.send(channelId, {
          type: "text",
          text: "Synthetic capacity message",
        });
        samples.push(performance.now() - at);
        ids.push(message.messageId);
      }
      await vi.waitFor(
        () => {
          for (const state of admitted) {
            expect(state.invalid || !!state.closed).toBe(false);
            expect(ids.every((id) => state.sourceIds.has(id))).toBe(true);
          }
        },
        { timeout: 30_000, interval: 50 },
      );
      const elapsed = performance.now() - started;
      const percentile = (values: number[], fraction: number) =>
        [...values].sort((a, b) => a - b)[
          Math.floor((values.length - 1) * fraction)
        ];
      // Aggregate timings only. Client and server share this process and machine; no production SLO claim.
      const report = {
        scope:
          "loopback PostgreSQL HTTP + 100 same-process WebSocket clients; bounded fan-out qualification",
        baselineMessages: baseline.length,
        baselineP95Ms: percentile(baseline, 0.95),
        loadedMessages: ids.length,
        loadedP95Ms: percentile(samples, 0.95),
        allRecipients: admitted.length,
        observedDeliveries: admitted.reduce(
          (sum, state) =>
            sum + ids.filter((id) => state.sourceIds.has(id)).length,
          0,
        ),
        elapsedMs: elapsed,
        processRssBytes: process.memoryUsage().rss,
      };
      console.info(JSON.stringify(report));
      if (process.env.MELDIQ_BOT_CAPACITY_REPORT)
        fs.writeFileSync(
          process.env.MELDIQ_BOT_CAPACITY_REPORT,
          JSON.stringify(report, null, 2) + "\n",
          { mode: 0o600 },
        );
      expect(
        h.ctx.hub
          .connections()
          .filter((connection) =>
            bots.some((bot) => bot.id === connection.userId),
          ),
      ).toEqual([]);
      await closeAll();
      const replacement = await settle(connect(bots[50], "198.18.2.2"));
      expect(replacement).toMatchObject({
        ready: true,
        closed: 0,
        invalid: false,
      });
    }, 90_000);
  },
);
