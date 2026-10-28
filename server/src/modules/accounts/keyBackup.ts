import crypto from "node:crypto";
import { HOUR_MS, SlidingWindow } from "../../app/middleware/abuse.js";
import type { AppContext } from "../../app/context.js";
import { ApiError } from "../../shared/errors.js";
import { now, sha256Hex } from "../../shared/utilities/util.js";
import type { KeyBackupRow, KeyBackupStore } from "./keyBackupStore.js";
import { mailTexts } from "../../infrastructure/mail/mailer.js";
import type { KeyBackupBody } from "../../shared/contracts/http/accounts.js";
import { type AccountService, maskEmail } from "./service.js";
import type { AccountRow, ActiveSession } from "./store.js";

const CODE_DIGITS = 6;
/** Unlock codes one account may be sent per hour. */
const UNLOCK_CODES_PER_HOUR = 5;

type Reply = { header: (k: string, v: string) => unknown };

/** The sealed keys as the clients read and write them. */
export interface KeyBackupView {
  version: number;
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
  identityKey: string;
}

const noBackup = () => new ApiError(404, "no_key_backup", "There's no key backup for this account's current password. Use your recovery key or another signed-in device.");
const invalidCode = () => new ApiError(400, "invalid_code", "That code isn't right, or it has expired. Ask for a new one.");
const needsDevice = () => new ApiError(403, "device_required", "Only a device that has this account's keys can back them up.");
const emailUnavailable = () => new ApiError(503, "email_unavailable", "This server can't send email right now. Use your recovery key or another signed-in device.");

const unlockHash = (accountId: string, sessionId: string, code: string) => sha256Hex(`${accountId}:${sessionId}:key-unlock:${code.replace(/\D/g, "")}`);

const view = (r: KeyBackupRow): KeyBackupView => ({ version: r.version, iterations: r.iterations, salt: r.salt, nonce: r.nonce, ciphertext: r.ciphertext, identityKey: r.identity_key });

/**
 * Encryption keys backed up under the account password (docs/KEY_BACKUP.md). A device holding the keys seals the
 * identity seed with a key derived from the password and stores the ciphertext here. A new device signs in with the
 * password, proves the inbox with an emailed code, and gets the ciphertext back to open with the password.
 *
 * - The server can't open a backup: it never stores the derived key. It does see the password at sign-in (as every
 *   password sign-in does), which is why this is weaker than the recovery key and documented as such.
 * - A backup counts only for the password and identity it was made with: a password change, reset or recovery, or a
 *   fresh identity, makes it stale, and the person falls back to the recovery key or another device.
 * - Writing one needs a session bound to a device of the account and the password again, so a stolen access token
 *   can't swap in a backup nobody can open.
 */
export class KeyBackupService {
  private readonly codesSent = new SlidingWindow(UNLOCK_CODES_PER_HOUR, HOUR_MS);

  constructor(
    private readonly ctx: AppContext,
    private readonly accounts: AccountService,
    readonly store: KeyBackupStore,
  ) {}

  /** Whether this account has a backup that its current password and identity can use. */
  async status(s: ActiveSession): Promise<{ exists: boolean; updatedAt: number | null }> {
    const row = await this.current(await this.account(s));
    return { exists: !!row, updatedAt: row?.updated_at ?? null };
  }

  /** Creates or replaces the backup from a device of the account, after checking the password. */
  async put(s: ActiveSession, password: string, backup: KeyBackupBody, ip: string, reply: Reply): Promise<{ updatedAt: number }> {
    const a = await this.account(s);
    if (!s.device_id || s.device_revoked_at !== null || !a.user_id) throw needsDevice();
    await this.accounts.checkPassword(a, password, ip, reply);
    return this.save(a, backup);
  }

  /**
   * Stores [backup] for [a]'s current password: also used by a password change, which seals the keys again under the
   * new password in the same request (service.changePassword).
   */
  async save(a: AccountRow, backup: KeyBackupBody): Promise<{ updatedAt: number }> {
    this.requireCurrentIdentity(a, backup);
    const t = now();
    const existing = await this.store.backup(a.id);
    await this.store.putBackup({
      account_id: a.id,
      identity_key: backup.identityKey,
      password_changed_at: a.password_changed_at,
      version: backup.version,
      iterations: backup.iterations,
      salt: backup.salt,
      nonce: backup.nonce,
      ciphertext: backup.ciphertext,
      created_at: existing?.created_at ?? t,
      updated_at: t,
    });
    this.ctx.audit({ actorId: a.user_id, action: "account.key_backup_saved", target: a.id });
    return { updatedAt: t };
  }

  /** Refuses a backup of keys other than the account's current identity (checked before a password change, too). */
  requireCurrentIdentity(a: AccountRow, backup: KeyBackupBody): void {
    if (backup.identityKey !== this.identityKey(a)) throw new ApiError(409, "identity_mismatch", "These keys aren't this account's current encryption keys.");
  }

  async remove(s: ActiveSession): Promise<void> {
    if (!s.device_id || s.device_revoked_at !== null) throw needsDevice();
    const a = await this.account(s);
    await this.store.deleteForAccount(a.id);
    this.ctx.audit({ actorId: a.user_id, action: "account.key_backup_removed", target: a.id });
  }

  /** Step 1 on a new device: emails a code for this session. Past the hourly limit nothing more is sent. */
  async startUnlock(s: ActiveSession): Promise<{ email: string; expiresAt: number }> {
    const a = await this.account(s);
    if (!(await this.current(a))) throw noBackup();
    if (!this.accounts.mailer.available) throw emailUnavailable();
    const t = now();
    const expiresAt = t + this.ctx.config.accounts.codeTtlMs;
    if (!this.codesSent.allows(a.id)) return { email: maskEmail(a.email), expiresAt };
    const code = crypto.randomInt(0, 10 ** CODE_DIGITS).toString().padStart(CODE_DIGITS, "0");
    await this.store.putUnlock({ account_id: a.id, session_id: s.id, code_hash: unlockHash(a.id, s.id, code), attempts: 0, created_at: t, expires_at: expiresAt });
    this.codesSent.record(a.id, t);
    try {
      await this.accounts.mailer.send({ to: a.email, ...mailTexts.keyUnlock(code) });
    } catch (e) {
      // The code itself is never logged; only that sending failed.
      this.ctx.log.error({ err: e }, "key unlock email not sent");
      throw new ApiError(503, "email_failed", "We couldn't send the email just now. Try again in a minute.");
    }
    this.ctx.audit({ actorId: a.user_id, action: "account.key_unlock_started", target: a.id });
    return { email: maskEmail(a.email), expiresAt };
  }

  /** Step 2: the emailed code, from the same session, gives back the sealed keys. Single use; wrong tries count. */
  async unlock(s: ActiveSession, code: string): Promise<KeyBackupView> {
    const a = await this.account(s);
    const row = await this.store.unlock(a.id);
    if (!row || row.session_id !== s.id || row.expires_at <= now() || row.attempts >= this.ctx.config.accounts.codeMaxAttempts) throw invalidCode();
    const expected = Buffer.from(row.code_hash, "hex");
    const given = Buffer.from(unlockHash(a.id, s.id, code), "hex");
    if (!crypto.timingSafeEqual(expected, given)) {
      await this.store.countUnlockAttempt(a.id);
      throw invalidCode();
    }
    if (!(await this.store.useUnlock(a.id, row.code_hash))) throw invalidCode();
    const backup = await this.current(a);
    if (!backup) throw noBackup();
    this.ctx.audit({ actorId: a.user_id, action: "account.key_unlocked", target: a.id });
    return view(backup);
  }

  purgeExpired(): Promise<number> {
    return this.store.purgeExpired(now());
  }

  private async account(s: ActiveSession): Promise<AccountRow> {
    const a = await this.accounts.store.accountById(s.account_id);
    if (!a) throw new ApiError(401, "unauthorized", "Sign in again.");
    return a;
  }

  private identityKey(a: AccountRow): string | null {
    if (!a.user_id) return null;
    const u = this.ctx.identity.get<{ identity_key: string }>("users", { id: a.user_id });
    return u?.identity_key ?? null;
  }

  /** The backup, if it was made for the account's current password and encryption identity. */
  private async current(a: AccountRow): Promise<KeyBackupRow | undefined> {
    const row = await this.store.backup(a.id);
    if (!row || row.password_changed_at !== a.password_changed_at || row.identity_key !== this.identityKey(a)) return undefined;
    return row;
  }
}
