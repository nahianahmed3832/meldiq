import crypto from "node:crypto";
import { ApiError } from "../../shared/errors.js";

/**
 * Credentials at rest (docs/AI_OPERATIONS.md › Credentials): AES-256-GCM with a key that lives only in the server's
 * environment (PLATFORM_SECRETS_KEY: 32 random bytes, base64 or hex), never in the database or a backup of it. Each
 * ciphertext is bound to the row it belongs to (associated data), so it can't be moved to another provider.
 *
 * Without the key, nothing can be stored: the console says so instead of falling back to plain text.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function secretsKey(env: NodeJS.ProcessEnv): Buffer | null {
  const raw = env.PLATFORM_SECRETS_KEY?.trim();
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("PLATFORM_SECRETS_KEY must be 32 bytes (64 hex characters or 44 base64 characters)");
  return key;
}

export class SecretBox {
  constructor(private readonly key: Buffer | null) {}

  get available(): boolean {
    return this.key !== null;
  }

  private need(): Buffer {
    if (!this.key) throw new ApiError(503, "secrets_unavailable", "Credentials can't be stored: PLATFORM_SECRETS_KEY isn't set on the server.");
    return this.key;
  }

  seal(plain: string, boundTo: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.need(), iv);
    cipher.setAAD(Buffer.from(boundTo));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${VERSION}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
  }

  open(sealed: string, boundTo: string): string {
    const [version, data] = sealed.split(".");
    if (version !== VERSION || !data) throw new Error("unknown secret format");
    const bytes = Buffer.from(data, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.need(), bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(boundTo));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  }
}
