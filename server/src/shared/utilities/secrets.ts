import crypto from "node:crypto";
import { sha256Hex } from "./util.js";

/** Random bytes in every credential handed to a developer or an app (256 bits). */
const SECRET_BYTES = 32;

/**
 * A credential shown once: "<prefix>_<43 base64url characters>". The prefix says what it is (mqs_ a client secret, mqb_
 * a bot token, mqo_ an OAuth access token…), so a leaked one is recognisable in logs and secret scanners. Only its
 * SHA-256 is stored: 256 random bits need no slow hash.
 */
export function newSecret(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(SECRET_BYTES).toString("base64url")}`;
}

/** The stored form of a credential. */
export const secretHash = (secret: string): string => sha256Hex(secret);

/** Whether [secret] is the one [hash] was made from, compared in constant time. */
export function matchesHash(secret: string, hash: string): boolean {
  const a = Buffer.from(secretHash(secret), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
