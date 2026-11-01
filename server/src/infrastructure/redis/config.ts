export interface RedisConfig {
  url: string;
  password?: string;
  prefix: string;
  timeoutMs: number;
}

/** Never include URL values in errors: userinfo/query parameters may contain credentials. */
export function redisConfig(
  env: NodeJS.ProcessEnv,
  production: boolean,
): RedisConfig | null {
  if (!env.REDIS_URL?.trim()) return null;
  let url: URL;
  try {
    url = new URL(env.REDIS_URL.trim());
  } catch {
    throw new Error("REDIS_URL must be a valid Redis URL");
  }
  if (!["redis:", "rediss:"].includes(url.protocol))
    throw new Error("REDIS_URL must use redis:// or rediss://");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    production &&
    !local &&
    url.protocol !== "rediss:" &&
    env.REDIS_PRIVATE_NETWORK !== "true"
  ) {
    throw new Error(
      "Redis requires TLS in production, or REDIS_PRIVATE_NETWORK=true on an isolated private network",
    );
  }
  if (url.search || url.hash)
    throw new Error(
      "REDIS_URL query parameters and fragments are not supported",
    );
  const prefix = env.REDIS_KEY_PREFIX?.trim() || "meldiq:production:v1";
  if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(prefix))
    throw new Error("REDIS_KEY_PREFIX contains unsupported characters");
  const timeoutMs = Number(env.REDIS_TIMEOUT_MS || 1000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000)
    throw new Error("REDIS_TIMEOUT_MS must be between 100 and 5000");
  return {
    url: url.toString(),
    password: env.REDIS_PASSWORD || undefined,
    prefix,
    timeoutMs,
  };
}
