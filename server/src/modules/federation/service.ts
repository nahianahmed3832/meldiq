/**
 * Federation on a home server (docs/FEDERATION_PROTOCOL.md). Owns this server's identity, its announcements to the
 * core nodes, signed requests to peers, global address lookup, remote users ("shadows"), the outbox and inbound
 * delivery. It never sees message content: it moves the same ciphertext envelopes the local queue holds.
 */
import { withoutMentionAll } from "../messaging/mentions.js";
import { memberUsers } from "../messaging/index.js";
import type { RowWriter } from "../../infrastructure/database/rows/index.js";
import type { CallEventExtras, CallEventName, ServerEvent } from "../../shared/contracts/realtime.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { FederationConfig } from "../../app/config.js";
import type { AppContext } from "../../app/context.js";
import { canonical, isValidPublicKey, verifyEd25519 } from "../../shared/utilities/crypto.js";
import type { QueueItemRow } from "../realtime/hub.js";
import { type CallRow, callView } from "../calls/routes.js";
import { readAll } from "../../infrastructure/storage/blobstore.js";
import { ApiError, type ErrorCode, isErrorCode } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { type ServerDescriptor, ServerIdentity, verifyServerText } from "./identity.js";
import { FederationError, type ResolvedServer, Resolver } from "./resolver.js";
import { sha256b64 } from "./sign.js";
import { H, PeerRateLimit, responseString, signedHeaders } from "./transport.js";

export interface FedDevice {
  id: string;
  signingKey: string;
  encryptionKey: string;
  certificate: string;
}
export interface FedUser {
  userId: string;
  username: string;
  displayName: string;
  avatarColor: number;
  identityKey: string;
  devices: FedDevice[];
}
export interface FedItem {
  key: string;
  kind: "envelope" | "receipt";
  conversationId: string;
  messageId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  payload: string;
  createdAt: number;
  expiresAt: number;
}
export interface FedAttachmentMeta {
  id: string;
  conversationId: string;
  uploaderUserId: string;
  size: number;
  expiresAt: number;
}

const USER_ID = /^u_[A-Za-z0-9_-]{22}$/;
const DEVICE_ID = /^d_[A-Za-z0-9_-]{22}$/;
const USERNAME = /^[a-z0-9._]{3,24}$/;
const ATTACHMENT_ID = /^a_[A-Za-z0-9_-]{22}$/;
const SHADOW_STALE_MS = 60_000;
const MAX_ITEM_PAYLOAD = 300 * 1024;

/** Federated DM id: identical on both servers because both user ids are. */
export function fedDmId(dmKey: string): string {
  return "cf_" + crypto.createHash("sha256").update(`griip-fed-dm-v1|${dmKey}`).digest("base64url").slice(0, 22);
}

export class Federation {
  readonly identity: ServerIdentity;
  readonly resolver: Resolver;
  private descriptorCache: ServerDescriptor | null = null;
  private timers: NodeJS.Timeout[] = [];
  private flushing = false;
  private peerBackoff = new Map<string, { until: number; delay: number }>();
  readonly requestLimit = new PeerRateLimit(1200);
  readonly lookupLimit = new PeerRateLimit(60);
  readonly userLookupLimit = new PeerRateLimit(30);

  constructor(
    private ctx: AppContext,
    public cfg: FederationConfig,
    private fetchFn: typeof fetch = fetch,
  ) {
    this.identity = ServerIdentity.loadOrCreate(cfg.keyDir);
    this.resolver = new Resolver(ctx.db, cfg.coreNodes, cfg.coreQuorum, fetchFn);
  }

  get serverId() {
    return this.identity.serverId;
  }
  get domain() {
    return this.cfg.domain;
  }
  /**
   * Whether this server can host calls with people on other servers: it needs its own LiveKit (the host issues every
   * token). Joining a call hosted elsewhere needs no LiveKit here.
   */
  callsEnabled(): boolean {
    return !!this.ctx.livekit;
  }

  capabilities(): string[] {
    return ["dm", "attachments", "receipts", ...(this.callsEnabled() && this.ctx.livekit ? ["calls"] : [])];
  }

  /** The current signed descriptor; reissued when it nears expiry, the endpoint changes, or after a key rotation. */
  descriptor(force = false): ServerDescriptor {
    const d = this.descriptorCache;
    if (force || !d || d.expiresAt - Date.now() < 86_400_000 || d.endpoint !== this.cfg.publicUrl || d.keyChain.length !== this.identity.publicChain().length) {
      if (!this.cfg.publicUrl) throw new Error("FEDERATION_PUBLIC_URL isn't set");
      this.descriptorCache = this.identity.descriptor({ domain: this.cfg.domain, endpoint: this.cfg.publicUrl, capabilities: this.capabilities() });
    }
    return this.descriptorCache!;
  }

  // ───────────────────────── core nodes ─────────────────────────

  private async core(c: { url: string }, p: string, body: unknown) {
    const res = await this.fetchFn(`${c.url.replace(/\/$/, "")}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, json };
  }

  /** Registers (or re-registers) this server with every core node. Each node challenges our endpoint. */
  async announce(): Promise<{ core: string; status: number; state?: string; error?: string }[]> {
    const d = this.descriptor();
    return Promise.all(
      this.cfg.coreNodes.map(async (c) => {
        try {
          const r = await this.core(c, "/core/v1/register", { descriptor: d });
          return { core: c.url, status: r.status, state: r.json?.result?.state, error: r.json?.error?.code };
        } catch (e) {
          return { core: c.url, status: 0, error: (e as Error).message };
        }
      }),
    );
  }

  async heartbeatOnce(): Promise<void> {
    const d = this.descriptor();
    const hb = this.identity.selfSigned({ t: "griip.server.heartbeat", at: Date.now(), seq: d.seq });
    await Promise.all(
      this.cfg.coreNodes.map(async (c) => {
        try {
          const r = await this.core(c, "/core/v1/heartbeat", hb);
          if (r.status === 404 || r.json?.wantDescriptor) await this.core(c, "/core/v1/register", { descriptor: d });
        } catch {
          /* that core is down; the others carry on (quorum) */
        }
      }),
    );
  }

  /** Signed, permanent retirement of this server (operator action). */
  async decommission(reason: string) {
    const rec = this.identity.selfSigned({ t: "griip.server.decommission" as const, reason, at: Date.now() });
    return Promise.all(this.cfg.coreNodes.map((c) => this.core(c, "/core/v1/decommission", rec).catch((e) => ({ status: 0, json: { error: String(e) } }))));
  }

  start() {
    const tick = (fn: () => Promise<unknown>, ms: number) => {
      if (ms > 0) this.timers.push(setInterval(() => void fn().catch((e) => this.ctx.log.warn({ err: (e as Error).message }, "federation task failed")), ms));
    };
    void this.announce().catch(() => {});
    tick(() => this.heartbeatOnce(), this.cfg.heartbeatMs);
    tick(() => this.flush(), this.cfg.outboxIntervalMs);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ───────────────────────── signed requests ─────────────────────────

  /** Peer must be routable: verified, not final, not blocked, allowed by policy. */
  checkPeer(peer: ResolvedServer) {
    if (peer.serverId === this.serverId) throw new FederationError(400, "self", "That's this server");
    if (peer.final) throw new FederationError(410, "server_retired", "That server was decommissioned or revoked");
    if (this.ctx.db.prepare("SELECT 1 FROM federation_blocks WHERE server_id = ?").get(peer.serverId)) throw new FederationError(403, "server_blocked", "This server doesn't federate with that server");
    if (this.cfg.policy === "allowlist" && !this.cfg.allowlist.includes(peer.serverId) && !this.cfg.allowlist.includes(peer.domain)) {
      throw new FederationError(403, "not_allowed", "This server only federates with listed servers");
    }
    if (!this.cfg.allowHttp && !peer.descriptor.endpoint.startsWith("https://")) throw new FederationError(502, "insecure_peer", "That server's endpoint isn't https");
  }

  async request(peer: ResolvedServer, method: string, p: string, body?: unknown, raw?: Buffer, extra: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    this.checkPeer(peer);
    const payload = raw ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"));
    const headers = signedHeaders(this.identity, method, p, payload, peer.serverId);
    const res = await this.fetchFn(`${peer.descriptor.endpoint.replace(/\/$/, "")}${p}`, {
      method,
      headers: { ...headers, ...extra, ...(payload.length || method !== "GET" ? { "content-type": raw ? "application/octet-stream" : "application/json" } : {}) },
      body: method === "GET" ? undefined : new Uint8Array(payload),
      signal: AbortSignal.timeout(raw ? 120_000 : 15_000),
    });
    const text = await res.text();
    const rsig = res.headers.get(H.rsig) ?? "";
    // The answer must come from the server we asked, for this request (not a cache, proxy or impostor).
    const ok = verifyServerText(peer.currentKey, responseString(headers[H.nonce], sha256b64(text), peer.serverId, this.serverId), rsig);
    if (!ok) throw new FederationError(502, "bad_response_signature", "The remote server's answer isn't signed by its key");
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  // ───────────────────────── addresses and directory ─────────────────────────

  /** "@bob:b.example" / "bob:b.example" → parts. The username can't contain ":", so the first ":" splits. */
  parseAddress(s: string): { username: string; domain: string } | null {
    const t = s.trim().replace(/^@/, "").toLowerCase();
    const i = t.indexOf(":");
    if (i < 0) return null;
    const username = t.slice(0, i);
    const domain = t.slice(i + 1);
    return USERNAME.test(username) && domain ? { username, domain } : null;
  }

  address(username: string): string {
    return `${username}:${this.cfg.domain}`;
  }

  /** Public directory entry for a local user: identity key and certified active devices. */
  entry(userId: string): FedUser | null {
    const u = this.ctx.db.prepare("SELECT * FROM users WHERE id = ? AND home_server_id IS NULL AND disabled_at IS NULL").get(userId) as any;
    if (!u) return null;
    const devices = (this.ctx.db.prepare("SELECT id, signing_key, encryption_key, certificate FROM devices WHERE user_id = ? AND revoked_at IS NULL").all(userId) as any[]).map((d) => ({
      id: d.id,
      signingKey: d.signing_key,
      encryptionKey: d.encryption_key,
      certificate: d.certificate,
    }));
    return { userId: u.id, username: u.username, displayName: u.display_name, avatarColor: u.avatar_color, identityKey: u.identity_key, devices };
  }

  /**
   * Stores or updates a remote user's local stand-in. Same user and device ids as on the home server (envelopes are
   * signed over them); an id that is local here, or bound to another server, is refused; every device certificate
   * must verify against the identity key. Devices the home server no longer lists are revoked here.
   */
  upsertShadow(peer: ResolvedServer, e: FedUser): string {
    const { db } = this.ctx;
    if (!e || !USER_ID.test(e.userId) || !USERNAME.test(e.username) || !isValidPublicKey(e.identityKey) || !Array.isArray(e.devices) || e.devices.length > 20) {
      throw new FederationError(400, "bad_entry", "Invalid user entry");
    }
    for (const d of e.devices) {
      if (!DEVICE_ID.test(d.id) || !isValidPublicKey(d.signingKey) || !isValidPublicKey(d.encryptionKey)) throw new FederationError(400, "bad_entry", "Invalid device");
      if (!verifyEd25519(e.identityKey, canonical.deviceCert(e.identityKey, d.signingKey, d.encryptionKey), d.certificate)) {
        throw new FederationError(400, "bad_certificate", "A device certificate doesn't verify against the identity key");
      }
    }
    const display = String(e.displayName ?? e.username).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) || e.username;
    const shadowName = `${e.username}:${peer.domain}`;
    const t = now();
    db.transaction(() => {
      const existing = db.prepare("SELECT id, home_server_id FROM users WHERE id = ?").get(e.userId) as { id: string; home_server_id: string | null } | undefined;
      if (existing && existing.home_server_id !== peer.serverId) throw new FederationError(409, "id_conflict", "That user id belongs to another server");
      // A different remote account that used to hold this address keeps its row but gives up the name.
      const holder = db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(shadowName, e.userId) as { id: string } | undefined;
      if (holder) db.prepare("UPDATE users SET username = ? WHERE id = ?").run(`${e.username}~${holder.id.slice(2, 8)}:${peer.domain}`, holder.id);
      if (existing) {
        db.prepare("UPDATE users SET username = ?, display_name = ?, avatar_color = ?, identity_key = ?, remote_synced_at = ?, updated_at = ? WHERE id = ?").run(
          shadowName,
          display,
          Number.isInteger(e.avatarColor) ? Math.min(15, Math.max(0, e.avatarColor)) : 0,
          e.identityKey,
          t,
          t,
          e.userId,
        );
      } else {
        db.prepare(
          "INSERT INTO users (id, username, display_name, identity_key, avatar_color, created_at, updated_at, home_server_id, remote_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(e.userId, shadowName, display, e.identityKey, Number.isInteger(e.avatarColor) ? Math.min(15, Math.max(0, e.avatarColor)) : 0, t, t, peer.serverId, t);
      }
      const keep = new Set<string>();
      for (const d of e.devices) {
        const dev = db.prepare("SELECT user_id FROM devices WHERE id = ?").get(d.id) as { user_id: string } | undefined;
        if (dev && dev.user_id !== e.userId) throw new FederationError(409, "id_conflict", "That device id belongs to someone else");
        const keyOwner = db.prepare("SELECT id FROM devices WHERE signing_key = ? AND id != ?").get(d.signingKey, d.id);
        if (keyOwner) throw new FederationError(409, "id_conflict", "That device key belongs to another device");
        if (dev) {
          db.prepare("UPDATE devices SET signing_key = ?, encryption_key = ?, certificate = ?, revoked_at = NULL WHERE id = ?").run(d.signingKey, d.encryptionKey, d.certificate, d.id);
        } else {
          db.prepare("INSERT INTO devices (id, user_id, name, signing_key, encryption_key, certificate, created_at) VALUES (?, ?, 'remote', ?, ?, ?, ?)").run(
            d.id,
            e.userId,
            d.signingKey,
            d.encryptionKey,
            d.certificate,
            t,
          );
        }
        keep.add(d.id);
      }
      for (const d of db.prepare("SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL").all(e.userId) as { id: string }[]) {
        if (!keep.has(d.id)) db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(t, d.id);
      }
    })();
    return e.userId;
  }

  /** Looks up a global address for a local user (exact match only: no search across servers). */
  async lookup(address: string): Promise<{ userId: string; server: ResolvedServer | null; local: boolean }> {
    const a = this.parseAddress(address);
    if (!a) throw new FederationError(400, "bad_address", "Use the form @name:server");
    if (a.domain === this.cfg.domain) {
      const u = this.ctx.db.prepare("SELECT id FROM users WHERE username = ? AND home_server_id IS NULL AND disabled_at IS NULL").get(a.username) as { id: string } | undefined;
      if (!u) throw new FederationError(404, "not_found", "No one with that address");
      return { userId: u.id, server: null, local: true };
    }
    const peer = await this.resolver.domain(a.domain);
    this.checkPeer(peer);
    if (peer.state !== "active" && peer.state !== "unreachable") throw new FederationError(503, "server_not_active", `That server is ${peer.state}`);
    const r = await this.request(peer, "GET", `/fed/v1/users/lookup?username=${encodeURIComponent(a.username)}`);
    if (r.status === 404) throw new FederationError(404, "not_found", "No one with that address");
    if (r.status === 403 || r.status === 410) throw new FederationError(403, "peer_refused", "That server doesn't accept contact from this server");
    if (r.status === 429) throw new FederationError(429, "rate_limited", "That server is limiting lookups. Try again later.");
    if (r.status !== 200) throw new FederationError(502, "lookup_failed", "That server didn't answer the lookup");
    const entry = r.json?.user as FedUser;
    if (entry?.username !== a.username) throw new FederationError(502, "lookup_mismatch", "That server answered for someone else");
    this.upsertShadow(peer, entry);
    return { userId: entry.userId, server: peer, local: false };
  }

  /** Re-fetches remote users whose keys haven't been refreshed recently (before someone encrypts to them). */
  async refreshStale(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const rows = this.ctx.db
      .prepare(`SELECT id, home_server_id, remote_synced_at FROM users WHERE id IN (${userIds.map(() => "?").join(",")}) AND home_server_id IS NOT NULL`)
      .all(...userIds) as { id: string; home_server_id: string; remote_synced_at: number | null }[];
    await Promise.all(
      rows
        .filter((r) => now() - (r.remote_synced_at ?? 0) > SHADOW_STALE_MS)
        .map(async (r) => {
          try {
            const peer = await this.resolver.server(r.home_server_id);
            const res = await this.request(peer, "GET", `/fed/v1/users/${r.id}`);
            if (res.status === 200) this.upsertShadow(peer, res.json.user);
          } catch (e) {
            this.ctx.log.warn({ err: (e as Error).message }, "remote user refresh failed"); // keep the cached keys
          }
        }),
    );
  }

  // ───────────────────────── outbox ─────────────────────────

  /** Throws 503 when the outbox to this peer is full (checked before a message is accepted, and again when queueing). */
  assertRoom(peerServerId: string): void {
    if (this.pendingFor(peerServerId) >= this.cfg.outboxMaxPerPeer) {
      throw new ApiError(503, "federation_backlog", "The other person's server isn't keeping up. Try again later.");
    }
  }

  /** Queues an item for a peer. Bounded per peer: when full, the sender gets 503 instead of unbounded growth. */
  enqueue(peerServerId: string, kind: "envelope" | "receipt" | "attachment", key: string, body: object, size: number, expiresAt: number) {
    this.assertRoom(peerServerId);
    const t = now();
    this.ctx.db
      .prepare("INSERT OR IGNORE INTO federation_outbox (peer_server_id, kind, item_key, body, size, created_at, expires_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(peerServerId, kind, key, JSON.stringify(body), size, t, expiresAt, t);
  }

  pendingFor(peerServerId: string): number {
    return (this.ctx.db.prepare("SELECT COUNT(*) n FROM federation_outbox WHERE peer_server_id = ?").get(peerServerId) as { n: number }).n;
  }

  /** Sends what's due, per peer, in order. A failing peer backs off (exponential, capped); others aren't held up. */
  async flush(): Promise<{ peer: string; sent: number; error?: string }[]> {
    if (this.flushing) return [];
    this.flushing = true;
    try {
      const t = now();
      this.ctx.db.prepare("DELETE FROM federation_outbox WHERE expires_at <= ?").run(t);
      const peers = (this.ctx.db.prepare("SELECT DISTINCT peer_server_id p FROM federation_outbox WHERE next_attempt_at <= ?").all(t) as { p: string }[]).map((r) => r.p);
      const out = [];
      for (const p of peers) {
        const b = this.peerBackoff.get(p);
        if (b && b.until > t) continue;
        try {
          const sent = await this.flushPeer(p);
          this.peerBackoff.delete(p);
          out.push({ peer: p, sent });
        } catch (e) {
          const delay = Math.min(300_000, (b?.delay ?? 1000) * 2);
          this.peerBackoff.set(p, { until: now() + delay, delay });
          this.ctx.db.prepare("UPDATE federation_outbox SET attempts = attempts + 1, last_error = ? WHERE peer_server_id = ?").run(String((e as Error).message).slice(0, 200), p);
          out.push({ peer: p, sent: 0, error: (e as Error).message });
        }
      }
      return out;
    } finally {
      this.flushing = false;
    }
  }

  private async flushPeer(peerServerId: string): Promise<number> {
    const peer = await this.resolver.server(peerServerId);
    if (peer.final) {
      const n = this.ctx.db.prepare("DELETE FROM federation_outbox WHERE peer_server_id = ?").run(peerServerId).changes;
      this.ctx.audit({ action: "federation.outbox_dropped", target: peerServerId, detail: `${n} items: server ${peer.final.kind}` });
      return 0;
    }
    let sent = 0;
    for (let round = 0; round < 20; round++) {
      const rows = this.ctx.db.prepare("SELECT * FROM federation_outbox WHERE peer_server_id = ? ORDER BY id LIMIT 100").all(peerServerId) as any[];
      if (rows.length === 0) break;
      if (rows[0].kind === "attachment") {
        await this.sendAttachment(peer, rows[0]);
        sent++;
        continue;
      }
      const batch = [];
      for (const r of rows) {
        if (r.kind === "attachment") break; // keep order: the attachment goes before later messages
        batch.push(r);
      }
      sent += await this.sendBatch(peer, batch);
    }
    return sent;
  }

  private async sendBatch(peer: ResolvedServer, rows: any[]): Promise<number> {
    const items = rows.map((r) => JSON.parse(r.body) as FedItem);
    const senders = [...new Set(items.map((i) => i.senderUserId))].map((id) => this.entry(id)).filter((e): e is FedUser => e !== null);
    const r = await this.request(peer, "POST", "/fed/v1/deliver", { items, senders });
    if (r.status !== 200) throw new Error(`deliver: HTTP ${r.status} ${r.json?.error?.code ?? ""}`);
    const results = new Map<string, { status: string; code?: string }>((r.json.results ?? []).map((x: any) => [x.key, x]));
    let done = 0;
    for (const row of rows) {
      const res = results.get(row.item_key);
      if (!res) continue; // not processed: stays queued for the next round
      if (res.status === "rejected") this.ctx.audit({ action: "federation.delivery_rejected", target: peer.serverId, detail: `${row.kind}: ${res.code}` });
      this.ctx.db.prepare("DELETE FROM federation_outbox WHERE id = ?").run(row.id);
      done++;
    }
    if (done === 0) throw new Error("peer accepted nothing");
    return done;
  }

  private async sendAttachment(peer: ResolvedServer, row: any) {
    const meta = JSON.parse(row.body) as FedAttachmentMeta;
    const stored = await this.ctx.blobs.get("attachments", meta.id);
    if (!stored) {
      this.ctx.db.prepare("DELETE FROM federation_outbox WHERE id = ?").run(row.id); // expired locally: nothing to send
      return;
    }
    const data = await readAll(stored);
    const r = await this.request(peer, "POST", "/fed/v1/attachments", undefined, data, { "x-griip-attachment": JSON.stringify(meta) });
    if (r.status !== 200 && r.status !== 409) {
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        this.ctx.audit({ action: "federation.attachment_rejected", target: peer.serverId, detail: String(r.json?.error?.code ?? r.status) });
        this.ctx.db.prepare("DELETE FROM federation_outbox WHERE id = ?").run(row.id);
        return;
      }
      throw new Error(`attachment: HTTP ${r.status}`);
    }
    this.ctx.db.prepare("DELETE FROM federation_outbox WHERE id = ?").run(row.id);
  }

  /** Queues a local queue row destined for a remote device (called instead of inserting it locally). */
  routeRemote(peerServerId: string, item: FedItem) {
    this.enqueue(peerServerId, item.kind, item.key, item, item.payload.length, item.expiresAt);
  }

  /** After an upload to a federated conversation: push the ciphertext to each remote member's server. */
  pushAttachment(conversationId: string, meta: FedAttachmentMeta) {
    for (const h of this.remoteHomes(conversationId)) this.enqueue(h, "attachment", `att:${meta.id}:${h}`, meta, meta.size, meta.expiresAt);
  }

  // ───────────────────────── inbound ─────────────────────────

  /** Applies a delivery batch from a verified peer. Returns a result per item; never throws for one bad item. */
  async acceptBatch(
    peer: ResolvedServer,
    body: { items?: FedItem[]; senders?: FedUser[] },
    notify: (conversationId: string) => void,
  ): Promise<{ key: string; status: string; code?: string }[]> {
    const { db } = this.ctx;
    const items = Array.isArray(body?.items) ? body.items.slice(0, 200) : [];
    const badSenders = new Set<string>();
    for (const s of Array.isArray(body?.senders) ? body.senders.slice(0, 200) : []) {
      try {
        this.upsertShadow(peer, s);
      } catch (e) {
        badSenders.add(s?.userId);
        this.ctx.audit({ action: "federation.sender_rejected", target: peer.serverId, detail: (e as FederationError).code ?? "invalid" });
      }
    }
    const results: { key: string; status: string; code?: string }[] = [];
    const queued: QueueItemRow[] = [];
    const t = now();
    for (const it of items) {
      const reject = (code: string) => results.push({ key: String(it?.key ?? ""), status: "rejected", code });
      if (!it || typeof it.key !== "string" || it.key.length > 200 || (it.kind !== "envelope" && it.kind !== "receipt")) {
        reject("bad_item");
        continue;
      }
      if (db.prepare("SELECT 1 FROM federation_inbox WHERE item_key = ?").get(`${peer.serverId}|${it.key}`)) {
        results.push({ key: it.key, status: "accepted" }); // duplicate retry: already delivered
        continue;
      }
      if (typeof it.payload !== "string" || it.payload.length > MAX_ITEM_PAYLOAD || badSenders.has(it.senderUserId)) {
        reject("bad_item");
        continue;
      }
      const rcpt = db
        .prepare("SELECT d.user_id FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.revoked_at IS NULL AND u.disabled_at IS NULL AND u.home_server_id IS NULL")
        .get(it.recipientDeviceId) as { user_id: string } | undefined;
      if (!rcpt) {
        reject("unknown_recipient");
        continue;
      }
      const sender = db
        .prepare("SELECT u.home_server_id, d.signing_key, d.revoked_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.user_id = ?")
        .get(it.senderDeviceId, it.senderUserId) as { home_server_id: string | null; signing_key: string; revoked_at: number | null } | undefined;
      if (!sender || sender.home_server_id !== peer.serverId) {
        reject("sender_not_from_peer"); // a server can only deliver on behalf of its own users
        continue;
      }
      const dmKey = [it.senderUserId, rcpt.user_id].sort().join("|");
      const convId = fedDmId(dmKey);
      if (it.conversationId !== convId) {
        reject("wrong_conversation");
        continue;
      }
      let payload: any;
      try {
        payload = JSON.parse(it.payload);
      } catch {
        reject("bad_item");
        continue;
      }
      if (it.kind === "envelope") {
        if (sender.revoked_at) {
          reject("sender_device_revoked");
          continue;
        }
        const signed = canonical.envelope({
          messageId: it.messageId,
          conversationId: convId,
          senderUserId: it.senderUserId,
          senderDeviceId: it.senderDeviceId,
          sentAt: payload.sentAt,
          cls: payload.cls,
          nonce: payload.nonce,
          ciphertext: payload.ciphertext,
        });
        if (!verifyEd25519(sender.signing_key, signed, payload.signature)) {
          reject("bad_signature"); // destination-side check: the envelope really is from that device
          continue;
        }
      } else if (!(payload?.status === "delivered" && Number.isFinite(payload.at))) {
        reject("bad_item");
        continue;
      }
      const blocked = db.prepare("SELECT 1 FROM user_blocks WHERE user_id = ? AND blocked_user_id = ?").get(rcpt.user_id, it.senderUserId);
      const expiresAt = Math.min(Number(it.expiresAt) || 0, t + this.ctx.config.queueTtlSeconds * 1000);
      const deliver = !blocked && expiresAt > t;
      // Queued first, then recorded: a peer's retry after a failure in between is skipped by the queue's unique key.
      if (deliver) {
        const rows = await this.ctx.relay.enqueue([
          {
            recipient_device_id: it.recipientDeviceId,
            kind: it.kind,
            conversation_id: convId,
            message_id: it.messageId,
            sender_user_id: it.senderUserId,
            sender_device_id: it.senderDeviceId,
            // A peer can't attest @everyone for this server's members: the mark is removed (docs/MENTIONS.md).
            payload: withoutMentionAll(it.payload),
            created_at: t,
            expires_at: expiresAt,
          },
        ]);
        queued.push(...rows);
      }
      // The inbox record (SQLite) commits with the conversation's unit (or just before it, in MongoDB).
      const created = await this.ctx.ws.write((w) => {
        const isNew = this.ensureDm(w, convId, dmKey, it.senderUserId, rcpt.user_id, t);
        if (deliver && it.kind === "envelope" && payload.cls === "message") w.update("conversations", { id: convId }, { updated_at: t });
        db.prepare("INSERT OR IGNORE INTO federation_inbox (item_key, peer_server_id, expires_at) VALUES (?, ?, ?)").run(`${peer.serverId}|${it.key}`, peer.serverId, t + 8 * 86_400_000);
        return isNew;
      });
      if (created) notify(convId);
      results.push({ key: it.key, status: "accepted" }); // blocked senders get the same answer (no block oracle)
    }
    for (const row of queued) this.ctx.hub.pushQueued(row.recipient_device_id, [row]);
    return results;
  }

  /** Creates the federated DM on first contact. Returns true if it was new. */
  ensureDm(w: RowWriter, convId: string, dmKey: string, a: string, b: string, t = now()): boolean {
    const existing = w.get<{ id: string }>("conversations", { dm_key: dmKey });
    if (existing) {
      if (existing.id !== convId) throw new FederationError(409, "conversation_conflict", "A different conversation already exists for these people");
      return false;
    }
    w.insert("conversations", { id: convId, type: "DM", dm_key: dmKey, created_by: a, created_at: t, updated_at: t });
    for (const u of [a, b]) w.insert("conversation_members", { conversation_id: convId, user_id: u, role: "MEMBER", joined_at: t }, { orIgnore: true });
    return true;
  }

  /** The home servers of [conversationId]'s members from other servers, once each. */
  private remoteHomes(conversationId: string): string[] {
    const homes = memberUsers<{ home_server_id: string | null }>(this.ctx, conversationId, "id, home_server_id").map(({ user }) => user.home_server_id);
    return [...new Set(homes.filter((h): h is string => h !== null))];
  }

  /** [conversationId]'s members whose account is on this server. */
  private localMembers(conversationId: string): string[] {
    return memberUsers<{ home_server_id: string | null }>(this.ctx, conversationId, "id, home_server_id")
      .filter(({ user }) => user.home_server_id === null)
      .map(({ member }) => member.user_id);
  }

  /** Stores a pushed attachment (ciphertext) for a federated conversation this server shares with the peer. */
  async acceptAttachment(peer: ResolvedServer, meta: FedAttachmentMeta, stream: Readable, expectedHash: string): Promise<{ status: number; code?: string }> {
    const { db, config } = this.ctx;
    if (!meta || !ATTACHMENT_ID.test(meta.id) || !Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size > config.attachmentMaxBytes + 64) return { status: 400, code: "bad_attachment" };
    const conv = this.ctx.ws.get("conversations", { id: meta.conversationId });
    const uploader = db.prepare("SELECT home_server_id FROM users WHERE id = ?").get(meta.uploaderUserId) as { home_server_id: string | null } | undefined;
    const member = this.ctx.ws.get("conversation_members", { conversation_id: meta.conversationId, user_id: meta.uploaderUserId });
    if (!conv || !member || uploader?.home_server_id !== peer.serverId) return { status: 403, code: "not_shared" };
    const existing = await this.ctx.files.attachment(meta.id);
    if (existing) return existing.size === meta.size ? { status: 200 } : { status: 409, code: "id_conflict" };
    // Storage quota for everything a peer pushes (same cap a local user has).
    const peerUsers = (db.prepare("SELECT id FROM users WHERE home_server_id = ?").all(peer.serverId) as { id: string }[]).map((r) => r.id);
    const fromPeer = (await this.ctx.files.storedUsage({ uploaders: peerUsers, liveAt: now() })).bytes;
    if (config.attachmentUserStoredBytes > 0 && fromPeer + meta.size > config.attachmentUserStoredBytes) return { status: 429, code: "quota_exceeded" };
    const tmp = path.join(this.ctx.blobs.spoolDir, `${meta.id}.fed.part`);
    const hash = crypto.createHash("sha256");
    let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tmp, { mode: 0o600 });
        stream.on("data", (c: Buffer) => {
          size += c.length;
          hash.update(c);
          if (size > meta.size) stream.destroy(new Error("too large"));
        });
        stream.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        stream.pipe(out);
      });
      const digest = hash.digest();
      if (size !== meta.size || digest.toString("base64") !== expectedHash) throw new Error("size or hash mismatch");
      try {
        await this.ctx.blobs.putFile("attachments", meta.id, tmp, size, digest.toString("hex"));
      } catch {
        await fs.promises.rm(tmp, { force: true });
        return { status: 503, code: "storage_unavailable" };
      }
    } catch (e) {
      await fs.promises.rm(tmp, { force: true });
      return { status: 400, code: "bad_body" };
    }
    const expiresAt = Math.min(meta.expiresAt, now() + config.attachmentTtlSeconds * 1000);
    await this.ctx.files.recordAttachment({ id: meta.id, conversation_id: meta.conversationId, uploader_user_id: meta.uploaderUserId, size, created_at: now(), expires_at: expiresAt });
    return { status: 200 };
  }

  /** Who may read a local user's directory entry by id: servers hosting someone they share a conversation with. */
  sharesConversation(userId: string, peerServerId: string): boolean {
    const mine = this.ctx.ws.all<{ conversation_id: string }>("conversation_members", { where: { user_id: userId } });
    return mine.some((m) => this.remoteHomes(m.conversation_id).includes(peerServerId));
  }

  // ───────────────────────── calls (docs/CALLING_AND_E2EE.md §6) ─────────────────────────

  /** What a peer needs to mirror a call this server hosts (no tokens, no keys). */
  async callRelayView(c: CallRow) {
    const participants = await this.ctx.calls.present(c.id);
    return {
      id: c.id,
      conversationId: c.conversation_id,
      roomName: c.room_name,
      createdBy: c.created_by,
      video: !!c.video,
      state: c.state,
      createdAt: c.created_at,
      answeredAt: c.answered_at,
      endedAt: c.ended_at,
      endReason: c.end_reason,
      alertedAt: c.alerted_at,
      participants: participants.map((p) => ({ userId: p.user_id, deviceId: p.device_id, joinedAt: p.joined_at })),
    };
  }

  /**
   * Sends a call event about a call hosted here to the home servers of the remote people in it (or of one person).
   * Realtime and best effort: three quick attempts, then the peer's next sync (join, active list) catches up.
   */
  async relayCall(c: CallRow, event: CallEventName, extra: CallEventExtras = {}, targetUserId?: string): Promise<void> {
    const homes = targetUserId
      ? (this.ctx.db.prepare("SELECT home_server_id h FROM users WHERE id = ? AND home_server_id IS NOT NULL").all(targetUserId) as { h: string }[])
      : this.remoteHomes(c.conversation_id).map((h) => ({ h }));
    if (homes.length === 0) return;
    // A ring can arrive before any message has created the conversation on the peer: it carries what the peer needs
    // to verify and create it (the caller's public directory entry and the members' ids).
    const members = this.ctx.ws.all<{ user_id: string }>("conversation_members", { where: { conversation_id: c.conversation_id } }).map((r) => r.user_id);
    const body = { event, call: await this.callRelayView(c), extra, targetUserId: targetUserId ?? null, caller: this.entry(c.created_by), members };
    for (const { h } of homes) {
      void (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const peer = await this.resolver.server(h);
            const r = await this.request(peer, "POST", "/fed/v1/calls/event", body);
            if (r.status === 200 || (r.status >= 400 && r.status < 500 && r.status !== 429)) return;
          } catch {
            /* retry */
          }
          await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
        }
        this.ctx.log.warn({ peer: h, event }, "call event not delivered");
      })();
    }
  }

  /** Mirrors a call hosted by `peer` from an event or a forwarded action's answer. Returns the mirror row. */
  async applyCallState(peer: ResolvedServer, v: Awaited<ReturnType<Federation["callRelayView"]>>): Promise<CallRow> {
    const { db } = this.ctx;
    if (!v || typeof v.id !== "string" || !/^call_[A-Za-z0-9_-]{22}$/.test(v.id) || typeof v.roomName !== "string" || v.roomName.length > 80) {
      throw new FederationError(400, "bad_call", "Invalid call");
    }
    const creator = db.prepare("SELECT home_server_id h FROM users WHERE id = ?").get(v.createdBy) as { h: string | null } | undefined;
    if (creator?.h !== peer.serverId) throw new FederationError(403, "not_host", "Calls are hosted by the caller's own server");
    const local = this.localMembers(v.conversationId).length > 0;
    const creatorMember = this.ctx.ws.get("conversation_members", { conversation_id: v.conversationId, user_id: v.createdBy });
    if (!local || !creatorMember) throw new FederationError(403, "not_shared", "No shared conversation");
    const state = (["RINGING", "ACTIVE", "ENDED"].includes(v.state) ? v.state : "ENDED") as CallRow["state"];
    const existing = await this.ctx.calls.get(v.id);
    if (existing && existing.host_server_id !== peer.serverId) throw new FederationError(409, "call_conflict", "That call isn't hosted by your server");
    // Participants as the host sees them (people and devices known here only).
    const known = db.prepare("SELECT 1 FROM devices WHERE id = ? AND user_id = ?");
    const participants = (Array.isArray(v.participants) ? v.participants.slice(0, 50) : [])
      .filter((p) => known.get(p.deviceId, p.userId))
      .map((p) => ({ user_id: p.userId, device_id: p.deviceId, joined_at: p.joinedAt }));
    await this.ctx.calls.applyMirror(
      {
        id: v.id,
        conversation_id: v.conversationId,
        room_name: v.roomName,
        created_by: v.createdBy,
        video: v.video ? 1 : 0,
        state,
        created_at: v.createdAt,
        answered_at: v.answeredAt,
        ended_at: v.endedAt,
        end_reason: v.endReason,
        alerted_at: v.alertedAt,
        host_server_id: peer.serverId,
        room: 0,
      },
      participants,
    );
    return (await this.ctx.calls.get(v.id))!;
  }

  /** A call event from its host: update the mirror and pass it to this server's members (or the one targeted). */
  async acceptCallEvent(
    peer: ResolvedServer,
    body: { event?: string; call?: any; extra?: object; targetUserId?: string | null; caller?: FedUser | null; members?: string[] },
    notify?: (conversationId: string) => void,
  ) {
    const event = body?.event;
    if (!isRelayedCallEvent(event)) throw new FederationError(400, "bad_event", "Unknown call event");
    await this.ensureCallConversation(peer, body, notify);
    const c = await this.applyCallState(peer, body.call);
    const view = await callView(this.ctx, c);
    const msg: ServerEvent = { t: "call", event, call: view, ...callExtras(body.extra) };
    if (body.targetUserId) {
      if (this.localMembers(c.conversation_id).includes(body.targetUserId)) {
        this.ctx.hub.sendToUser(body.targetUserId, msg);
        if (body.event === "ring") this.ctx.push?.ring(body.targetUserId); // devices with no open socket (payload-free)
      }
    } else {
      const members = this.localMembers(c.conversation_id);
      this.ctx.hub.sendToUsers(members, msg);
      if (body.event === "ring") for (const m of members) this.ctx.push?.ring(m);
    }
  }

  /**
   * First contact by call: create the federated DM if it doesn't exist yet, but only after checking that the caller is
   * the host's own user (directory entry verified as for messages), the callee is local here, and the conversation id
   * is the one both servers derive from exactly those two people.
   */
  private async ensureCallConversation(peer: ResolvedServer, body: { call?: any; caller?: FedUser | null; members?: string[] }, notify?: (conversationId: string) => void) {
    const convId = body.call?.conversationId;
    if (typeof convId !== "string" || this.ctx.ws.get("conversations", { id: convId })) return;
    const caller = body.caller;
    if (!caller || caller.userId !== body.call?.createdBy || !Array.isArray(body.members) || body.members.length !== 2) return;
    this.upsertShadow(peer, caller);
    const callee = body.members.find((m) => m !== caller.userId);
    const local = callee && this.ctx.db.prepare("SELECT 1 FROM users WHERE id = ? AND home_server_id IS NULL AND disabled_at IS NULL").get(callee);
    if (!callee || !local) return;
    const dmKey = [caller.userId, callee].sort().join("|");
    if (fedDmId(dmKey) !== convId) return;
    if (await this.ctx.ws.write((w) => this.ensureDm(w, convId, dmKey, caller.userId, callee))) notify?.(convId);
  }

  /** One of this server's users acts on a call hosted elsewhere: forwarded to the host, which owns the state and tokens. */
  async forwardCall(c: CallRow, action: string, userId: string, deviceId: string, body: object = {}) {
    const peer = await this.resolver.server(c.host_server_id!);
    const r = await this.request(peer, "POST", `/fed/v1/calls/${c.id}/${action}`, { userId, deviceId, ...body });
    if (r.status !== 200) throw new ApiError(r.status === 404 ? 404 : r.status, remoteCode(r.json?.error?.code), r.json?.error?.message ?? "The call's server refused that");
    const mirror = await this.applyCallState(peer, r.json.call);
    return { call: await callView(this.ctx, mirror), ...(r.json.media ? { media: r.json.media } : {}) };
  }

  cleanup(t = now()) {
    const { db } = this.ctx;
    return {
      nonces: db.prepare("DELETE FROM federation_nonces WHERE expires_at <= ?").run(t).changes,
      inbox: db.prepare("DELETE FROM federation_inbox WHERE expires_at <= ?").run(t).changes,
      outbox: db.prepare("DELETE FROM federation_outbox WHERE expires_at <= ?").run(t).changes,
    };
  }
}

/** A host server's error code passed on to our client: only codes this server's catalog knows (shared/errors.ts). */
function remoteCode(code: unknown): ErrorCode {
  return typeof code === "string" && isErrorCode(code) ? code : "call_failed";
}

const RELAYED_CALL_EVENTS: readonly CallEventName[] = ["ring", "updated", "ended", "alerted", "declined", "dismissed", "started"];

export function isRelayedCallEvent(e: unknown): e is CallEventName {
  return typeof e === "string" && (RELAYED_CALL_EVENTS as readonly string[]).includes(e);
}

/** The extra fields of a call event from a peer server: only the contract's, with their types checked. */
export function callExtras(raw: unknown): CallEventExtras {
  if (!raw || typeof raw !== "object") return {};
  const x = raw as Record<string, unknown>;
  const out: CallEventExtras = {};
  const from = x.from as Record<string, unknown> | undefined;
  if (from && typeof from.userId === "string" && typeof from.displayName === "string") out.from = { userId: from.userId, displayName: from.displayName };
  if (typeof x.userId === "string") out.userId = x.userId;
  if (x.reason === "declined" || x.reason === "busy") out.reason = x.reason;
  return out;
}
