import type { FastifyInstance, FastifyRequest } from "fastify";
import { type AppContext } from "../../app/context.js";
import { bearer } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { removePushEndpoint } from "../notifications/service.js";
import { notFound, unauthorized } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { DELETE_ACCOUNT_RATE_LIMIT, deleteOwnAccount } from "./deletion.js";
import type { Accounts } from "./index.js";
import {
  ChangePasswordBody,
  DeleteAccountBody,
  EmailBody,
  EnrollDeviceBody,
  KeyUnlockBody,
  LegacyCompleteBody,
  LegacyVerifyBody,
  LoginBody,
  PasskeyIdParams,
  PasskeyLoginBody,
  PasskeyOptionsBody,
  PasskeyRegisterBody,
  PreferencesBody,
  PutKeyBackupBody,
  RecoveryCompleteBody,
  RecoveryPasswordBody,
  RecoveryStartBody,
  RefreshBody,
  RegisterBody,
  ResetIdentityBody,
  ResetPasswordBody,
  SessionIdParams,
  UpdateAccountBody,
  VerifyEmailBody,
  EmailChangeConfirmBody,
  EmailChangeStartBody,
  TotpCodeBody,
  TotpDisableBody,
  TotpSetupBody,
} from "../../shared/contracts/http/accounts.js";
import { mailTexts } from "../../infrastructure/mail/mailer.js";
import { standingOf } from "./standing.js";
import type { ActiveSession } from "./store.js";
import { announceOwnSettingsChange, announceProfileChange } from "./profileEvents.js";

declare module "fastify" {
  interface FastifyRequest {
    accountSession?: ActiveSession;
  }
}

function session(req: FastifyRequest): ActiveSession {
  if (!req.accountSession) throw unauthorized();
  return req.accountSession;
}

/** The v2 account API (docs/ORBIT_2_ARCHITECTURE §6). */
export default async function accountRoutes(app: FastifyInstance, ctx: AppContext, accounts: Accounts) {
  const { service, identity, legacy, workspaces, store, recovery, keyBackups, passkeys, totp, emailChange } = accounts;
  // Unauthenticated routes that hash passwords or send email: tighter than the global limit, per network.
  const strict = { config: { rateLimit: { max: ctx.config.accounts.authRateLimitPerMinute, timeWindow: "1 minute" } } };
  const requireAccount = async (req: FastifyRequest) => {
    const s = await service.sessions.authenticate(bearer(req), now());
    if (!s) throw unauthorized();
    req.accountSession = s;
  };
  const authed = { preHandler: requireAccount };
  const authedStrict = { preHandler: requireAccount, ...strict };
  const accountOf = async (req: FastifyRequest) => (await store.accountById(session(req).account_id))!;

  // ───────────── Sign-up, email codes, sign-in ─────────────
  app.post("/v2/auth/register", strict, async (req, reply) => {
    const body = parse(RegisterBody, req.body);
    await service.register(body, req.ip, reply);
    return reply.code(202).send({ status: "verification_sent", email: body.email });
  });

  app.post("/v2/auth/email/verify", strict, async (req) => {
    const body = parse(VerifyEmailBody, req.body);
    await service.verifyEmail(body.email, body.code, body.password);
    return { verified: true };
  });

  app.post("/v2/auth/email/resend", strict, async (req, reply) => {
    await service.resendVerification(parse(EmailBody, req.body).email, req.ip);
    return reply.code(202).send({ status: "sent_if_pending" });
  });

  app.post("/v2/auth/login", strict, async (req, reply) => service.login(parse(LoginBody, req.body), req.ip, reply));

  // Renewal happens every few minutes from every signed-in app; phones behind one carrier NAT share an address.
  const renewal = { config: { rateLimit: { max: ctx.config.accounts.authRateLimitPerMinute * 10, timeWindow: "1 minute" } } };
  app.post("/v2/auth/refresh", renewal, async (req) => service.refresh(parse(RefreshBody, req.body).refreshToken));

  // ───────────── Passkeys (2026-10-23, passkeys.ts) ─────────────
  app.post("/v2/auth/passkey/options", strict, async (req) => passkeys.loginOptions(parse(PasskeyOptionsBody, req.body ?? {}).rpId));
  app.post("/v2/auth/passkey/login", strict, async (req, reply) => passkeys.login(parse(PasskeyLoginBody, req.body), req.ip, reply));
  app.get("/v2/account/passkeys", authed, async (req) => passkeys.list(session(req).account_id));
  app.post("/v2/account/passkeys/options", authedStrict, async (req) =>
    passkeys.registrationOptions(session(req), parse(PasskeyOptionsBody, req.body ?? {}).rpId),
  );
  app.post("/v2/account/passkeys", authedStrict, async (req, reply) => {
    const added = await passkeys.register(session(req), parse(PasskeyRegisterBody, req.body));
    reply.code(201);
    return added;
  });
  app.delete("/v2/account/passkeys/:id", authedStrict, async (req) => passkeys.remove(session(req), parse(PasskeyIdParams, req.params).id));
  // ───────────── Two-step sign-in, email change, standing (API 0.46.0, docs/ACCOUNT_SAFETY.md) ─────────────
  const tell = (a: { email: string }, on: boolean) =>
    void accounts.mailer.send({ to: a.email, ...mailTexts.totpChanged(on) }).catch((e: unknown) => ctx.log.warn({ err: e }, "account email not sent"));
  app.get("/v2/account/totp", authed, async (req) => totp.status(session(req).account_id));
  app.post("/v2/account/totp/setup", authedStrict, async (req) => totp.setup(session(req), await accountOf(req), parse(TotpSetupBody, req.body).password));
  app.post("/v2/account/totp/enable", authedStrict, async (req) => {
    const done = totp.enable(session(req), session(req).account_id, parse(TotpCodeBody, req.body).code);
    tell(await accountOf(req), true);
    return done;
  });
  app.post("/v2/account/totp/disable", authedStrict, async (req) => {
    const body = parse(TotpDisableBody, req.body);
    const a = await accountOf(req);
    const was = totp.enabled(a.id);
    await totp.disable(session(req), a, body.password, body.code);
    if (was) tell(a, false);
    return { ok: true };
  });
  app.post("/v2/account/email", authedStrict, async (req, reply) => {
    const body = parse(EmailChangeStartBody, req.body);
    const started = await emailChange.start(session(req), await accountOf(req), body.password, body.newEmail);
    return reply.code(202).send(started);
  });
  app.post("/v2/account/email/confirm", authedStrict, async (req) => {
    const changed = await emailChange.confirm(session(req), await accountOf(req), parse(EmailChangeConfirmBody, req.body).code);
    if (session(req).user_id) announceOwnSettingsChange(ctx, session(req).user_id!);
    return changed;
  });
  app.get("/v2/account/standing", authed, async (req) => {
    const userId = session(req).user_id;
    return userId ? standingOf(ctx.db, userId) : { level: "good", warnings: [] };
  });

  // Digital Asset Links: Android only offers this server's passkeys to the apps listed here.
  app.get("/.well-known/assetlinks.json", async () => passkeys.assetLinks());

  app.post("/v2/auth/logout", authed, async (req) => {
    const s = session(req);
    await service.logout(s);
    // A signed-out device isn't woken any more; signing in again, the app registers its endpoint again.
    if (s.device_id) removePushEndpoint(ctx.db, s.device_id);
    return { ok: true };
  });

  app.post("/v2/auth/password/forgot", strict, async (req, reply) => {
    await service.forgotPassword(parse(EmailBody, req.body).email, req.ip);
    return reply.code(202).send({ status: "sent_if_account" });
  });

  app.post("/v2/auth/password/reset", strict, async (req) => {
    const body = parse(ResetPasswordBody, req.body);
    await service.resetPassword(body.email, body.code, body.newPassword);
    return { ok: true };
  });

  // ───────────── Recovery after losing the account's email (docs/ACCOUNT_RECOVERY.md) ─────────────
  app.post("/v2/auth/recover/start", strict, async (req, reply) => {
    const body = parse(RecoveryStartBody, req.body);
    return recovery.start(body.email, body.code, body.newEmail, req.ip, reply);
  });

  app.post("/v2/auth/recover/complete", strict, async (req) => {
    const body = parse(RecoveryCompleteBody, req.body);
    return recovery.complete(body.ticket, body.code, body.newPassword);
  });

  app.get("/v2/account/recovery-codes", authed, async (req) => recovery.status(session(req).account_id));

  app.post("/v2/account/recovery-codes", authedStrict, async (req, reply) => {
    const { password } = parse(RecoveryPasswordBody, req.body);
    return recovery.generate(session(req), password, req.ip, reply);
  });

  app.post("/v2/account/recovery-codes/revoke", authedStrict, async (req, reply) => {
    const { password } = parse(RecoveryPasswordBody, req.body);
    await recovery.revoke(session(req), password, req.ip, reply);
    return { ok: true };
  });

  // ───────────── The signed-in account ─────────────
  app.get("/v2/account", authed, async (req) => {
    const s = session(req);
    return { account: service.view(await accountOf(req)), session: { id: s.id, deviceId: s.device_id, createdAt: s.created_at } };
  });

  app.patch("/v2/account", authed, async (req) => {
    const { name } = parse(UpdateAccountBody, req.body);
    const a = await accountOf(req);
    const t = now();
    await store.updateAccount(a.id, { name }, t);
    // The encryption identity shows the same name to contacts (the same edit again repairs a half-done one).
    if (a.user_id) {
      ctx.db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(name, t, a.user_id);
      announceProfileChange(ctx, a.user_id);
    }
    return { account: service.view((await store.accountById(a.id))!) };
  });

  // Deleting the account for good (docs/ACCOUNT_DELETION.md): the password again and the account's email typed out.
  // Refused with 409 owns_workspaces, changing nothing, while the person is a workspace's only owner.
  app.delete("/v2/account", { preHandler: requireAccount, config: { rateLimit: DELETE_ACCOUNT_RATE_LIMIT } }, async (req, reply) => {
    const body = parse(DeleteAccountBody, req.body ?? {});
    const result = await deleteOwnAccount(ctx, accounts, await accountOf(req), body, req.ip, reply);
    return { deleted: true, deletedAt: result.deletedAt };
  });

  app.post("/v2/account/password", authedStrict, async (req, reply) => {
    const body = parse(ChangePasswordBody, req.body);
    if (body.keyBackup) keyBackups.requireCurrentIdentity(await accountOf(req), body.keyBackup);
    await service.changePassword(session(req), body.currentPassword, body.newPassword, req.ip, reply);
    // The old backup no longer matches the password; the keys sealed under the new one replace it.
    if (body.keyBackup) await keyBackups.save(await accountOf(req), body.keyBackup);
    return { ok: true, keyBackup: !!body.keyBackup };
  });

  // ───────────── Keys backed up under the password (docs/KEY_BACKUP.md) ─────────────
  app.get("/v2/account/key-backup", authed, async (req) => keyBackups.status(session(req)));
  app.put("/v2/account/key-backup", authedStrict, async (req, reply) => {
    const body = parse(PutKeyBackupBody, req.body);
    return keyBackups.put(session(req), body.password, body.backup, req.ip, reply);
  });
  app.delete("/v2/account/key-backup", authed, async (req) => {
    await keyBackups.remove(session(req));
    return { ok: true };
  });
  app.post("/v2/account/key-backup/unlock/start", authedStrict, async (req) => keyBackups.startUnlock(session(req)));
  app.post("/v2/account/key-backup/unlock", authedStrict, async (req) => keyBackups.unlock(session(req), parse(KeyUnlockBody, req.body).code));

  app.get("/v2/account/sessions", authed, async (req) => {
    const s = session(req);
    return {
      sessions: (await store.activeSessions(s.account_id, now())).map((r) => ({
        id: r.id,
        label: r.label,
        deviceId: r.device_id,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        current: r.id === s.id,
      })),
    };
  });

  app.delete("/v2/account/sessions/:id", authed, async (req) => {
    const s = session(req);
    const { id } = parse(SessionIdParams, req.params);
    const target = await store.sessionById(id);
    // Someone else's session answers like one that doesn't exist.
    if (!target || target.account_id !== s.account_id || target.revoked_at) throw notFound("Session not found");
    await service.logout(target);
    ctx.audit({ actorId: target.user_id, action: "account.session_revoke", target: id, detail: id === s.id ? "self" : null });
    return { ok: true };
  });

  app.put("/v2/account/preferences", authed, async (req) => {
    const { selectedWorkspaceId } = parse(PreferencesBody, req.body);
    const a = await accountOf(req);
    const selected = await workspaces.select(a, selectedWorkspaceId);
    if (a.user_id) announceOwnSettingsChange(ctx, a.user_id);
    return { selectedWorkspaceId: selected };
  });

  // ───────────── Encryption setup on this device ─────────────
  app.post("/v2/account/devices", authedStrict, async (req) => identity.enroll(session(req), parse(EnrollDeviceBody, req.body)));

  app.post("/v2/account/identity/reset", authedStrict, async (req, reply) => identity.resetIdentity(session(req), parse(ResetIdentityBody, req.body), req.ip, reply));

  // ───────────── Workspaces ─────────────
  app.get("/v2/workspaces", authed, async (req) => workspaces.list(await accountOf(req)));

  // ───────────── Legacy migration ─────────────
  app.post("/v2/migration/legacy/verify", strict, async (req, reply) => legacy.verify(parse(LegacyVerifyBody, req.body), req.ip, reply));

  app.post("/v2/migration/legacy/complete", strict, async (req, reply) => {
    const { email } = await legacy.complete(parse(LegacyCompleteBody, req.body));
    return reply.code(202).send({ status: "verification_sent", email });
  });
}
