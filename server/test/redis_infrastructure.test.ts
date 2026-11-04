import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redisConfig } from "../src/infrastructure/redis/config.js";
import { RedisInfrastructure } from "../src/infrastructure/redis/service.js";
import { startServer } from "./support/harness.js";

let process: ChildProcess;
let url: string;
const opened: RedisInfrastructure[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function client(prefix = randomUUID()) {
  const c = new RedisInfrastructure(
    redisConfig({ REDIS_URL: url, REDIS_KEY_PREFIX: `test:${prefix}` }, false)!,
  );
  opened.push(c);
  await c.connect();
  expect(await c.ping()).toBe(true);
  return c;
}
beforeAll(async () => {
  const listener = net.createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  url = `redis://127.0.0.1:${port}`;
  process = spawn(
    "redis-server",
    [
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--save",
      "",
      "--appendonly",
      "no",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    process.once("error", reject);
    process.stdout!.on("data", (data) => {
      if (String(data).includes("Ready to accept connections")) resolve();
    });
    process.once("exit", (code) =>
      reject(new Error(`Test Redis exited: ${code}`)),
    );
  });
});
afterAll(async () => {
  for (const c of opened) await c.close();
  process?.kill("SIGTERM");
});

describe("Redis infrastructure", () => {
  it("validates configuration without echoing secrets and isolates scopes", async () => {
    expect(() =>
      redisConfig({ REDIS_URL: "http://example.com:secret" }, true),
    ).toThrow();
    expect(() =>
      redisConfig({ REDIS_URL: "redis://u:secret@remote.example" }, true),
    ).toThrow(/TLS/);
    expect(() =>
      redisConfig({ REDIS_URL: "redis://u:secret@remote.example" }, true),
    ).not.toThrow(/secret/);
    expect(
      redisConfig({ REDIS_URL: "rediss://u:secret@remote.example" }, true),
    ).not.toBeNull();
    const c = await client();
    expect(c.key("cache", "a:b", "c")).not.toEqual(c.key("cache", "a", "b:c"));
    expect(c.key("cache", "user1", "community1")).not.toEqual(
      c.key("cache", "user1", "community2"),
    );
  });
  it("caches, expires, invalidates across clients, and collapses simultaneous reads", async () => {
    const prefix = randomUUID();
    const [a, b] = await Promise.all([client(prefix), client(prefix)]);
    let reads = 0;
    const load = async () => {
      reads++;
      await delay(20);
      return { rev: reads };
    };
    await Promise.all(
      Array.from({ length: 10 }, () =>
        a.cached("prefs", ["user", "community"], 120, load),
      ),
    );
    expect(reads).toBe(1);
    expect(await b.cached("prefs", ["user", "community"], 120, load)).toEqual({
      rev: 1,
    });
    await b.invalidate("prefs");
    expect(await a.cached("prefs", ["user", "community"], 120, load)).toEqual({
      rev: 2,
    });
    await delay(150);
    expect(await a.cached("prefs", ["user", "community"], 120, load)).toEqual({
      rev: 3,
    });
  });
  it("does not let an in-flight old read refill the current cache generation", async () => {
    const c = await client();
    let started!: () => void, finish!: (value: number) => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const old = c.cached("prefs", ["user"], 1000, () => {
      started();
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    });
    await active;
    await c.invalidate("prefs");
    finish(1);
    expect(await old).toBe(1);
    expect(await c.cached("prefs", ["user"], 1000, async () => 2)).toBe(2);
  });
  it("enforces a shared atomic budget and TTL across two API clients", async () => {
    const prefix = randomUUID();
    const [a, b] = await Promise.all([client(prefix), client(prefix)]);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? a : b).rateLimit(["user"], 3, 120),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    await delay(150);
    expect((await a.rateLimit(["user"], 3, 120)).allowed).toBe(true);
  });
  it("tracks independent presence leases and temporary typing without message content", async () => {
    const c = await client();
    await c.touchPresence("user", "device", "instance1");
    await c.touchPresence("user", "device", "instance2");
    await c.removePresence("user", "device", "instance1");
    expect(await c.isPresent("user")).toBe(true);
    await c.removePresence("user", "device", "instance2");
    expect(await c.isPresent("user")).toBe(false);
    await c.typing("community-channel", "user", true);
    expect(
      await c.client.pttl(c.key("typing", "community-channel", "user")),
    ).toBeGreaterThan(0);
    await c.typing("community-channel", "user", false);
    expect(
      await c.client.exists(c.key("typing", "community-channel", "user")),
    ).toBe(0);
  });
  it("delivers metadata through Pub/Sub and has no durable event backlog", async () => {
    const prefix = randomUUID();
    const [a, b] = await Promise.all([client(prefix), client(prefix)]);
    const events: string[] = [];
    await b.subscribe("preferences", (data) => events.push(data));
    await a.publish("preferences", JSON.stringify({ userId: "u1", rev: 2 }));
    for (let i = 0; i < 40 && !events.length; i++) await delay(10);
    expect(events).toEqual([JSON.stringify({ userId: "u1", rev: 2 })]);
  });
  it("bypasses cache during an outage, propagates source failures, and fails distributed admission closed", async () => {
    const c = await client();
    c.client.disconnect();
    expect(await c.cached("prefs", ["user"], 1000, async () => 42)).toBe(42);
    await expect(
      c.cached("prefs", ["user"], 1000, async () => {
        throw new Error("Source unavailable");
      }),
    ).rejects.toThrow("Source unavailable");
    await expect(c.rateLimit(["user"], 3, 1000)).rejects.toThrow("unavailable");
    expect(await c.ping()).toBe(false);
    for (let i = 0; i < 100 && c.client.status !== "end"; i++) await delay(10);
    await c.client.connect();
    expect(await c.ping()).toBe(true);
  });
  it("accepts the deployment ACL while rejecting unauthenticated commands", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-redis-acl-"));
    let server: ChildProcess | undefined;
    try {
      const setup = spawn(
        "python3",
        ["-c", "import os, runpy, sys; os.umask(0o077); sys.argv = ['prepare-redis.py', sys.argv[1]]; runpy.run_path('../deploy/redis/prepare-redis.py', run_name='__main__')", dir],
        { stdio: "ignore" },
      );
      expect((await once(setup, "exit"))[0]).toBe(0);
      expect(fs.statSync(path.join(dir, "secrets/redis.acl")).mode & 0o777).toBe(0o644);
      expect(fs.statSync(path.join(dir, ".env.redis")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, "secrets")).mode & 0o777).toBe(0o700);
      const env = Object.fromEntries(
        fs
          .readFileSync(path.join(dir, ".env.redis"), "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const i = line.indexOf("=");
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      );
      const socket = path.join(dir, "redis.sock");
      const listener = net.createServer();
      await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
      const port = (listener.address() as net.AddressInfo).port;
      await new Promise<void>(resolve => listener.close(() => resolve()));
      server = spawn(
        "redis-server",
        [
          "--port",
          String(port),
          "--bind",
          "127.0.0.1",
          "--unixsocket",
          socket,
          "--save",
          "",
          "--appendonly",
          "no",
          "--aclfile",
          path.join(dir, "secrets/redis.acl"),
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.once("exit", code => reject(new Error(`Redis ACL fixture exited before readiness: ${code}`)));
        server!.stdout!.on("data", (data) => {
          if (String(data).includes("Ready to accept connections")) resolve();
        });
      });
      const { Redis } = await import("ioredis");
      const unauthenticated = new Redis(socket, {
        enableOfflineQueue: false,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      unauthenticated.on("error", () => {});
      try {
        await unauthenticated.connect().catch(() => {});
        await expect(unauthenticated.ping()).rejects.toThrow();
      } finally {
        unauthenticated.disconnect();
      }
      const infrastructure = new RedisInfrastructure({
        url: `redis://meldiq@127.0.0.1:${port}`,
        password: env.REDIS_PASSWORD,
        prefix: "meldiq:test:v1",
        timeoutMs: 1000,
      });
      const authenticated = infrastructure.client;
      authenticated.on("error", () => {});
      try {
        await authenticated.connect();
        expect(await authenticated.ping()).toBe("PONG");
        await authenticated.set("meldiq:test:acl", "ok", "PX", 1000);
        expect(
          await authenticated.eval(
            "return redis.call('GET',KEYS[1])",
            1,
            "meldiq:test:acl",
          ),
        ).toBe("ok");
        await expect(
          authenticated.set("outside:scope", "blocked"),
        ).rejects.toThrow(/NOPERM/);
        await expect(authenticated.config("GET", "*")).rejects.toThrow(
          /NOPERM/,
        );
      } finally {
        await infrastructure.close();
      }
    } finally {
      server?.kill("SIGTERM");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("integrates shared HTTP limits and keeps health reachable during Redis failure", async () => {
    const s = await startServer({
      REDIS_URL: url,
      REDIS_KEY_PREFIX: `test:${randomUUID()}`,
      RATE_LIMIT_PER_MINUTE: "2",
    });
    try {
      expect((await s.app.inject({ url: "/v1/server-info" })).statusCode).toBe(
        200,
      );
      expect((await s.app.inject({ url: "/v1/server-info" })).statusCode).toBe(
        200,
      );
      expect((await s.app.inject({ url: "/v1/server-info" })).statusCode).toBe(
        429,
      );
      s.ctx.redis!.client.disconnect();
      expect((await s.app.inject({ url: "/v1/server-info" })).statusCode).toBe(
        503,
      );
      const health = await s.app.inject({ url: "/healthz" });
      expect(health.statusCode).toBe(503);
      expect(health.json()).toMatchObject({ redis: false, ok: false });
    } finally {
      await s.close();
    }
  });
});
