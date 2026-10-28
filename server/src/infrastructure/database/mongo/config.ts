/**
 * MongoDB settings (docs/MONGODB.md). Nothing here is required: without MONGODB_URI the server keeps every table in
 * SQLite exactly as before. MONGODB_DOMAINS lists the data that is authoritative in MongoDB instead; each domain moves
 * as a whole, with its own migration (src/mongo/migrate.ts), so no table ever has two writable copies.
 */
export const MONGO_DOMAINS = ["accounts", "preferences", "history", "reports", "relationships", "relay", "files"] as const;
/**
 * Domains that no longer exist: "integrations" went with the apps (docs/COMMUNITY_REBUILD_2026-10-21.md). A server
 * still configured with one starts and ignores it, so an unchanged environment file can't stop a deploy.
 */
export const RETIRED_MONGO_DOMAINS: readonly string[] = ["integrations"];
export type MongoDomain = (typeof MONGO_DOMAINS)[number];

export interface MongoConfig {
  /** Connection string; never logged (see redactUri). Credentials belong in it or in the environment, never in Git. */
  uri: string;
  dbName: string;
  domains: ReadonlySet<MongoDomain>;
  maxPoolSize: number;
  /** Server selection, connect and per-operation socket timeouts (ms). */
  timeoutMs: number;
  /** The deployment's storage limit in MiB (512 on an Atlas Free cluster); 0: copies aren't checked against one. */
  storageLimitMb: number;
}

const DEFAULT_DB = "meldiq";
const DEFAULT_POOL = 20;
const DEFAULT_TIMEOUT_MS = 5000;

/** The URI with any password replaced, for logs and errors. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:/@]+):([^@]*)@/, "//$1:***@");
}

/** Local addresses, where TLS isn't required (a development or test database on the same machine). */
function isLocalHost(uri: string): boolean {
  const hosts = uri.replace(/^mongodb(\+srv)?:\/\//, "").split("/")[0].replace(/^[^@]*@/, "");
  return hosts.split(",").every((h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h));
}

function usesTls(uri: string): boolean {
  return uri.startsWith("mongodb+srv://") || /[?&](tls|ssl)=true(&|$)/i.test(uri);
}

export function mongoConfig(env: NodeJS.ProcessEnv, appEnv: string, int: (name: string, def: number) => number): MongoConfig | null {
  const uri = env.MONGODB_URI?.trim();
  const domains = (env.MONGODB_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d && !RETIRED_MONGO_DOMAINS.includes(d));
  for (const d of domains) {
    if (!(MONGO_DOMAINS as readonly string[]).includes(d)) throw new Error(`MONGODB_DOMAINS: unknown domain "${d}" (known: ${MONGO_DOMAINS.join(", ")})`);
  }
  if (!uri) {
    if (domains.length) throw new Error("MONGODB_DOMAINS needs MONGODB_URI");
    return null;
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error("MONGODB_URI must start with mongodb:// or mongodb+srv://");
  // Production data never crosses a network unencrypted.
  if (appEnv === "production" && !isLocalHost(uri) && !usesTls(uri)) {
    throw new Error(`MONGODB_URI must use TLS in production (mongodb+srv:// or tls=true): ${redactUri(uri)}`);
  }
  const dbName = env.MONGODB_DB?.trim() || DEFAULT_DB;
  if (!/^[A-Za-z0-9_-]{1,38}$/.test(dbName)) throw new Error("MONGODB_DB may only use letters, digits, _ and - (at most 38)");
  return {
    uri,
    dbName,
    domains: new Set(domains as MongoDomain[]),
    maxPoolSize: Math.min(Math.max(int("MONGODB_MAX_POOL", DEFAULT_POOL), 1), 200),
    timeoutMs: Math.min(Math.max(int("MONGODB_TIMEOUT_MS", DEFAULT_TIMEOUT_MS), 500), 60_000),
    storageLimitMb: Math.max(int("MONGODB_STORAGE_LIMIT_MB", 0), 0),
  };
}
