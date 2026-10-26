import { secretsKey } from "../modules/ai/index.js";
import path from "node:path";
import { networkKey } from "./middleware/abuse.js";
import { type MongoConfig, mongoConfig } from "../infrastructure/database/mongo/config.js";
import { type AccountsConfig, accountsConfig } from "../modules/accounts/config.js";
import { type EntitlementConfig, entitlementConfig } from "../modules/administration/entitlements.js";
import { type ExperimentsConfig, experimentsConfig } from "../modules/administration/experiments/assign.js";
import type { S3Config } from "../infrastructure/storage/s3.js";
import { type FcmConfig, fcmConfig } from "../modules/notifications/fcm.js";
import { type AdminConsoleConfig, adminConsoleConfig } from "../modules/platformAdmin/config.js";

const SEVEN_DAYS_S = 7 * 24 * 3600;
const MiB = 1024 * 1024;
/** The default per-file limit (Orbit 2.0): 1 GiB of the person's file, before encryption. */
export const DEFAULT_FILE_MAX_BYTES = 1024 * MiB;
/** Room for encryption overhead on top of the file limit: the chunked format adds 16 bytes per 1 MiB chunk. */
const ENCRYPTION_HEADROOM_BYTES = MiB;

export type StorageBackend = "local" | "s3";

function registrationMode(v: string | undefined): "invite" | "open" {
  if (v === undefined || v === "" || v === "invite") return "invite";
  if (v === "open") return "open";
  throw new Error("REGISTRATION_MODE must be invite or open");
}

function intFrom(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === "") return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}`);
  return n;
}

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  /** The data folder (DATA_DIR): files the server keeps besides the database, e.g. reports.key (batch B4). */
  dataDir: string;
  attachmentDir: string;
  /** How long a 1:1 call waits for someone whose media connection dropped before it ends as "lost" (ms). */
  callPeerGraceMs: number;
  /**
   * Most devices in one call (UI-003). Matches LiveKit's `room.max_participants` (12 in deploy/livekit), so a join past it
   * is refused with a clear reason instead of failing inside the media server.
   */
  callMaxParticipants: number;
  /** Profile photos (published by their owners, not end-to-end encrypted; served per each person's privacy settings). */
  profilePhotoDir: string;
  /** Delivery queue TTL in seconds. Hard-capped at 7 days. */
  queueTtlSeconds: number;
  /**
   * Batch B6: who may open a DM with someone who hasn't chosen (DEFAULT_DM_POLICY). "everyone" until apps that show
   * message requests are common; then "communities", so strangers' DMs wait as requests.
   */
  defaultDmPolicy: "everyone" | "communities" | "connections";
  /** How often due reminders are fired (docs/REMINDERS.md); 0 turns the loop off (tests fire them by hand). */
  reminderTickMs: number;
  /** How often telemetry is written and sampled (TELEMETRY_TICK_MS, default a minute; 0: never, tests drive it). */
  telemetryTickMs: number;
  /** How often the AI Workforce worker looks for due jobs (AI_WORKFORCE_TICK_MS, default 1 s; 0: never, tests drive it). */
  aiWorkforceTickMs: number;
  /** PLATFORM_SECRETS_KEY: the key that encrypts credentials stored by the platform console (AI providers); null unset. */
  platformSecretsKey: Buffer | null;
  /** How often background schedules (meeting "starting soon" notices) are checked; 0 stops them (tests drive them). */
  workflowTickMs: number;
  attachmentTtlSeconds: number;
  attachmentMaxBytes: number;
  /**
   * Upload quotas (bytes; 0: no limit). Owner's decision 2026-10-18 (UI-003): 1 GB per file and no other file upload
   * limits, so all of them default to 0; each can still be set if a server ever needs one.
   */
  attachmentUserDailyBytes: number;
  attachmentUserStoredBytes: number;
  attachmentTotalBytes: number;
  /** Uploads streaming at once, per user and for the whole server, and the bytes they may have in flight. */
  attachmentMaxConcurrentPerUser: number;
  attachmentMaxConcurrent: number;
  attachmentMaxPendingBytes: number;
  /**
   * Durable files (2026-10-17): an attachment a member keeps for their encrypted history (POST /v1/attachments/:id/keep)
   * stays this many days instead of the 7-day relay window (0: files are never kept longer). Kept bytes count against
   * the uploader's own quota for kept files, not the 7-day one.
   */
  attachmentKeepDays: number;
  attachmentUserKeptBytes: number;
  /**
   * Where files live: the server's disk (default) or Amazon S3 / a compatible store (docs/STORAGE_AND_DATA.md).
   * [readFallback]: the other backend, still read (and deleted from) after a switch, so files stored before it stay
   * available until they expire; new files go to [backend] only. [s3] is set whenever either one is S3.
   */
  storage: { backend: StorageBackend; readFallback: StorageBackend | null; s3: S3Config | null };
  /** Encrypted message history kept for each account (docs/MESSAGE_HISTORY.md). */
  history: { enabled: boolean; maxItemsPerUser: number; maxBytesPerUser: number; maxItemBytes: number; tombstoneDays: number; maxTotalBytes: number };
  /**
   * Direct uploads from the app to S3 (2026-10-17). How long an upload URL may be started with, how long an upload may
   * take before it counts as abandoned (its object or parts are then deleted), and how many a person may have open.
   */
  directUploads: { urlTtlSeconds: number; sessionSeconds: number; maxPendingPerUser: number };
  /**
   * The largest file a person may send, in bytes of the file itself (before encryption). Apps check it byte-exactly;
   * [attachmentMaxBytes] is the ciphertext limit the server enforces, which defaults to this plus encryption headroom.
   */
  fileMaxBytes: number;
  /** Orbit 2.0 email-and-password accounts (src/accounts). */
  accounts: AccountsConfig;
  /** MongoDB, for the data domains listed in MONGODB_DOMAINS (docs/MONGODB.md); null: everything stays in SQLite. */
  mongo: MongoConfig | null;
  /**
   * Platform administrators (PLATFORM_ADMIN_USER_IDS, user ids): the service health, usage and experiments views. Never
   * grants anything inside a community.
   */
  platformAdmins: ReadonlySet<string>;
  /**
   * The Platform Admin Console (ADMIN_CONSOLE_ORIGIN, src/modules/platformAdmin): its routes exist only when set. Its
   * roles are its own (platform_admins); PLATFORM_ADMIN_USER_IDS above stays the in-app Service health switch.
   */
  adminConsole: AdminConsoleConfig | null;
  /** Server-wide limits for future plans (docs/PLANS.md); none by default. */
  entitlements: EntitlementConfig;
  /** Product experiments (docs/product/EXPERIMENTS.md): off unless EXPERIMENTS_MODE says otherwise. */
  experiments: ExperimentsConfig;
  /** Content-free daily analytics counts (ANALYTICS_ENABLED=true); off by default. */
  analyticsEnabled: boolean;
  /** "invite" (default): registering needs a registration or org invite code. "open": anyone may register. */
  registrationMode: "invite" | "open";
  /**
   * Synthetic load-test accounts registered with an operator's load-test invite (docs/LOADTEST_PROVISIONING.md):
   * rolling-hour and rolling-24-hour quotas (both > 0 to enable; 0, the default: the path is closed) and the networks
   * allowed to use it (empty: any network that holds a valid load-test invite).
   */
  loadtestRegistration: { hourly: number; daily: number; networks: string[] };
  sessionTtlSeconds: number;
  cleanupIntervalSeconds: number;
  ringTimeoutSeconds: number;
  /** Ended calls (and their participant rows) older than this are deleted (RETENTION.md). */
  callRecordRetentionDays: number;
  /** Audit-log rows older than this are deleted (RETENTION.md). */
  auditRetentionDays: number;
  /**
   * @everyone policy (docs/MENTIONS.md). Group admins and channel managers may always mention everyone; other members
   * only in conversations with at most this many members (0: admins and managers only).
   */
  mentionAllMemberLimit: number;
  /** @everyone messages one person may send per conversation per hour (any role). */
  mentionAllPerHour: number;
  livekit: {
    /** URL clients use to reach LiveKit (ws:// or wss://). */
    publicUrl: string;
    /** URL the API uses for LiveKit's server API (http:// or https://). */
    apiUrl: string;
    apiKey: string;
    apiSecret: string;
  } | null;
  /**
   * Which X-Forwarded-For entries to believe for the client address (rate limits, registration limits): a list of the
   * proxies' addresses, CIDRs or proxy-addr names (production: "loopback,uniquelocal", host nginx reaching the
   * container through Docker's network). The client is then the last address a trusted proxy added. `true` believes
   * every entry, including ones a client sends itself, so per-address limits can be dodged (logged at start).
   */
  trustProxy: boolean | string[];
  /**
   * WEB_ORIGINS: the browser apps allowed to use this API from another origin (CORS) and to open its WebSocket, e.g.
   * "https://web.griipbuddy.cloud". Empty (the default): no cross-origin access, and WebSocket origins aren't checked.
   * Requests without an Origin (the phone apps) are never affected. Tokens are bearer tokens, never cookies.
   */
  webOrigins: string[];
  /** Abuse controls (docs/ABUSE_CONTROLS.md). 0 turns a limit off. */
  abuse: AbuseConfig;
  /**
   * How long a connection must stay open before others see the person online (PRESENCE_SETTLE_MS, default 4 s), and
   * how long after the last one closes they still appear online (PRESENCE_GRACE_MS, default 10 s): push wake-ups and
   * network hand-offs don't flash anyone online or offline (src/modules/realtime/presence.ts).
   */
  presence: { settleMs: number; graceMs: number };
  /** Optional display name for this instance, shown on client setup screens (INSTANCE_NAME). */
  instanceName: string | null;
  /** Federation with other Griip servers (docs/FEDERATION_PROTOCOL.md). Null when FEDERATION_DOMAIN isn't set. */
  federation: FederationConfig | null;
  /** Payload-free push wake-ups (docs/BACKGROUND_DELIVERY.md). Null (off) unless PUSH_UNIFIEDPUSH_HOSTS is set. */
  push: PushConfig | null;
  /** Firebase Cloud Messaging wake-ups (docs/PUSH_FCM.md). Null (off) unless FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_FILE are set. */
  fcm: FcmConfig | null;
  /** Importing a Discord server's structure (docs/DISCORD_IMPORT.md). Null (off) unless all four DISCORD_* values are set. */
  discord: DiscordConfig | null;
  logLevel: string;
  rateLimitPerMinute: number;
}

export interface DiscordConfig {
  /** The Discord application (DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET) and its bot (DISCORD_BOT_TOKEN). */
  clientId: string;
  clientSecret: string;
  botToken: string;
  /** Where Discord sends people back (DISCORD_REDIRECT_URI): Meldiq Web's /discord/callback, registered on the application. */
  redirectUri: string;
  /** Discord's API and image CDN; other values only for tests against a local stand-in (DISCORD_API_BASE, DISCORD_CDN_BASE). */
  apiBase: string;
  cdnBase: string;
}

/** An https URL, or http on this machine (tests and local development only). */
function serviceUrl(raw: string, name: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name}: "${raw}" isn't a URL`);
  }
  const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !local) throw new Error(`${name} must be an https URL`);
  return raw.replace(/\/$/, "");
}

export function discordConfig(env: NodeJS.ProcessEnv): DiscordConfig | null {
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const redirect = env.DISCORD_REDIRECT_URI?.trim();
  if (!clientId && !clientSecret && !botToken && !redirect) return null;
  if (!clientId || !clientSecret || !botToken || !redirect) {
    throw new Error("Discord import needs DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN and DISCORD_REDIRECT_URI together (or none of them)");
  }
  if (!/^\d{5,25}$/.test(clientId)) throw new Error("DISCORD_CLIENT_ID is the application's numeric id");
  return {
    clientId,
    clientSecret,
    botToken,
    redirectUri: serviceUrl(redirect, "DISCORD_REDIRECT_URI"),
    apiBase: serviceUrl(env.DISCORD_API_BASE?.trim() || "https://discord.com/api/v10", "DISCORD_API_BASE"),
    cdnBase: serviceUrl(env.DISCORD_CDN_BASE?.trim() || "https://cdn.discordapp.com", "DISCORD_CDN_BASE"),
  };
}

export interface PushConfig {
  /**
   * The only push servers wake-ups are sent to: host names, or host:port for a port other than 443. Devices can
   * register endpoints on these hosts only, and every request also has to reach a public address (no SSRF).
   */
  unifiedPushHosts: string[];
  /** At most one wake-up per device in this window; a later request waits for its end instead of being dropped. */
  wakeIntervalMs: number;
  /** A ring is urgent: it waits at most this long after the device's previous wake-up. */
  urgentWakeIntervalMs: number;
  /** Deadline for one wake-up request, connecting included. */
  timeoutMs: number;
}

const PUSH_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;

function pushConfig(env: NodeJS.ProcessEnv, int: (n: string, d: number) => number): PushConfig | null {
  const hosts = [...new Set((env.PUSH_UNIFIEDPUSH_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (hosts.length === 0) return null;
  for (const h of hosts) {
    const port = h.includes(":") ? Number(h.split(":")[1]) : 443;
    if (!PUSH_HOST.test(h) || port < 1 || port > 65535 || h.endsWith(":443")) {
      throw new Error(`PUSH_UNIFIEDPUSH_HOSTS takes host names such as ntfy.example.com (host:port only for a port other than 443), without https:// or a path; got "${h}"`);
    }
  }
  return {
    unifiedPushHosts: hosts,
    wakeIntervalMs: Math.min(Math.max(int("PUSH_WAKE_INTERVAL_SECONDS", 30), 5), 600) * 1000,
    urgentWakeIntervalMs: 5000,
    timeoutMs: Math.min(Math.max(int("PUSH_TIMEOUT_MS", 5000), 1000), 15_000),
  };
}

export interface AbuseConfig {
  /** Accounts created by open registration (no invitation) from one network address: IPv4 address or IPv6 /64. */
  registrationsPerAddressPerHour: number;
  registrationsPerAddressPerDay: number;
  /** Open registrations on the whole server in 24 hours; past it, sign-up waits (invitations still work). */
  openRegistrationsPerDay: number;
  /**
   * New-account limits: an account made by open registration has smaller allowances for this many days, until it
   * accepts an invitation from an established member, or until an administrator ends them (admin.js limits-end).
   */
  newAccountDays: number;
  newAccountDailyBytes: number;
  newAccountStoredBytes: number;
  /** Files stored by all accounts under new-account limits together, so many new accounts can't fill the server. */
  newAccountsTotalBytes: number;
  newAccountHistoryBytes: number;
  /** Files stored in one workspace's conversations (including kept files and uploads in progress). */
  orgStoredBytes: number;
  /** Uploads one person may start in an hour (finished, failed or cancelled), so retries can't run forever. */
  uploadStartsPerHour: number;
  /** Devices an account may have at once (not removed). */
  maxDevicesPerUser: number;
  /** Realtime frames a connection may send: a steady rate and a burst; far past the burst the connection is closed. */
  wsFramesPerSecond: number;
  wsFrameBurst: number;
  /** Realtime connections per device; a newer one replaces the oldest. */
  wsMaxSocketsPerDevice: number;
  /** How long a socket opened without an Authorization header (a browser) has to send its {t:"auth"} frame. */
  wsAuthTimeoutMs: number;
}

/** WEB_ORIGINS: comma-separated origins (scheme, host and port only); https, or http for localhost in development. */
export function webOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(part);
    } catch {
      throw new Error(`WEB_ORIGINS: "${part}" isn't an origin like https://web.example.com`);
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if ((u.protocol !== "https:" && !(u.protocol === "http:" && local)) || u.pathname !== "/" || u.search || u.hash || u.username) {
      throw new Error(`WEB_ORIGINS: "${part}" must be an https origin without a path`);
    }
    out.push(u.origin);
  }
  return [...new Set(out)];
}

/** TRUST_PROXY: false | true | comma-separated proxy addresses, CIDRs or names (loopback, linklocal, uniquelocal). */
function trustProxy(v: string | undefined): Config["trustProxy"] {
  const s = (v ?? "").trim();
  if (s === "" || s === "false") return false;
  if (s === "true") return true;
  // Fastify ignores a hop count altogether (it can't tell a proxy from a client that way), so refuse one.
  if (/^\d+$/.test(s)) throw new Error("TRUST_PROXY takes the proxies' addresses (for example loopback,uniquelocal), not a number of hops");
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function abuseConfig(int: (n: string, d: number) => number): AbuseConfig {
  const atLeast0 = (n: string, d: number) => Math.max(int(n, d), 0);
  return {
    registrationsPerAddressPerHour: atLeast0("REGISTRATION_PER_ADDRESS_PER_HOUR", 10),
    registrationsPerAddressPerDay: atLeast0("REGISTRATION_PER_ADDRESS_PER_DAY", 30),
    openRegistrationsPerDay: atLeast0("REGISTRATION_OPEN_PER_DAY", 200),
    newAccountDays: atLeast0("NEW_ACCOUNT_LIMIT_DAYS", 7),
    // File uploads: no new-account limits by default (0: none; owner's decision 2026-10-18, UI-003).
    newAccountDailyBytes: atLeast0("NEW_ACCOUNT_DAILY_UPLOAD_BYTES", 0),
    newAccountStoredBytes: atLeast0("NEW_ACCOUNT_STORED_BYTES", 0),
    newAccountsTotalBytes: atLeast0("NEW_ACCOUNTS_TOTAL_STORED_BYTES", 0),
    newAccountHistoryBytes: atLeast0("NEW_ACCOUNT_HISTORY_BYTES", 64 * MiB),
    orgStoredBytes: atLeast0("ATTACHMENT_ORG_STORED_BYTES", 0),
    uploadStartsPerHour: atLeast0("ATTACHMENT_UPLOAD_STARTS_PER_HOUR", 0),
    maxDevicesPerUser: atLeast0("MAX_DEVICES_PER_USER", 20),
    wsFramesPerSecond: Math.max(int("WS_FRAMES_PER_SECOND", 20), 1),
    wsFrameBurst: Math.max(int("WS_FRAME_BURST", 100), 1),
    wsMaxSocketsPerDevice: Math.max(int("WS_MAX_SOCKETS_PER_DEVICE", 4), 1),
    wsAuthTimeoutMs: Math.min(Math.max(int("WS_AUTH_TIMEOUT_MS", 10_000), 100), 60_000),
  };
}

export interface FederationConfig {
  /** This server's federation domain: the part after ":" in user addresses (@name:domain). */
  domain: string;
  /** Public base URL other servers and core nodes reach this server at. Set after listen() in tests if empty. */
  publicUrl: string;
  /** Core nodes: url and public key of each. */
  coreNodes: { url: string; publicKey: string }[];
  /** How many core nodes must agree on a domain → server binding. */
  coreQuorum: number;
  /** Development only: allow plain http between servers and to core nodes. */
  allowHttp: boolean;
  /** "open": any registered, verified server may federate; "allowlist": only listed server ids or domains. */
  policy: "open" | "allowlist";
  allowlist: string[];
  heartbeatMs: number;
  outboxIntervalMs: number;
  /** Bound on queued federation items per destination server. */
  outboxMaxPerPeer: number;
  /** Where the server's identity key lives (default DATA_DIR/federation). */
  keyDir: string;
}

function federationConfig(env: NodeJS.ProcessEnv, dataDir: string, int: (n: string, d: number) => number): FederationConfig | null {
  const domain = (env.FEDERATION_DOMAIN ?? "").trim().toLowerCase();
  if (!domain) return null;
  const coreNodes = (env.FEDERATION_CORE_NODES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf("#");
      if (i < 0) throw new Error("FEDERATION_CORE_NODES entries need the form url#publicKey");
      return { url: s.slice(0, i), publicKey: s.slice(i + 1) };
    });
  return {
    domain,
    publicUrl: (env.FEDERATION_PUBLIC_URL ?? "").trim().replace(/\/$/, ""),
    coreNodes,
    coreQuorum: int("FEDERATION_CORE_QUORUM", Math.floor(coreNodes.length / 2) + 1),
    allowHttp: env.FEDERATION_ALLOW_HTTP === "true",
    policy: env.FEDERATION_POLICY === "allowlist" ? "allowlist" : "open",
    allowlist: (env.FEDERATION_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    heartbeatMs: int("FEDERATION_HEARTBEAT_SECONDS", 60) * 1000,
    outboxIntervalMs: int("FEDERATION_OUTBOX_INTERVAL_MS", 2000),
    outboxMaxPerPeer: int("FEDERATION_OUTBOX_MAX_PER_PEER", 10000),
    keyDir: env.FEDERATION_KEY_DIR ?? path.join(dataDir, "federation"),
  };
}

/** Bytes the chunked attachment format adds per chunk (an AES-GCM tag) and its chunk size (docs/ATTACHMENTS.md). */
const CHUNK_TAG_BYTES = 16;
const CHUNK_BYTES = MiB;

/**
 * The file limit apps are told (`fileMaxBytes` in server-info): [Config.fileMaxBytes], lowered when the ciphertext
 * limit is set smaller (production ran ATTACHMENT_MAX_BYTES at 25 MB), so a file the app accepts always fits once
 * encrypted. The overhead is counted per started chunk, which is never less than the real one.
 */
export function effectiveFileMaxBytes(c: Pick<Config, "fileMaxBytes" | "attachmentMaxBytes">): number {
  const overhead = CHUNK_TAG_BYTES * Math.ceil(c.attachmentMaxBytes / CHUNK_BYTES);
  return Math.max(Math.min(c.fileMaxBytes, c.attachmentMaxBytes - overhead), 0);
}

function dmPolicyFrom(v: string | undefined): Config["defaultDmPolicy"] {
  if (v === undefined || v === "") return "everyone";
  if (v === "everyone" || v === "communities" || v === "connections") return v;
  throw new Error(`DEFAULT_DM_POLICY must be everyone, communities or connections (got "${v}")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const int = (name: string, def: number) => intFrom(env, name, def);
  const dataDir = env.DATA_DIR ?? path.resolve("data");
  const lkKey = env.LIVEKIT_API_KEY;
  const lkSecret = env.LIVEKIT_API_SECRET;
  const lkPublic = env.LIVEKIT_PUBLIC_URL;
  if (lkSecret && lkSecret.length < 32) {
    throw new Error("LIVEKIT_API_SECRET must be at least 32 characters");
  }
  const queueTtl = Math.min(int("QUEUE_TTL_SECONDS", SEVEN_DAYS_S), SEVEN_DAYS_S);
  const fileMaxBytes = Math.max(int("FILE_MAX_BYTES", DEFAULT_FILE_MAX_BYTES), 1);
  const attachmentMaxBytes = int("ATTACHMENT_MAX_BYTES", fileMaxBytes + ENCRYPTION_HEADROOM_BYTES);
  return {
    host: env.HOST ?? "0.0.0.0",
    port: int("PORT", 8080),
    databasePath: env.DATABASE_PATH ?? path.join(dataDir, "griip.sqlite"),
    dataDir,
    attachmentDir: env.ATTACHMENT_DIR ?? path.join(dataDir, "attachments"),
    profilePhotoDir: env.PROFILE_PHOTO_DIR ?? path.join(dataDir, "profile-photos"),
    callPeerGraceMs: int("CALL_PEER_GRACE_MS", 30_000),
    callMaxParticipants: Math.max(int("CALL_MAX_PARTICIPANTS", 12), 2),
    queueTtlSeconds: Math.max(queueTtl, 1),
    defaultDmPolicy: dmPolicyFrom(env.DEFAULT_DM_POLICY),
    reminderTickMs: Math.min(Math.max(int("REMINDER_TICK_MS", 15_000), 0), 300_000),
    telemetryTickMs: Math.min(Math.max(int("TELEMETRY_TICK_MS", 60_000), 0), 300_000),
    aiWorkforceTickMs: Math.min(Math.max(int("AI_WORKFORCE_TICK_MS", 1000), 0), 60_000),
    platformSecretsKey: secretsKey(env),
    workflowTickMs: Math.min(Math.max(int("WORKFLOW_TICK_MS", 3_000), 0), 300_000),
    attachmentTtlSeconds: Math.min(int("ATTACHMENT_TTL_SECONDS", SEVEN_DAYS_S), SEVEN_DAYS_S),
    // 1 GiB per file since Orbit 2.0 (files over 25 MB use the chunked format; docs/ATTACHMENTS.md). Uploads to S3 go
    // straight from the app; uploads through the server need the reverse proxy to allow bodies this large.
    attachmentMaxBytes,
    fileMaxBytes,
    accounts: accountsConfig(env, dataDir, int),
    mongo: mongoConfig(env, env.APP_ENV?.trim() || "development", int),
    platformAdmins: new Set((env.PLATFORM_ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    adminConsole: adminConsoleConfig(env, int),
    entitlements: entitlementConfig(env),
    experiments: experimentsConfig(env),
    analyticsEnabled: (env.ANALYTICS_ENABLED ?? "").trim().toLowerCase() === "true",
    // No upload quotas by default (0: no limit; owner's decision 2026-10-18, UI-003).
    attachmentUserDailyBytes: Math.max(int("ATTACHMENT_USER_DAILY_BYTES", 0), 0),
    attachmentUserStoredBytes: Math.max(int("ATTACHMENT_USER_STORED_BYTES", 0), 0),
    attachmentTotalBytes: Math.max(int("ATTACHMENT_TOTAL_BYTES", 0), 0),
    attachmentMaxConcurrentPerUser: int("ATTACHMENT_MAX_CONCURRENT_PER_USER", 2),
    attachmentMaxConcurrent: int("ATTACHMENT_MAX_CONCURRENT", 8),
    // Bytes being streamed through the server at once (its temporary disk). At least two files of the largest size:
    // the old default (1024 MiB) was below one 1 GB file plus its encryption headroom, so such a file was always refused.
    attachmentMaxPendingBytes: Math.max(int("ATTACHMENT_MAX_PENDING_BYTES", 2 * attachmentMaxBytes), 2 * attachmentMaxBytes),
    attachmentKeepDays: Math.max(int("ATTACHMENT_KEEP_DAYS", 365), 0),
    attachmentUserKeptBytes: Math.max(int("ATTACHMENT_USER_KEPT_BYTES", 0), 0),
    storage: storageConfig(env, dataDir, int),
    directUploads: {
      urlTtlSeconds: Math.min(Math.max(int("S3_UPLOAD_URL_TTL_SECONDS", 900), 60), 3600),
      sessionSeconds: Math.min(Math.max(int("DIRECT_UPLOAD_SESSION_SECONDS", 24 * 3600), 600), 7 * 86_400),
      maxPendingPerUser: Math.max(int("DIRECT_UPLOAD_MAX_PENDING_PER_USER", 10), 1),
    },
    history: {
      enabled: env.HISTORY_ENABLED !== "false",
      maxItemsPerUser: Math.max(int("HISTORY_MAX_ITEMS_PER_USER", 500_000), 0),
      maxBytesPerUser: Math.max(int("HISTORY_MAX_BYTES_PER_USER", 1024 * MiB), 0),
      maxItemBytes: Math.min(Math.max(int("HISTORY_MAX_ITEM_BYTES", 64 * 1024), 1024), 1024 * 1024),
      tombstoneDays: Math.max(int("HISTORY_TOMBSTONE_DAYS", 90), 1),
      // Every account's history together: it lives in the database, on the server's own disk (0: no cap).
      maxTotalBytes: Math.max(int("HISTORY_TOTAL_BYTES", 10 * 1024 * MiB), 0),
    },
    registrationMode: registrationMode(env.REGISTRATION_MODE),
    loadtestRegistration: {
      hourly: Math.max(int("LOADTEST_REGISTRATION_HOURLY_LIMIT", 0), 0),
      daily: Math.max(int("LOADTEST_REGISTRATION_DAILY_LIMIT", 0), 0),
      networks: (env.LOADTEST_REGISTRATION_NETWORKS ?? "").split(",").map((n) => n.trim()).filter(Boolean).map((n) => networkKey(n)),
    },
    sessionTtlSeconds: int("SESSION_TTL_SECONDS", 7 * 24 * 3600),
    cleanupIntervalSeconds: Math.max(int("CLEANUP_INTERVAL_SECONDS", 60), 1),
    ringTimeoutSeconds: int("RING_TIMEOUT_SECONDS", 45),
    callRecordRetentionDays: Math.max(int("CALL_RECORD_RETENTION_DAYS", 90), 1),
    auditRetentionDays: Math.max(int("AUDIT_RETENTION_DAYS", 365), 30),
    mentionAllMemberLimit: Math.max(int("MENTION_ALL_MEMBER_LIMIT", 10), 0),
    mentionAllPerHour: Math.max(int("MENTION_ALL_PER_HOUR", 5), 1),
    livekit:
      lkKey && lkSecret && lkPublic
        ? {
            publicUrl: lkPublic,
            apiUrl: env.LIVEKIT_API_URL ?? lkPublic.replace(/^ws/, "http"),
            apiKey: lkKey,
            apiSecret: lkSecret,
          }
        : null,
    trustProxy: trustProxy(env.TRUST_PROXY),
    webOrigins: webOrigins(env.WEB_ORIGINS),
    abuse: abuseConfig(int),
    presence: {
      settleMs: Math.min(Math.max(int("PRESENCE_SETTLE_MS", 4_000), 0), 60_000),
      graceMs: Math.min(Math.max(int("PRESENCE_GRACE_MS", 10_000), 0), 120_000),
    },
    instanceName: (env.INSTANCE_NAME ?? "").trim().slice(0, 80) || null,
    federation: federationConfig(env, dataDir, int),
    push: pushConfig(env, int),
    fcm: fcmConfig(env),
    discord: discordConfig(env),
    logLevel: env.LOG_LEVEL ?? "info",
    rateLimitPerMinute: int("RATE_LIMIT_PER_MINUTE", 600),
  };
}

/**
 * STORAGE_BACKEND=s3 stores attachments and profile photos in a private S3 bucket instead of DATA_DIR. Credentials come
 * from S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, or else from the AWS SDK's default chain (AWS_* variables, AWS_PROFILE,
 * or a `credential_process` such as IAM Roles Anywhere's signing helper); never from clients. Missing settings stop the
 * server at startup rather than silently falling back to disk.
 *
 * STORAGE_READ_FALLBACK names the other backend after a switch (s3 when going back to the disk, local when moving to
 * S3): files it holds stay readable, nothing is copied or removed from it except by normal expiry.
 */
function storageConfig(env: NodeJS.ProcessEnv, dataDir: string, int: (n: string, d: number) => number): Config["storage"] {
  const backend = storageBackend(env.STORAGE_BACKEND, "STORAGE_BACKEND") ?? "local";
  const readFallback = storageBackend(env.STORAGE_READ_FALLBACK, "STORAGE_READ_FALLBACK");
  if (readFallback === backend) throw new Error("STORAGE_READ_FALLBACK must differ from STORAGE_BACKEND");
  const usesS3 = backend === "s3" || readFallback === "s3";
  return { backend, readFallback, s3: usesS3 ? s3Config(env, dataDir, int) : null };
}

function storageBackend(v: string | undefined, name: string): StorageBackend | null {
  const s = (v ?? "").trim();
  if (s === "") return null;
  if (s !== "local" && s !== "s3") throw new Error(`${name} must be local or s3`);
  return s;
}

function s3Config(env: NodeJS.ProcessEnv, dataDir: string, int: (n: string, d: number) => number): S3Config {
  const need = (name: string, v: string | undefined) => {
    if (!v || !v.trim()) throw new Error(`S3 storage needs ${name}`);
    return v.trim();
  };
  const sse = (env.S3_SSE ?? "AES256").trim();
  if (sse !== "AES256" && sse !== "aws:kms" && sse !== "none") throw new Error("S3_SSE must be AES256, aws:kms or none");
  const prefix = (env.S3_PREFIX ?? "orbit/").trim();
  if (prefix && !/^[A-Za-z0-9_\-/.]{1,64}$/.test(prefix)) throw new Error("S3_PREFIX may only use letters, digits, _ - . /");
  const partSize = Math.max(int("S3_PART_SIZE", 16 * MiB), 5 * MiB);
  return {
    bucket: need("S3_BUCKET", env.S3_BUCKET),
    region: need("S3_REGION", env.S3_REGION ?? env.AWS_REGION),
    endpoint: env.S3_ENDPOINT?.trim() || null,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    prefix: prefix && !prefix.endsWith("/") ? prefix + "/" : prefix,
    credentials: s3Credentials(env),
    sse: sse === "none" ? null : sse,
    kmsKeyId: env.S3_KMS_KEY_ID?.trim() || null,
    // On by default with S3: downloads go straight from S3 after the server's checks (5-minute links).
    presignedDownloads: env.S3_PRESIGNED_DOWNLOADS !== "false",
    presignTtlSeconds: Math.min(Math.max(int("S3_PRESIGN_TTL_SECONDS", 300), 30), 3600),
    multipartThreshold: Math.max(int("S3_MULTIPART_THRESHOLD", 64 * MiB), partSize),
    partSize,
    spoolDir: env.S3_SPOOL_DIR ?? path.join(dataDir, "upload-spool"),
  };
}

/** Static keys when both are set (one without the other is a mistake); null: the AWS SDK's default credential chain. */
function s3Credentials(env: NodeJS.ProcessEnv): S3Config["credentials"] {
  const id = env.S3_ACCESS_KEY_ID?.trim();
  const secret = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!id && !secret) return null;
  if (!id || !secret) throw new Error("Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither (to use the AWS default credential chain)");
  return { accessKeyId: id, secretAccessKey: secret, sessionToken: env.S3_SESSION_TOKEN?.trim() || undefined };
}
