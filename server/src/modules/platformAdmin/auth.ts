import crypto from "node:crypto";
import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError } from "../../shared/errors.js";
import { newId, normalizeCode, now, sha256Hex } from "../../shared/utilities/util.js";
import type { AccountRow } from "../accounts/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminConsoleConfig } from "./config.js";
import { AdminCredentials, type Reply, type RequestMeta } from "./credentials.js";
import type { PlatformRole } from "./permissions.js";
import type { AdminGrantRow, AdminSessionRow, ChallengePurpose, ChallengeRow, PlatformAdminStore } from "./store.js";
import { authenticationOptions, CEREMONY_MS, registrationOptions, verifyAuthentication, verifyRegistration } from "./webauthn.js";

/** A signed-in console request: its session, the grant as it is now, and the account. */
export interface AdminPrincipal {
  session: AdminSessionRow;
  grant: AdminGrantRow & { role: PlatformRole };
  account: AccountRow;
}

export interface IssuedAdminSession {
  token: string;
  session: AdminSessionRow;
}

const TOKEN_BYTES = 32;
const CEREMONY_ID_BYTES = 24;
/** Wrong enrolment codes before the code is void and a new one must be issued. */
const MAX_ENROLMENT_ATTEMPTS = 5;
/** Console passkeys one admin may hold (a phone, a laptop, a security key or two). */
const MAX_PASSKEYS = 5;

const ceremonyFailed = () => new ApiError(401, "passkey_failed", "That passkey couldn't be verified. Start again.");
const challengeExpired = () => new ApiError(401, "challenge_expired", "That took too long. Start again.");

/**
 * Console sign-in (meldiq_central_admin/docs/ARCHITECTURE_PROPOSAL.md §3.3): the account password, then a console
 * passkey; first-time enrolment with a one-time code; step-up re-authentication; and the session check every request
 * makes, which re-reads the grant and the account so a revocation, a disabled account or a new password ends it.
 */
export class AdminAuthService {
  readonly credentials: AdminCredentials;

  constructor(
    private readonly ctx: AppContext,
    private readonly cfg: AdminConsoleConfig,
    readonly store: PlatformAdminStore,
    private readonly audit: PlatformAudit,
  ) {
    this.credentials = new AdminCredentials(ctx, store, audit);
  }

  private async ceremony(purpose: ChallengePurpose, accountId: string, challenge: string, sessionId: string | null = null): Promise<string> {
    const t = now();
    const id = crypto.randomBytes(CEREMONY_ID_BYTES).toString("base64url");
    await this.store.putChallenge({ id, purpose, account_id: accountId, session_id: sessionId, challenge, created_at: t, expires_at: t + CEREMONY_MS });
    return id;
  }

  private async take(id: string | undefined, purpose: ChallengePurpose, sessionId: string | null = null): Promise<ChallengeRow> {
    const row = id ? await this.store.takeChallenge(id) : undefined;
    if (!row || row.purpose !== purpose || row.session_id !== sessionId || row.expires_at <= now()) throw challengeExpired();
    return row;
  }

  // ───────────── Sign-in ─────────────

  /** Step one: the password. Answers the passkey request and the ceremony id for the pending cookie. */
  async passwordStep(email: string, password: string, meta: RequestMeta, reply: Reply): Promise<{ ceremonyId: string; options: Record<string, unknown> }> {
    const { account } = await this.credentials.check(email, password, meta, reply, "password");
    const passkeys = this.store.passkeys(account.id);
    if (passkeys.length === 0) {
      await this.audit.record({ action: "admin.login", outcome: "denied", actorAccountId: account.id, network: networkKey(meta.ip), requestId: meta.requestId, detail: { why: "no_passkey" } });
      throw new ApiError(403, "enrolment_required", "Register a console passkey with your enrolment code first.");
    }
    const { challenge, options } = await authenticationOptions(this.cfg, passkeys);
    return { ceremonyId: await this.ceremony("login", account.id, challenge), options };
  }

  /** Step two: the passkey answer for the pending ceremony → a session. */
  async passkeyStep(ceremonyId: string | undefined, response: { id: string }, meta: RequestMeta): Promise<IssuedAdminSession> {
    const ceremony = await this.take(ceremonyId, "login");
    const network = networkKey(meta.ip);
    const passkey = this.store.passkey(response.id);
    const verified = passkey && passkey.account_id === ceremony.account_id ? await verifyAuthentication(this.cfg, response, ceremony.challenge, passkey) : null;
    if (!passkey || !verified) {
      await this.audit.record({ action: "admin.login", outcome: "failed", actorAccountId: ceremony.account_id, network, requestId: meta.requestId, detail: { step: "passkey" } });
      throw ceremonyFailed();
    }
    await this.store.usedPasskey(passkey.id, verified.newCounter, verified.backedUp, now());
    const { account, grant } = await this.stillEligible(ceremony.account_id, meta, "passkey");
    const issued = await this.issue(account.id, network);
    await this.audit.record({ action: "admin.login", outcome: "success", actorAccountId: account.id, actorRole: grant.role, network, requestId: meta.requestId, targetType: "admin_session", targetId: issued.session.id });
    return issued;
  }

  /** Between the steps the grant or the account may have changed: check both again. */
  private async stillEligible(accountId: string, meta: RequestMeta, step: string): Promise<{ account: AccountRow; grant: AdminGrantRow }> {
    const account = await this.ctx.accounts.store.accountById(accountId);
    const grant = this.store.activeGrant(accountId);
    const problem = !account ? "account_gone" : (this.credentials.standing(account) ?? (grant ? null : "no_grant"));
    if (problem || !account || !grant) {
      await this.audit.record({ action: "admin.login", outcome: "denied", actorAccountId: accountId, network: networkKey(meta.ip), requestId: meta.requestId, detail: { step, why: problem } });
      throw ceremonyFailed();
    }
    return { account, grant };
  }

  private async issue(accountId: string, network: string): Promise<IssuedAdminSession> {
    const t = now();
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const session: AdminSessionRow = {
      id: newId("as"),
      token_hash: sha256Hex(token),
      account_id: accountId,
      created_at: t,
      last_used_at: t,
      idle_expires_at: t + this.cfg.idleMs,
      expires_at: t + this.cfg.maxMs,
      reauth_at: t,
      network,
      revoked_at: null,
      revoke_reason: null,
    };
    await this.store.insertSession(session);
    return { token, session };
  }

  // ───────────── Enrolment (first console passkey) ─────────────

  /** Password and the one-time enrolment code → passkey creation options. */
  async enrolStart(email: string, password: string, code: string, meta: RequestMeta, reply: Reply): Promise<{ ceremonyId: string; options: Record<string, unknown> }> {
    const { account } = await this.credentials.check(email, password, meta, reply, "enrol");
    const network = networkKey(meta.ip);
    const enrolment = this.store.enrolment(account.id);
    const valid = enrolment && enrolment.expires_at > now() && enrolment.attempts < MAX_ENROLMENT_ATTEMPTS;
    const given = Buffer.from(sha256Hex(`admin-enrol:${normalizeCode(code)}`));
    if (!valid || !crypto.timingSafeEqual(given, Buffer.from(enrolment.code_hash))) {
      if (enrolment) await this.store.countEnrolmentAttempt(account.id);
      await this.audit.record({ action: "admin.enrol", outcome: "failed", actorAccountId: account.id, network, requestId: meta.requestId, detail: { why: valid ? "wrong_code" : "no_valid_code" } });
      throw new ApiError(400, "invalid_code", "That enrolment code isn't right, or it has expired. Ask for a new one.");
    }
    const existing = this.store.passkeys(account.id);
    if (existing.length >= MAX_PASSKEYS) throw new ApiError(409, "passkey_limit", "This console account already has as many passkeys as it can.");
    const { challenge, options } = await registrationOptions(this.cfg, account, existing);
    return { ceremonyId: await this.ceremony("register", account.id, challenge), options };
  }

  /** The new passkey for the pending enrolment → stored, the code used up, and a session. */
  async enrolFinish(ceremonyId: string | undefined, response: { id: string }, name: string | undefined, meta: RequestMeta): Promise<IssuedAdminSession> {
    const ceremony = await this.take(ceremonyId, "register");
    const network = networkKey(meta.ip);
    const created = await verifyRegistration(this.cfg, response, ceremony.challenge);
    if (!created || this.store.passkey(created.id)) {
      await this.audit.record({ action: "admin.enrol", outcome: "failed", actorAccountId: ceremony.account_id, network, requestId: meta.requestId, detail: { step: "passkey" } });
      throw ceremonyFailed();
    }
    const { account, grant } = await this.stillEligible(ceremony.account_id, meta, "enrol");
    const t = now();
    await this.store.platform.write((w) =>
      this.store.insertPasskey(w, {
        id: created.id,
        account_id: account.id,
        public_key: Buffer.from(created.publicKey).toString("base64url"),
        counter: created.counter,
        transports: created.transports?.length ? JSON.stringify(created.transports) : null,
        name: name?.trim() || "Console passkey",
        backed_up: created.backedUp ? 1 : 0,
        created_at: t,
        last_used_at: t,
      }),
    );
    await this.store.deleteEnrolment(account.id);
    const issued = await this.issue(account.id, network);
    await this.audit.record({ action: "admin.enrol", outcome: "success", actorAccountId: account.id, actorRole: grant.role, network, requestId: meta.requestId, targetType: "admin_passkey", targetId: created.id });
    return issued;
  }

  // ───────────── Sessions ─────────────

  /** The principal behind a session cookie, or null. A session ended by a change elsewhere is revoked and recorded. */
  async resolve(token: string | undefined): Promise<AdminPrincipal | null> {
    if (!token) return null;
    const t = now();
    const session = this.store.sessionByTokenHash(sha256Hex(token));
    if (!session || session.revoked_at !== null || session.expires_at <= t || session.idle_expires_at <= t) return null;
    const grant = this.store.activeGrant(session.account_id);
    const account = await this.ctx.accounts.store.accountById(session.account_id);
    const problem = !grant ? "grant_revoked" : !account ? "account_gone" : (this.credentials.standing(account) ?? (account.password_changed_at > session.created_at ? "password_changed" : null));
    if (problem || !grant || !account) {
      if (await this.store.revokeSession(session.id, problem ?? "ended", t)) {
        await this.audit.record({ action: "admin.session_end", outcome: "success", actorAccountId: session.account_id, targetType: "admin_session", targetId: session.id, detail: { why: problem } });
      }
      return null;
    }
    const idle = Math.min(t + this.cfg.idleMs, session.expires_at);
    await this.store.touchSession(session.id, t, idle);
    return { session: { ...session, last_used_at: t, idle_expires_at: idle }, grant: grant as AdminPrincipal["grant"], account };
  }

  async logout(p: AdminPrincipal, meta: RequestMeta): Promise<void> {
    if (await this.store.revokeSession(p.session.id, "logout", now())) {
      await this.audit.record({ action: "admin.logout", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, network: networkKey(meta.ip), requestId: meta.requestId, targetType: "admin_session", targetId: p.session.id });
    }
  }

  /** Whether [p]'s last passkey check is recent enough for a sensitive action. */
  recentlyVerified(p: AdminPrincipal): boolean {
    return now() - p.session.reauth_at <= this.cfg.reauthMs;
  }

  /** Step-up: passkey request options bound to [p]'s session. */
  async reauthOptions(p: AdminPrincipal): Promise<{ ceremonyId: string; options: Record<string, unknown> }> {
    const { challenge, options } = await authenticationOptions(this.cfg, this.store.passkeys(p.account.id));
    return { ceremonyId: await this.ceremony("reauth", p.account.id, challenge, p.session.id), options };
  }

  async reauth(p: AdminPrincipal, ceremonyId: string | undefined, response: { id: string }, meta: RequestMeta): Promise<void> {
    const ceremony = await this.take(ceremonyId, "reauth", p.session.id);
    const passkey = this.store.passkey(response.id);
    const verified = passkey && passkey.account_id === ceremony.account_id ? await verifyAuthentication(this.cfg, response, ceremony.challenge, passkey) : null;
    const base = { action: "admin.reauth", actorAccountId: p.account.id, actorRole: p.grant.role, network: networkKey(meta.ip), requestId: meta.requestId, targetType: "admin_session", targetId: p.session.id };
    if (!passkey || !verified) {
      await this.audit.record({ ...base, outcome: "failed" });
      throw ceremonyFailed();
    }
    const t = now();
    await this.store.usedPasskey(passkey.id, verified.newCounter, verified.backedUp, t);
    await this.store.reauthenticated(p.session.id, t);
    await this.audit.record({ ...base, outcome: "success" });
  }
}
