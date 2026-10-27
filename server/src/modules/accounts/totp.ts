import crypto from "node:crypto";
import type { AppContext } from "../../app/context.js";
import type { DB } from "../../infrastructure/database/db.js";
import { ApiError } from "../../shared/errors.js";
import { humanCode, newId, normalizeCode, now, sha256Hex } from "../../shared/utilities/util.js";
import { SecretBox } from "../../infrastructure/crypto/secretBox.js";
import { verifyPassword } from "./passwords.js";
import type { AccountRow, ActiveSession } from "./store.js";

/**
 * Two-step sign-in with an authenticator app (API 0.46.0, docs/ACCOUNT_SAFETY.md): RFC 6238 TOTP (HMAC-SHA-1, 6 digits,
 * 30-second steps, one step of clock drift either way). Signing in with a password then also needs a code from the app,
 * or one of ten single-use backup codes. A passkey sign-in doesn't ask (a passkey is already something you have and
 * something you are). The shared secret is sealed with PLATFORM_SECRETS_KEY; without the key, two-step sign-in can't be
 * turned on (it never falls back to storing the secret in the clear).
 */

export const TOTP = { digits: 6, periodSeconds: 30, drift: 1, secretBytes: 20, backupCodes: 10, backupLength: 10 } as const;
/** Wrong codes per account before a 15-minute pause (the password was right, so this guards the second factor). */
const MAX_WRONG = 5;
const LOCK_MS = 15 * 60_000;
const SETUP_TTL_MS = 15 * 60_000;
const ISSUER = "Meldiq";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for time step [step] (RFC 4226 dynamic truncation). */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP.digits;
  return n.toString().padStart(TOTP.digits, "0");
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / TOTP.periodSeconds);

/** The step [code] belongs to, within the allowed drift and later than [lastStep] (a code works once), else null. */
export function matchStep(secret: Buffer, code: string, at: number, lastStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const current = stepAt(at);
  for (let d = -TOTP.drift; d <= TOTP.drift; d++) {
    const step = current + d;
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, step)), given)) return step;
  }
  return null;
}

interface TotpRow {
  account_id: string;
  secret: string;
  created_at: number;
  enabled_at: number | null;
  last_step: number;
}

const backupHash = (accountId: string, code: string) => sha256Hex(`${accountId}:totp-backup:${normalizeCode(code)}`);
const sealedFor = (accountId: string) => `totp:${accountId}`;

export class TotpService {
  private readonly box: SecretBox;
  private readonly wrong = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly ctx: AppContext,
    secretsKey: Buffer | null,
  ) {
    this.box = new SecretBox(secretsKey);
  }

  private get db(): DB {
    return this.ctx.db;
  }

  private row(accountId: string): TotpRow | undefined {
    return this.db.prepare("SELECT * FROM account_totp WHERE account_id = ?").get(accountId) as TotpRow | undefined;
  }

  enabled(accountId: string): boolean {
    return !!this.row(accountId)?.enabled_at;
  }

  status(accountId: string) {
    const r = this.row(accountId);
    const left = (this.db.prepare("SELECT COUNT(*) n FROM account_totp_backup WHERE account_id = ? AND used_at IS NULL").get(accountId) as { n: number }).n;
    return { available: this.box.available, enabled: !!r?.enabled_at, enabledAt: r?.enabled_at ?? null, backupCodesLeft: r?.enabled_at ? left : 0 };
  }

  private async checkPassword(a: AccountRow, password: string): Promise<void> {
    if (!a.password_hash || !(await verifyPassword(password, a.password_hash))) throw new ApiError(401, "invalid_credentials", "That password isn't right.");
  }

  /** Step 1: a fresh secret for the authenticator app (not on until a code from it comes back). Needs the password. */
  async setup(s: ActiveSession, a: AccountRow, password: string): Promise<{ secret: string; uri: string }> {
    await this.checkPassword(a, password);
    if (this.enabled(a.id)) throw new ApiError(409, "totp_already_on", "Two-step sign-in is already on. Turn it off first to use a new app.");
    const secret = crypto.randomBytes(TOTP.secretBytes);
    const t = now();
    this.db
      .prepare(
        "INSERT INTO account_totp (account_id, secret, created_at, enabled_at, last_step) VALUES (?, ?, ?, NULL, 0) ON CONFLICT(account_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, enabled_at = NULL, last_step = 0",
      )
      .run(a.id, this.box.seal(secret.toString("base64"), sealedFor(a.id)), t);
    const label = `${ISSUER}:${encodeURIComponent(a.email)}`;
    const b32 = base32(secret);
    this.ctx.audit({ actorId: s.user_id, action: "account.totp_setup", target: s.id });
    return { secret: b32, uri: `otpauth://totp/${label}?secret=${b32}&issuer=${ISSUER}&algorithm=SHA1&digits=${TOTP.digits}&period=${TOTP.periodSeconds}` };
  }

  /** Step 2: the first code from the app turns it on and gives the backup codes (shown once). */
  enable(s: ActiveSession, accountId: string, code: string): { backupCodes: string[] } {
    const r = this.row(accountId);
    if (!r || r.enabled_at) throw new ApiError(409, "totp_not_pending", "Start setting up two-step sign-in again.");
    if (r.created_at + SETUP_TTL_MS < now()) throw new ApiError(409, "totp_not_pending", "That set-up took too long. Start again.");
    const step = matchStep(this.secretOf(r), code.trim(), now(), r.last_step);
    if (step === null) throw new ApiError(400, "totp_invalid", "That code isn't right. Check the time on your phone and try the newest code.");
    const t = now();
    const codes = Array.from({ length: TOTP.backupCodes }, () => humanCode(TOTP.backupLength));
    this.db.transaction(() => {
      this.db.prepare("UPDATE account_totp SET enabled_at = ?, last_step = ? WHERE account_id = ?").run(t, step, accountId);
      this.db.prepare("DELETE FROM account_totp_backup WHERE account_id = ?").run(accountId);
      const ins = this.db.prepare("INSERT INTO account_totp_backup (id, account_id, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, NULL)");
      for (const c of codes) ins.run(newId("tb"), accountId, backupHash(accountId, c), t);
    })();
    this.ctx.audit({ actorId: s.user_id, action: "account.totp_on", target: s.id });
    return { backupCodes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`) };
  }

  /** Turning it off needs the password and a code (from the app or a backup code). */
  async disable(s: ActiveSession, a: AccountRow, password: string, code: string): Promise<void> {
    await this.checkPassword(a, password);
    if (!this.enabled(a.id)) return;
    this.requireCode(a.id, code);
    this.remove(a.id);
    this.ctx.audit({ actorId: s.user_id, action: "account.totp_off", target: s.id });
  }

  /** Account deletion: everything of the account's. */
  remove(accountId: string): void {
    this.db.prepare("DELETE FROM account_totp WHERE account_id = ?").run(accountId);
    this.db.prepare("DELETE FROM account_totp_backup WHERE account_id = ?").run(accountId);
  }

  /**
   * At a password sign-in: nothing to do when it's off; otherwise the code (app or backup) must be right. Too many wrong
   * codes pause the account's second step for 15 minutes.
   */
  checkSignIn(accountId: string, code: string | undefined): void {
    if (!this.enabled(accountId)) return;
    if (!code) throw new ApiError(401, "totp_required", "Enter the code from your authenticator app.");
    this.requireCode(accountId, code);
  }

  private requireCode(accountId: string, code: string): void {
    const t = now();
    const w = this.wrong.get(accountId);
    if (w && w.count >= MAX_WRONG && w.until > t) throw new ApiError(429, "totp_locked", "Too many wrong codes. Try again in 15 minutes.");
    if (this.useCode(accountId, code.trim(), t)) {
      this.wrong.delete(accountId);
      return;
    }
    const next = w && w.until > t ? { count: w.count + 1, until: w.until } : { count: 1, until: t + LOCK_MS };
    this.wrong.set(accountId, next);
    throw new ApiError(401, "totp_invalid", "That code isn't right. Use the newest code from your app, or a backup code.");
  }

  /** An app code (once per step) or an unused backup code; true when it was accepted and used up. */
  private useCode(accountId: string, code: string, at: number): boolean {
    const r = this.row(accountId);
    if (!r?.enabled_at) return false;
    const digits = code.replace(/\s/g, "");
    if (/^\d{6}$/.test(digits)) {
      const step = matchStep(this.secretOf(r), digits, at, r.last_step);
      // Conditional: of two sign-ins racing with the same code, one wins.
      return step !== null && this.db.prepare("UPDATE account_totp SET last_step = ? WHERE account_id = ? AND last_step < ?").run(step, accountId, step).changes === 1;
    }
    return this.db.prepare("UPDATE account_totp_backup SET used_at = ? WHERE account_id = ? AND code_hash = ? AND used_at IS NULL").run(at, accountId, backupHash(accountId, code)).changes === 1;
  }

  private secretOf(r: TotpRow): Buffer {
    return Buffer.from(this.box.open(r.secret, sealedFor(r.account_id)), "base64");
  }
}
