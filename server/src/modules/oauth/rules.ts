import crypto from "node:crypto";
import { OAUTH_SCOPES, type OAuthErrorCode, type OAuthScope } from "../../shared/contracts/http/oauthApps.js";

/** Lifetimes (API 0.65.0, docs/SETTINGS_PARITY_API.md). */
export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;

/** Credential prefixes: client secret, authorization code, access token, refresh token. */
export const PREFIX = { secret: "mqs", code: "mqc", access: "mqo", refresh: "mqr" } as const;

/** What each scope lets an app see, in the words the consent screen uses. */
export const SCOPE_WORDS: Readonly<Record<OAuthScope, string>> = {
  identify: "Your username, display name and profile picture",
  email: "Your email address",
};

/** "identify email" → the scopes asked for (identify always included), or null when one isn't known. */
export function parseScopes(raw: string | undefined): OAuthScope[] | null {
  const asked = (raw ?? "").split(/[\s+]+/).filter(Boolean);
  if (!asked.every((s) => (OAUTH_SCOPES as readonly string[]).includes(s))) return null;
  return OAUTH_SCOPES.filter((s) => s === "identify" || asked.includes(s));
}

/** RFC 7636 §4.6: BASE64URL(SHA256(code_verifier)) equals the challenge. */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(crypto.createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

/** An answer of the token endpoint in RFC 6749 §5.2's shape (not the error envelope). */
export class OAuthError extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly error: OAuthErrorCode,
    description: string,
  ) {
    super(description);
  }
}

export const invalidGrant = (why: string) => new OAuthError(400, "invalid_grant", why);
export const invalidRequest = (why: string) => new OAuthError(400, "invalid_request", why);
export const invalidClient = (why = "Unknown client or wrong client secret") => new OAuthError(401, "invalid_client", why);

/** "<prefix>_<familyId>.<secret>": the family is found by its id, the secret compared by hash. */
export function familyOfRefresh(token: string): string | null {
  const m = /^mqr_([A-Za-z0-9_-]{8,64})\.[A-Za-z0-9_-]{20,}$/.exec(token);
  return m ? m[1]! : null;
}
