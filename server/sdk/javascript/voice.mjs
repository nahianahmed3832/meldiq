import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { MeldiqBotError } from "./transport.mjs";

const info = new TextEncoder().encode("meldiq-bot-voice-v1");
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

/** Optional media helper. Private keys stay in the caller's process and are never sent to Meldiq. */
export async function createVoiceKeys() {
  const keys = await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ]);
  const raw = await crypto.subtle.exportKey("raw", keys.publicKey);
  return {
    keys,
    publicKey: Buffer.from(raw).toString("base64"),
    fingerprint: Buffer.from(
      await crypto.subtle.digest("SHA-256", raw),
    ).toString("hex"),
  };
}

/** Returns the native key text expected by LiveKit's key provider, only inside this bot process. */
export async function openVoiceKey(keys, response) {
  if (!response?.key)
    throw new MeldiqBotError(
      409,
      "voice_key_pending",
      "Wait for an encrypted key from a connected room participant",
    );
  try {
    for (const field of ["callId", "channelId", "botId", "leaseId"])
      if (
        typeof response[field] !== "string" ||
        !response[field] ||
        response[field].length > 64
      )
        throw new Error("Invalid context");
    if (
      !Number.isSafeInteger(response.manifestRev) ||
      response.manifestRev < 1 ||
      !Number.isSafeInteger(response.expiresAt) ||
      response.expiresAt <= Date.now()
    )
      throw new Error("Expired context");
    const enc = Buffer.from(response.key.enc, "base64"),
      ct = Buffer.from(response.key.ct, "base64");
    if (enc.length !== 32 || ct.length !== 48)
      throw new Error("Invalid ciphertext");
    const aad = Buffer.from(
      JSON.stringify([
        "meldiq-bot-voice-v1",
        response.callId,
        response.channelId,
        response.botId,
        response.leaseId,
        response.manifestRev,
      ]),
    );
    const plain = await suite.open({ recipientKey: keys, enc, info }, ct, aad);
    if (plain.byteLength !== 32) throw new Error("Invalid key");
    return Buffer.from(plain).toString("base64");
  } catch {
    throw new MeldiqBotError(
      0,
      "voice_key_invalid",
      "The encrypted voice key did not match this bot and lease",
    );
  }
}
