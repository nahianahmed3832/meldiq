import crypto from "node:crypto";
import { DAY_MS, HOUR_MS, networkKey, openRegistrationsToday, SlidingWindow } from "../../app/middleware/abuse.js";
import type { AppContext } from "../../app/context.js";
import { canonical, verifyEd25519 } from "../../shared/utilities/crypto.js";
import { consumeInviteUse, findOrgInvite, findRegistrationInvite, returnInviteUse } from "../organizations/invites.js";
import { ApiError } from "../../shared/errors.js";
import { humanCode, newId, normalizeCode, now, sha256Hex } from "../../shared/utilities/util.js";
import type { Mailer } from "../../infrastructure/mail/mailer.js";
import { mailTexts } from "../../infrastructure/mail/mailer.js";
import { burnPasswordCheck, hashPassword, needsRehash, PASSWORD_PROBLEMS, passwordProblem, verifyPassword } from "./passwords.js";
import type { LoginBody, RegisterBody } from "../../shared/contracts/http/accounts.js";
import { type IssuedSession, sessionEnded, SessionService } from "./sessions.js";
import type { AccountRow, AccountStore, ActiveSession, CodePurpose } from "./store.js";

const MINUTE_MS = 60_000;
const VERIFY_CODE_DIGITS = 6;
const RESET_CODE_LENGTH = 10;

/** Email codes one account may be sent per hour, for each purpose (verification, reset). */
const CODES_PER_HOUR = 5;
/** "Someone tried to sign up with your address" notices per account per hour. */
const NOTICES_PER_HOUR = 1;
/** Wrong passwords per account and network in 15 minutes, and per account in an hour, before sign-in waits. */
const LOGIN_FAILURES_PER_NETWORK = 5;
const LOGIN_FAILURES_PER_ACCOUNT = 50;

export const invalidCredentials = () => new ApiError(401, "invalid_credentials", "That email and password don't match an account.");
const invalidCode = () => new ApiError(400, "invalid_code", "That code isn't right, or it has expired. Ask for a new one.");
const emailUnavailable = () => new ApiError(503, "email_unavailable", "This server can't send email yet, so new accounts can't be verified. Try again later.");

export function weakPassword(password: string, email: string): ApiError | null {
  const problem = passwordProblem(password, email);
  return problem ? new ApiError(400, "weak_password", PASSWORD_PROBLEMS[problem], { reason: problem }) : null;
}

/** "n********2@gmail.com": enough for someone to recognise their own address, not enough to learn someone else's. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const shown = local.length <= 2 ? local[0] ?? "" : `${local[0]}${"*".repeat(Math.min(local.length - 2, 8))}${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}

const codeHash = (accountId: string, purpose: CodePurpose, code: string) => sha256Hex(`${accountId}:${purpose}:${code}`);

/** How an invite-only server admitted a sign-up (accounts.admitted_via). */
interface Admission {
  kind: "registration-invite" | "org-invite";
  id: string;
}

const normalizeVerifyCode = (code: string) => code.replace(/\D/g, "");

/** A session as the API returns it (docs/ORBIT_2_ARCHITECTURE §6). */
export interface SessionResponse {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  session: { id: string; deviceId: string | null; createdAt: number };
  account: AccountView;
}

export interface AccountView {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  legacyLinkedAt: number | null;
  selectedWorkspaceId: string | null;
  identity: { userId: string; username: string; identityKey: string } | null;
}

/**
 * Email-and-password accounts (docs/ORBIT_2_ARCHITECTURE §2): sign-up with an emailed code, sign-in, refresh, reset and
 * change of password. The answers to sign-up, resend and forgot never say whether an email has an account.
 */
export class AccountService {
  readonly sessions: SessionService;
  /** API 0.46.0: two-step sign-in, checked after the password (accounts/totp.ts); set by Accounts. */
  secondFactor: ((accountId: string, code: string | undefined) => void) | null = null;
  private readonly codesSent = new SlidingWindow(CODES_PER_HOUR, HOUR_MS);
  private readonly notices = new SlidingWindow(NOTICES_PER_HOUR, HOUR_MS);
  private readonly codeRequests: SlidingWindow;
  private readonly failuresByNetwork = new SlidingWindow(LOGIN_FAILURES_PER_NETWORK, 15 * MINUTE_MS);
  private readonly failuresByAccount = new SlidingWindow(LOGIN_FAILURES_PER_ACCOUNT, HOUR_MS);
  private readonly registeredFrom: { hour: SlidingWindow; day: SlidingWindow };

  constructor(
    private readonly ctx: AppContext,
    readonly store: AccountStore,
    readonly mailer: Mailer,
  ) {
    this.sessions = new SessionService(store, ctx.config.accounts);
    this.codeRequests = new SlidingWindow(ctx.config.accounts.emailsPerNetworkPerHour, HOUR_MS);
    const abuse = ctx.config.abuse;
    this.registeredFrom = {
      hour: new SlidingWindow(abuse.registrationsPerAddressPerHour, HOUR_MS),
      day: new SlidingWindow(abuse.registrationsPerAddressPerDay, DAY_MS),
    };
  }

  private get cfg() {
    return this.ctx.config.accounts;
  }

  // ───────────── Views ─────────────

  view(a: AccountRow): AccountView {
    const u = a.user_id
      ? (this.ctx.db.prepare("SELECT id, username, identity_key FROM users WHERE id = ?").get(a.user_id) as { id: string; username: string; identity_key: string } | undefined)
      : undefined;
    return {
      id: a.id,
      email: a.email,
      name: a.name,
      createdAt: a.created_at,
      legacyLinkedAt: a.legacy_linked_at,
      selectedWorkspaceId: a.selected_workspace_id,
      identity: u ? { userId: u.id, username: u.username, identityKey: u.identity_key } : null,
    };
  }

  respond(issued: IssuedSession, a: AccountRow): SessionResponse {
    const { session, ...tokens } = issued;
    return { ...tokens, session: { id: session.id, deviceId: session.device_id, createdAt: session.created_at }, account: this.view(a) };
  }

  // ───────────── Sign-up and email codes ─────────────

  /**
   * REGISTRATION_MODE=invite: a usable registration or organisation invite, checked before anything else. Its use is
   * taken when the account is made ([register]).
   */
  private requireAdmission(inviteCode: string | undefined): Admission | null {
    if (this.ctx.config.registrationMode !== "invite") return null;
    if (!inviteCode) throw new ApiError(403, "invite_required", "Signing up needs an invitation code");
    const admission = this.findAdmission(inviteCode);
    if (!admission) throw new ApiError(403, "invalid_invite", "This invitation code is invalid, expired or already used");
    return admission;
  }

  private findAdmission(code: string): Admission | null {
    const reg = findRegistrationInvite(this.ctx.db, code);
    if (reg) return { kind: "registration-invite", id: reg.id };
    const org = findOrgInvite(this.ctx.ws, this.ctx.authz, code);
    return org ? { kind: "org-invite", id: org.id } : null;
  }

  /**
   * Takes one use of the invite, inside the transaction that makes the account, after checking it again so two sign-ups
   * can't share an invite's last use. An organisation invite's use is reserved now; the person joins its organisation
   * when their encryption identity is made (identity.ts).
   */
  private consumeAdmission(code: string): string {
    const reg = findRegistrationInvite(this.ctx.db, code);
    if (!reg) throw new ApiError(403, "invalid_invite", "This invitation code is invalid, expired or already used");
    this.ctx.db.prepare("UPDATE registration_invites SET uses = uses + 1 WHERE id = ?").run(reg.id);
    return `registration-invite:${reg.id}`;
  }

  /**
   * An organisation invite's use is reserved before the account is made, in one write unit that checks the invite again,
   * so two sign-ups can't share its last use (communities' rows may not be in SQLite). Returns "org-invite:<id>".
   */
  private async reserveOrgInvite(code: string): Promise<string> {
    const id = await this.ctx.ws.write((w) => {
      const org = findOrgInvite(w, this.ctx.authz, code);
      if (!org) throw new ApiError(403, "invalid_invite", "This invitation code is invalid, expired or already used");
      consumeInviteUse(w, org.id);
      return org.id;
    });
    return `org-invite:${id}`;
  }

  /** Gives back the use [consumeAdmission] took ("<kind>:<id>") when the account couldn't be made after all. */
  private returnAdmission(admittedVia: string): void {
    const [kind, id] = [admittedVia.slice(0, admittedVia.indexOf(":")), admittedVia.slice(admittedVia.indexOf(":") + 1)];
    if (kind === "registration-invite") {
      this.ctx.db.prepare("UPDATE registration_invites SET uses = uses - 1 WHERE id = ? AND uses > 0").run(id);
      return;
    }
    // Called from the account store's own step (synchronous): the give-back is its own write unit.
    this.ctx.ws
      .write((w) => returnInviteUse(w, id))
      .catch((e) => this.ctx.log.error({ err: e }, "sign-up: an invitation's reserved use wasn't given back"));
  }

  /** Open sign-up is limited per network and per day (docs/ABUSE_CONTROLS.md › Registration), before any hashing. */
  private requireRegistrationAllowance(ip: string, reply: { header: (k: string, v: string) => unknown }): string {
    const network = networkKey(ip);
    if (this.ctx.config.registrationMode !== "open") return network;
    const wait = Math.max(this.registeredFrom.hour.retryAfterMs(network), this.registeredFrom.day.retryAfterMs(network));
    if (wait > 0) {
      reply.header("retry-after", String(Math.ceil(wait / 1000)));
      throw new ApiError(429, "registration_limited", "Too many new accounts from this network. Try again later, or ask for an invitation code.");
    }
    const perDay = this.ctx.config.abuse.openRegistrationsPerDay;
    if (perDay > 0 && openRegistrationsToday(this.ctx.ws) >= perDay) {
      throw new ApiError(429, "registration_paused", "New sign-ups are paused for now. Try again later, or ask for an invitation code.");
    }
    return network;
  }

  async register(body: RegisterBody, ip: string, reply: { header: (k: string, v: string) => unknown }): Promise<void> {
    if (!this.mailer.available) throw emailUnavailable();
    const weak = weakPassword(body.password, body.email);
    if (weak) throw weak;
    const admission = this.requireAdmission(body.inviteCode);
    const network = this.requireRegistrationAllowance(ip, reply);
    const hash = await hashPassword(body.password, this.cfg.scryptLogN);
    const t = now();
    // Every sign-up passing the checks counts for its network, new address or not, so the limit doesn't tell them apart.
    if (this.ctx.config.registrationMode === "open") {
      this.registeredFrom.hour.record(network, t);
      this.registeredFrom.day.record(network, t);
    }
    const existing = await this.store.accountByEmail(body.email);
    if (existing?.email_verified_at) {
      // Same answer as a new sign-up; the owner of the address is told instead.
      await this.sendNotice(existing, network);
      return;
    }
    if (existing) {
      // Nobody has proved this address yet: the newest sign-up wins, so an unverified sign-up can't hold it hostage. Its
      // details change only together with a new code, and the code checks the password (verifyEmail), so whoever set the
      // password is whoever can verify. A legacy link keeps its details until it is verified or redone.
      if (!this.canSendCode(existing, "verify_email", network)) return;
      if (!existing.legacy_linked_at) await this.store.updateAccount(existing.id, { name: body.name, password_hash: hash, password_changed_at: t }, t);
      await this.sendCode((await this.store.accountById(existing.id))!, "verify_email", network);
      return;
    }
    const account: AccountRow = {
      id: newId("acc"),
      email: body.email,
      name: body.name,
      password_hash: hash,
      password_changed_at: t,
      email_verified_at: null,
      user_id: null,
      legacy_linked_at: null,
      selected_workspace_id: null,
      admitted_via: null,
      created_at: t,
      updated_at: t,
      disabled_at: null,
    };
    const code = body.inviteCode;
    let taken: string | null = null;
    const reserved = admission?.kind === "org-invite" && code ? await this.reserveOrgInvite(code) : null;
    let givenBack = false;
    const giveBack = (via: string) => {
      if (givenBack) return;
      givenBack = true;
      this.returnAdmission(via);
    };
    const take = admission && code ? { take: () => (taken = reserved ?? this.consumeAdmission(code)), undo: () => taken && giveBack(taken) } : null;
    let created: Awaited<ReturnType<typeof this.store.createAccount>>;
    try {
      created = await this.store.createAccount(account, take);
    } catch (e) {
      // The org invite's use was reserved outside the account's own transaction: give it back here.
      if (reserved) giveBack(reserved);
      throw e;
    }
    // A parallel sign-up for the same address won the race (this one's invite use was given back): same answer.
    if (!created) {
      if (reserved) giveBack(reserved);
      return;
    }
    this.ctx.audit({ action: "account.register", target: created.id, detail: created.admitted_via });
    await this.sendCode(created, "verify_email", network);
  }

  private codeKey(a: AccountRow, purpose: CodePurpose) {
    return `${a.id}:${purpose}`;
  }

  /** Codes are limited per account and purpose, and per requesting network, so nobody can use up someone's reset emails. */
  private canSendCode(a: AccountRow, purpose: CodePurpose, network: string | null): boolean {
    return this.codesSent.allows(this.codeKey(a, purpose)) && (network === null || this.codeRequests.allows(network));
  }

  /**
   * A new code replaces the previous one. Past the limits nothing is sent (same answer). [network] is the requester's,
   * or null for a step that already proved something (a legacy ticket).
   */
  async sendCode(a: AccountRow, purpose: CodePurpose, network: string | null): Promise<void> {
    if (!this.mailer.available) throw emailUnavailable();
    if (!this.canSendCode(a, purpose, network)) return;
    const code = purpose === "verify_email" ? crypto.randomInt(0, 10 ** VERIFY_CODE_DIGITS).toString().padStart(VERIFY_CODE_DIGITS, "0") : humanCode(RESET_CODE_LENGTH);
    const t = now();
    await this.store.putCode({ account_id: a.id, purpose, code_hash: codeHash(a.id, purpose, code), attempts: 0, created_at: t, expires_at: t + this.cfg.codeTtlMs });
    this.codesSent.record(this.codeKey(a, purpose), t);
    if (network !== null) this.codeRequests.record(network, t);
    const text = purpose === "verify_email" ? mailTexts.verifyEmail(code) : mailTexts.resetPassword(formatResetCode(code));
    try {
      await this.mailer.send({ to: a.email, ...text });
    } catch (e) {
      // The code itself is never logged; only that sending failed.
      this.ctx.log.error({ err: e, purpose }, "account email not sent");
      throw new ApiError(503, "email_failed", "We couldn't send the email just now. Try again in a minute.");
    }
  }

  /** "Someone tried to sign up with your address": its own small allowance, so it never crowds out a reset code. */
  private async sendNotice(a: AccountRow, network: string): Promise<void> {
    if (!this.notices.allows(a.id) || !this.codeRequests.allows(network)) return;
    this.notices.record(a.id);
    this.codeRequests.record(network);
    await this.mailer.send({ to: a.email, ...mailTexts.alreadyRegistered() }).catch((e) => this.ctx.log.warn({ err: e }, "account email not sent"));
  }

  /**
   * Checks and consumes a code; [alsoRequired] must hold too (verification: the password). Wrong tries count; after too
   * many the code is dead until a new one is sent. Every failure gives the same answer, whether or not the address has an
   * account or a code, so this reveals nothing about either.
   */
  private async consumeCode(a: AccountRow | undefined, purpose: CodePurpose, code: string, alsoRequired = true): Promise<AccountRow> {
    if (!a) throw invalidCode();
    const row = await this.store.code(a.id, purpose);
    if (!row || row.expires_at <= now() || row.attempts >= this.cfg.codeMaxAttempts) throw invalidCode();
    const normalized = purpose === "verify_email" ? normalizeVerifyCode(code) : normalizeCode(code);
    const expected = Buffer.from(row.code_hash, "hex");
    const given = Buffer.from(codeHash(a.id, purpose, normalized), "hex");
    if (!crypto.timingSafeEqual(expected, given) || !alsoRequired) {
      await this.store.countCodeAttempt(a.id, purpose);
      throw invalidCode();
    }
    // A code works once: of two requests with it, only the one that removes it goes on.
    if (!(await this.store.deleteCode(a.id, purpose, row.code_hash))) throw invalidCode();
    return a;
  }

  /**
   * The emailed code and the password chosen at sign-up, together: whoever verifies is whoever set the password, so a
   * later sign-up for the same unverified address can't take over the account its owner is verifying.
   */
  async verifyEmail(email: string, code: string, password: string): Promise<void> {
    const existing = await this.store.accountByEmail(email);
    // A verified address has no code: same answer as a wrong one, so this doesn't reveal which addresses are verified.
    const target = existing?.email_verified_at ? undefined : existing;
    if (!target) {
      await burnPasswordCheck(password, this.cfg.scryptLogN);
      throw invalidCode();
    }
    const passwordOk = await verifyPassword(password, target.password_hash);
    const a = await this.consumeCode(target, "verify_email", code, passwordOk);
    const t = now();
    await this.store.updateAccount(a.id, { email_verified_at: t }, t);
    this.ctx.audit({ actorId: a.user_id, action: "account.verify_email", target: a.id });
  }

  async resendVerification(email: string, ip: string): Promise<void> {
    if (!this.mailer.available) throw emailUnavailable();
    const a = await this.store.accountByEmail(email);
    if (a && !a.email_verified_at && !a.disabled_at) await this.sendCode(a, "verify_email", networkKey(ip));
  }

  // ───────────── Sign-in ─────────────

  /**
   * Failures are counted per email address (whether or not it has an account), so being throttled says nothing about
   * which addresses exist: an unknown address is throttled exactly like a known one.
   */
  private throttleKeys(email: string, ip: string) {
    return { network: `${email}|${networkKey(ip)}`, account: email };
  }

  private recordFailure(email: string, ip: string): void {
    const k = this.throttleKeys(email, ip);
    this.failuresByNetwork.record(k.network);
    this.failuresByAccount.record(k.account);
  }

  private requireNotThrottled(email: string, ip: string, reply: { header: (k: string, v: string) => unknown }): void {
    const k = this.throttleKeys(email, ip);
    const wait = Math.max(this.failuresByNetwork.retryAfterMs(k.network), this.failuresByAccount.retryAfterMs(k.account));
    if (wait > 0) {
      reply.header("retry-after", String(Math.ceil(wait / 1000)));
      throw new ApiError(429, "login_throttled", "Too many wrong passwords. Wait a few minutes and try again.");
    }
  }

  /** Checks [password] for [a], counting failures; rehashes with current parameters when they were raised. */
  async checkPassword(a: AccountRow, password: string, ip: string, reply: { header: (k: string, v: string) => unknown }): Promise<void> {
    this.requireNotThrottled(a.email, ip, reply);
    if (!(await verifyPassword(password, a.password_hash))) {
      this.recordFailure(a.email, ip);
      // The person's sign-in history (Platform Admin Console): a wrong password for an existing account.
      this.ctx.audit({ actorId: a.user_id, action: "account.login_failed", target: a.id });
      throw invalidCredentials();
    }
    if (needsRehash(a.password_hash, this.cfg.scryptLogN)) {
      const t = now();
      await this.store.updateAccount(a.id, { password_hash: await hashPassword(password, this.cfg.scryptLogN) }, t);
    }
  }

  async login(body: LoginBody, ip: string, reply: { header: (k: string, v: string) => unknown }): Promise<SessionResponse> {
    const a = await this.store.accountByEmail(body.email);
    if (!a) {
      this.requireNotThrottled(body.email, ip, reply);
      await burnPasswordCheck(body.password, this.cfg.scryptLogN);
      this.recordFailure(body.email, ip);
      throw invalidCredentials();
    }
    await this.checkPassword(a, body.password, ip, reply);
    this.secondFactor?.(a.id, body.totpCode);
    return this.finishLogin(a, body, "password");
  }

  /**
   * Sign-in with a passkey (2026-10-23, passkeys.ts) once its signature checked out: the same session and the same
   * checks as a password sign-in (disabled, email verified, device proof).
   */
  async loginWithPasskey(
    accountId: string,
    body: { deviceName?: string; device?: { deviceId: string; nonce: string; signature: string } },
    _ip: string,
    _reply: { header: (k: string, v: string) => unknown },
  ): Promise<SessionResponse> {
    const a = await this.store.accountById(accountId);
    if (!a) throw new ApiError(401, "passkey_unknown", "This passkey isn't registered here. Sign in with your password and add it again.");
    return this.finishLogin(a, body, "passkey");
  }

  private async finishLogin(
    a: AccountRow,
    body: { deviceName?: string; device?: { deviceId: string; nonce: string; signature: string } },
    via: "password" | "passkey",
  ): Promise<SessionResponse> {
    if (a.disabled_at) throw sessionEnded("account_disabled");
    if (!a.email_verified_at) throw new ApiError(403, "email_unverified", "Verify your email first: enter the code we sent you.", { email: a.email });
    if (a.user_id) {
      const user = this.ctx.db.prepare("SELECT disabled_at FROM users WHERE id = ?").get(a.user_id) as { disabled_at: number | null } | undefined;
      if (user?.disabled_at) throw sessionEnded("account_disabled");
    }
    const deviceId = body.device ? this.provenDevice(a, body.device) : null;
    const issued = await this.sessions.issue(a.id, body.deviceName ?? "Meldiq app", deviceId, now());
    const detail = [via === "passkey" ? "passkey" : null, deviceId ? "device" : null].filter(Boolean).join(",") || null;
    this.ctx.audit({ actorId: a.user_id, action: "account.login", target: issued.session.id, detail });
    // Signed-in sessions per person (docs/QUOTAS.md): observed and warned only; signing in is never refused by a quota.
    if (a.user_id && this.ctx.quotas?.hasPolicies("sessions.active")) {
      const open = (await this.store.activeSessions(a.id, now())).length;
      this.ctx.quotas.check("sessions.active", [{ type: "user", id: a.user_id }], 0, { measured: { user: open } });
    }
    return this.respond(issued, (await this.store.accountById(a.id))!);
  }

  /**
   * A device of this account signing in again proves it holds the device key (a fresh challenge signed with it), so its
   * new session is bound to it at once and the app keeps its keys, database and history.
   */
  private provenDevice(a: AccountRow, proof: { deviceId: string; nonce: string; signature: string }): string {
    const dev = a.user_id
      ? (this.ctx.db.prepare("SELECT id, signing_key, revoked_at FROM devices WHERE id = ? AND user_id = ?").get(proof.deviceId, a.user_id) as
          | { id: string; signing_key: string; revoked_at: number | null }
          | undefined)
      : undefined;
    if (!dev || !verifyEd25519(dev.signing_key, canonical.authProof("login", proof.nonce, dev.signing_key), proof.signature)) {
      throw new ApiError(401, "invalid_device_proof", "This phone's keys don't belong to this account. Set up encryption again.");
    }
    if (!consumeChallenge(this.ctx, proof.nonce)) throw new ApiError(401, "challenge_expired", "The sign-in took too long. Try again.");
    if (dev.revoked_at) throw new ApiError(401, "device_revoked", "This phone was removed from your account. Set up encryption again.");
    return dev.id;
  }

  async refresh(refreshToken: string): Promise<SessionResponse> {
    const issued = await this.sessions.refresh(refreshToken, now(), (s) => {
      if (s.device_id) this.ctx.hub.disconnectDevice(s.device_id, "session revoked");
      this.ctx.audit({ action: "account.refresh_reuse", target: s.id });
    });
    return this.respond(issued, (await this.store.accountById(issued.session.account_id))!);
  }

  /** Ends sessions and closes their devices' sockets. */
  async revokeSessions(accountId: string, reason: string, exceptSessionId?: string): Promise<void> {
    for (const d of await this.store.revokeAccountSessions(accountId, reason, now(), exceptSessionId)) this.ctx.hub.disconnectDevice(d, "session revoked");
  }

  async logout(s: ActiveSession): Promise<void> {
    await this.store.revokeSession(s.id, "logout", now());
    if (s.device_id) this.ctx.hub.disconnectDevice(s.device_id, "signed out");
  }

  // ───────────── Passwords ─────────────

  async forgotPassword(email: string, ip: string): Promise<void> {
    if (!this.mailer.available) throw emailUnavailable();
    const a = await this.store.accountByEmail(email);
    if (a && !a.disabled_at) await this.sendCode(a, "reset_password", networkKey(ip));
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    const weak = weakPassword(newPassword, email);
    if (weak) throw weak;
    const a = await this.consumeCode(await this.store.accountByEmail(email), "reset_password", code);
    const hash = await hashPassword(newPassword, this.cfg.scryptLogN);
    const t = now();
    // The code arrived by email, so the address is proven too.
    await this.store.updateAccount(a.id, { password_hash: hash, password_changed_at: t, email_verified_at: a.email_verified_at ?? t }, t);
    await this.revokeSessions(a.id, "password_reset");
    // Whoever reset the password owns the inbox: wrong guesses by others no longer keep them out.
    this.failuresByAccount.clear(a.email);
    this.failuresByNetwork.clearPrefix(`${a.email}|`);
    this.ctx.audit({ actorId: a.user_id, action: "account.password_reset", target: a.id });
  }

  async changePassword(s: ActiveSession, current: string, next: string, ip: string, reply: { header: (k: string, v: string) => unknown }): Promise<void> {
    const a = (await this.store.accountById(s.account_id))!;
    await this.checkPassword(a, current, ip, reply);
    const weak = weakPassword(next, a.email);
    if (weak) throw weak;
    const t = now();
    await this.store.updateAccount(a.id, { password_hash: await hashPassword(next, this.cfg.scryptLogN), password_changed_at: t }, t);
    await this.revokeSessions(a.id, "password_changed", s.id);
    this.ctx.audit({ actorId: a.user_id, action: "account.password_change", target: a.id });
  }
}

/** "ABCDE-FGHJK": easier to read and type; the dash is ignored when checking. */
function formatResetCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Consumes a single-use /v1/auth/challenge nonce. False if unknown, expired or already used. */
export function consumeChallenge(ctx: AppContext, nonce: string): boolean {
  return !!ctx.db.prepare("DELETE FROM auth_challenges WHERE nonce = ? AND expires_at > ? RETURNING nonce").get(nonce, now());
}
