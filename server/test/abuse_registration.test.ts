import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { networkKey } from "../src/app/middleware/abuse.js";
import { loadConfig } from "../src/app/config.js";
import { createRegistrationInvite } from "../src/modules/organizations/invites.js";
import { ApiFailure, canonical, GriipClient, sign } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

// Abuse controls for sign-up, sign-in and realtime connections (docs/ABUSE_CONTROLS.md). Every client here is a
// synthetic test account on an in-process server; "networks" are documentation addresses (RFC 5737 / RFC 3849).

let seq = 0;
/** A client that reaches the server through a trusted proxy (loopback), from [address]. */
function from(h: Harness, address: string, name = "abuser"): GriipClient {
  const c = new GriipClient(h.baseUrl, `${name}${++seq}`);
  c.extraHeaders = { "x-forwarded-for": address };
  return c;
}

/** The refusal of a request that must fail, with its Retry-After header. */
async function refusal(p: Promise<unknown>): Promise<ApiFailure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiFailure) return e;
    throw e;
  }
  throw new Error("expected the request to be refused");
}

/** Moves the clock the server and its rate limiter read (Date only; timers keep running normally). */
function advanceClock(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
}
afterEach(() => vi.useRealTimers());

const HOUR = 3_600_000;

describe("client address behind the proxy", () => {
  it("counts IPv4 addresses one by one and IPv6 addresses by /64", () => {
    expect(networkKey("203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("2001:db8:1:2::a")).toBe("2001:0db8:0001:0002::/64");
    expect(networkKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(networkKey("2001:db8:1:2::a"));
    expect(networkKey("2001:db8:1:3::a")).not.toBe(networkKey("2001:db8:1:2::a"));
    expect(networkKey("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("TRUST_PROXY takes the proxy's addresses and refuses a hop count, which Fastify would ignore", () => {
    expect(loadConfig({ TRUST_PROXY: "loopback,uniquelocal" } as NodeJS.ProcessEnv).trustProxy).toEqual(["loopback", "uniquelocal"]);
    expect(loadConfig({} as NodeJS.ProcessEnv).trustProxy).toBe(false);
    expect(() => loadConfig({ TRUST_PROXY: "1" } as NodeJS.ProcessEnv)).toThrow(/addresses/);
  });
});

describe("TRUST_PROXY=true (the setting production had until this change)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ TRUST_PROXY: "true", REGISTRATION_PER_ADDRESS_PER_HOUR: "1" });
  });
  afterAll(async () => h.close());

  it("lets a client choose its own address with X-Forwarded-For, so per-address limits don't hold", async () => {
    await from(h, "198.51.100.9, 203.0.113.90").register();
    await from(h, "198.51.100.10, 203.0.113.90").register(); // same real address, invented one in front: not limited
  });
});

describe("registration limits", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({
      TRUST_PROXY: "loopback",
      REGISTRATION_PER_ADDRESS_PER_HOUR: "2",
      REGISTRATION_PER_ADDRESS_PER_DAY: "3",
    });
  });
  afterAll(async () => h.close());

  it("allows a few accounts per network an hour, then says when to try again", async () => {
    await from(h, "203.0.113.10").register();
    await from(h, "203.0.113.10").register();
    const third = await refusal(from(h, "203.0.113.10").register());
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("registration_limited");
    expect(Number(third.retryAfter)).toBeGreaterThan(0);
    expect(Number(third.retryAfter)).toBeLessThanOrEqual(3600);
    // Someone on another network isn't affected.
    await from(h, "203.0.113.11").register();
  });

  it("can't be dodged with an X-Forwarded-For the client writes itself, or a new IPv6 address in the same /64", async () => {
    await from(h, "203.0.113.20").register();
    await from(h, "198.51.100.1, 203.0.113.20").register();
    // The proxy appends the real address last: an invented address in front of it changes nothing.
    expect((await refusal(from(h, "198.51.100.2, 203.0.113.20").register())).body.error.code).toBe("registration_limited");
    await from(h, "2001:db8:5:6::1").register();
    await from(h, "2001:db8:5:6::2").register();
    expect((await refusal(from(h, "2001:db8:5:6:abcd::3").register())).body.error.code).toBe("registration_limited");
  });

  it("refused or failed attempts don't use up the allowance", async () => {
    const taken = await from(h, "203.0.113.30").register();
    for (let i = 0; i < 3; i++) {
      const again = from(h, "203.0.113.30");
      again.username = taken.username; // the same name again: 409, and nothing is created
      await expectStatus(again.register(), 409);
    }
    await from(h, "203.0.113.30").register(); // the second account still fits this hour
  });

  it("opens up again once the window has passed, up to the daily limit", async () => {
    await from(h, "203.0.113.40").register();
    await from(h, "203.0.113.40").register();
    expect((await refusal(from(h, "203.0.113.40").register())).status).toBe(429);
    advanceClock(HOUR + 1000);
    await from(h, "203.0.113.40").register(); // third of the day
    const fourth = await refusal(from(h, "203.0.113.40").register());
    expect(fourth.body.error.code).toBe("registration_limited");
    expect(Number(fourth.retryAfter)).toBeGreaterThan(HOUR / 1000); // the daily limit: about 23 hours to go
  });
});

describe("open registrations per day, server-wide", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ TRUST_PROXY: "loopback", REGISTRATION_OPEN_PER_DAY: "2" });
  });
  afterAll(async () => h.close());

  it("pauses open sign-up for the rest of the day once the cap is reached, from any network", async () => {
    await from(h, "203.0.113.50").register();
    await from(h, "203.0.113.51").register();
    const paused = await refusal(from(h, "203.0.113.52").register());
    expect(paused.status).toBe(429);
    expect(paused.body.error.code).toBe("registration_paused");
    advanceClock(24 * HOUR + 1000);
    await from(h, "203.0.113.53").register();
  });
});

describe("registration with an invitation", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ TRUST_PROXY: "loopback", REGISTRATION_MODE: "invite", REGISTRATION_PER_ADDRESS_PER_HOUR: "1" });
  });
  afterAll(async () => h.close());

  it("isn't limited per network: each invitation is already limited by its own uses", async () => {
    const { code } = await createRegistrationInvite(h.ctx.identity, { maxUses: 3, days: 1 });
    await from(h, "203.0.113.60").register(code);
    await from(h, "203.0.113.60").register(code);
    await from(h, "203.0.113.60").register(code);
    await expectStatus(from(h, "203.0.113.60").register(code), 403); // used up
  });
});

describe("sign-in and recovery", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ TRUST_PROXY: "loopback", MAX_DEVICES_PER_USER: "2" });
  });
  afterAll(async () => h.close());

  it("limits sign-in attempts per network, and a person who waits a minute signs in normally", async () => {
    const a = from(h, "203.0.113.70", "signin");
    await a.register();
    // 30 challenges a minute per network: registering used one, someone on the same network takes the rest.
    const flood = from(h, "203.0.113.70");
    for (let i = 0; i < 29; i++) await flood.req("POST", "/v1/auth/challenge");
    a.token = ""; // signing in again: no valid session, so the attempt counts for the network
    const limited = await refusal(a.login());
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    // Another network isn't affected...
    const elsewhere = from(h, "203.0.113.71");
    await elsewhere.req("POST", "/v1/auth/challenge");
    // ...and after the window, the same person retries and signs in.
    advanceClock(61_000);
    await a.login();
    expect((await a.req("GET", "/v1/users/me")).user.id).toBe(a.userId);
  });

  it("answers an unknown username and a certificate that doesn't match the same way", async () => {
    const victim = await h.client("victim");
    const mallory = new GriipClient(h.baseUrl, "mallory");
    const attempt = async (username: string) => {
      const { nonce } = await mallory.req("POST", "/v1/auth/challenge");
      return expectStatus(
        mallory.req("POST", "/v1/auth/add-device", {
          username,
          device: { name: "evil", signingKey: mallory.signingKeyB64, encryptionKey: mallory.encKeyB64, certificate: mallory.certificate() },
          nonce,
          signature: sign(mallory.device, canonical.authProof("add-device", nonce, mallory.signingKeyB64)),
        }),
        401,
      );
    };
    const unknown = await attempt("nobody.here");
    const existing = await attempt(victim.username);
    expect(existing).toEqual(unknown);
    expect(existing.error).toEqual({ code: "unauthorized", message: "Invalid device proof" });
  });

  it("caps devices per account; removing one makes room again", async () => {
    const a = await h.client("devices");
    const addDevice = async () => {
      const phone = new GriipClient(h.baseUrl, a.username);
      phone.identity = a.identity;
      const { nonce } = await phone.req("POST", "/v1/auth/challenge");
      return phone.req("POST", "/v1/auth/add-device", {
        username: a.username,
        device: { name: "phone", signingKey: phone.signingKeyB64, encryptionKey: phone.encKeyB64, certificate: phone.certificate() },
        nonce,
        signature: sign(phone.device, canonical.authProof("add-device", nonce, phone.signingKeyB64)),
      });
    };
    const second = await addDevice();
    const third = await expectStatus(addDevice(), 409);
    expect(third.error.code).toBe("too_many_devices");
    await a.req("DELETE", `/v1/devices/${second.deviceId}`);
    await addDevice();
  });
});

describe("realtime connections", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ WS_FRAMES_PER_SECOND: "5", WS_FRAME_BURST: "10", WS_MAX_SOCKETS_PER_DEVICE: "2" });
  });
  afterAll(async () => h.close());

  /** A raw realtime connection, open once the server said hello. Records pongs and how it closed. */
  const open = (token: string) =>
    new Promise<{ ws: WebSocket; pongs: () => number; closed: Promise<number> }>((resolve, reject) => {
      const ws = new WebSocket(h.baseUrl.replace(/^http/, "ws") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
      let pongs = 0;
      const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        if (m.t === "hello") resolve({ ws, pongs: () => pongs, closed });
        if (m.t === "pong") pongs++;
      });
      ws.on("error", reject);
    });

  it("ignores frames past the budget and closes a connection that keeps flooding", async () => {
    const c = await h.client("flood");
    const s = await open(c.token!);
    for (let i = 0; i < 60; i++) s.ws.send(JSON.stringify({ t: "ping" }));
    expect(await s.closed).toBe(4429);
    expect(s.pongs()).toBeLessThanOrEqual(11);
  });

  it("leaves a normal connection alone: a few frames a second get answers, and messages still arrive", async () => {
    const a = await h.client("steady");
    const b = await h.client("steadyb");
    const s = await open(a.token!);
    for (let i = 0; i < 5; i++) s.ws.send(JSON.stringify({ t: "ping" }));
    await a.waitFor(() => s.pongs() === 5);
    s.ws.close();
    await b.connect();
    const dm = (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id;
    await a.send(dm, { text: "still works" });
    await b.waitFor(() => b.received.find((m) => m.payload.text === "still works"));
  });

  it("a device opening more connections than allowed loses its oldest, never the newest", async () => {
    const c = await h.client("sockets");
    const first = await open(c.token!);
    const second = await open(c.token!);
    const third = await open(c.token!);
    expect(await first.closed).toBe(4409);
    third.ws.send(JSON.stringify({ t: "ping" }));
    second.ws.send(JSON.stringify({ t: "ping" }));
    await c.waitFor(() => third.pongs() === 1 && second.pongs() === 1);
    second.ws.close();
    third.ws.close();
  });
});
