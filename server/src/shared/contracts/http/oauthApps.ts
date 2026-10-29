import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * "Log in with Meldiq" (API 0.65.0, settings parity batch B, docs/SETTINGS_PARITY_API.md): apps people make in
 * Developer settings, and the OAuth 2.0 authorization code flow (RFC 6749) with PKCE (RFC 7636, S256 only) that lets
 * someone sign in to such an app with their Meldiq account. The OAuth parameters keep their standard snake_case names.
 */

/** Apps one person may make. */
export const APP_LIMIT = 10;
export const REDIRECT_URI_LIMIT = 10;
export const OAUTH_SCOPES = ["identify", "email"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https anywhere, or http on this computer (localhost, 127.0.0.1, [::1]) while developing; no fragment, no user info. */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || raw.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

const zRedirectUri = z.string().trim().min(1).max(500).refine(isAllowedRedirectUri, "https, or http://localhost while developing; no #fragment");
const zAppName = z.string().trim().min(1).max(80);
const zRedirectUris = z
  .array(zRedirectUri)
  .min(1)
  .max(REDIRECT_URI_LIMIT)
  .refine((l) => new Set(l).size === l.length, "Each redirect URI once");

export const AppBody = z.strictObject({ name: zAppName, redirectUris: zRedirectUris });
export const AppPatch = z
  .strictObject({ name: zAppName.optional(), redirectUris: zRedirectUris.optional() })
  .refine((b) => b.name !== undefined || b.redirectUris !== undefined, "Send a name or redirect URIs");
export const AppParams = z.strictObject({ id: z.string().min(1).max(64) });
export const ClientParams = z.strictObject({ clientId: z.string().min(1).max(64) });

/** An app as its owner sees it. Its id is the OAuth client_id. The secret is never shown again after it's made. */
export const DeveloperApp = z.strictObject({
  id: z.string(),
  name: z.string(),
  redirectUris: z.array(z.string()),
  createdAt: zTime,
  updatedAt: zTime,
  secretRotatedAt: zTime,
});
export const AppList = z.strictObject({ apps: z.array(DeveloperApp), limit: zCount });
export const AppWithSecret = z.strictObject({
  app: DeveloperApp,
  /** Shown this once: Meldiq keeps only its hash. */
  clientSecret: z.string(),
});
export const AppResult = z.strictObject({ app: DeveloperApp });
export const Deleted = z.strictObject({ deleted: z.literal(true) });

const zScopeList = z.string().trim().max(200);
/** RFC 7636: 43 to 128 characters of [A-Za-z0-9-._~]; S256 challenges are 43 base64url characters. */
const zChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "An S256 code_challenge is 43 base64url characters");

/** The authorization request, as the app sent it to the consent page. */
export const AuthorizeQuery = z.object({
  response_type: z.literal("code").optional(),
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().min(1).max(500),
  /** Space-separated; empty means "identify". */
  scope: zScopeList.optional(),
  state: z.string().max(500).optional(),
  code_challenge: zChallenge.optional(),
  /** Only S256 ("plain" is refused). Required with a code_challenge. */
  code_challenge_method: z.string().max(10).optional(),
});
export const AuthorizeBody = AuthorizeQuery.extend({ approve: z.boolean() });

export const AppSummary = z.strictObject({ id: z.string(), name: z.string(), ownerUsername: z.string().nullable() });
export const ScopeView = z.strictObject({ id: z.enum(OAUTH_SCOPES), description: z.string() });

/** What the consent screen shows. */
export const AuthorizeInfo = z.strictObject({
  app: AppSummary,
  scopes: z.array(ScopeView),
  redirectUri: z.string(),
  /** You approved this app for these scopes already (apps may still show the screen). */
  alreadyAuthorized: z.boolean(),
});
/** Where the browser goes next: the app's redirect_uri with ?code=…&state=… (or ?error=access_denied&state=…). */
export const AuthorizeResult = z.strictObject({ redirect: z.string() });

/** POST /v2/oauth/token, as a form (application/x-www-form-urlencoded) or JSON. Client credentials may also come as HTTP Basic. */
export const TokenBody = z.object({
  grant_type: z.string().max(40),
  code: z.string().max(200).optional(),
  redirect_uri: z.string().max(500).optional(),
  code_verifier: z.string().max(200).optional(),
  client_id: z.string().max(64).optional(),
  client_secret: z.string().max(200).optional(),
  refresh_token: z.string().max(300).optional(),
  scope: zScopeList.optional(),
});
export const TokenResponse = z.strictObject({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  /** Seconds (one hour). */
  expires_in: z.number().int().positive(),
  /** Rotating: each refresh answers a new one and the old one stops working. */
  refresh_token: z.string(),
  scope: z.string(),
});
export const OAUTH_ERRORS = ["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope"] as const;
export type OAuthErrorCode = (typeof OAUTH_ERRORS)[number];
/** RFC 6749 §5.2: the token endpoint's error body. */
export const OAuthErrorBody = z.strictObject({ error: z.enum(OAUTH_ERRORS), error_description: z.string().optional() });

export const UserInfo = z.strictObject({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  /** GET it with the same access token; null without a profile picture everyone may see. */
  avatarUrl: z.string().nullable(),
  /** With the email scope, and only once the address is verified. */
  email: z.string().optional(),
  emailVerified: z.literal(true).optional(),
});

export const GrantView = z.strictObject({
  app: AppSummary,
  scopes: z.array(z.enum(OAUTH_SCOPES)),
  createdAt: zTime,
  updatedAt: zTime,
});
export const GrantList = z.strictObject({ grants: z.array(GrantView) });
export const GrantRevoked = z.strictObject({ revoked: z.boolean() });

const dev = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "developer", auth: true, ...c });
const oauth = (c: Omit<Parameters<typeof route>[0], "tag">) => route({ tag: "oauth", ...c });

export const oauthAppRoutes = [
  dev({ method: "GET", url: "/v2/developer/apps", summary: "Your \"Log in with Meldiq\" apps (up to 10).", response: AppList }),
  dev({
    method: "POST",
    url: "/v2/developer/apps",
    summary: "Make an app: its id is the client_id, and its client secret is shown this once.",
    body: AppBody,
    response: AppWithSecret,
    status: 201,
    errors: ["limit_reached"],
  }),
  dev({ method: "PATCH", url: "/v2/developer/apps/:id", summary: "Rename an app or change its redirect URIs.", params: AppParams, body: AppPatch, response: AppResult, errors: ["not_found"] }),
  dev({
    method: "DELETE",
    url: "/v2/developer/apps/:id",
    summary: "Delete an app: everyone's sign-ins to it end.",
    params: AppParams,
    response: Deleted,
    errors: ["not_found"],
  }),
  dev({
    method: "POST",
    url: "/v2/developer/apps/:id/secret",
    summary: "Replace the client secret (the old one stops working at once); the new one is shown this once.",
    params: AppParams,
    response: AppWithSecret,
    errors: ["not_found"],
  }),
  oauth({
    method: "GET",
    url: "/v2/oauth/authorize/info",
    summary: "Check an authorization request and say what the consent screen shows: the app, its owner and the scopes in plain words.",
    auth: true,
    query: AuthorizeQuery,
    response: AuthorizeInfo,
    errors: ["oauth_invalid_client", "oauth_invalid_redirect", "oauth_invalid_scope", "oauth_invalid_request"],
  }),
  oauth({
    method: "POST",
    url: "/v2/oauth/authorize",
    summary: "Approve or deny an app: answers the redirect with a single-use code (10 minutes) or error=access_denied.",
    auth: true,
    body: AuthorizeBody,
    response: AuthorizeResult,
    errors: ["oauth_invalid_client", "oauth_invalid_redirect", "oauth_invalid_scope", "oauth_invalid_request"],
  }),
  oauth({
    method: "POST",
    url: "/v2/oauth/token",
    summary: "Exchange a code (authorization_code, with the PKCE verifier) or a refresh token (refresh_token) for tokens.",
    auth: false,
    body: TokenBody,
    response: TokenResponse,
    errorFormat: "oauth",
  }),
  oauth({
    method: "GET",
    url: "/v2/oauth/userinfo",
    summary: "Who signed in, with the app's access token: id, username, display name, avatar URL (and verified email with the email scope).",
    auth: true,
    scheme: "oauth",
    response: UserInfo,
    errors: ["invalid_token"],
  }),
  oauth({
    method: "GET",
    url: "/v2/oauth/userinfo/avatar",
    summary: "The signed-in person's profile picture (JPEG), with the app's access token.",
    auth: true,
    scheme: "oauth",
    response: z.unknown(),
    binary: "response",
    errors: ["invalid_token", "not_found"],
  }),
  oauth({ method: "GET", url: "/v2/oauth/grants", summary: "Apps you signed in to with Meldiq, and what each may see.", auth: true, response: GrantList }),
  oauth({
    method: "DELETE",
    url: "/v2/oauth/grants/:clientId",
    summary: "Remove an app's access: its tokens stop working at once.",
    auth: true,
    params: ClientParams,
    response: GrantRevoked,
  }),
];
