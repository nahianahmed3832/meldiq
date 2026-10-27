import crypto from "node:crypto";
import type { AppContext } from "../../app/context.js";
import { mailTexts } from "../../infrastructure/mail/mailer.js";
import { ApiError } from "../../shared/errors.js";
import { now, sha256Hex } from "../../shared/utilities/util.js";
import { SlidingWindow } from "../../app/middleware/abuse.js";
import { verifyPassword } from "./passwords.js";
import { type AccountService, maskEmail } from "./service.js";
import type { AccountRow, ActiveSession } from "./store.js";

/**
 * Changing the account's email from Settings (API 0.46.0, docs/ACCOUNT_SAFETY.md): the password, then a 6-digit code
 * sent to the new address. The old address is told once the change is done. Whether the new address already has an
 * account isn't revealed to the asker: that address gets a "this address is in use" email instead of a code.
 */
const TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 5;
const PER_HOUR = 5;

interface ChangeRow {
  account_id: string;
  new_email: string;
  code_hash: string;
  attempts: number;
  created_at: number;
  expires_at: number;
}

const codeHash = (accountId: string, email: string, code: string) => sha256Hex(`${accountId}:email-change:${email}:${code}`);

export class EmailChangeService {
  private readonly sent = new SlidingWindow(PER_HOUR, 60 * 60_000);

  constructor(
    private readonly ctx: AppContext,
    private readonly service: AccountService,
  ) {}

  async start(s: ActiveSession, a: AccountRow, password: string, newEmail: string): Promise<{ email: string; expiresAt: number }> {
    if (!a.password_hash || !(await verifyPassword(password, a.password_hash))) throw new ApiError(401, "invalid_credentials", "That password isn't right.");
    const email = newEmail.trim().toLowerCase();
    if (email === a.email.toLowerCase()) throw new ApiError(400, "bad_request", "That's already your email address.");
    if (!this.service.mailer.available) throw new ApiError(503, "email_unavailable", "This server can't send email right now. Try again later.");
    if (!this.sent.allows(a.id)) throw new ApiError(429, "rate_limited", "Too many codes asked for. Try again in an hour.");
    this.sent.record(a.id);
    const t = now();
    const expiresAt = t + TTL_MS;
    const taken = await this.service.store.accountByEmail(email);
    if (taken) {
      // No code (nothing can change), and the same answer as for a free address.
      this.ctx.db.prepare("DELETE FROM account_email_changes WHERE account_id = ?").run(a.id);
      await this.send(email, mailTexts.emailChangeInUse());
    } else {
      const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
      this.ctx.db
        .prepare(
          `INSERT INTO account_email_changes (account_id, new_email, code_hash, attempts, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET new_email = excluded.new_email, code_hash = excluded.code_hash, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at`,
        )
        .run(a.id, email, codeHash(a.id, email, code), t, expiresAt);
      await this.send(email, mailTexts.emailChangeCode(code));
    }
    this.ctx.audit({ actorId: s.user_id, action: "account.email_change_start", target: s.id });
    return { email: maskEmail(email), expiresAt };
  }

  async confirm(s: ActiveSession, a: AccountRow, code: string): Promise<{ email: string }> {
    const row = this.ctx.db.prepare("SELECT * FROM account_email_changes WHERE account_id = ?").get(a.id) as ChangeRow | undefined;
    const bad = () => new ApiError(400, "invalid_code", "That code isn't right or has expired. Ask for a new one.");
    if (!row || row.expires_at <= now() || row.attempts >= MAX_ATTEMPTS) throw bad();
    const given = Buffer.from(codeHash(a.id, row.new_email, code.replace(/\D/g, "")), "hex");
    if (!crypto.timingSafeEqual(given, Buffer.from(row.code_hash, "hex"))) {
      this.ctx.db.prepare("UPDATE account_email_changes SET attempts = attempts + 1 WHERE account_id = ?").run(a.id);
      throw bad();
    }
    // Used once: of two confirmations, the one that removes the row goes on.
    if (this.ctx.db.prepare("DELETE FROM account_email_changes WHERE account_id = ? AND code_hash = ?").run(a.id, row.code_hash).changes !== 1) throw bad();
    if (!(await this.service.store.changeVerifiedEmail(a.id, row.new_email, now()))) {
      throw new ApiError(409, "email_in_use", "That address now belongs to another account. Use a different one.");
    }
    await this.send(a.email, mailTexts.emailChanged(maskEmail(row.new_email)));
    this.ctx.audit({ actorId: s.user_id, action: "account.email_changed", target: s.id });
    return { email: row.new_email };
  }

  /** Account deletion: a change in progress. */
  remove(accountId: string): void {
    this.ctx.db.prepare("DELETE FROM account_email_changes WHERE account_id = ?").run(accountId);
  }

  private async send(to: string, text: ReturnType<typeof mailTexts.emailChanged>): Promise<void> {
    try {
      await this.service.mailer.send({ to, ...text });
    } catch (e) {
      this.ctx.log.error({ err: e }, "account email not sent");
      throw new ApiError(503, "email_failed", "We couldn't send the email just now. Try again in a minute.");
    }
  }
}
