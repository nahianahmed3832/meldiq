import crypto from "node:crypto";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { type GriipClient, sign } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { queuedCount, queuedRows } from "./support/relay.js";

let h: Harness;
let alice: GriipClient, bob: GriipClient, carol: GriipClient;
let dmId: string;

beforeAll(async () => {
  h = await startServer();
  alice = await h.client("alice");
  bob = await h.client("bob");
  carol = await h.client("carol");
  dmId = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
});
afterAll(async () => h.close());

describe("end-to-end encrypted messaging", () => {
  it("delivers a message in real time both ways and the relay holds only ciphertext", async () => {
    await alice.connect();
    await bob.connect();
    bob.autoAck = false; // keep the row so we can inspect what the server stores
    const secret = `the launch code is ${crypto.randomUUID()}`;
    await alice.send(dmId, { type: "text", text: secret });
    const got = await bob.waitFor(() => bob.received.find((m) => m.payload.text === secret));
    expect(got.senderUserId).toBe(alice.userId);

    const rows = await queuedRows(h);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.payload).not.toContain(secret.slice(0, 20));
    if (h.ctx.postgres) {
      const stored = await h.ctx.postgres.database.query<{payload:string}>("SELECT payload FROM meldiq.delivery_queue");
      expect(stored.rows.length).toBeGreaterThan(0);
      for (const row of stored.rows) expect(row.payload).not.toContain(secret.slice(0, 20));
    } else {
      const dbFile = fs.readFileSync(h.ctx.config.databasePath + "-wal").toString("latin1") + fs.readFileSync(h.ctx.config.databasePath).toString("latin1");
      expect(dbFile).not.toContain(secret.slice(0, 20));
    }

    bob.ws!.send(JSON.stringify({ t: "ack", ids: [got.queueId] }));
    await new Promise((r) => setTimeout(r, 100));
    bob.autoAck = true;
    await bob.send(dmId, { type: "text", text: "copy that" });
    await alice.waitFor(() => alice.received.find((m) => m.payload.text === "copy that"));
  });

  it("removes acknowledged items and sends a delivery receipt to the sender", async () => {
    const r = await alice.send(dmId, { type: "text", text: "receipt please" });
    await bob.waitFor(() => bob.received.find((m) => m.messageId === r.messageId));
    const receipt = await alice.waitFor(() => alice.receipts.find((x) => x.messageId === r.messageId));
    expect(receipt.payload.status).toBe("delivered");
    expect(receipt.senderUserId).toBe(bob.userId);
    await new Promise((res) => setTimeout(res, 100));
    const left = { n: await queuedCount(h, (q) => q.message_id === r.messageId && q.kind === "envelope") };
    expect(left.n).toBe(0);
  });

  it("queues for offline recipients and delivers after reconnect", async () => {
    await bob.disconnect();
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) sent.push((await alice.send(dmId, { type: "text", text: `offline #${i}` })).messageId);
    const queued = { n: await queuedCount(h, (q) => q.recipient_device_id === bob.deviceId && q.kind === "envelope") };
    expect(queued.n).toBe(3);
    bob.received = [];
    await bob.connect();
    await bob.waitFor(() => sent.every((id) => bob.received.some((m) => m.messageId === id)));
    expect(bob.received.filter((m) => m.payload.text?.startsWith("offline")).map((m) => m.payload.text)).toEqual(["offline #0", "offline #1", "offline #2"]);
    await bob.waitFor(() => bob.events.some((e) => e.t === "queue.drained"));
  });

  it("is idempotent for retried submissions (duplicate suppression)", async () => {
    const id = crypto.randomUUID();
    const first = await alice.send(dmId, { type: "text", text: "once" }, "message", id);
    const again = await alice.send(dmId, { type: "text", text: "once" }, "message", id);
    expect(again.duplicate).toBe(true);
    expect(again.serverTs).toBe(first.serverTs);
    await new Promise((r) => setTimeout(r, 200));
    expect(bob.received.filter((m) => m.messageId === id)).toHaveLength(1);
  });

  it("rejects envelopes with a bad signature or a stale device list", async () => {
    const keys = await alice.conversationKeys(dmId);
    const bobDevices = keys.find((u) => u.userId === bob.userId)!.devices;
    const env = await alice.encrypt(dmId, { type: "text", text: "tamper" }, "message", bobDevices);
    const tampered = { ...env, ciphertext: Buffer.from("garbage-garbage-garbage").toString("base64") };
    const e1 = await expectStatus(alice.req("POST", "/v1/messages", tampered), 400);
    expect(e1.error.code).toBe("bad_signature");
    const missing = await alice.encrypt(dmId, { type: "text", text: "partial" }, "message", []);
    const e2 = await expectStatus(alice.req("POST", "/v1/messages", missing), 409);
    expect(e2.error.code).toBe("device_mismatch");
    expect(e2.error.details.missing[0].deviceId).toBe(bob.deviceId);
    // Wrong signer: sign with a key that isn't the sending device
    const env2 = await alice.encrypt(dmId, { type: "text", text: "x" }, "message", bobDevices);
    env2.signature = sign(carol.device, "anything");
    await expectStatus(alice.req("POST", "/v1/messages", env2), 400);
  });

  it("delivers group messages only to the intended members", async () => {
    await carol.connect();
    const dave = await h.client("dave");
    await dave.connect();
    const g = (await alice.req("POST", "/v1/conversations/group", { name: "Launch crew", memberIds: [bob.userId, carol.userId] })).conversation;
    const r = await alice.send(g.id, { type: "text", text: "group hello" });
    await bob.waitFor(() => bob.received.find((m) => m.messageId === r.messageId));
    await carol.waitFor(() => carol.received.find((m) => m.messageId === r.messageId));
    await new Promise((res) => setTimeout(res, 150));
    expect(dave.received.find((m) => m.messageId === r.messageId)).toBeUndefined();
    // Non-member can't fetch keys or post
    await expectStatus(dave.req("GET", `/v1/conversations/${g.id}/devices`), 404);
    const env = await dave.encrypt(g.id, { type: "text", text: "intrude" }, "message", []);
    await expectStatus(dave.req("POST", "/v1/messages", env), 404);
  });

  it("relays typing indicators to other members only", async () => {
    alice.ws!.send(JSON.stringify({ t: "typing", c: dmId, on: true }));
    const ev = await bob.waitFor(() => bob.events.find((e) => e.t === "typing" && e.c === dmId));
    expect(ev.u).toBe(alice.userId);
    expect(carol.events.find((e) => e.t === "typing" && e.c === dmId)).toBeUndefined();
  });

  it("supports multi-device: sender's other devices receive a copy", async () => {
    // bob adds a second device via his identity key
    const { GriipClient, canonical } = await import("./support/griipClient.js");
    const bob2 = new GriipClient(h.baseUrl, bob.username);
    bob2.identity = bob.identity;
    const { nonce } = await bob2.req("POST", "/v1/auth/challenge");
    const r = await bob2.req("POST", "/v1/auth/add-device", {
      username: bob.username,
      device: { name: "tablet", signingKey: bob2.signingKeyB64, encryptionKey: bob2.encKeyB64, certificate: bob2.certificate() },
      nonce,
      signature: sign(bob2.device, canonical.authProof("add-device", nonce, bob2.signingKeyB64)),
    });
    Object.assign(bob2, { userId: r.userId, deviceId: r.deviceId, token: r.sessionToken });
    await bob2.connect();
    const m = await alice.send(dmId, { type: "text", text: "to both of bob's phones" });
    await bob.waitFor(() => bob.received.find((x) => x.messageId === m.messageId));
    await bob2.waitFor(() => bob2.received.find((x) => x.messageId === m.messageId));
    const own = await bob.send(dmId, { type: "text", text: "sync to my tablet" });
    await bob2.waitFor(() => bob2.received.find((x) => x.messageId === own.messageId));
    await bob2.disconnect();
  });
});

describe("announcement channels", () => {
  it("lets only managers post", async () => {
    const boss = await h.client("boss");
    const staff = await h.client("staff");
    const org = (await boss.req("POST", "/v1/orgs", { name: "Acme" })).org;
    const code = (await boss.req("POST", `/v1/orgs/${org.id}/invites`, { role: "MEMBER" })).invite.code;
    await staff.req("POST", "/v1/invites/accept", { code });
    const ch = (await boss.req("POST", `/v1/orgs/${org.id}/channels`, { name: "news", scope: "ORG", kind: "ANNOUNCEMENT" })).channel;
    await boss.send(ch.id, { type: "text", text: "Q4 all-hands Friday" });
    const env = await staff.encrypt(ch.id, { type: "text", text: "me too" }, "message", []);
    const err = await expectStatus(staff.req("POST", "/v1/messages", env), 403);
    expect(err.error.message).toMatch(/announcement/i);
    const view = (await staff.req("GET", `/v1/conversations/${ch.id}`)).conversation;
    expect(view.canPost).toBe(false);
  });

  it("refuses members' controls too (reactions, pins), so the app must not offer them", async () => {
    const boss = await h.client("boss2");
    const staff = await h.client("staff2");
    const org = (await boss.req("POST", "/v1/orgs", { name: "Acme" })).org;
    const code = (await boss.req("POST", `/v1/orgs/${org.id}/invites`, { role: "MEMBER" })).invite.code;
    await staff.req("POST", "/v1/invites/accept", { code });
    const ch = (await boss.req("POST", `/v1/orgs/${org.id}/channels`, { name: "news", scope: "ORG", kind: "ANNOUNCEMENT" })).channel;
    const post = await boss.send(ch.id, { type: "text", text: "Office closed Monday" });
    // The server can't read the payload type, so it refuses every envelope from a non-poster.
    for (const payload of [{ type: "reaction", target: post.messageId, emoji: "👍", add: true }, { type: "pin", target: post.messageId, pinned: true }]) {
      const env = await staff.encrypt(ch.id, payload, "control", []);
      await expectStatus(staff.req("POST", "/v1/messages", env), 403);
    }
    const ok = await boss.send(ch.id, { type: "pin", target: post.messageId, pinned: true }, "control");
    expect(ok.messageId).toBeTruthy();
  });
});

describe("retention", () => {
  it("expires queued envelopes: not retrievable after TTL, deleted by cleanup", async () => {
    const h2 = await startServer({ QUEUE_TTL_SECONDS: "1" });
    try {
      const a = await h2.client("ttla");
      const b = await h2.client("ttlb");
      const dm = (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id;
      await a.send(dm, { type: "text", text: "self-destruct" });
      const before = await b.req("GET", "/v1/queue");
      expect(before.items).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 1200));
      // Expired items are filtered on read even before the cleanup job runs
      expect((await b.req("GET", "/v1/queue")).items).toHaveLength(0);
      await b.connect();
      await new Promise((r) => setTimeout(r, 200));
      expect(b.received).toHaveLength(0);
      const raw = { n: await queuedCount(h2) };
      expect(raw.n).toBe(1);
      const res = await runCleanup(h2.ctx);
      expect(res.queue).toBe(1);
      expect(await queuedCount(h2)).toBe(0);
    } finally {
      await h2.close();
    }
  });

  it("caps the queue TTL at 7 days regardless of configuration", async () => {
    const h3 = await startServer({ QUEUE_TTL_SECONDS: String(30 * 24 * 3600) });
    try {
      expect(h3.ctx.config.queueTtlSeconds).toBe(7 * 24 * 3600);
    } finally {
      await h3.close();
    }
  });
});
