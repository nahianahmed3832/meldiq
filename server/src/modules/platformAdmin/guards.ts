import type { FastifyReply, FastifyRequest } from "fastify";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError, forbidden, unauthorized } from "../../shared/errors.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminAuthService, AdminPrincipal } from "./auth.js";
import { type AdminConsoleConfig, networkAllowed } from "./config.js";
import { readCookie, SESSION_COOKIE } from "./cookies.js";
import type { RequestMeta } from "./credentials.js";
import { can, type Permission, SENSITIVE } from "./permissions.js";

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminPrincipal;
  }
}

/** The header the console's own requests carry: a page on another site can't add it without a CORS preflight, which
 * admin routes never answer. */
export const ADMIN_HEADER = "x-meldiq-admin";

export const metaOf = (req: FastifyRequest): RequestMeta => ({ ip: req.ip, requestId: String(req.id) });

/**
 * Checks every admin request before anything else runs (§3.5): the console's host (the raw Host header, which nginx
 * sets; X-Forwarded-Host is ignored), the network allowlist when one is set, no app bearer token, the console header,
 * and for every change the console's exact Origin. Answers are never cached.
 */
export function gate(cfg: AdminConsoleConfig) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    // The apps' CORS answer (WEB_ORIGINS, set by an earlier hook) never applies here: the console is same-origin.
    reply.removeHeader("access-control-allow-origin");
    if (req.headers.host !== cfg.host) throw new ApiError(404, "not_found", "Not found");
    if (!networkAllowed(cfg, req.ip)) {
      req.log.warn({ network: networkKey(req.ip) }, "admin console request from a network that isn't allowed");
      throw forbidden("The console isn't available from this network.");
    }
    if (req.headers.authorization) throw unauthorized("The console doesn't accept app tokens. Sign in to the console.");
    if (req.headers[ADMIN_HEADER] !== "1") throw forbidden("Requests must come from the console.");
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin !== cfg.origin) throw forbidden("Requests must come from the console.");
  };
}

/** A signed-in console session is required; sets req.admin. */
export function requireSession(auth: AdminAuthService) {
  return async (req: FastifyRequest) => {
    const principal = await auth.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!principal) throw new ApiError(401, "session_expired", "Your console session has ended. Sign in again.");
    req.admin = principal;
  };
}

export function principal(req: FastifyRequest): AdminPrincipal {
  if (!req.admin) throw new ApiError(401, "session_expired", "Your console session has ended. Sign in again.");
  return req.admin;
}

/**
 * [permission] for the signed-in admin's current role (re-read on every request), audited when refused. Sensitive
 * permissions also need a passkey check within ADMIN_REAUTH_MINUTES.
 */
export function requirePermission(auth: AdminAuthService, audit: PlatformAudit, permission: Permission) {
  const session = requireSession(auth);
  return async (req: FastifyRequest) => {
    await session(req);
    const p = principal(req);
    if (!can(p.grant.role, permission)) {
      await audit.record({
        action: "admin.permission",
        outcome: "denied",
        actorAccountId: p.account.id,
        actorRole: p.grant.role,
        requestId: String(req.id),
        network: networkKey(req.ip),
        detail: { permission, route: req.routeOptions?.url ?? null },
      });
      throw forbidden("Your console role doesn't allow that.");
    }
    if (SENSITIVE.has(permission) && !auth.recentlyVerified(p)) {
      throw new ApiError(403, "reauth_required", "Confirm with your passkey again to do that.");
    }
  };
}
