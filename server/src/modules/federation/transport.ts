/**
 * Signed server-to-server requests (docs/FEDERATION_PROTOCOL.md §4). Every federation request carries:
 *   x-griip-from, x-griip-to (server ids), x-griip-time (ms), x-griip-nonce, x-griip-body-sha256, x-griip-signature
 * where the signature (sender's current server key) covers
 *   "griip-fed-req/1\n" + METHOD + "\n" + path?query + "\n" + bodySha256 + "\n" + from + "\n" + to + "\n" + time + "\n" + nonce.
 * Responses carry x-griip-response-signature over "griip-fed-res/1\n" + requestNonce + "\n" + bodySha256 + "\n" + from + "\n" + to.
 * The receiver checks destination, clock window (±5 min), the signature against the sender's verified descriptor,
 * a per-sender rate limit, and that the nonce hasn't been used (replay). TLS protects transport; the payloads inside
 * are end-to-end encrypted independently of it.
 */
import type { Rows } from "../../infrastructure/database/rows/index.js";
import { verifyServerText, type ServerIdentity } from "./identity.js";
import { FederationError, type ResolvedServer } from "./resolver.js";
import { randomToken, sha256b64 } from "./sign.js";

export const H = {
  from: "x-griip-from",
  to: "x-griip-to",
  time: "x-griip-time",
  nonce: "x-griip-nonce",
  body: "x-griip-body-sha256",
  sig: "x-griip-signature",
  rsig: "x-griip-response-signature",
} as const;

export const CLOCK_WINDOW_MS = 5 * 60_000;

export const requestString = (method: string, path: string, bodyHash: string, from: string, to: string, time: string, nonce: string) =>
  ["griip-fed-req/1", method.toUpperCase(), path, bodyHash, from, to, time, nonce].join("\n");

export const responseString = (nonce: string, bodyHash: string, from: string, to: string) => ["griip-fed-res/1", nonce, bodyHash, from, to].join("\n");

export function signedHeaders(identity: ServerIdentity, method: string, path: string, body: Buffer | string, to: string): Record<string, string> {
  const time = String(Date.now());
  const nonce = randomToken(18);
  const bodyHash = sha256b64(body);
  return {
    [H.from]: identity.serverId,
    [H.to]: to,
    [H.time]: time,
    [H.nonce]: nonce,
    [H.body]: bodyHash,
    [H.sig]: identity.signText(requestString(method, path, bodyHash, identity.serverId, to, time, nonce)),
  };
}

/** Records a nonce; false if it was already used (a replay). Nonces outlive the clock window. */
export function useNonce(ephemeral: Rows, nonce: string, peer: string): Promise<boolean> {
  return ephemeral.write((w) => w.insert("federation_nonces", { nonce, peer_server_id: peer, expires_at: Date.now() + 2 * CLOCK_WINDOW_MS }, { orIgnore: true }).inserted);
}

/** Simple per-peer token bucket (requests per minute). In-memory: one API process (ARCHITECTURE.md §7). */
export class PeerRateLimit {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private perMinute: number) {}
  take(peer: string, cost = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(peer) ?? { tokens: this.perMinute, at: now };
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    if (b.tokens < cost) {
      this.buckets.set(peer, b);
      return false;
    }
    b.tokens -= cost;
    this.buckets.set(peer, b);
    return true;
  }
}

/** Checks the signed headers of an incoming request against an already-resolved sender. Throws on failure. */
export function checkRequest(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  bodyHash: string,
  self: string,
  peer: ResolvedServer,
): { nonce: string } {
  const h = (k: string) => {
    const v = headers[k];
    return typeof v === "string" ? v : "";
  };
  if (h(H.to) !== self) throw new FederationError(421, "wrong_destination", "This request is for another server");
  const time = h(H.time);
  if (!/^\d{10,16}$/.test(time) || Math.abs(Date.now() - Number(time)) > CLOCK_WINDOW_MS) throw new FederationError(401, "bad_time", "Request time is outside the allowed window");
  const nonce = h(H.nonce);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new FederationError(401, "bad_nonce", "Missing nonce");
  if (h(H.body) !== bodyHash) throw new FederationError(401, "bad_body_hash", "Body doesn't match its hash");
  if (!verifyServerText(peer.currentKey, requestString(method, path, bodyHash, h(H.from), self, time, nonce), h(H.sig))) {
    throw new FederationError(401, "bad_signature", "Request isn't signed by the sending server's current key");
  }
  return { nonce };
}
