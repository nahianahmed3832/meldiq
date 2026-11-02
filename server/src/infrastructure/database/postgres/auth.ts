import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { MeldiqPostgres } from "./client.js";

export interface SupabasePrincipal { authUserId: string; accountId: string; userId: string; sessionId: string; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Supabase identity never replaces Meldiq's existing device proof or platform-admin authorization. */
export class SupabaseAccessVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly issuer: string;
  constructor(projectUrl: string, private readonly db: MeldiqPostgres, keys?: JWTVerifyGetKey) {
    const url = new URL(projectUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Trusted HTTPS Supabase project origin required");
    this.issuer = `${url.origin}/auth/v1`;
    this.keys = keys ?? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`), { timeoutDuration: 5000, cooldownDuration: 30_000 });
  }
  async verify(token: string): Promise<SupabasePrincipal | null> {
    if (token.length > 16_384) return null;
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, this.keys, { issuer: this.issuer, audience: "authenticated", algorithms: ["ES256", "RS256"],
        requiredClaims: ["sub", "exp", "iat", "session_id", "role"], clockTolerance: 5 }));
    } catch { return null; }
    if (!claims.sub || !uuid.test(claims.sub) || typeof claims.session_id !== "string" || !uuid.test(claims.session_id)
      || claims.role !== "authenticated" || typeof claims.iat !== "number" || claims.iat > Date.now()/1000+5) return null;
    // Ownership and revocation remain database checks, never mutable JWT user_metadata.
    const result = await this.db.query<{ account_id: string; user_id: string }>(`
      SELECT l.account_id, l.user_id FROM meldiq_private.auth_links l
      JOIN meldiq.accounts a ON a.id = l.account_id AND a.user_id = l.user_id
      JOIN meldiq.users u ON u.id = l.user_id
      WHERE l.auth_user_id = $1 AND a.disabled_at IS NULL AND u.disabled_at IS NULL AND u.deleted_at IS NULL
        AND meldiq_private.session_active($1::uuid, $2::uuid)`, [claims.sub, claims.session_id]);
    const owner = result.rows[0];
    return owner ? { authUserId: claims.sub, accountId: owner.account_id, userId: owner.user_id, sessionId: claims.session_id } : null;
  }
}
