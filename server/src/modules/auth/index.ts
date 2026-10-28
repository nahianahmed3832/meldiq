import type { FastifyRequest } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ApiError, unauthorized } from "../../shared/errors.js";
import { now, sha256Hex } from "../../shared/utilities/util.js";

export { revokeUserDevice } from "./routes.js";

/**
 * The auth module's public API: who a request or a WebSocket is. A bearer token is either a v1 session token (device
 * key sign-in, routes.ts) or an accounts v2 access token bound to a device (modules/accounts).
 */
export interface AuthInfo {
  userId: string;
  deviceId: string;
  /** Set when the token is an Orbit 2.0 access token: the account session it belongs to. */
  sessionId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthInfo;
  }
}

/**
 * Resolve a bearer token → (user, device): a v1 session token, or an Orbit 2.0 access token whose session is bound to a
 * device. Rejects revoked devices, disabled users and ended sessions.
 */
export async function authenticateToken(ctx: AppContext, token: string | undefined): Promise<AuthInfo | null> {
  return authenticateV1Token(ctx, token) ?? (await ctx.accounts?.deviceAuth(token)) ?? null;
}

/** The authentication of a request, worked out once (the rate limiter and the route's preHandler both need it). */
const requestAuth = new WeakMap<FastifyRequest, Promise<AuthInfo | null>>();
export function authenticateRequest(ctx: AppContext, req: FastifyRequest): Promise<AuthInfo | null> {
  let p = requestAuth.get(req);
  if (!p) {
    p = authenticateToken(ctx, bearer(req)).catch((e) => {
      // The account store (MongoDB) can't be reached: say so, rather than a generic error or a sign-out.
      ctx.log.error({ err: e }, "authentication store unavailable");
      throw new ApiError(503, "unavailable", "The server can't check your session right now. Try again in a moment.");
    });
    requestAuth.set(req, p);
  }
  return p;
}

/**
 * For a connection that stays open (the WebSocket): whether what it authenticated with still holds. A v2 session is
 * checked by its id, so the access token being renewed every few minutes doesn't close the socket, while a revoked
 * session, device or account still does at once.
 */
export async function stillAuthenticated(ctx: AppContext, token: string | undefined, auth: AuthInfo): Promise<boolean> {
  if (auth.sessionId) return ctx.accounts.sessionStillValid(auth.sessionId, auth.deviceId);
  return authenticateV1Token(ctx, token) !== null;
}

function authenticateV1Token(ctx: AppContext, token: string | undefined): AuthInfo | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const s = ctx.ephemeral.get<{ user_id: string; device_id: string; expires_at: number }>("sessions", { token_hash: sha256Hex(token) });
  if (!s || s.expires_at <= now()) return null;
  const device = ctx.identity.get<{ revoked_at: number | null }>("devices", { id: s.device_id });
  const user = ctx.identity.get<{ disabled_at: number | null }>("users", { id: s.user_id });
  if (!device || !user || device.revoked_at || user.disabled_at) return null;
  return { userId: s.user_id, deviceId: s.device_id };
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return undefined;
  return h.slice(7).trim();
}

export function requireAuth(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const auth = await authenticateRequest(ctx, req);
    if (!auth) throw unauthorized();
    req.auth = auth;
  };
}

export function me(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw new ApiError(401, "unauthorized", "Authentication required");
  return req.auth;
}

/** Ends every v1 (device-signature) session of [userId]; the Platform Admin Console's session revocation and suspension. */
export function endLegacySessions(ctx: AppContext, userId: string): Promise<number> {
  return ctx.ephemeral.write((w) => w.delete("sessions", { user_id: userId }));
}

/** How many v1 (device-signature) sessions [userId] has (the console's session view). */
export function legacySessionCount(ctx: AppContext, userId: string): number {
  return ctx.ephemeral.count("sessions", { user_id: userId, expires_at: { gt: now() } });
}
