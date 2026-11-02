import type { z } from "zod/v4";
import type { AuthorizeBody, AuthorizeQuery, OAuthScope, TokenBody, TokenResponse } from "../../shared/contracts/http/oauthApps.js";
import { ApiError } from "../../shared/errors.js";
import { matchesHash, newSecret, secretHash } from "../../shared/utilities/secrets.js";
import { newId } from "../../shared/utilities/util.js";
import { type AppIdentity, appIdentity } from "../accounts/index.js";
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  familyOfRefresh,
  invalidClient,
  invalidGrant,
  invalidRequest,
  OAuthError,
  parseScopes,
  PREFIX,
  REFRESH_TTL_MS,
  SCOPE_WORDS,
  verifierMatches,
} from "./rules.js";
import type { OAuthService } from "./service.js";
import type { OAuthApp, TokenFamily } from "./store.js";

type Query = z.infer<typeof AuthorizeQuery>;
type Token = z.infer<typeof TokenResponse>;

/** Client credentials of a token request: from HTTP Basic or the body (never both). */
export interface ClientCredentials {
  id: string | undefined;
  secret: string | undefined;
}

interface CheckedRequest {
  app: OAuthApp;
  redirectUri: string;
  scopes: OAuthScope[];
  challenge: string | null;
}

/**
 * An authorization request as the consent page passes it on. An unknown client or an unregistered redirect_uri is
 * never redirected to (RFC 6749 §4.1.2.1): the page shows the error instead. PKCE: only S256.
 */
async function checkRequest(svc: OAuthService, q: Query): Promise<CheckedRequest> {
  const app = await svc.store.app(q.client_id);
  if (!app) throw new ApiError(400, "oauth_invalid_client", "No app has that client_id");
  if (!app.redirectUris.includes(q.redirect_uri)) throw new ApiError(400, "oauth_invalid_redirect", "That redirect_uri isn't registered for this app");
  const scopes = parseScopes(q.scope);
  if (!scopes) throw new ApiError(400, "oauth_invalid_scope", "Meldiq's scopes are identify and email");
  const method = q.code_challenge_method;
  if (method !== undefined && method !== "S256") throw new ApiError(400, "oauth_invalid_request", "Only code_challenge_method=S256 is supported");
  if (method && !q.code_challenge) throw new ApiError(400, "oauth_invalid_request", "code_challenge_method needs a code_challenge");
  if (q.code_challenge && method !== "S256") throw new ApiError(400, "oauth_invalid_request", "Send code_challenge_method=S256 with the code_challenge");
  return { app, redirectUri: q.redirect_uri, scopes, challenge: q.code_challenge ?? null };
}

/** What the consent screen shows for [q], asked by the signed-in [userId]. */
export async function authorizeInfo(svc: OAuthService, userId: string, q: Query) {
  const r = await checkRequest(svc, q);
  const grant = await svc.store.grant(r.app.id, userId);
  return {
    app: svc.summaries([r.app]).get(r.app.id)!,
    scopes: r.scopes.map((id) => ({ id, description: SCOPE_WORDS[id] })),
    redirectUri: r.redirectUri,
    alreadyAuthorized: !!grant && r.scopes.every((s) => grant.scopes.includes(s)),
  };
}

function redirectTo(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** The signed-in person's answer: a single-use code for the app, or access_denied. Either way, where to go next. */
export async function authorize(svc: OAuthService, userId: string, body: z.infer<typeof AuthorizeBody>): Promise<{ redirect: string }> {
  const r = await checkRequest(svc, body);
  if (!body.approve) return { redirect: redirectTo(r.redirectUri, { error: "access_denied", state: body.state }) };
  const t = svc.clock();
  const code = newSecret(PREFIX.code);
  await svc.store.upsertGrant(r.app.id, userId, r.scopes, t);
  await svc.store.insertCode({
    hash: secretHash(code),
    appId: r.app.id,
    userId,
    redirectUri: r.redirectUri,
    scopes: r.scopes,
    challenge: r.challenge,
    createdAt: t,
    expiresAt: t + CODE_TTL_MS,
    usedAt: null,
    familyId: null,
  });
  svc.ctx.audit({ actorId: userId, action: "oauth.authorize", target: r.app.id, detail: r.scopes.join(" ") });
  return { redirect: redirectTo(r.redirectUri, { code, state: body.state }) };
}

/** The client of a token request: its secret checked when sent. Returns the app and whether it proved its secret. */
async function client(svc: OAuthService, c: ClientCredentials): Promise<{ app: OAuthApp; confidential: boolean }> {
  if (!c.id) throw invalidClient("client_id is required");
  const app = await svc.store.app(c.id);
  if (!app) throw invalidClient();
  if (c.secret === undefined) return { app, confidential: false };
  if (!matchesHash(c.secret, app.secretHash)) throw invalidClient();
  return { app, confidential: true };
}

async function issue(svc: OAuthService, f: Omit<TokenFamily, "accessHash" | "accessExpiresAt" | "refreshHash" | "previousRefreshHash" | "refreshExpiresAt" | "rotatedAt">): Promise<Token> {
  const t = svc.clock();
  const access = newSecret(PREFIX.access);
  const refresh = `${PREFIX.refresh}_${f.id}.${newSecret("x").slice(2)}`;
  await svc.store.insertFamily({
    ...f,
    accessHash: secretHash(access),
    accessExpiresAt: t + ACCESS_TTL_MS,
    refreshHash: secretHash(refresh),
    previousRefreshHash: null,
    refreshExpiresAt: t + REFRESH_TTL_MS,
    rotatedAt: t,
  });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: f.scopes.join(" ") };
}

/** grant_type=authorization_code (RFC 6749 §4.1.3, RFC 7636 §4.5). */
async function exchangeCode(svc: OAuthService, body: z.infer<typeof TokenBody>, creds: ClientCredentials): Promise<Token> {
  const { app, confidential } = await client(svc, creds);
  if (!body.code) throw invalidRequest("code is required");
  const t = svc.clock();
  const code = await svc.store.takeCode(secretHash(body.code), t);
  if (!code || code.appId !== app.id) throw invalidGrant("The code is unknown or was issued to another app");
  if (code.usedAt !== null) {
    // RFC 6749 §4.1.2: a code used twice revokes what it was exchanged for.
    if (code.familyId) await svc.store.deleteFamily(code.familyId);
    throw invalidGrant("The code was used already");
  }
  if (code.expiresAt <= t) throw invalidGrant("The code expired (codes last 10 minutes)");
  if (body.redirect_uri !== code.redirectUri) throw invalidGrant("redirect_uri doesn't match the authorization request");
  if (code.challenge) {
    if (!body.code_verifier || !verifierMatches(body.code_verifier, code.challenge)) throw invalidGrant("The code_verifier doesn't match the code_challenge");
  } else if (!confidential) {
    throw invalidGrant("This code was issued without PKCE, so it needs the client secret");
  }
  if (!(await svc.store.grant(app.id, code.userId))) throw invalidGrant("The person removed this app's access");
  const familyId = newId("tf");
  const token = await issue(svc, { id: familyId, appId: app.id, userId: code.userId, scopes: code.scopes, confidential, createdAt: t });
  await svc.store.setCodeFamily(code.hash, familyId);
  return token;
}

/** grant_type=refresh_token (RFC 6749 §6): rotates, and a replaced refresh token presented again revokes the family. */
async function refresh(svc: OAuthService, body: z.infer<typeof TokenBody>, creds: ClientCredentials): Promise<Token> {
  const { app, confidential } = await client(svc, creds);
  const presented = body.refresh_token;
  if (!presented) throw invalidRequest("refresh_token is required");
  const family = await svc.store.family(familyOfRefresh(presented) ?? "");
  if (!family || family.appId !== app.id) throw invalidGrant("The refresh token is unknown or was issued to another app");
  if (family.confidential && !confidential) throw invalidClient("This app signs in with its client secret: send it");
  const hash = secretHash(presented);
  if (family.previousRefreshHash === hash) {
    await svc.store.deleteFamily(family.id);
    throw invalidGrant("This refresh token was replaced already; the app's sign-in was ended for safety");
  }
  const t = svc.clock();
  if (family.refreshHash !== hash || family.refreshExpiresAt <= t) throw invalidGrant("The refresh token is invalid or expired");
  const scopes = body.scope === undefined ? family.scopes : parseScopes(body.scope);
  if (!scopes || !scopes.every((s) => family.scopes.includes(s))) throw new OAuthError(400, "invalid_scope", "A refresh can only keep or narrow the scopes");
  if (!(await svc.store.grant(app.id, family.userId))) throw invalidGrant("The person removed this app's access");
  const access = newSecret(PREFIX.access);
  const next = `${PREFIX.refresh}_${family.id}.${newSecret("x").slice(2)}`;
  const rotated = await svc.store.rotateFamily(family.id, hash, {
    accessHash: secretHash(access),
    accessExpiresAt: t + ACCESS_TTL_MS,
    refreshHash: secretHash(next),
    refreshExpiresAt: t + REFRESH_TTL_MS,
    scopes,
    at: t,
  });
  if (!rotated) throw invalidGrant("The refresh token was used already");
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: next, scope: scopes.join(" ") };
}

/** POST /v2/oauth/token. Throws OAuthError, which the route answers in RFC 6749 §5.2's shape. */
export async function token(svc: OAuthService, body: z.infer<typeof TokenBody>, creds: ClientCredentials): Promise<Token> {
  await svc.purgeNowAndThen();
  const run = async () => {
    if (body.grant_type === "authorization_code") return exchangeCode(svc, body, creds);
    if (body.grant_type === "refresh_token") return refresh(svc, body, creds);
    throw new OAuthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  };
  if (!svc.store.transaction) return run();
  const outcome = await svc.store.transaction(async () => {
    try { return {ok: true as const, token: await run()}; }
    catch (error) {
      // Replay rejection must COMMIT its revocation. Unexpected persistence errors roll the whole exchange back.
      if (error instanceof OAuthError) return {ok: false as const, error};
      throw error;
    }
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.token;
}

/** Who an access token speaks for, and what it may see; null for a token that's unknown, expired or revoked. */
export async function tokenHolder(svc: OAuthService, accessToken: string | undefined): Promise<{ family: TokenFamily; identity: AppIdentity } | null> {
  if (!accessToken?.startsWith(`${PREFIX.access}_`)) return null;
  const family = await svc.store.familyByAccess(secretHash(accessToken));
  if (!family || family.accessExpiresAt <= svc.clock()) return null;
  const identity = await appIdentity(svc.ctx, family.userId);
  return identity ? { family, identity } : null;
}
