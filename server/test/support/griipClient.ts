/**
 * Reference client for the Griip Message protocol (griip-envelope-v1), used by integration tests
 * and by the headless "bot" that acts as a second participant against the Android app.
 * Mirrors android/.../crypto/EnvelopeCrypto.kt byte-for-byte (see docs/SECURITY.md §3).
 */
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import crypto from "node:crypto";
import WebSocket from "ws";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const HPKE_INFO = new TextEncoder().encode("griip-envelope-v1/key");

export const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });

export interface Ed25519Pair {
  seed: Buffer;
  pub: Buffer;
  key: crypto.KeyObject;
}

export function ed25519FromSeed(seed: Buffer): Ed25519Pair {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const jwk = crypto.createPublicKey(key).export({ format: "jwk" }) as { x: string };
  return { seed, pub: Buffer.from(jwk.x, "base64url"), key };
}

export function newEd25519(): Ed25519Pair {
  return ed25519FromSeed(crypto.randomBytes(32));
}

export function sign(pair: Ed25519Pair, message: string): string {
  return crypto.sign(null, Buffer.from(message, "utf8"), pair.key).toString("base64");
}

export function verify(pubB64: string, message: string, sigB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubB64, "base64").toString("base64url") }, format: "jwk" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

export function newX25519(): { priv: Buffer; pub: Buffer } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const d = (privateKey.export({ format: "jwk" }) as { d: string }).d;
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { priv: Buffer.from(d, "base64url"), pub: Buffer.from(x, "base64url") };
}

export const canonical = {
  deviceCert: (identityKey: string, signingKey: string, encryptionKey: string) =>
    `griip-device-cert-v1\n${identityKey}\n${signingKey}\n${encryptionKey}`,
  authProof: (purpose: string, nonce: string, signingKey: string) => `griip-auth-v1\n${purpose}\n${nonce}\n${signingKey}`,
  header: (h: { messageId: string; conversationId: string; senderUserId: string; senderDeviceId: string; sentAt: number; cls: string }) =>
    `griip-envelope-v1\n${h.messageId}\n${h.conversationId}\n${h.senderUserId}\n${h.senderDeviceId}\n${h.sentAt}\n${h.cls}`,
};

export interface DeviceKeys {
  id: string;
  signingKey: string;
  encryptionKey: string;
  certificate: string;
}
/** A device removed from its account: never encrypted to; envelopes the server accepted up to `revokedAt` verify. */
export interface RevokedDeviceKeys extends DeviceKeys {
  revokedAt: number;
}
export interface UserKeys {
  userId: string;
  identityKey: string;
  devices: DeviceKeys[];
  /** Servers from 2026-10-17 (T1.5); older ones omit it. */
  revokedDevices?: RevokedDeviceKeys[];
  /** An AI agent reading the conversation (servers from 0.40.0, for clients that ask): only its device there. */
  agent?: { installId: string; readerId: string; name: string };
}

export interface DecryptedMessage {
  queueId: number;
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  cls: string;
  sentAt: number;
  payload: any;
  /** The server attested @everyone on this copy (docs/MENTIONS.md). */
  mentionAllAttested?: boolean;
}

/** Sending or opening is paused: these users' identity keys differ from the ones pinned on first contact (T1.2). */
export class IdentityChangedError extends Error {
  constructor(public userIds: string[]) {
    super(`identity key changed for ${userIds.join(", ")}`);
  }
}

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public body: any,
    /** The Retry-After header of a refusal, if any. */
    public retryAfter: string | null = null,
  ) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

export class GriipClient {
  identity = newEd25519();
  device = newEd25519();
  enc = newX25519();
  userId = "";
  deviceId = "";
  /** Identity keys pinned on first contact (T1.2). */
  pins = new Map<string, string>();
  /** Envelopes from senders whose identity changed, kept until acceptIdentity. */
  held: any[] = [];
  token = "";
  ws: WebSocket | null = null;
  received: DecryptedMessage[] = [];
  receipts: any[] = [];
  events: any[] = [];
  private keyCache = new Map<string, UserKeys>();
  private waiters: (() => void)[] = [];
  /** Settles when the last frame received so far has been handled. */
  private frames: Promise<void> = Promise.resolve();
  autoAck = true;

  constructor(
    public baseUrl: string,
    public username: string,
    public displayName = username,
  ) {}

  get signingKeyB64() {
    return this.device.pub.toString("base64");
  }
  get identityKeyB64() {
    return this.identity.pub.toString("base64");
  }
  get encKeyB64() {
    return this.enc.pub.toString("base64");
  }

  certificate(): string {
    return sign(this.identity, canonical.deviceCert(this.identityKeyB64, this.signingKeyB64, this.encKeyB64));
  }

  /** Sent with every request, e.g. X-Forwarded-For to act as a client behind a trusted proxy (abuse-control tests). */
  extraHeaders: Record<string, string> = {};
  /**
   * AI readers (docs/AI_WORKFORCE_2_PLAN.md phase 5): null, like an older client, never sees one and never shares; "share"
   * or "keep" asks for them (x-meldiq-ai-reader) and wraps to a reader only with "share", as the apps do per member.
   */
  aiReaders: "share" | "keep" | null = null;

  async req(method: string, path: string, body?: unknown, raw?: Buffer): Promise<any> {
    const headers: Record<string, string> = { ...this.extraHeaders };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    if (raw) {
      headers["content-type"] = "application/octet-stream";
      payload = new Uint8Array(raw);
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.baseUrl + path, { method, headers, body: payload });
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new ApiFailure(res.status, data, res.headers.get("retry-after"));
    return data;
  }

  /** `inviteCode` is required by servers in invite-only mode (the default); a registration or org invite. */
  async register(inviteCode?: string): Promise<this> {
    const { nonce } = await this.req("POST", "/v1/auth/challenge");
    const r = await this.req("POST", "/v1/auth/register", {
      ...(inviteCode ? { inviteCode } : {}),
      username: this.username,
      displayName: this.displayName,
      identityKey: this.identityKeyB64,
      device: { name: "test-bot", signingKey: this.signingKeyB64, encryptionKey: this.encKeyB64, certificate: this.certificate() },
      nonce,
      signature: sign(this.device, canonical.authProof("register", nonce, this.signingKeyB64)),
    });
    this.userId = r.userId;
    this.deviceId = r.deviceId;
    this.token = r.sessionToken;
    return this;
  }

  async login(): Promise<void> {
    const { nonce } = await this.req("POST", "/v1/auth/challenge");
    const r = await this.req("POST", "/v1/auth/login", {
      deviceId: this.deviceId,
      nonce,
      signature: sign(this.device, canonical.authProof("login", nonce, this.signingKeyB64)),
    });
    this.token = r.sessionToken;
  }

  // ───── realtime ─────
  connect(): Promise<void> {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/v1/ws";
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${this.token}` } });
      this.ws = ws;
      let resolved = false;
      ws.on("message", async (data) => {
        const msg = JSON.parse(data.toString());
        this.events.push(msg);
        if (msg.t === "hello" && !resolved) {
          resolved = true;
          resolve();
        }
        // One consumer in arrival order, like the app (FrameInbox + processLock). Handled concurrently, a later
        // frame's decryption can finish first and `received` no longer reflects the order the server delivered.
        const previous = this.frames;
        let release!: () => void;
        this.frames = new Promise<void>((r) => (release = r));
        await previous;
        try {
          if (msg.t === "queue") await this.handleQueue(msg.items, !!msg.backlog);
          this.notify();
        } finally {
          release();
        }
      });
      ws.on("error", (e) => {
        if (!resolved) reject(e);
      });
      ws.on("close", () => {
        if (!resolved) reject(new Error("closed before hello"));
      });
    });
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }

  private notify() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  async waitFor<T>(pred: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise<void>((r) => {
        const t = setTimeout(r, 100);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  private async handleQueue(items: any[], backlog: boolean) {
    const ackIds: number[] = [];
    for (const it of items) {
      try {
        if (it.kind === "receipt") {
          this.receipts.push(it);
        } else {
          const m = await this.decrypt(it);
          m.mentionAllAttested = it.payload?.mentionAll === true;
          if (!this.received.some((r) => r.messageId === m.messageId)) this.received.push(m);
        }
        ackIds.push(it.id);
      } catch (e) {
        if (e instanceof IdentityChangedError) {
          // Kept (like the app's quarantine) and acknowledged; opened if acceptIdentity is called.
          if (!this.held.some((h) => h.id === it.id)) this.held.push(it); // the same item can arrive twice (P6)
          this.events.push({ t: "identity_changed", userIds: e.userIds, item: it });
          ackIds.push(it.id);
          continue;
        }
        this.events.push({ t: "decrypt_error", error: String(e), item: it });
        ackIds.push(it.id);
      }
    }
    if (this.autoAck && this.ws && (ackIds.length || backlog)) this.ws.send(JSON.stringify({ t: "ack", ids: ackIds, backlog }));
  }

  // ───── keys ─────
  async conversationKeys(conversationId: string): Promise<UserKeys[]> {
    const saved = this.extraHeaders;
    if (this.aiReaders) this.extraHeaders = { ...saved, "x-meldiq-ai-reader": "1" };
    const r = await this.req("GET", `/v1/conversations/${conversationId}/devices`).finally(() => (this.extraHeaders = saved));
    for (const u of r.users as UserKeys[]) this.keyCache.set(u.userId, u);
    return r.users;
  }

  async userKeys(userId: string): Promise<UserKeys> {
    const cached = this.keyCache.get(userId);
    if (cached) return cached;
    const r = await this.req("POST", "/v1/users/devices", { userIds: [userId] });
    const u = r.users[0] as UserKeys;
    this.keyCache.set(userId, u);
    return u;
  }

  // ───── messaging ─────
  async encrypt(conversationId: string, payload: unknown, cls: "message" | "control", recipients: DeviceKeys[], messageId = crypto.randomUUID()) {
    const sentAt = Date.now();
    const header = canonical.header({ messageId, conversationId, senderUserId: this.userId, senderDeviceId: this.deviceId, sentAt, cls });
    const contentKey = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", contentKey, nonce);
    cipher.setAAD(Buffer.from(header, "utf8"));
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final(), cipher.getAuthTag()]);
    const ciphertext = ct.toString("base64");
    const nonceB64 = nonce.toString("base64");
    const signature = sign(this.device, `${header}\n${nonceB64}\n${ciphertext}`);
    const wraps = [];
    for (const d of recipients) {
      const recipientPublicKey = await suite.kem.deserializePublicKey(Buffer.from(d.encryptionKey, "base64"));
      const sealed = await suite.seal({ recipientPublicKey, info: HPKE_INFO }, contentKey, Buffer.from(`${messageId}\n${d.id}`, "utf8"));
      wraps.push({ deviceId: d.id, enc: Buffer.from(sealed.enc).toString("base64"), wrappedKey: Buffer.from(sealed.ct).toString("base64") });
    }
    return { conversationId, messageId, cls, sentAt, nonce: nonceB64, ciphertext, signature, recipients: wraps };
  }

  /** Encrypt to every member device (refetching keys once on device_mismatch) and submit. */
  async send(conversationId: string, payload: unknown, cls: "message" | "control" = "message", messageId?: string, extra: { mentionAll?: boolean } = {}) {
    const id = messageId ?? crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const users = await this.conversationKeys(conversationId);
      const changed = users.filter((u) => this.trustedKey(u) === null).map((u) => u.userId);
      if (changed.length) throw new IdentityChangedError(changed); // never encrypt to a substituted key
      const devices = users
        .filter((u) => !u.agent || this.aiReaders === "share")
        .flatMap((u) => this.verifiedDevices(u))
        .filter((d) => d.id !== this.deviceId);
      const env = await this.encrypt(conversationId, payload, cls, devices, id);
      try {
        return await this.req("POST", "/v1/messages", { ...env, ...extra });
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 409 && e.body?.error?.code === "device_mismatch" && attempt === 0) continue;
        throw e;
      }
    }
  }

  /**
   * Trust on first use, as the Android app does (T1.2): the first identity key seen for a user is
   * pinned; a different key later is untrusted until acceptIdentity is called with it.
   */
  private trustedKey(u: UserKeys): string | null {
    const pinned = this.pins.get(u.userId);
    if (pinned === undefined) {
      this.pins.set(u.userId, u.identityKey);
      return u.identityKey;
    }
    return pinned === u.identityKey ? pinned : null;
  }

  /** Only devices whose certificate verifies against the user's *pinned* identity key are encrypted to. */
  verifiedDevices(u: UserKeys): DeviceKeys[] {
    return this.certified(u, u.devices);
  }

  private certified<D extends DeviceKeys>(u: UserKeys, devices: D[]): D[] {
    const key = this.trustedKey(u);
    if (key === null) return [];
    return devices.filter((d) => verify(key, canonical.deviceCert(key, d.signingKey, d.encryptionKey), d.certificate));
  }

  /**
   * The device that signed an envelope the server accepted at `serverTs`: an active one, or one revoked no earlier
   * than that (T1.5). The server accepts nothing from a device after revoking it, so a later envelope is refused.
   */
  private senderDevice(u: UserKeys, deviceId: string, serverTs: number): DeviceKeys | undefined {
    return (
      this.verifiedDevices(u).find((d) => d.id === deviceId) ??
      this.certified(u, u.revokedDevices ?? []).find((d) => d.id === deviceId && serverTs <= d.revokedAt)
    );
  }

  /** Drop cached key lists, e.g. after a test changes keys on the server behind the client's back. */
  clearKeyCache(): void {
    this.keyCache.clear();
  }

  /** Accept `identityKey` (the one whose safety number was compared) for `userId`, then open held envelopes. */
  async acceptIdentity(userId: string, identityKey: string): Promise<void> {
    this.pins.set(userId, identityKey);
    this.keyCache.delete(userId);
    const mine = this.held.filter((it) => it.senderUserId === userId);
    this.held = this.held.filter((it) => it.senderUserId !== userId);
    for (const it of mine) {
      const m = await this.decrypt(it);
      if (!this.received.some((r) => r.messageId === m.messageId)) this.received.push(m);
    }
  }

  async decrypt(item: any, refetched = false): Promise<DecryptedMessage> {
    const p = item.payload;
    const sender = await this.userKeys(item.senderUserId);
    if (this.trustedKey(sender) === null) throw new IdentityChangedError([item.senderUserId]);
    const dev = this.senderDevice(sender, item.senderDeviceId, p.serverTs ?? item.createdAt);
    if (!dev) {
      this.keyCache.delete(item.senderUserId);
      if (!refetched) return this.decrypt(item, true); // keys may have changed since they were cached
      throw new Error("unknown or uncertified sender device");
    }
    const header = canonical.header({
      messageId: item.messageId,
      conversationId: item.conversationId,
      senderUserId: item.senderUserId,
      senderDeviceId: item.senderDeviceId,
      sentAt: p.sentAt,
      cls: p.cls,
    });
    if (!verify(dev.signingKey, `${header}\n${p.nonce}\n${p.ciphertext}`, p.signature)) {
      this.keyCache.delete(item.senderUserId);
      if (!refetched) return this.decrypt(item, true);
      throw new Error("bad signature");
    }
    const recipientKey = await suite.kem.deserializePrivateKey(this.enc.priv);
    const contentKey = Buffer.from(
      await suite.open({ recipientKey, enc: Buffer.from(p.enc, "base64"), info: HPKE_INFO }, Buffer.from(p.wrappedKey, "base64"), Buffer.from(`${item.messageId}\n${this.deviceId}`, "utf8")),
    );
    const ct = Buffer.from(p.ciphertext, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", contentKey, Buffer.from(p.nonce, "base64"));
    decipher.setAAD(Buffer.from(header, "utf8"));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    const pt = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
    return {
      queueId: item.id,
      messageId: item.messageId,
      conversationId: item.conversationId,
      senderUserId: item.senderUserId,
      senderDeviceId: item.senderDeviceId,
      cls: p.cls,
      sentAt: p.sentAt,
      payload: JSON.parse(pt.toString("utf8")),
    };
  }
}
