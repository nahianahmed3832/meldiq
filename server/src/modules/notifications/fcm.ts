import crypto from "node:crypto";
import fs from "node:fs";
import type { FastifyBaseLogger } from "fastify";
import type { Rows } from "../../infrastructure/database/rows/index.js";
import type { Hub } from "../realtime/hub.js";
import type { Metrics } from "../administration/ops/metrics.js";
import { now } from "../../shared/utilities/util.js";

/**
 * Firebase Cloud Messaging as an optional second wake-up channel (docs/PUSH_FCM.md), beside UnifiedPush. Off unless
 * FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_FILE are set. Messages are data-only and carry nothing but `{"w":"1"}`: the
 * app then connects and fetches its encrypted messages, ringing calls and reminders itself, so Google sees that a
 * device was woken and when, never what for. The service-account key stays on the server (a file outside Git, read at
 * start); clients can't send pushes to anyone, only register their own device's token.
 *
 * HTTP v1 API: an OAuth 2.0 access token from a JWT signed with the service account's key (RS256, scope
 * firebase.messaging, 1 hour), then POST https://fcm.googleapis.com/v1/projects/<id>/messages:send.
 */
export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  /** Minimum time between two ordinary wake-ups of one device (calls and reminders don't wait). */
  wakeIntervalMs: number;
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_S = 3600;
const TIMEOUT_MS = 8000;
/** Tokens failing for this long are dropped (the app registers a fresh one when it next runs). */
const DROP_AFTER_FAILING_MS = 7 * 86_400_000;
/** FCM registration tokens are long opaque strings; this only bounds what is stored. */
export const MAX_FCM_TOKEN_LENGTH = 4096;

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** Reads FCM_* settings; null when FCM isn't configured. Throws on a half or broken configuration. */
export function fcmConfig(env: NodeJS.ProcessEnv): FcmConfig | null {
  const projectId = env.FCM_PROJECT_ID?.trim();
  const file = env.FCM_SERVICE_ACCOUNT_FILE?.trim();
  if (!projectId && !file) return null;
  if (!projectId || !file) throw new Error("FCM needs both FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_FILE");
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) throw new Error("FCM_PROJECT_ID must be a Firebase project id such as meldiq-12345");
  let sa: { client_email?: unknown; private_key?: unknown; project_id?: unknown; type?: unknown };
  try {
    sa = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`FCM_SERVICE_ACCOUNT_FILE can't be read as a service-account JSON file: ${(e as Error).message.split("\n")[0]}`);
  }
  if (sa.type !== "service_account" || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") {
    throw new Error("FCM_SERVICE_ACCOUNT_FILE must be a Google service-account key (type service_account)");
  }
  if (typeof sa.project_id === "string" && sa.project_id !== projectId) throw new Error("FCM_SERVICE_ACCOUNT_FILE belongs to another project than FCM_PROJECT_ID");
  const interval = Number(env.FCM_WAKE_INTERVAL_SECONDS ?? 30);
  return { projectId, clientEmail: sa.client_email, privateKey: sa.private_key, wakeIntervalMs: Math.min(Math.max(Number.isFinite(interval) ? interval : 30, 5), 3600) * 1000 };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The signed assertion for Google's token endpoint (RFC 7523). */
export function serviceAccountAssertion(cfg: Pick<FcmConfig, "clientEmail" | "privateKey">, issuedAt: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(issuedAt / 1000);
  const claims = b64url(JSON.stringify({ iss: cfg.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + TOKEN_LIFETIME_S }));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), cfg.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

export class FcmService {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private readonly lastSent = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly identity: Rows,
    private readonly hub: Hub,
    readonly config: FcmConfig,
    private readonly log: FastifyBaseLogger,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {}

  /** Health view counters (docs/OPERATIONS.md); set by buildApp. Outcome kinds only. */
  metrics?: Metrics;

  async register(deviceId: string, token: string): Promise<{ kind: "fcm"; updatedAt: number }> {
    const t = now();
    await this.identity.write((w) => {
      // A token belongs to one installation: the latest device to register it wins.
      w.delete("fcm_tokens", { token, device_id: { ne: deviceId } });
      w.upsert("fcm_tokens", { device_id: deviceId, token, created_at: t, updated_at: t }, { token, updated_at: t, failing_since: null });
    });
    return { kind: "fcm", updatedAt: t };
  }

  unregister(deviceId: string): Promise<boolean> {
    return this.identity.write((w) => w.delete("fcm_tokens", { device_id: deviceId }) > 0);
  }

  /** Something was queued for a device with no open socket: wake it (at most once per interval). */
  queued(deviceId: string): void {
    void this.wake(deviceId, false);
  }

  /** A call rings or a reminder fired for [userId]: wake each of their devices with no open socket, right away. */
  wakeUser(userId: string): void {
    const devices = this.identity.all<{ id: string }>("devices", { where: { user_id: userId, revoked_at: null } }).map((d) => d.id);
    if (!devices.length) return;
    for (const r of this.identity.all<{ device_id: string }>("fcm_tokens", { where: { device_id: { in: devices } } })) void this.wake(r.device_id, true);
  }

  stop(): void {
    this.stopped = true;
  }

  /** One data-only wake-up. Never rejects: a failed wake-up must not break what triggered it. */
  async wake(deviceId: string, urgent: boolean): Promise<"sent" | "skipped" | "failed" | "dropped"> {
    try {
      if (this.stopped || this.hub.isDeviceOnline(deviceId)) return "skipped";
      const row = this.tokenOf(deviceId);
      if (!row) return "skipped";
      const t = Date.now();
      if (!urgent && t - (this.lastSent.get(deviceId) ?? Number.NEGATIVE_INFINITY) < this.config.wakeIntervalMs) return "skipped";
      this.lastSent.set(deviceId, t);
      const res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token: row.token, data: { w: "1" }, android: { priority: "HIGH", ttl: urgent ? "60s" : "86400s" } } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return await this.record(deviceId, row.token, res.status, res.status >= 400 ? await res.json().catch(() => null) : null);
    } catch (err) {
      // Only the error's type: a message could quote the token.
      this.log.warn({ deviceId, errorType: err instanceof Error ? err.name : typeof err }, "fcm wake-up failed");
      this.metrics?.recordProvider("push.fcm", err);
      return "failed";
    }
  }

  /** The token of an active device of an enabled account. */
  private tokenOf(deviceId: string): { token: string } | undefined {
    const device = this.identity.get<{ user_id: string }>("devices", { id: deviceId, revoked_at: null });
    if (!device || !this.identity.get("users", { id: device.user_id, disabled_at: null })) return undefined;
    return this.identity.get<{ token: string }>("fcm_tokens", { device_id: deviceId });
  }

  private async record(deviceId: string, token: string, status: number, body: unknown): Promise<"sent" | "failed" | "dropped"> {
    this.metrics?.recordProvider("push.fcm", status >= 200 && status < 300 ? undefined : { code: `http_${status}` });
    const t = now();
    const where = { device_id: deviceId, token };
    if (status >= 200 && status < 300) {
      await this.identity.write((w) => w.update("fcm_tokens", where, { last_wake_at: t, failing_since: null }));
      return "sent";
    }
    const code = JSON.stringify(body ?? {}).match(/"(UNREGISTERED|INVALID_ARGUMENT|SENDER_ID_MISMATCH)"/)?.[1];
    // The token is no longer valid for this app: remove it (only that token; a newer one may have replaced it).
    if (status === 404 || code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH" || (status === 400 && code === "INVALID_ARGUMENT")) {
      await this.identity.write((w) => w.delete("fcm_tokens", where));
      this.log.info({ deviceId, reason: code ?? `http_${status}` }, "fcm token removed");
      return "dropped";
    }
    if (status === 401) this.accessToken = null;
    const dropped = await this.identity.write((w) => {
      const row = w.get<{ failing_since: number | null }>("fcm_tokens", where);
      if (!row) return false;
      if (row.failing_since === null) w.update("fcm_tokens", where, { failing_since: t });
      if ((row.failing_since ?? t) > t - DROP_AFTER_FAILING_MS) return false;
      w.delete("fcm_tokens", where);
      return true;
    });
    if (dropped) return "dropped";
    this.log.warn({ deviceId, reason: `http_${status}` }, "fcm wake-up failed");
    return "failed";
  }

  /** The connector check: signs in to Google with the service account (sends nothing to any phone). */
  async checkCredentials(): Promise<void> {
    this.accessToken = null;
    try {
      await this.token();
      this.metrics?.recordProvider("push.fcm");
    } catch (e) {
      this.metrics?.recordProvider("push.fcm", e);
      throw e;
    }
  }

  /** A cached OAuth access token for FCM, renewed a few minutes before it expires. */
  private async token(): Promise<string> {
    const t = Date.now();
    if (this.accessToken && this.accessToken.expiresAt - 300_000 > t) return this.accessToken.value;
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(this.config, t) }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (res.status !== 200 || typeof body?.access_token !== "string") throw new Error(`Google token endpoint answered ${res.status}`);
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : TOKEN_LIFETIME_S;
    this.accessToken = { value: body.access_token, expiresAt: t + expiresIn * 1000 };
    return body.access_token;
  }
}
