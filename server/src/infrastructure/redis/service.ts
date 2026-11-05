import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { RedisConfig } from "./config.js";
import { ApiError } from "../../shared/errors.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const GENERATION_MS = 86_400_000;
const RATE = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}`;
const FILL = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]) end; return nil`;

export interface RedisMetrics {
  hits: number;
  misses: number;
  errors: number;
  invalidations: number;
}

/** Shared, bounded Redis infrastructure. Business records and permission decisions stay in MongoDB. */
export class RedisInfrastructure {
  readonly client: Redis;
  readonly instanceId = randomUUID();
  private subscriber: Redis | null = null;
  private readonly flights = new Map<string, Promise<unknown>>();
  private readonly handlers = new Map<string, Set<(data: string) => void>>();
  private cacheBypassUntil = 0;
  private closed = false;
  private lastWarning = 0;
  readonly metrics: RedisMetrics = {
    hits: 0,
    misses: 0,
    errors: 0,
    invalidations: 0,
  };

  constructor(
    readonly config: RedisConfig,
    private readonly log?: { warn(obj: object, message?: string): void },
  ) {
    // ioredis gives URL auth precedence over its second argument, including an empty URL password. Merge the
    // separately supplied secret before constructing the client; never log this internal connection URL.
    const connectionUrl = new URL(config.url);
    if (config.password !== undefined) connectionUrl.password = config.password;
    this.client = new Redis(connectionUrl.toString(), {
      lazyConnect: true,
      connectTimeout: config.timeoutMs,
      commandTimeout: config.timeoutMs,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (n) =>
        Math.min(100 * 2 ** Math.min(n, 5), 3000) +
        Math.floor(Math.random() * 100),
    });
    this.client.on("error", () => this.failure());
  }

  /** Preserve the plugin's Redis store and quotas, but classify admission failures
   * at their source even when the socket remains ready after a command timeout. */
  requestLimitClient(): Redis {
    return new Proxy(this.client, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property !== "rateLimit" && property !== "rateLimitRead")
          return value.bind(target);
        return (...args: unknown[]) => {
          const callback = args.at(-1);
          if (typeof callback !== "function") return value.apply(target, args);
          args[args.length - 1] = (error: unknown, result: unknown) => {
            if (error) {
              this.failure();
              callback(new ApiError(503, "unavailable", "Shared request limits are temporarily unavailable."), null);
            } else callback(null, result);
          };
          return value.apply(target, args);
        };
      },
    });
  }

  private failure(): void {
    this.metrics.errors++;
    // Never log driver errors, URLs, keys, values or a caller's exception.
    if (Date.now() - this.lastWarning > 30_000) {
      this.lastWarning = Date.now();
      this.log?.warn(
        { service: "redis" },
        "Redis unavailable; cache bypassed, distributed admission fails closed",
      );
    }
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch {
      this.failure();
    }
  }

  key(kind: string, ...scope: string[]): string {
    return `${this.config.prefix}:${kind}:${digest(JSON.stringify(scope))}`;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  /** Caller chooses non-sensitive data only. Generation changes prevent a slow read repopulating an invalidated cache. */
  async cached<T>(
    namespace: string,
    scope: string[],
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 60_000)
      throw new Error("Cache TTL must be 100..60000 ms");
    if (this.client.status !== "ready" || Date.now() < this.cacheBypassUntil)
      return load();
    const generationKey = this.key("generation", namespace);
    let generation: string;
    let cacheKey: string;
    try {
      await this.client.set(
        generationKey,
        randomUUID(),
        "PX",
        GENERATION_MS,
        "NX",
      );
      generation = (await this.client.get(generationKey))!;
      cacheKey = this.key("cache", namespace, generation, ...scope);
      const value = await this.client.get(cacheKey);
      if (value !== null) {
        this.metrics.hits++;
        return JSON.parse(value) as T;
      }
    } catch {
      this.failure();
      return load();
    }
    this.metrics.misses++;
    const existing = this.flights.get(cacheKey);
    if (existing) return existing as Promise<T>;
    const work = (async () => {
      const value = await load(); // permanent-store errors always propagate
      const json = JSON.stringify(value);
      if (json !== undefined && Buffer.byteLength(json) <= 64 * 1024) {
        try {
          await this.client.eval(
            FILL,
            2,
            generationKey,
            cacheKey,
            generation,
            json,
            ttlMs,
          );
        } catch {
          this.failure();
        }
      }
      return value;
    })();
    // Bound process memory during high-cardinality traffic. Excess callers go directly to the source.
    if (this.flights.size < 1000) this.flights.set(cacheKey, work);
    try {
      return await work;
    } finally {
      if (this.flights.get(cacheKey) === work) this.flights.delete(cacheKey);
    }
  }

  async invalidate(namespace: string): Promise<void> {
    this.metrics.invalidations++;
    try {
      await this.client.set(
        this.key("generation", namespace),
        randomUUID(),
        "PX",
        GENERATION_MS,
      );
    } catch {
      this.failure();
      // Preferences are display state only; other processes may retain at most their 15-second TTL.
      this.cacheBypassUntil = Date.now() + 60_000;
    }
  }

  /** One atomic, shared fixed window. No local fallback that would multiply the permitted budget. */
  async rateLimit(
    scope: string[],
    max: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    if (
      !Number.isInteger(max) ||
      max < 1 ||
      !Number.isInteger(windowMs) ||
      windowMs < 1 ||
      windowMs > GENERATION_MS
    )
      throw new Error("Invalid rate limit");
    try {
      const [count, ttl] = (await this.client.eval(
        RATE,
        1,
        this.key("rate", ...scope),
        windowMs,
      )) as [number, number];
      return { allowed: count <= max, retryAfterMs: Math.max(ttl, 1) };
    } catch {
      this.failure();
      throw new Error("Shared rate limiter unavailable");
    }
  }

  /** Expiring device presence; no keys, session tokens or content. A lost process expires without cleanup. */
  async touchPresence(
    userId: string,
    deviceId: string,
    instanceId: string,
  ): Promise<void> {
    try {
      await this.client.eval(
        `redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2]); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[3]); redis.call('PEXPIRE',KEYS[1],90000); return 1`,
        1,
        this.key("presence", userId),
        Date.now() + 90_000,
        digest(JSON.stringify([deviceId, instanceId])),
        Date.now(),
      );
    } catch {
      this.failure();
    }
  }

  async removePresence(
    userId: string,
    deviceId: string,
    instanceId: string,
  ): Promise<void> {
    try {
      await this.client.zrem(
        this.key("presence", userId),
        digest(JSON.stringify([deviceId, instanceId])),
      );
    } catch {
      this.failure();
    }
  }

  async isPresent(userId: string): Promise<boolean | null> {
    try {
      return (
        (await this.client.zcount(
          this.key("presence", userId),
          Date.now(),
          "+inf",
        )) > 0
      );
    } catch {
      return null;
    }
  }

  async typing(
    conversationId: string,
    userId: string,
    on: boolean,
  ): Promise<void> {
    try {
      const key = this.key("typing", conversationId, userId);
      if (on) await this.client.set(key, "1", "PX", 5000);
      else await this.client.del(key);
    } catch {
      this.failure();
    }
  }

  /** Pub/Sub carries invalidation/wakeup metadata only. MongoDB records must be committed before publishing. */
  async publish(
    topic: "preferences" | "relay-wakeup",
    data: string,
  ): Promise<void> {
    if (Buffer.byteLength(data) > 8192)
      throw new Error("Coordination payload too large");
    try {
      await this.client.publish(this.key("events", topic), data);
    } catch {
      this.failure();
    }
  }

  async subscribe(
    topic: "preferences" | "relay-wakeup",
    handler: (data: string) => void,
  ): Promise<void> {
    if (this.closed) return;
    if (!this.subscriber) {
      this.subscriber = this.client.duplicate();
      this.subscriber.on("error", () => this.failure());
      this.subscriber.on("ready", () => {
        const channels = [...this.handlers.keys()];
        if (channels.length)
          void this.subscriber!.subscribe(...channels).catch(() =>
            this.failure(),
          );
      });
      this.subscriber.on("message", (channel, data) => {
        for (const fn of this.handlers.get(channel) ?? []) {
          try {
            fn(data);
          } catch {
            this.failure();
          }
        }
      });
      try {
        await this.subscriber.connect();
      } catch {
        this.failure();
      }
    }
    const channel = this.key("events", topic);
    const listeners = this.handlers.get(channel) ?? new Set();
    listeners.add(handler);
    this.handlers.set(channel, listeners);
    try {
      await this.subscriber.subscribe(channel);
    } catch {
      this.failure();
    }
  }

  /** Aggregate infrastructure measurements only; exposed through the authenticated admin infrastructure view. */
  async diagnostics(): Promise<{
    ready: boolean;
    usedMemoryBytes: number | null;
    metrics: RedisMetrics;
  }> {
    let usedMemoryBytes: number | null = null;
    try {
      const info = await this.client.info("memory");
      const match = /^used_memory:(\d+)/m.exec(info);
      if (match) usedMemoryBytes = Number(match[1]);
    } catch {
      this.failure();
    }
    return {
      ready: this.client.status === "ready",
      usedMemoryBytes,
      metrics: { ...this.metrics },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    this.subscriber?.disconnect();
    this.client.disconnect();
  }
}
