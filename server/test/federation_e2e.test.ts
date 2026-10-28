/**
 * Federation acceptance (docs/TESTING.md §8): two isolated home servers (A, B), three core nodes, reference clients
 * that encrypt and verify exactly like the Android app. A message counts as delivered only when the recipient's own
 * client verified the sender's certified device against the pinned identity key and decrypted it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerIdentity } from "../src/modules/federation/identity.js";
import { signedHeaders } from "../src/modules/federation/transport.js";
import { signRecord } from "../src/modules/federation/sign.js";
import { fedDmId } from "../src/modules/federation/service.js";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";
import { startCores, stopCores, type TestCore, tempIdentity } from "./support/federation.js";
import { queuedCount } from "./support/relay.js";

let cores: TestCore[];
let A: Harness;
let B: Harness;
let C: Harness;
let alice: GriipClient;
let bob: GriipClient;
let conv: string;

const fedEnv = (domain: string) => ({
  FEDERATION_DOMAIN: domain,
  FEDERATION_CORE_NODES: cores.map((c) => `${c.url}#${c.node.key.publicKey}`).join(","),
  FEDERATION_CORE_QUORUM: "2",
  FEDERATION_ALLOW_HTTP: "true",
  FEDERATION_HEARTBEAT_SECONDS: "0",
  FEDERATION_OUTBOX_INTERVAL_MS: "0",
});

const flushAll = async () => {
  for (let i = 0; i < 3; i++) {
    await A.ctx.federation!.flush();
    await B.ctx.federation!.flush();
  }
};

/** Every SQLite file of a server (database + WAL) as one buffer, to search for plaintext. */
const dbBytes = (h: Harness) =>
  Buffer.concat(
    fs
      .readdirSync(h.dir)
      .filter((f) => f.startsWith("griip.sqlite"))
      .map((f) => fs.readFileSync(path.join(h.dir, f))),
  );

beforeAll(async () => {
  cores = await startCores(3);
  A = await startServer(fedEnv("a.test"));
  B = await startServer(fedEnv("b.test"));
  C = await startServer(fedEnv("c.test"));
  for (const h of [A, B, C]) {
    const r = await h.ctx.federation!.announce();
    expect(r.every((x) => x.status === 200 && x.state === "active")).toBe(true);
  }
  alice = await A.client("alice", "Alice");
  bob = await B.client("bob", "Bob");
  await alice.connect();
  await bob.connect();
}, 60_000);

afterAll(async () => {
  for (const h of [A, B, C]) await h?.close();
  await stopCores(cores);
});

describe("global identity and discovery", () => {
  it("tells a person their global address", async () => {
    expect(await alice.req("GET", "/v1/federation/info")).toMatchObject({ enabled: true, address: `@${alice.username}:a.test` });
  });

  it("resolves @bob:b.test from server A through a core-node quorum, with Bob's real ids and keys", async () => {
    const r = await alice.req("GET", `/v1/federation/resolve?address=${encodeURIComponent(`@${bob.username}:b.test`)}`);
    expect(r.user.id).toBe(bob.userId); // same id on both servers (envelopes are signed over it)
    expect(r.user.identityKey).toBe(bob.identityKeyB64);
    expect(r.user.address).toBe(`@${bob.username}:b.test`);
    expect(r.user.homeServer).toBe(B.ctx.federation!.serverId);
    expect(r.server).toMatchObject({ serverId: B.ctx.federation!.serverId, domain: "b.test", state: "active", source: "quorum" });
    expect(r.server.verifiedBy).toBeGreaterThanOrEqual(2);
  });

  it("finds nobody for unknown names or servers, and refuses lookups of local addresses that don't exist", async () => {
    await expect(alice.req("GET", `/v1/federation/resolve?address=@nobody123:b.test`)).rejects.toMatchObject({ status: 404 });
    await expect(alice.req("GET", `/v1/federation/resolve?address=@bob:unknown.test`)).rejects.toMatchObject({ status: 404 });
    await expect(alice.req("GET", `/v1/federation/resolve?address=not-an-address`)).rejects.toMatchObject({ status: 400 });
  });

  it("shadows of remote users can't sign in, aren't searchable, and can't join local groups", async () => {
    const shadow = A.ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(bob.userId) as any;
    expect(shadow.home_server_id).toBe(B.ctx.federation!.serverId);
    expect(shadow.username).toBe(`${bob.username}:b.test`);
    const s = await alice.req("GET", `/v1/users/search?q=${encodeURIComponent(bob.username)}`);
    expect(s.users.map((u: any) => u.id)).not.toContain(bob.userId);
    await expect(alice.req("POST", "/v1/conversations/group", { name: "mixed", memberIds: [bob.userId] })).rejects.toMatchObject({ status: 400 });
    const { nonce } = await alice.req("POST", "/v1/auth/challenge");
    await expect(alice.req("POST", "/v1/auth/login", { deviceId: bob.deviceId, nonce, signature: "A".repeat(86) + "==" })).rejects.toMatchObject({ status: 401 });
  });
});

describe("cross-server messaging", () => {
  it("delivers end-to-end encrypted messages both ways between two home servers", async () => {
    const dm = await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId });
    conv = dm.conversation.id;
    expect(conv).toBe(fedDmId([alice.userId, bob.userId].sort().join("|")));
    expect(dm.conversation.federation.servers[0]).toMatchObject({ domain: "b.test" });

    await alice.send(conv, { type: "text", text: "secret-from-alice-7731" });
    expect(A.ctx.federation!.pendingFor(B.ctx.federation!.serverId)).toBeGreaterThan(0);
    await flushAll();
    const got = await bob.waitFor(() => bob.received.find((m) => m.payload.text === "secret-from-alice-7731"));
    expect(got.senderUserId).toBe(alice.userId);
    expect(got.conversationId).toBe(conv); // same conversation id on B

    const onB = await bob.req("GET", "/v1/conversations");
    const c = onB.conversations.find((x: any) => x.id === conv);
    expect(c.members.map((m: any) => m.username)).toContain(`${alice.username}:a.test`);

    await bob.send(conv, { type: "text", text: "secret-from-bob-4410" });
    await flushAll();
    const back = await alice.waitFor(() => alice.received.find((m) => m.payload.text === "secret-from-bob-4410"));
    expect(back.senderUserId).toBe(bob.userId);
  });

  it("returns delivery receipts across servers", async () => {
    await flushAll(); // Bob's acknowledgement produced a receipt on B for Alice's device on A
    const r = await alice.waitFor(() => alice.receipts.find((x) => x.senderUserId === bob.userId));
    expect(r.payload.status).toBe("delivered");
  });

  it("keeps no plaintext in either server's database, queue or outbox", async () => {
    await flushAll();
    for (const h of [A, B]) {
      const bytes = dbBytes(h);
      expect(bytes.includes(Buffer.from("secret-from-alice-7731"))).toBe(false);
      expect(bytes.includes(Buffer.from("secret-from-bob-4410"))).toBe(false);
    }
  });

  it("queues for an offline recipient and delivers on reconnect; retries are deduplicated", async () => {
    await bob.disconnect();
    await alice.send(conv, { type: "text", text: "while-you-were-away" });
    await flushAll();
    const queued = { n: await queuedCount(B, (r) => r.recipient_device_id === bob.deviceId) };
    expect(queued.n).toBeGreaterThan(0);
    await bob.connect();
    await bob.waitFor(() => bob.received.find((m) => m.payload.text === "while-you-were-away"));
    const before = bob.received.length;
    const fedA = A.ctx.federation!;
    const peerB = await fedA.resolver.server(B.ctx.federation!.serverId);
    const lastKey = (B.ctx.db.prepare("SELECT item_key FROM federation_inbox ORDER BY rowid DESC LIMIT 1").get() as { item_key: string }).item_key.split("|")[1];
    const r = await fedA.request(peerB, "POST", "/fed/v1/deliver", { items: [{ key: lastKey, kind: "envelope" }], senders: [] });
    expect(r.json.results[0]).toMatchObject({ status: "accepted" });
    await new Promise((res) => setTimeout(res, 300));
    expect(bob.received.length).toBe(before);
  });

  it("bounds the outbox: a full queue to one server refuses new sends instead of growing", async () => {
    const fed = A.ctx.federation!;
    const old = fed.cfg.outboxMaxPerPeer;
    fed.cfg.outboxMaxPerPeer = 0;
    try {
      await expect(alice.send(conv, { type: "text", text: "no-room" })).rejects.toMatchObject({ status: 503 });
    } finally {
      fed.cfg.outboxMaxPerPeer = old;
    }
    // Expired items are dropped, never delivered late.
    fed.enqueue(B.ctx.federation!.serverId, "receipt", "test:expired", { k: 1 }, 1, Date.now() - 1);
    expect(fed.cleanup().outbox).toBeGreaterThanOrEqual(1);
  });
});

describe("attachments and voice messages across servers", () => {
  it("pushes the ciphertext to the recipient's server; the recipient downloads, verifies and decrypts it there", async () => {
    const audio = crypto.randomBytes(20_000); // stands in for an AAC clip
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const ct = Buffer.concat([c.update(audio), c.final(), c.getAuthTag()]);
    const up = await alice.req("POST", `/v1/attachments?conversationId=${conv}`, undefined, ct);
    const ref = {
      id: up.id, name: "voice-1.m4a", mime: "audio/mp4", size: audio.length,
      key: key.toString("base64"), nonce: nonce.toString("base64"), sha256: crypto.createHash("sha256").update(ct).digest("base64"),
      voice: true, durationMs: 3200,
    };
    await alice.send(conv, { type: "text", text: "", attachments: [ref] });
    await flushAll();
    const m = await bob.waitFor(() => bob.received.find((x) => x.payload.attachments?.[0]?.id === up.id));
    const a = m.payload.attachments[0];
    expect(a).toMatchObject({ voice: true, durationMs: 3200, mime: "audio/mp4" });
    const blob: Buffer = await bob.req("GET", `/v1/attachments/${a.id}`); // from B, not from A
    expect(crypto.createHash("sha256").update(blob).digest("base64")).toBe(a.sha256);
    const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(a.key, "base64"), Buffer.from(a.nonce, "base64"));
    d.setAuthTag(blob.subarray(blob.length - 16));
    expect(Buffer.concat([d.update(blob.subarray(0, blob.length - 16)), d.final()]).equals(audio)).toBe(true);
    expect(dbBytes(B).includes(audio.subarray(0, 64))).toBe(false);
    // Someone who isn't in the conversation can't fetch it from B.
    const eve = await B.client("eve");
    await expect(eve.req("GET", `/v1/attachments/${a.id}`)).rejects.toMatchObject({ status: 404 });
  });
});

describe("cross-server calls (hosted by the caller's server)", () => {
  it("rings across servers, reports alerted, admits the remote callee with a host-issued token, and ends on both sides", async () => {
    const started = await alice.req("POST", "/v1/calls", { conversationId: conv, video: true });
    const callId = started.call.id;
    // The ring reaches Bob through his own server, which mirrors the call under the same id.
    const ring = await bob.waitFor(() => bob.events.find((e) => e.t === "call" && e.event === "ring" && e.call?.id === callId));
    expect(ring.call).toMatchObject({ createdBy: alice.userId, conversationId: conv, video: true, state: "RINGING" });
    expect(ring.from.userId).toBe(alice.userId);
    expect((await B.ctx.calls.get(callId))!.host_server_id).toBe(A.ctx.federation!.serverId);
    // Ring recovery on B sees it too.
    expect((await bob.req("GET", "/v1/calls/active")).calls.map((c: any) => c.id)).toContain(callId);

    await bob.req("POST", `/v1/calls/${callId}/alerted`);
    await alice.waitFor(() => alice.events.find((e) => e.t === "call" && e.event === "alerted" && e.call?.id === callId));

    const joined = await bob.req("POST", `/v1/calls/${callId}/join`);
    expect(joined.media.url).toBe(A.ctx.livekit!.publicUrl); // A's media server; B needs none
    const { TokenVerifier } = await import("livekit-server-sdk");
    const claims = await new TokenVerifier("devkey", "test-secret-that-is-at-least-32-characters-long").verify(joined.media.token);
    expect(claims.sub).toBe(`${bob.userId}.${bob.deviceId}`);
    expect(claims.video?.room).toBe(started.media.room);
    expect(JSON.stringify(joined)).not.toMatch(/e2eeKey|secret/i); // the media key never travels through the call API

    await alice.req("POST", `/v1/calls/${callId}/connected`);
    await bob.req("POST", `/v1/calls/${callId}/connected`);
    await bob.waitFor(() => bob.events.find((e) => e.t === "call" && e.event === "updated" && e.call?.id === callId && e.call.state === "ACTIVE"));
    expect((await A.ctx.calls.get(callId))!.state).toBe("ACTIVE");

    await alice.req("POST", `/v1/calls/${callId}/end`);
    await bob.waitFor(() => bob.events.find((e) => e.t === "call" && e.event === "ended" && e.call?.id === callId));
    expect(await B.ctx.calls.get(callId)).toMatchObject({ state: "ENDED", end_reason: "hangup" });
  });

  it("rings someone on another server before any message has created the conversation there", async () => {
    const dana = await B.client("dana");
    await dana.connect();
    const found = await alice.req("GET", `/v1/federation/resolve?address=${encodeURIComponent(`@${dana.username}:b.test`)}`);
    const dm = await alice.req("POST", "/v1/conversations/dm", { userId: found.user.id });
    expect(B.ctx.ws.get("conversations", { id: dm.conversation.id })).toBeUndefined();
    const started = await alice.req("POST", "/v1/calls", { conversationId: dm.conversation.id, video: false });
    const ring = await dana.waitFor(() => dana.events.find((e) => e.t === "call" && e.event === "ring" && e.call?.id === started.call.id));
    expect(ring.call.conversationId).toBe(dm.conversation.id);
    expect(B.ctx.ws.get("conversations", { id: dm.conversation.id })).toBeTruthy();
    await alice.req("POST", `/v1/calls/${started.call.id}/end`);
    await dana.disconnect();
  });

  it("a remote decline ends a ringing 1:1 call on the host", async () => {
    const started = await bob.req("POST", "/v1/calls", { conversationId: conv, video: false }); // hosted by B this time
    const id = started.call.id;
    await alice.waitFor(() => alice.events.find((e) => e.t === "call" && e.event === "ring" && e.call?.id === id));
    await alice.req("POST", `/v1/calls/${id}/decline`, { reason: "busy" });
    await bob.waitFor(() => bob.events.find((e) => e.t === "call" && e.event === "ended" && e.call?.id === id && e.call.endReason === "busy"));
  });

  it("refuses call actions and events from a server that doesn't own the user or the call", async () => {
    const started = await alice.req("POST", "/v1/calls", { conversationId: conv, video: false });
    const id = started.call.id;
    const fedC = C.ctx.federation!;
    const peerA = await fedC.resolver.server(A.ctx.federation!.serverId);
    // C asks A for a token on Bob's behalf: Bob isn't C's user.
    const r = await fedC.request(peerA, "POST", `/fed/v1/calls/${id}/join`, { userId: bob.userId, deviceId: bob.deviceId });
    expect(r.status).toBe(403);
    // C claims to host a call created by Alice (A's user) in the shared conversation.
    const peerB = await fedC.resolver.server(B.ctx.federation!.serverId);
    const forged = { ...(await A.ctx.federation!.callRelayView((await A.ctx.calls.get(id))!)), id: "call_" + "x".repeat(22) };
    const ev = await fedC.request(peerB, "POST", "/fed/v1/calls/event", { event: "ring", call: forged, extra: {} });
    expect(ev.status).toBe(403);
    expect(await B.ctx.calls.get(forged.id)).toBeNull();
    await alice.req("POST", `/v1/calls/${id}/end`);
  });
});

describe("adversarial servers and requests", () => {
  it("a registered third server can't deliver as a user of another server", async () => {
    const fedC = C.ctx.federation!;
    const peerB = await fedC.resolver.server(B.ctx.federation!.serverId);
    const forged = {
      key: "forged-1", kind: "envelope", conversationId: conv, messageId: crypto.randomUUID(),
      senderUserId: alice.userId, senderDeviceId: alice.deviceId, recipientDeviceId: bob.deviceId,
      payload: JSON.stringify({ v: 1, cls: "message", sentAt: Date.now(), nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA", signature: "A".repeat(86) + "==", enc: "x", wrappedKey: "y" }),
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    };
    const aliceEntry = A.ctx.federation!.entry(alice.userId)!;
    const r = await fedC.request(peerB, "POST", "/fed/v1/deliver", { items: [forged], senders: [aliceEntry] });
    expect(r.json.results[0].status).toBe("rejected");
    expect(["sender_not_from_peer", "bad_item"]).toContain(r.json.results[0].code);
    // Without a (refused) directory entry, the item reaches the rule itself: only A may deliver as Alice.
    const r2 = await fedC.request(peerB, "POST", "/fed/v1/deliver", { items: [{ ...forged, key: "forged-2" }], senders: [] });
    expect(r2.json.results[0]).toMatchObject({ status: "rejected", code: "sender_not_from_peer" });
    // Alice's shadow on B is still bound to A.
    expect((B.ctx.db.prepare("SELECT home_server_id h FROM users WHERE id = ?").get(alice.userId) as any).h).toBe(A.ctx.federation!.serverId);
  });

  it("rejects unsigned, replayed, misdirected and unregistered-server requests", async () => {
    const url = `${B.baseUrl}/fed/v1/users/lookup?username=${bob.username}`;
    expect((await fetch(url)).status).toBe(401); // unsigned
    const fedC = C.ctx.federation!;
    const p = `/fed/v1/users/lookup?username=${bob.username}`;
    const h = signedHeaders(fedC.identity, "GET", p, Buffer.alloc(0), B.ctx.federation!.serverId);
    expect((await fetch(`${B.baseUrl}${p}`, { headers: h })).status).toBe(200);
    expect((await fetch(`${B.baseUrl}${p}`, { headers: h })).status).toBe(401); // replay of the same request
    const wrong = signedHeaders(fedC.identity, "GET", p, Buffer.alloc(0), A.ctx.federation!.serverId);
    expect((await fetch(`${B.baseUrl}${p}`, { headers: wrong })).status).toBe(421); // addressed to A, sent to B
    const { identity: stranger, dir } = tempIdentity(); // never registered with the core nodes
    try {
      const s = signedHeaders(stranger as ServerIdentity, "GET", p, Buffer.alloc(0), B.ctx.federation!.serverId);
      expect((await fetch(`${B.baseUrl}${p}`, { headers: s })).status).toBe(403);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a substituted identity key for a remote user is caught by the recipient's pinned key", async () => {
    // A malicious home server can publish any key for its own users; servers can't tell. Bob's client must.
    const mallory = await A.client("mallory");
    const real = A.ctx.federation!.entry(alice.userId)!;
    const fakeKeys = A.ctx.federation!.entry(mallory.userId)!;
    const substituted = { ...real, identityKey: fakeKeys.identityKey, devices: fakeKeys.devices.map((d) => ({ ...d, id: real.devices[0].id })) };
    const peerA = await B.ctx.federation!.resolver.server(A.ctx.federation!.serverId);
    B.ctx.db.prepare("DELETE FROM devices WHERE id = ?").run(mallory.deviceId); // (not on B anyway)
    B.ctx.federation!.upsertShadow(peerA, substituted); // the server accepts what Alice's home server says…
    bob.clearKeyCache();
    // …but Bob's client pinned Alice's real key on first contact and refuses to encrypt to the new one.
    await expect(bob.send(conv, { type: "text", text: "to-substituted-key" })).rejects.toThrow(/identity/i);
    expect(bob.pins.get(alice.userId)).toBe(alice.identityKeyB64);
    B.ctx.federation!.upsertShadow(peerA, real); // the genuine directory entry restores normal sending
    bob.clearKeyCache();
    await bob.send(conv, { type: "text", text: "after-restore" });
    await flushAll();
    await alice.waitFor(() => alice.received.find((m) => m.payload.text === "after-restore"));
  });
});

describe("server lifecycle seen from home servers", () => {
  it("keeps queued messages while a peer refuses or is down, and delivers them in order once it recovers", async () => {
    const fedB = B.ctx.federation!;
    fedB.cfg.policy = "allowlist"; // B temporarily refuses everyone (stands in for an outage)
    try {
      await alice.send(conv, { type: "text", text: "queued-1" });
      await alice.send(conv, { type: "text", text: "queued-2" });
      const r = await A.ctx.federation!.flush();
      expect(r.find((x) => x.peer === fedB.serverId)?.error).toBeTruthy();
      expect(A.ctx.federation!.pendingFor(fedB.serverId)).toBeGreaterThanOrEqual(2); // nothing lost
    } finally {
      fedB.cfg.policy = "open";
    }
    await new Promise((res) => setTimeout(res, 2100)); // first backoff step
    await flushAll();
    const one = await bob.waitFor(() => bob.received.findIndex((m) => m.payload.text === "queued-1") + 1);
    const two = await bob.waitFor(() => bob.received.findIndex((m) => m.payload.text === "queued-2") + 1);
    expect(one).toBeLessThan(two);
  });

  it("follows a peer's key rotation without manual steps; the old key is refused afterwards", async () => {
    const fedA = A.ctx.federation!;
    const oldSign = (fedA.identity as any).current;
    fedA.identity.rotateKey();
    fedA.descriptor(true);
    const ann = await fedA.announce();
    expect(ann.filter((x) => x.status === 200).length).toBeGreaterThanOrEqual(2);
    await alice.send(conv, { type: "text", text: "after-rotation" });
    await flushAll(); // B's cached key is old: it re-resolves A, verifies with the new key and accepts
    await bob.waitFor(() => bob.received.find((m) => m.payload.text === "after-rotation"));
    // A request signed with the rotated-away key is refused.
    const p = `/fed/v1/users/lookup?username=${bob.username}`;
    const fake = { ...fedA.identity, signText: (m: string) => require_sign(oldSign, m), serverId: fedA.serverId } as any;
    const h = signedHeaders(fake, "GET", p, Buffer.alloc(0), B.ctx.federation!.serverId);
    expect((await fetch(`${B.baseUrl}${p}`, { headers: h })).status).toBe(401);
  });

  it("honours an operator's server block", async () => {
    B.ctx.db.prepare("INSERT INTO federation_blocks (server_id, reason, created_at) VALUES (?, 'test', ?)").run(C.ctx.federation!.serverId, Date.now());
    try {
      const c1 = await C.client("carol");
      await expect(c1.req("GET", `/v1/federation/resolve?address=${encodeURIComponent(`@${bob.username}:b.test`)}`)).rejects.toMatchObject({ status: 403 });
    } finally {
      B.ctx.db.prepare("DELETE FROM federation_blocks WHERE server_id = ?").run(C.ctx.federation!.serverId);
    }
  });

  it("stops routing to a decommissioned server, drops what was queued for it, and never re-admits its id", async () => {
    const fedC = C.ctx.federation!;
    const carol = await C.client("carol2");
    const r = await carol.req("GET", `/v1/federation/resolve?address=${encodeURIComponent(`@${bob.username}:b.test`)}`);
    expect(r.user.id).toBe(bob.userId);
    const res = await fedC.decommission("closing the test server");
    expect(res.filter((x: any) => x.status === 200).length).toBeGreaterThanOrEqual(2);
    // B learns it on the next resolution; requests signed by C are refused from then on.
    await B.ctx.federation!.resolver.server(fedC.serverId, { fresh: true });
    const p = `/fed/v1/users/lookup?username=${bob.username}`;
    const h = signedHeaders(fedC.identity, "GET", p, Buffer.alloc(0), B.ctx.federation!.serverId);
    expect((await fetch(`${B.baseUrl}${p}`, { headers: h })).status).toBe(410);
    const again = await fedC.announce();
    expect(again.every((x) => x.status !== 200)).toBe(true); // tombstoned id can't come back
  });
});

describe("resilience", () => {
  it("keeps resolving and delivering with one of three core nodes down (the acceptance criterion)", async () => {
    await cores[2].app.close();
    // Forget cached bindings so this lookup must reach a live quorum (2 of 3).
    B.ctx.db.prepare("DELETE FROM federation_domains").run();
    B.ctx.db.prepare("DELETE FROM federation_peers").run();
    const r = await bob.req("GET", `/v1/federation/resolve?address=${encodeURIComponent(`@${alice.username}:a.test`)}`);
    expect(r.user.id).toBe(alice.userId);
    expect(r.server.verifiedBy).toBe(2);
    await bob.send(conv, { type: "text", text: "core-node-down-but-still-here" });
    await flushAll();
    await alice.waitFor(() => alice.received.find((m) => m.payload.text === "core-node-down-but-still-here"));
  });

  it("refuses to resolve an unknown domain without a quorum, but keeps known servers working from cache", async () => {
    await cores[1].app.close(); // now only 1 of 3 answers
    await expect(alice.req("GET", `/v1/federation/resolve?address=@xyz:never-seen.test`)).rejects.toMatchObject({ status: 503 });
    await alice.send(conv, { type: "text", text: "cached-route" });
    await flushAll();
    await bob.waitFor(() => bob.received.find((m) => m.payload.text === "cached-route"));
  });
});

/** Signs like ServerIdentity.signText, but with a given (old) key pair. */
function require_sign(kp: any, m: string): string {
  return signRecord(kp, { m }).sig;
}
