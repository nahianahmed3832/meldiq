import type { FastifyInstance, FastifyReply } from "fastify";
import { AdminEnrolFinishBody, AdminEnrolStartBody, AdminPasskeyBody, AdminPasswordBody } from "../../shared/contracts/http/platformAdmin.js";
import { parse } from "../../shared/validation/index.js";
import type { AdminAuthService, AdminPrincipal, IssuedAdminSession } from "./auth.js";
import type { AdminConsoleConfig } from "./config.js";
import { clearCookie, PENDING_COOKIE, readCookie, SESSION_COOKIE, setCookie } from "./cookies.js";
import { metaOf, principal, requireSession } from "./guards.js";
import { permissionsOf } from "./permissions.js";
import { CEREMONY_MS } from "./webauthn.js";

/** What the console shows about the signed-in admin (GET /admin/v1/me and the end of every sign-in). */
export function meView(p: AdminPrincipal, cfg: AdminConsoleConfig, passkeys: number) {
  return {
    account: { id: p.account.id, email: p.account.email, name: p.account.name },
    role: p.grant.role,
    permissions: permissionsOf(p.grant.role),
    session: {
      id: p.session.id,
      createdAt: p.session.created_at,
      expiresAt: p.session.expires_at,
      idleExpiresAt: p.session.idle_expires_at,
      reauthUntil: p.session.reauth_at + cfg.reauthMs,
    },
    passkeys,
  };
}

/** Sign-in, enrolment, step-up and sign-out (§3.3). Registered inside the console's gated scope. */
export default async function adminAuthRoutes(app: FastifyInstance, cfg: AdminConsoleConfig, auth: AdminAuthService) {
  const session = { preHandler: requireSession(auth) };
  const pending = (reply: FastifyReply, ceremonyId: string) => reply.header("set-cookie", setCookie(PENDING_COOKIE, ceremonyId, CEREMONY_MS / 1000));

  /** Sets the session cookie for [issued] and answers who signed in. */
  const signedIn = async (reply: FastifyReply, issued: IssuedAdminSession) => {
    const p = await auth.resolve(issued.token);
    if (!p) throw new Error("a session issued a moment ago doesn't resolve");
    reply.header("set-cookie", [clearCookie(PENDING_COOKIE), setCookie(SESSION_COOKIE, issued.token, cfg.maxMs / 1000)]);
    return meView(p, cfg, auth.store.passkeys(p.account.id).length);
  };

  app.post("/admin/v1/auth/password", async (req, reply) => {
    const { email, password } = parse(AdminPasswordBody, req.body);
    const { ceremonyId, options } = await auth.passwordStep(email, password, metaOf(req), reply);
    pending(reply, ceremonyId);
    return { options };
  });

  app.post("/admin/v1/auth/passkey", async (req, reply) => {
    const { response } = parse(AdminPasskeyBody, req.body);
    const issued = await auth.passkeyStep(readCookie(req.headers.cookie, PENDING_COOKIE), response, metaOf(req));
    return signedIn(reply, issued);
  });

  app.post("/admin/v1/auth/enrol/options", async (req, reply) => {
    const { email, password, code } = parse(AdminEnrolStartBody, req.body);
    const { ceremonyId, options } = await auth.enrolStart(email, password, code, metaOf(req), reply);
    pending(reply, ceremonyId);
    return { options };
  });

  app.post("/admin/v1/auth/enrol", async (req, reply) => {
    const { response, name } = parse(AdminEnrolFinishBody, req.body);
    const issued = await auth.enrolFinish(readCookie(req.headers.cookie, PENDING_COOKIE), response, name, metaOf(req));
    return signedIn(reply, issued);
  });

  app.post("/admin/v1/auth/reauth/options", session, async (req, reply) => {
    const { ceremonyId, options } = await auth.reauthOptions(principal(req));
    pending(reply, ceremonyId);
    return { options };
  });

  app.post("/admin/v1/auth/reauth", session, async (req, reply) => {
    const { response } = parse(AdminPasskeyBody, req.body);
    await auth.reauth(principal(req), readCookie(req.headers.cookie, PENDING_COOKIE), response, metaOf(req));
    reply.header("set-cookie", clearCookie(PENDING_COOKIE));
    const p = await auth.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!p) throw new Error("a session re-authenticated a moment ago doesn't resolve");
    return meView(p, cfg, auth.store.passkeys(p.account.id).length);
  });

  app.post("/admin/v1/auth/logout", session, async (req, reply) => {
    await auth.logout(principal(req), metaOf(req));
    reply.header("set-cookie", [clearCookie(SESSION_COOKIE), clearCookie(PENDING_COOKIE)]);
    return { ok: true as const };
  });

  app.get("/admin/v1/me", session, async (req) => {
    const p = principal(req);
    return meView(p, cfg, auth.store.passkeys(p.account.id).length);
  });
}
