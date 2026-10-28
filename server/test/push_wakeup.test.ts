import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/app/config.js";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { checkEndpoint, isPublicAddress } from "../src/modules/notifications/address.js";
import type { GriipClient } from "./support/griipClient.js";
import { FakePushNetwork } from "./support/fakePush.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { queuedCount } from "./support/relay.js";

/**
 * Push wake-ups (docs/BACKGROUND_DELIVERY.md, option B). The push network is faked here (DNS and requests recorded,
 * answers chosen per test); push_transport.test.ts sends real HTTPS requests.
 */
const HOST = "push.example.com";
const PUBLIC_IP = "1.1.1.1"; // never contacted: the fake network only records the request
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let net: FakePushNetwork;
let h: Harness;

/** A push-enabled server per group of tests: registering is limited to 30 accounts a minute per address. */
function usePushServer() {
  beforeAll(async () => {
    net = new FakePushNetwork();
    h = await startServer({ PUSH_UNIFIEDPUSH_HOSTS: HOST }, { push: net.deps() });
  });
  afterAll(async () => h.close());
  beforeEach(() => {
    net.reset();
    net.dns.set(HOST, [{ address: PUBLIC_IP, family: 4 }]);
    const push = h.ctx.config.push!;
    push.unifiedPushHosts = [HOST];
    push.wakeIntervalMs = 30_000;
    push.urgentWakeIntervalMs = 5000;
  });
}

async function pair() {
  const alice = await h.client("pusha");
  const bob = await h.client("pushb");
  const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id as string;
  return { alice, bob, dm };
}

const WINDOW_MS = 2500;
const endpointOf = (c: GriipClient) => `https://${HOST}/up${c.deviceId.replace(/[^A-Za-z0-9]/g, "").slice(-12)}?up=1`;
const register = (c: GriipClient, endpoint = endpointOf(c)) => c.req("PUT", "/v1/devices/current/push", { kind: "unifiedpush", endpoint });
const stored = (deviceId: string) =>
  h.ctx.identity.get<{ endpoint: string; last_wake_at: number | null; failing_since: number | null }>("push_endpoints", { device_id: deviceId });

describe("registering a device's endpoint", () => {
  usePushServer();

  it("needs a signed-in device that hasn't been removed", async () => {
    const res = await fetch(`${h.baseUrl}/v1/devices/current/push`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "unifiedpush", endpoint: `https://${HOST}/upX` }),
    });
    expect(res.status).toBe(401);

    const { bob } = await pair();
    const r = await register(bob);
    expect(r.push).toMatchObject({ kind: "unifiedpush", host: HOST });
    expect(stored(bob.deviceId)?.endpoint).toBe(endpointOf(bob));

    await bob.req("DELETE", `/v1/devices/${bob.deviceId}`);
    expect(stored(bob.deviceId)).toBeUndefined();
    await expectStatus(register(bob), 401);
  });

  it("keeps one endpoint per device, and an endpoint moves to the device that registered it last", async () => {
    const { alice, bob } = await pair();
    await register(bob, `https://${HOST}/upFirst?up=1`);
    await register(bob, `https://${HOST}/upSecond?up=1`);
    expect(h.ctx.identity.all<{ endpoint: string }>("push_endpoints", { where: { device_id: bob.deviceId } }).map((r) => ({ endpoint: r.endpoint }))).toEqual([{ endpoint: `https://${HOST}/upSecond?up=1` }]);

    await register(alice, `https://${HOST}/upSecond?up=1`);
    expect(stored(bob.deviceId)).toBeUndefined();
    expect(stored(alice.deviceId)?.endpoint).toBe(`https://${HOST}/upSecond?up=1`);
  });

  it("is removed on request and when the device signs out", async () => {
    const { bob } = await pair();
    await register(bob);
    expect(await bob.req("DELETE", "/v1/devices/current/push")).toEqual({ ok: true, removed: true });
    expect(await bob.req("DELETE", "/v1/devices/current/push")).toEqual({ ok: true, removed: false });

    await register(bob);
    await bob.req("POST", "/v1/auth/logout");
    expect(stored(bob.deviceId)).toBeUndefined();
  });

  it("refuses anything but https on an allow-listed push host (no SSRF through registration)", async () => {
    const { bob } = await pair();
    const refused: [string, string][] = [
      ["not a url", "push_endpoint_invalid"],
      [`http://${HOST}/upX`, "push_endpoint_invalid"],
      [`https://user:secret@${HOST}/upX`, "push_endpoint_invalid"],
      [`https://${HOST}/upX#fragment`, "push_endpoint_invalid"],
      [`ftp://${HOST}/upX`, "push_endpoint_invalid"],
      [`https://${HOST}/${"x".repeat(1100)}`, "bad_request"],
      ["https://evil.example.net/upX", "push_host_not_allowed"],
      [`https://${HOST}.evil.example.net/upX`, "push_host_not_allowed"],
      [`https://${HOST}:8443/upX`, "push_host_not_allowed"],
      ["https://127.0.0.1/upX", "push_host_not_allowed"],
      ["https://169.254.169.254/latest/meta-data", "push_host_not_allowed"],
      ["https://[::1]/upX", "push_host_not_allowed"],
      ["https://localhost/upX", "push_host_not_allowed"],
    ];
    for (const [endpoint, code] of refused) {
      const body = await expectStatus(register(bob, endpoint), 400);
      expect(body.error.code, endpoint).toBe(code);
      if (code === "push_host_not_allowed") expect(body.error.details).toEqual({ allowedHosts: [HOST] });
    }
    const wrongKind = await expectStatus(bob.req("PUT", "/v1/devices/current/push", { kind: "fcm", endpoint: endpointOf(bob) }), 400);
    expect(wrongKind.error.code).toBe("bad_request");
    expect(stored(bob.deviceId)).toBeUndefined();
  });

  it("accepts the host in any letter case and stores the normalized URL", async () => {
    const { bob } = await pair();
    await register(bob, `https://PUSH.Example.COM:443/upCase?up=1`);
    expect(stored(bob.deviceId)?.endpoint).toBe(`https://${HOST}/upCase?up=1`);
  });

  it("is advertised in server-info only when configured; without it, registering is refused but removal works", async () => {
    const info = await (await fetch(`${h.baseUrl}/v1/server-info`)).json();
    expect(info.features).toContain("push-unifiedpush");
    expect(info.push).toEqual({ unifiedPushHosts: [HOST] });

    const plain = await startServer();
    try {
      const off = await (await fetch(`${plain.baseUrl}/v1/server-info`)).json();
      expect(off.features).not.toContain("push-unifiedpush");
      expect(off.push).toBeNull();
      const carol = await plain.client("pushc");
      const body = await expectStatus(carol.req("PUT", "/v1/devices/current/push", { kind: "unifiedpush", endpoint: `https://${HOST}/upX` }), 404);
      expect(body.error.code).toBe("push_unavailable");
      expect(await carol.req("DELETE", "/v1/devices/current/push")).toEqual({ ok: true, removed: false });
    } finally {
      await plain.close();
    }
  });
});

describe("waking a device", () => {
  usePushServer();

  it("wakes an offline device with an empty request that names nothing about the message", async () => {
    const { alice, bob, dm } = await pair();
    await register(bob);
    const sent = await alice.send(dm, { type: "text", text: "the secret plan" });

    await expect.poll(() => net.sent.length).toBe(1);
    const wake = net.sent[0];
    expect(wake.url).toBe(endpointOf(bob));
    expect(wake.address).toBe(PUBLIC_IP);
    expect(wake.opts).toEqual({ timeoutMs: 5000, ttlSeconds: h.ctx.config.queueTtlSeconds });
    expect(net.lookups).toEqual([HOST]);
    // The transport gets a URL and options only: no field could carry content. Check that nothing leaked into them.
    const text = JSON.stringify(wake);
    for (const secret of [dm, sent.messageId, alice.userId, alice.deviceId, bob.userId, "secret plan"]) expect(text).not.toContain(secret);
    // Recorded after the wake-up goes out (a write that commits on its own in MongoDB).
    await expect.poll(() => stored(bob.deviceId)?.last_wake_at ?? 0).toBeGreaterThan(0);
    // The message is still queued: the wake-up only tells the app to fetch it.
    expect(await queuedCount(h, (r) => r.recipient_device_id === bob.deviceId)).toBe(1);
  });

  it("doesn't wake a connected device, and delivery receipts never wake anyone", async () => {
    const { alice, bob, dm } = await pair();
    await register(bob);
    await register(alice); // alice stays offline: bob's "delivered" receipt is queued for her
    await bob.connect();
    await alice.send(dm, { type: "text", text: "hi" });
    await bob.waitFor(() => bob.received.length === 1);
    await expect.poll(() => queuedCount(h, (r) => r.recipient_device_id === alice.deviceId && r.kind === "receipt")).toBe(1);
    await sleep(300);
    expect(net.sent).toEqual([]);
    await bob.disconnect();
  });

  // The window is wide enough that sending, connecting and fetching fit inside it on a busy machine (a full run with
  // every domain in MongoDB).
  it("coalesces wake-ups to one per window and defers the rest instead of dropping them", async () => {
    h.ctx.config.push!.wakeIntervalMs = WINDOW_MS;
    const { alice, bob, dm } = await pair();
    await register(bob);
    await Promise.all([0, 1, 2].map((i) => alice.send(dm, { type: "text", text: `m${i}` })));
    await sleep(150);
    expect(net.sent.length).toBe(1);
    await expect.poll(() => net.sent.length, { timeout: WINDOW_MS + 3000 }).toBe(2);
    expect(net.sent[1].at - net.sent[0].at).toBeGreaterThanOrEqual(WINDOW_MS - 50);
    await sleep(WINDOW_MS + 300);
    expect(net.sent.length).toBe(2); // nothing new arrived: no further wake-up
  });

  it("skips a deferred wake-up once the device has fetched its queue", async () => {
    h.ctx.config.push!.wakeIntervalMs = WINDOW_MS;
    const { alice, bob, dm } = await pair();
    await register(bob);
    await alice.send(dm, { type: "text", text: "first" });
    await expect.poll(() => net.sent.length).toBe(1);
    await alice.send(dm, { type: "text", text: "second" }); // inside the window: deferred
    await bob.connect();
    await bob.waitFor(() => bob.received.length === 2);
    await expect.poll(() => queuedCount(h, (r) => r.recipient_device_id === bob.deviceId)).toBe(0);
    await bob.disconnect();
    await sleep(WINDOW_MS + 300);
    expect(net.sent.length).toBe(1);
  });

  it("wakes a device whose socket closed with live items unacknowledged, but not for items from its backlog", async () => {
    h.ctx.config.push!.wakeIntervalMs = 200;
    const { alice, bob, dm } = await pair();
    await register(bob);
    bob.autoAck = false;
    await bob.connect();
    await alice.send(dm, { type: "text", text: "pushed into the socket" });
    await bob.waitFor(() => bob.received.length === 1);
    expect(net.sent).toEqual([]); // connected: no wake-up
    await bob.disconnect();
    await expect.poll(() => net.sent.length).toBe(1);

    // Back again: the item comes in the backlog and still isn't acknowledged (an app that can't process it). Leaving
    // must not wake the device again, or one bad item would wake it forever.
    bob.events = [];
    await bob.connect();
    await bob.waitFor(() => bob.events.some((e) => e.t === "queue" && e.backlog && e.items.length === 1));
    await bob.disconnect();
    await sleep(500);
    expect(net.sent.length).toBe(1);
  });

  it("rings an offline device at once, even right after a message wake-up", async () => {
    h.ctx.config.push!.urgentWakeIntervalMs = 300;
    const { alice, bob, dm } = await pair();
    await register(bob);
    await alice.req("POST", "/v1/calls", { conversationId: dm });
    await expect.poll(() => net.sent.length).toBe(1);

    const second = await pair();
    await register(second.bob);
    await second.alice.send(second.dm, { type: "text", text: "call me" });
    await expect.poll(() => net.sent.length).toBe(2);
    await second.alice.req("POST", "/v1/calls", { conversationId: second.dm });
    await expect.poll(() => net.sent.length, { timeout: 3000 }).toBe(3); // after 300 ms, not the 30 s message window
    expect(net.sent[2].url).toBe(endpointOf(second.bob));
    expect(net.sent[2].at - net.sent[1].at).toBeLessThan(2000);
  });

  it("doesn't ring a device that is connected", async () => {
    const { alice, bob, dm } = await pair();
    await register(bob);
    await bob.connect();
    await alice.req("POST", "/v1/calls", { conversationId: dm });
    await bob.waitFor(() => bob.events.some((e) => e.t === "call" && e.event === "ring"));
    await sleep(300);
    expect(net.sent).toEqual([]);
    await bob.disconnect();
  });

  it("never wakes disabled accounts, and the retention job removes endpoints of revoked devices", async () => {
    const { bob } = await pair();
    await register(bob);
    await h.ctx.identity.write((w) => w.update("users", { id: bob.userId }, { disabled_at: Date.now() }));
    h.ctx.push!.queued(bob.deviceId);
    h.ctx.push!.ring(bob.userId);
    await sleep(200);
    expect(net.sent).toEqual([]);

    // Revoked outside the route (the admin CLI, or before this feature): the next cleanup run removes the endpoint.
    const { bob: dave } = await pair();
    await register(dave);
    await h.ctx.identity.write((w) => w.update("devices", { id: dave.deviceId }, { revoked_at: Date.now() }));
    h.ctx.push!.queued(dave.deviceId);
    await sleep(100);
    expect(net.sent).toEqual([]);
    const r = await runCleanup(h.ctx);
    expect(r.pushEndpoints).toBeGreaterThanOrEqual(1);
    expect(stored(dave.deviceId)).toBeUndefined();
  });
});

describe("push server answers and address checks", () => {
  usePushServer();

  const logText = () => JSON.stringify(net.logs);

  it("drops an endpoint the push server reports gone (404, 410), logging no URL", async () => {
    for (const status of [404, 410]) {
      net.reset();
      net.dns.set(HOST, [{ address: PUBLIC_IP, family: 4 }]);
      net.respond = () => ({ status });
      const { alice, bob, dm } = await pair();
      await register(bob);
      await alice.send(dm, { type: "text", text: "x" });
      await expect.poll(() => stored(bob.deviceId)).toBeUndefined();
      expect(net.logs).toContainEqual({ level: "info", obj: { deviceId: bob.deviceId, reason: `http_${status}` }, msg: "push endpoint removed" });
      expect(logText()).not.toContain(HOST);
      expect(logText()).not.toContain("/up");
    }
  });

  it("keeps the endpoint on other failures and logs only the device and a reason", async () => {
    const results = [{ status: 507 }, { status: 500 }, { status: 301 }, { error: "timeout" as const }, { error: "tls" as const }];
    h.ctx.config.push!.wakeIntervalMs = 0;
    const { alice, bob, dm } = await pair();
    await register(bob);
    for (const result of results) {
      net.respond = () => result;
      const before = net.logs.length;
      await alice.send(dm, { type: "text", text: "x" });
      await expect.poll(() => net.logs.length).toBe(before + 1);
      const reason = "status" in result ? `http_${result.status}` : result.error;
      expect(net.logs.at(-1)).toEqual({ level: "warn", obj: { deviceId: bob.deviceId, reason }, msg: "push wake-up failed" });
    }
    expect(stored(bob.deviceId)?.failing_since).toBeGreaterThan(0);
    expect(logText()).not.toContain(HOST);
    expect(logText()).not.toContain("/up");

    net.respond = () => ({ status: 200 });
    await alice.send(dm, { type: "text", text: "works again" });
    await expect.poll(() => stored(bob.deviceId)?.failing_since).toBeNull();
  });

  it("drops an endpoint that has kept failing for a week", async () => {
    net.respond = () => ({ status: 500 });
    const { alice, bob, dm } = await pair();
    await register(bob);
    await h.ctx.identity.write((w) => w.update("push_endpoints", { device_id: bob.deviceId }, { failing_since: Date.now() - 8 * 86_400_000 }));
    await alice.send(dm, { type: "text", text: "x" });
    await expect.poll(() => stored(bob.deviceId)).toBeUndefined();
    expect(net.logs).toContainEqual({ level: "info", obj: { deviceId: bob.deviceId, reason: "http_500_for_7_days" }, msg: "push endpoint removed" });
  });

  it("never sends to a push host that resolves to a private, loopback or link-local address", async () => {
    h.ctx.config.push!.wakeIntervalMs = 0;
    const { alice, bob, dm } = await pair();
    await register(bob);
    const answers = [
      ["10.0.0.5"],
      ["127.0.0.1"],
      ["169.254.169.254"],
      ["100.64.1.1"],
      ["::1"],
      ["fd00::1"],
      ["fe80::1"],
      ["::ffff:192.168.1.1"],
      [PUBLIC_IP, "192.168.0.10"], // one private address among public ones is enough to refuse
    ];
    for (const addrs of answers) {
      net.dns.set(HOST, addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
      const lookups = net.lookups.length;
      await alice.send(dm, { type: "text", text: "x" });
      await expect.poll(() => net.lookups.length).toBe(lookups + 1);
      await expect.poll(() => net.logs.at(-1)).toEqual({ level: "warn", obj: { deviceId: bob.deviceId, reason: "blocked_address" }, msg: "push wake-up failed" });
    }
    expect(net.sent).toEqual([]);

    net.dns.delete(HOST);
    await alice.send(dm, { type: "text", text: "x" });
    await expect.poll(() => net.logs.at(-1)).toEqual({ level: "warn", obj: { deviceId: bob.deviceId, reason: "dns" }, msg: "push wake-up failed" });
    expect(net.sent).toEqual([]);
  });

  it("never lets a failure inside push break sending a message", async () => {
    const { alice, bob, dm } = await pair();
    await register(bob);
    const internals = h.ctx.push as unknown as { endpointOf: (deviceId: string) => string | null };
    const original = internals.endpointOf;
    internals.endpointOf = () => {
      throw new TypeError("simulated database failure");
    };
    try {
      const r = await alice.send(dm, { type: "text", text: "still delivered" });
      expect(r.duplicate).toBe(false);
    } finally {
      internals.endpointOf = original;
    }
    expect(net.logs).toContainEqual({ level: "error", obj: { deviceId: bob.deviceId, reason: "internal", errorType: "TypeError" }, msg: "push wake-up failed" });
    expect(JSON.stringify(net.logs)).not.toContain("simulated");
  });

  it("drops endpoints on a host that is no longer allow-listed, without contacting it", async () => {
    const { alice, bob, dm } = await pair();
    await register(bob);
    h.ctx.config.push!.unifiedPushHosts = ["ntfy.example.org"];
    await alice.send(dm, { type: "text", text: "x" });
    await expect.poll(() => stored(bob.deviceId)).toBeUndefined();
    expect(net.lookups).toEqual([]);
    expect(net.sent).toEqual([]);
  });

  it("stops waking anyone once the server is shutting down", async () => {
    const quiet = new FakePushNetwork();
    quiet.dns.set(HOST, [{ address: PUBLIC_IP, family: 4 }]);
    const h2 = await startServer({ PUSH_UNIFIEDPUSH_HOSTS: HOST }, { push: quiet.deps() });
    const alice = await h2.client("pushsa");
    const bob = await h2.client("pushsb");
    const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    await bob.req("PUT", "/v1/devices/current/push", { kind: "unifiedpush", endpoint: `https://${HOST}/upShutdown` });
    bob.autoAck = false;
    await bob.connect();
    await alice.send(dm, { type: "text", text: "in flight" });
    await bob.waitFor(() => bob.received.length === 1);
    await h2.app.close(); // closes bob's socket with an unacknowledged item
    await sleep(200);
    expect(quiet.sent).toEqual([]);
    h2.ctx.db.close();
    fs.rmSync(h2.dir, { recursive: true, force: true });
  });
});

describe("address and endpoint rules", () => {
  usePushServer();

  it("counts only public unicast addresses as public", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.215.14", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "::ffff:808:808"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    const blocked = [
      "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
      "240.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fe80::1%en0", "fc00::1", "fd12:3456::1", "ff02::1",
      "2001:db8::1", "2002:c0a8:101::1", "2001::1", "64:ff9b::a00:1", "100::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
      "::ffff:a9fe:a9fe", "::127.0.0.1", "not-an-address", "",
    ];
    for (const ip of blocked) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("matches the allow-list on host and port", () => {
    const hosts = ["ntfy.example.com", "push.example.org:8443"];
    expect(checkEndpoint("https://ntfy.example.com/upA?up=1", hosts)).toEqual({ url: new URL("https://ntfy.example.com/upA?up=1") });
    expect(checkEndpoint("https://push.example.org:8443/upA", hosts)).toHaveProperty("url");
    expect(checkEndpoint("https://push.example.org/upA", hosts)).toEqual({ refusal: "push_host_not_allowed" });
    expect(checkEndpoint("https://ntfy.example.com:8443/upA", hosts)).toEqual({ refusal: "push_host_not_allowed" });
    expect(checkEndpoint("https://ntfy.example.com./upA", hosts)).toEqual({ refusal: "push_host_not_allowed" });
  });

  it("reads the push settings strictly and keeps push off by default", () => {
    const base = { DATA_DIR: h.dir };
    expect(loadConfig(base).push).toBeNull();
    expect(loadConfig({ ...base, PUSH_UNIFIEDPUSH_HOSTS: " NTFY.example.com, push.example.org:8443 ,ntfy.example.com" }).push).toEqual({
      unifiedPushHosts: ["ntfy.example.com", "push.example.org:8443"],
      wakeIntervalMs: 30_000,
      urgentWakeIntervalMs: 5000,
      timeoutMs: 5000,
    });
    for (const bad of ["https://ntfy.example.com", "ntfy.example.com/up", "ntfy.example.com:443", "ntfy.example.com:0", "localhost", "ntfy_example.com"]) {
      expect(() => loadConfig({ ...base, PUSH_UNIFIEDPUSH_HOSTS: bad }), bad).toThrow(/PUSH_UNIFIEDPUSH_HOSTS/);
    }
    const clamped = loadConfig({ ...base, PUSH_UNIFIEDPUSH_HOSTS: "ntfy.example.com", PUSH_WAKE_INTERVAL_SECONDS: "1", PUSH_TIMEOUT_MS: "999999" }).push!;
    expect(clamped.wakeIntervalMs).toBe(5000);
    expect(clamped.timeoutMs).toBe(15_000);
  });
});
