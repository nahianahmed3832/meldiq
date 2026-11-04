/**
 * Shared griip-envelope-v1 test vectors (technical debt D22). The committed file is a contract that
 * both implementations check: this suite verifies it with the Node reference client, and the
 * Android unit test `EnvelopeInteropTest` verifies the same bytes with the Kotlin client.
 * Deterministic values (Ed25519 signatures, certificates, fingerprints, AES-GCM with a fixed nonce)
 * must be reproduced exactly; the HPKE-wrapped envelope (randomised) must open and verify.
 *
 * Regenerate (only when the protocol deliberately changes):
 *   GRIIP_WRITE_VECTORS=1 npx vitest run test/interop_vectors.test.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keyFingerprint } from "../src/shared/utilities/crypto.js";
import { canonical, ed25519FromSeed, GriipClient, newX25519, sign, suite, verify } from "./support/griipClient.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.MELDIQ_INTEROP_VECTOR_FILE ?? path.resolve(here, "../../android/app/src/test/resources/griip-envelope-v1-vectors.json");
const HPKE_INFO = new TextEncoder().encode("griip-envelope-v1/key");
const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64");

function aesGcm(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer) {
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

async function generate() {
  const identity = ed25519FromSeed(crypto.randomBytes(32));
  const device = ed25519FromSeed(crypto.randomBytes(32));
  const enc = newX25519();
  const recipient = newX25519();
  const identityKey = b64(identity.pub);
  const sender = {
    userId: "u_vector_sender",
    deviceId: "d_vector_sender",
    identitySeed: b64(identity.seed),
    identityKey,
    deviceSignSeed: b64(device.seed),
    deviceSigningKey: b64(device.pub),
    deviceEncPrivate: b64(enc.priv),
    deviceEncPublic: b64(enc.pub),
    certificate: sign(identity, canonical.deviceCert(identityKey, b64(device.pub), b64(enc.pub))),
    fingerprint: keyFingerprint(identityKey),
  };
  const proofMessage = canonical.authProof("login", "nonce-0123456789abcdef", sender.deviceSigningKey);
  const aes = { key: crypto.randomBytes(32), nonce: crypto.randomBytes(12), aad: Buffer.from("griip-aad"), plaintext: Buffer.from("AES-GCM vector ✓") };

  const client = new GriipClient("http://unused", "vectors", "Vectors");
  client.identity = identity;
  client.device = device;
  client.enc = enc;
  client.userId = sender.userId;
  client.deviceId = sender.deviceId;
  const payload = { type: "text", text: "Hello from the Node reference client ✓" };
  const env = await client.encrypt("c_vector", payload, "message", [{ id: "d_vector_recipient", signingKey: "", encryptionKey: b64(recipient.pub), certificate: "" }], "m_vector_0001");
  return {
    comment: "griip-envelope-v1 interop vectors. Test keys only. Verified by server/test/interop_vectors.test.ts and android EnvelopeInteropTest.",
    sender,
    recipient: { deviceId: "d_vector_recipient", encPrivate: b64(recipient.priv), encPublic: b64(recipient.pub) },
    authProof: { message: proofMessage, signature: sign(device, proofMessage) },
    aesGcm: { key: b64(aes.key), nonce: b64(aes.nonce), aad: b64(aes.aad), plaintext: b64(aes.plaintext), ciphertext: b64(aesGcm(aes.key, aes.nonce, aes.plaintext, aes.aad)) },
    envelope: {
      header: { messageId: env.messageId, conversationId: env.conversationId, senderUserId: sender.userId, senderDeviceId: sender.deviceId, sentAt: env.sentAt, cls: env.cls },
      nonce: env.nonce,
      ciphertext: env.ciphertext,
      signature: env.signature,
      enc: env.recipients[0].enc,
      wrappedKey: env.recipients[0].wrappedKey,
      plaintext: JSON.stringify(payload),
    },
  };
}

describe("griip-envelope-v1 interop vectors (shared with the Android tests)", () => {
  it("the committed vectors verify with the Node reference client", async () => {
    if (process.env.GRIIP_WRITE_VECTORS === "1") {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(await generate(), null, 2) + "\n");
    }
    const v = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const s = v.sender;
    const identity = ed25519FromSeed(Buffer.from(s.identitySeed, "base64"));
    const device = ed25519FromSeed(Buffer.from(s.deviceSignSeed, "base64"));
    expect(b64(identity.pub)).toBe(s.identityKey);
    expect(b64(device.pub)).toBe(s.deviceSigningKey);
    // Ed25519 is deterministic: the same inputs give the same signature on every implementation.
    expect(sign(identity, canonical.deviceCert(s.identityKey, s.deviceSigningKey, s.deviceEncPublic))).toBe(s.certificate);
    expect(sign(device, v.authProof.message)).toBe(v.authProof.signature);
    expect(keyFingerprint(s.identityKey)).toBe(s.fingerprint);
    const a = v.aesGcm;
    const unb = (x: string) => Buffer.from(x, "base64");
    expect(b64(aesGcm(unb(a.key), unb(a.nonce), unb(a.plaintext), unb(a.aad)))).toBe(a.ciphertext);

    const e = v.envelope;
    const header = canonical.header(e.header);
    expect(verify(s.deviceSigningKey, `${header}\n${e.nonce}\n${e.ciphertext}`, e.signature)).toBe(true);
    const recipientKey = await suite.kem.deserializePrivateKey(unb(v.recipient.encPrivate));
    const contentKey = Buffer.from(await suite.open({ recipientKey, enc: unb(e.enc), info: HPKE_INFO }, unb(e.wrappedKey), Buffer.from(`${e.header.messageId}\n${v.recipient.deviceId}`, "utf8")));
    const ct = unb(e.ciphertext);
    const d = crypto.createDecipheriv("aes-256-gcm", contentKey, unb(e.nonce));
    d.setAAD(Buffer.from(header, "utf8"));
    d.setAuthTag(ct.subarray(ct.length - 16));
    expect(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8")).toBe(e.plaintext);
  });
});
