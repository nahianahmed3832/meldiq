import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { BotEventWebhooks } from "../src/modules/bots/eventWebhooks.js";
import * as transport from "../src/modules/bots/webhookTransport.js";

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)("outbound event destination lifecycle (local PostgreSQL)", () => {
  let h: Harness, owner: GriipClient, other: GriipClient, id: string, token: string, org: string, channel: string, endpoint: string;
  let manifestRev: number, approvalRev: number, secret: Buffer, offset = 0;
  const deliveries: Array<{ id: string; body: string }> = [];
  let prove = false, status = 503, beforeSend: (() => Promise<void>) | undefined;
  const webhookPath = "/meldiq-events";
  const setup = () => owner.req("PUT", endpoint, { communityId: org, url: "https://sink.meldiq.net" + webhookPath });
  const activate = (generation: string) => owner.req("POST", endpoint + "/activate", { generation });
  const post = (text: string) => owner.send(channel, { type: "text", text });
  const approval = (permissions: string[]) => owner.req("PUT", `/v1/orgs/${org}/bots/${id}/permissions`, {
    permissions, manifestRev, rev: approvalRev,
  }).then((result) => { approvalRev = result.rev; });

  beforeAll(async () => {
    vi.spyOn(BotEventWebhooks.prototype, "start").mockImplementation(async () => {});
    vi.spyOn(transport, "deliverWebhook").mockImplementation(async (url, input, _signal, allow) => {
      expect(url.pathname).toBe(webhookPath);
      if (input.readProof) {
        if (!(await allow())) return undefined;
        const { nonce } = JSON.parse(input.body.toString());
        const proof = "v1=" + createHmac("sha256", secret).update("meldiq.bot.webhook.verify.v1\n" + nonce).digest("hex");
        return { status: 200, proof: prove ? proof : "OK" };
      }
      const wait = beforeSend;
      beforeSend = undefined;
      await wait?.();
      if (!(await allow())) return undefined;
      deliveries.push({ id: input.id, body: input.body.toString() });
      return { status, proof: "" };
    });
    h = await startServer({
      BOT_EVENT_WEBHOOK_HOSTS: "sink.meldiq.net",
      BOT_EVENT_WEBHOOK_MASTER_KEY: randomBytes(32).toString("base64url"),
    });
    h.ctx.bots.clock = () => Date.now() + offset;
    owner = await h.client("webhookowner"); owner.serverMessages = true;
    other = await h.client("webhookother");
    org = (await owner.req("POST", "/v1/orgs", { name: "Webhook lab" })).org.id;
    channel = (await owner.req("GET", `/v1/orgs/${org}/channels`)).channels[0].id;
    const created = await owner.req("POST", "/v2/developer/bots", { name: "External events" });
    id = created.bot.id;
    token = created.token;
    endpoint = `/v2/developer/bots/${id}/event-webhook`;
    await owner.req("POST", `/v1/orgs/${org}/bots`, { botId: id });
    const permission = await owner.req("PUT", `/v2/developer/bots/${id}/permissions`, { permissions: ["events.read", "messages.history"], rev: 0 });
    manifestRev = permission.rev;
    approvalRev = 0;
  });

  afterAll(async () => { await h?.close(); vi.restoreAllMocks(); });

  it("requires owner and installation approval, rejects an unlisted endpoint, and keeps the secret out of subsequent reads", async () => {
    await expect(setup()).rejects.toMatchObject({ status: 403 });
    await expect(other.req("GET", endpoint)).rejects.toMatchObject({ status: 404 });
    const botLogin = await fetch(h.baseUrl + endpoint, { headers: { authorization: `Bot ${token}` } });
    expect(botLogin.status).toBe(401);
    await approval(["events.read", "messages.history"]);
    await expect(owner.req("PUT", endpoint, { communityId: org, url: "https://not-approved.net/hooks" })).rejects.toMatchObject({ status: 400 });
    const created = await setup();
    secret = Buffer.from(created.signingSecret, "base64url");
    expect(secret).toHaveLength(32);
    expect(created.webhook).toMatchObject({ active: false, communityId: org });
    await expect(activate(created.webhook.generation)).rejects.toMatchObject({ status: 400 });
    const read = await owner.req("GET", endpoint);
    expect(read).toEqual({ webhook: created.webhook });
    await expect(h.ctx.postgres!.database.transaction(async () => {
      await h.ctx.postgres!.database.query("SET LOCAL ROLE authenticated");
      await h.ctx.postgres!.database.query("SELECT 1 FROM meldiq_private.bot_event_webhooks");
    })).rejects.toMatchObject({ code: "42501" });
  });

  it("starts after proof, retries once across workers with a stable ID, and only emits approved community event IDs", async () => {
    const current = await owner.req("GET", endpoint);
    await post("pre-activation text");
    prove = true;
    expect((await activate(current.webhook.generation)).webhook.active).toBe(true);
    const elsewhere = (await owner.req("POST", "/v1/orgs", { name: "Unrelated webhook lab" })).org.id;
    const otherChannel = (await owner.req("GET", `/v1/orgs/${elsewhere}/channels`)).channels[0].id;
    await owner.send(otherChannel, { type: "text", text: "wrong community" });
    const message = await post("no plaintext on the outbound transport");
    const db = h.ctx.postgres!.database;
    const feed = await fetch(h.baseUrl + "/v2/bot/events", { headers: { authorization: `Bot ${token}` } });
    expect((await feed.json()).events).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: message.messageId })]));
    const workers = [h.ctx.bots.eventWebhooks, new BotEventWebhooks(h.ctx.bots)];
    await Promise.all(workers.map((worker) => worker.runOnce()));
    const row = (await db.query("SELECT active,position,attempts,claim,last_result FROM meldiq_private.bot_event_webhooks")).rows[0];
    expect(deliveries, JSON.stringify(row)).toHaveLength(1);
    expect(JSON.parse(deliveries[0]!.body)).toMatchObject({ type: "event", event: { communityId: org, sourceId: message.messageId } });
    expect(JSON.parse(deliveries[0]!.body).event).not.toHaveProperty("data");
    expect(deliveries[0]!.body).not.toContain("no plaintext");
    await workers[0]!.runOnce();
    expect(deliveries).toHaveLength(1);
    offset += 10_001;
    status = 204;
    await Promise.all(workers.map((worker) => worker.runOnce()));
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect((await owner.req("GET", endpoint)).webhook.lastResult).toBe("delivered");
  });

  it("bounds transient retries and moves past an exhausted event", async () => {
    const message = await post("delivery will exhaust");
    status = 503;
    const sizes = deliveries.length;
    for (const delay of [0, 10_001, 60_001, 300_001, 900_001]) {
      offset += delay;
      await h.ctx.bots.eventWebhooks.runOnce();
    }
    const retried = deliveries.slice(sizes);
    expect(retried).toHaveLength(5);
    expect(new Set(retried.map((d) => d.id)).size).toBe(1);
    expect(JSON.parse(retried[0]!.body).event.sourceId).toBe(message.messageId);
    expect((await owner.req("GET", endpoint)).webhook.lastResult).toBe("exhausted");
    status = 204;
    const fresh = await post("delivery can continue");
    await h.ctx.bots.eventWebhooks.runOnce();
    expect(JSON.parse(deliveries.at(-1)!.body).event.sourceId).toBe(fresh.messageId);
  });

  it("rechecks installation on the send boundary and cannot reuse a stale proof after approval or token changes", async () => {
    const before = deliveries.length;
    await post("scheduled before permission withdrawal");
    beforeSend = () => approval([]);
    await h.ctx.bots.eventWebhooks.runOnce();
    expect(deliveries).toHaveLength(before);
    const withdrawn = (await owner.req("GET", endpoint)).webhook;
    expect(withdrawn.active).toBe(false);
    await approval(["events.read", "messages.history"]);
    await expect(activate(withdrawn.generation)).rejects.toMatchObject({ status: 409 });
    const replacement = await setup();
    const oldSecret = secret;
    secret = Buffer.from(replacement.signingSecret, "base64url");
    expect(secret.equals(oldSecret)).toBe(false);
    await activate(replacement.webhook.generation);
    await owner.req("POST", `/v2/developer/bots/${id}/token`);
    await post("after rotation");
    await h.ctx.bots.eventWebhooks.runOnce();
    expect(deliveries).toHaveLength(before);
    expect((await owner.req("GET", endpoint)).webhook.active).toBe(false);
    await owner.req("DELETE", endpoint);
    expect(await owner.req("GET", endpoint)).toEqual({ webhook: null });
  });

  it("dispatches new work without a pull client when the configured scheduler starts", async () => {
    vi.mocked(BotEventWebhooks.prototype.start).mockRestore();
    const created = await setup();
    secret = Buffer.from(created.signingSecret, "base64url");
    await activate(created.webhook.generation);
    const sent = await post("scheduled by the worker");
    await h.ctx.bots.eventWebhooks.start();
    await vi.waitFor(() => {
      expect(JSON.parse(deliveries.at(-1)!.body).event.sourceId).toBe(sent.messageId);
    }, { timeout: 3_000 });
  });

});
