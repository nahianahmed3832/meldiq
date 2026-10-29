import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../app/context.js";
import { AppBody, AppParams, AppPatch, AuthorizeBody, AuthorizeQuery, ClientParams, TokenBody } from "../../shared/contracts/http/oauthApps.js";
import { ApiError, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { photoBytes } from "../accounts/index.js";
import { me, requireAuth } from "../auth/index.js";
import { authorize, authorizeInfo, type ClientCredentials, token, tokenHolder } from "./flow.js";
import { invalidClient, invalidRequest, OAuthError } from "./rules.js";
import type { OAuthService } from "./service.js";

const minute = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });

/** Client credentials from HTTP Basic (RFC 6749 §2.3.1: each part form-urlencoded) or the body, never both. */
function credentials(req: FastifyRequest, body: { client_id?: string; client_secret?: string }): ClientCredentials {
  const h = req.headers.authorization;
  if (!h?.startsWith("Basic ")) return { id: body.client_id, secret: body.client_secret };
  if (body.client_secret !== undefined) throw invalidRequest("Send the client secret one way: HTTP Basic or the body");
  const decoded = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) throw invalidClient("Malformed HTTP Basic credentials");
  const id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
  if (body.client_id !== undefined && body.client_id !== id) throw invalidRequest("client_id differs from the HTTP Basic one");
  return { id, secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " ")) };
}

function oauthFailure(reply: FastifyReply, req: FastifyRequest, e: OAuthError) {
  if (e.status === 401 && req.headers.authorization?.startsWith("Basic ")) reply.header("www-authenticate", 'Basic realm="meldiq"');
  return reply.code(e.status).send({ error: e.error, error_description: e.message });
}

/** The access token of a request to /v2/oauth/userinfo…: the only routes that accept one. */
async function holder(svc: OAuthService, req: FastifyRequest, reply: FastifyReply) {
  const h = req.headers.authorization;
  const found = await tokenHolder(svc, h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined);
  if (!found) {
    reply.header("www-authenticate", 'Bearer realm="meldiq", error="invalid_token"');
    throw new ApiError(401, "invalid_token", "The access token is missing, expired or was revoked");
  }
  return found;
}

/**
 * "Log in with Meldiq" (API 0.65.0, docs/SETTINGS_PARITY_API.md): the apps people make, the consent page's two calls,
 * the token endpoint, what an app may read with its token, and the apps people signed in to. OAuth access tokens work
 * here only: every other route looks sessions up in their own stores, where no OAuth token is.
 */
export default async function oauthRoutes(app: FastifyInstance, ctx: AppContext) {
  const svc = ctx.oauth;
  const auth = { preHandler: requireAuth(ctx), config: minute(60) };

  // RFC 6749 §4.1.3: the token request is a form. Only in this plugin's scope.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get("/v2/developer/apps", auth, async (req) => svc.listApps(me(req).userId));
  app.post("/v2/developer/apps", { ...auth, config: minute(20) }, async (req, reply) => {
    const created = await svc.createApp(me(req).userId, parse(AppBody, req.body));
    return reply.code(201).send(created);
  });
  app.patch("/v2/developer/apps/:id", auth, async (req) => svc.updateApp(me(req).userId, parse(AppParams, req.params).id, parse(AppPatch, req.body)));
  app.delete("/v2/developer/apps/:id", auth, async (req) => svc.deleteApp(me(req).userId, parse(AppParams, req.params).id));
  app.post("/v2/developer/apps/:id/secret", { ...auth, config: minute(20) }, async (req) => svc.rotateSecret(me(req).userId, parse(AppParams, req.params).id));

  app.get("/v2/oauth/authorize/info", auth, async (req) => authorizeInfo(svc, me(req).userId, parse(AuthorizeQuery, req.query)));
  app.post("/v2/oauth/authorize", { ...auth, config: minute(30) }, async (req) => authorize(svc, me(req).userId, parse(AuthorizeBody, req.body)));

  app.post("/v2/oauth/token", { config: minute(60) }, async (req, reply) => {
    reply.header("cache-control", "no-store").header("pragma", "no-cache");
    try {
      const r = TokenBody.safeParse(req.body ?? {});
      if (!r.success) throw invalidRequest(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return await token(svc, r.data, credentials(req, r.data));
    } catch (e) {
      if (e instanceof OAuthError) return oauthFailure(reply, req, e);
      throw e;
    }
  });

  app.get("/v2/oauth/userinfo", { config: minute(120) }, async (req, reply) => {
    const { family, identity } = await holder(svc, req, reply);
    return {
      id: identity.id,
      username: identity.username,
      displayName: identity.displayName,
      avatarUrl: identity.photoRev ? `${req.protocol}://${req.host}/v2/oauth/userinfo/avatar?rev=${identity.photoRev}` : null,
      ...(family.scopes.includes("email") && identity.email ? { email: identity.email, emailVerified: true as const } : {}),
    };
  });

  app.get("/v2/oauth/userinfo/avatar", { config: minute(120) }, async (req, reply) => {
    const { identity } = await holder(svc, req, reply);
    const stream = identity.photoRev ? await photoBytes(ctx, identity.id, identity.photoRev) : null;
    if (!stream) throw notFound("No profile picture everyone may see");
    return reply.header("content-type", "image/jpeg").header("cache-control", "private, max-age=3600").send(stream);
  });

  app.get("/v2/oauth/grants", auth, async (req) => svc.grants(me(req).userId));
  app.delete("/v2/oauth/grants/:clientId", auth, async (req) => svc.revoke(me(req).userId, parse(ClientParams, req.params).clientId));
}
