import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import crypto from "node:crypto";

/**
 * `griip-envelope-v1` on the server (docs/SECURITY.md §2–3): the same composition as the Android app
 * (`EnvelopeCrypto.kt`) and the reference client (`test/support/griipClient.ts`), for the one place the server holds
 * member keys: an AI agent's reader device in a conversation that switched reading on (docs/AI_WORKFORCE_2_PLAN.md,
 * phase 5). Primitives come from Node's crypto and @hpke/core; nothing here implements a primitive.
 */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const HPKE_INFO = new TextEncoder().encode("griip-envelope-v1/key");
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const GCM_TAG = 16;

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

export const newEd25519 = (): Ed25519Pair => ed25519FromSeed(crypto.randomBytes(32));

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
  deviceCert: (identityKey: string, signingKey: string, encryptionKey: string) => `griip-device-cert-v1\n${identityKey}\n${signingKey}\n${encryptionKey}`,
  header: (h: { messageId: string; conversationId: string; senderUserId: string; senderDeviceId: string; sentAt: number; cls: string }) =>
    `griip-envelope-v1\n${h.messageId}\n${h.conversationId}\n${h.senderUserId}\n${h.senderDeviceId}\n${h.sentAt}\n${h.cls}`,
};

/** A queued envelope as a recipient device gets it (the relay's payload JSON). */
export interface QueuedEnvelope {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  payload: { sentAt: number; cls: string; nonce: string; ciphertext: string; signature: string; enc: string; wrappedKey: string };
}

export interface OpenedEnvelope {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  cls: string;
  sentAt: number;
  payload: unknown;
}

/**
 * Opens an envelope for [recipient]: checks the sender device's certificate against the sender's identity key and its
 * signature over the header and ciphertext, unwraps the content key, and authenticates the content. Throws on any
 * failure; nothing unauthenticated comes out.
 */
export async function openEnvelope(
  e: QueuedEnvelope,
  sender: { identityKey: string; signingKey: string; encryptionKey: string; certificate: string },
  recipient: { deviceId: string; encPriv: Buffer },
): Promise<OpenedEnvelope> {
  if (!verify(sender.identityKey, canonical.deviceCert(sender.identityKey, sender.signingKey, sender.encryptionKey), sender.certificate)) throw new Error("uncertified sender device");
  const p = e.payload;
  const header = canonical.header({ messageId: e.messageId, conversationId: e.conversationId, senderUserId: e.senderUserId, senderDeviceId: e.senderDeviceId, sentAt: p.sentAt, cls: p.cls });
  if (!verify(sender.signingKey, `${header}\n${p.nonce}\n${p.ciphertext}`, p.signature)) throw new Error("bad signature");
  const recipientKey = await suite.kem.deserializePrivateKey(new Uint8Array(recipient.encPriv));
  const contentKey = Buffer.from(
    await suite.open({ recipientKey, enc: Buffer.from(p.enc, "base64"), info: HPKE_INFO }, Buffer.from(p.wrappedKey, "base64"), Buffer.from(`${e.messageId}\n${recipient.deviceId}`, "utf8")),
  );
  const ct = Buffer.from(p.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", contentKey, Buffer.from(p.nonce, "base64"));
  decipher.setAAD(Buffer.from(header, "utf8"));
  decipher.setAuthTag(ct.subarray(ct.length - GCM_TAG));
  const pt = Buffer.concat([decipher.update(ct.subarray(0, ct.length - GCM_TAG)), decipher.final()]);
  return { messageId: e.messageId, conversationId: e.conversationId, senderUserId: e.senderUserId, senderDeviceId: e.senderDeviceId, cls: p.cls, sentAt: p.sentAt, payload: JSON.parse(pt.toString("utf8")) as unknown };
}

/** AES-256-GCM sealing for keys and stored text: nonce ‖ ciphertext ‖ tag, base64; [aad] binds it to its row. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([nonce, c.update(plaintext), c.final(), c.getAuthTag()]).toString("base64");
}

export function unseal(key: Buffer, sealed: string, aad: string): Buffer {
  const b = Buffer.from(sealed, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(b.subarray(b.length - GCM_TAG));
  return Buffer.concat([d.update(b.subarray(12, b.length - GCM_TAG)), d.final()]);
}
