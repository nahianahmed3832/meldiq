import crypto from "node:crypto";

/**
 * The `state` a connection carries through the provider's sign-in page and back: who started it, for which provider,
 * until when, and a one-time nonce, signed with HMAC-SHA256. The callback has no session (it's the browser coming
 * back from the provider), so this is what ties it to the account; the nonce must also match a start this server
 * recorded, so a state works once.
 *
 * The signing key comes from PLATFORM_SECRETS_KEY when set (so every API process agrees on it); otherwise each process
 * makes its own at start, and a connection must finish on the process that started it within the 10 minutes.
 */
export const STATE_TTL_MS = 10 * 60_000;

export interface StatePayload {
  userId: string;
  provider: string;
  nonce: string;
  expiresAt: number;
}

export class StateSigner {
  private readonly key: Buffer;

  constructor(secretsKey: Buffer | null) {
    this.key = secretsKey ? crypto.createHmac("sha256", secretsKey).update("meldiq linked-account state v1").digest() : crypto.randomBytes(32);
  }

  sign(p: StatePayload): string {
    const body = Buffer.from(JSON.stringify([p.userId, p.provider, p.nonce, p.expiresAt])).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  /** The payload of a state this server signed, unexpired and for [provider]; null for anything else. */
  verify(state: string, provider: string, at: number): StatePayload | null {
    const [body, mac, extra] = state.split(".");
    if (!body || !mac || extra !== undefined) return null;
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [userId, p, nonce, expiresAt] = parsed as unknown[];
    if (typeof userId !== "string" || typeof p !== "string" || typeof nonce !== "string" || typeof expiresAt !== "number") return null;
    if (p !== provider || expiresAt <= at) return null;
    return { userId, provider: p, nonce, expiresAt };
  }

  private mac(body: string): string {
    return crypto.createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}
