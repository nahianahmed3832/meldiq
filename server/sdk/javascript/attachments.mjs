import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { MeldiqBotError } from "./transport.mjs";

// Convenience for whole-object native AES-GCM references. This in-memory helper does not change server/plan limits.
const MAX_BUFFER = 64 * 1024 * 1024;
export function encryptAttachmentBytes(
  input,
  { name = "file", mime = "application/octet-stream" } = {},
) {
  if (
    !(input instanceof Uint8Array) ||
    !input.byteLength ||
    input.byteLength > MAX_BUFFER ||
    typeof name !== "string" ||
    name.length > 512 ||
    typeof mime !== "string" ||
    mime.length > 255
  )
    throw new TypeError(
      "Supply a non-empty file up to 64 MiB with valid metadata; use native streaming encryption for larger files",
    );
  const key = randomBytes(32),
    nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const bytes = Buffer.concat([
    cipher.update(input),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    bytes,
    reference: {
      name,
      mime,
      size: input.byteLength,
      key: key.toString("base64"),
      nonce: nonce.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("base64"),
    },
  };
}
export function decryptAttachmentBytes(input, reference) {
  try {
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength > MAX_BUFFER + 16 ||
      reference?.chunk !== undefined ||
      !Number.isSafeInteger(reference?.size) ||
      reference.size < 1 ||
      input.byteLength !== reference.size + 16
    )
      throw new Error();
    const key = Buffer.from(reference.key, "base64"),
      nonce = Buffer.from(reference.nonce, "base64"),
      hash = Buffer.from(reference.sha256, "base64");
    if (
      key.length !== 32 ||
      nonce.length !== 12 ||
      hash.length !== 32 ||
      !timingSafeEqual(hash, createHash("sha256").update(input).digest())
    )
      throw new Error();
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      decipher.update(bytes.subarray(0, -16)),
      decipher.final(),
    ]);
  } catch {
    throw new MeldiqBotError(
      0,
      "attachment_invalid",
      "The attachment bytes or encryption metadata did not match",
    );
  }
}
