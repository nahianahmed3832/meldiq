import crypto from "node:crypto";
import { HOUR_MS, networkKey, SlidingWindow } from "../../app/middleware/abuse.js";
import type { AppContext } from "../../app/context.js";
import { canonical, verifyEd25519 } from "../../shared/utilities/crypto.js";
import { ApiError } from "../../shared/errors.js";
import { newId, now, sha256Hex } from "../../shared/utilities/util.js";
import { hashPassword } from "./passwords.js";
import type { LegacyCompleteBody, LegacyVerifyBody } from "../../shared/contracts/http/accounts.js";
import { type AccountService, consumeChallenge, maskEmail, weakPassword } from "./service.js";
import type { AccountRow } from "./store.js";

const TICKET_TTL_MS = 15 * 60_000;
/** Failed proofs per legacy username and per network per hour. */
const FAILURES_PER_USERNAME = 10;
const FAILURES_PER_NETWORK = 30;

const verificationFailed = () =>
  new ApiError(401, "legacy_verification_failed", "That username and recovery key don't match an account. Check both and try again.");
const invalidTicket = () => new ApiError(401, "invalid_ticket", "This step took too long. Start again with your username and recovery key.");
const closed = () => new ApiError(410, "migration_closed", "Moving older accounts has ended on this server.");

export interface LegacyVerified {
  ticket: string;
  expiresAt: number;
  legacyUser: { username: string; displayName: string };
}

/**
 * Linking a legacy (device-keyed) account to a new email-and-password account (docs/ORBIT_2_ARCHITECTURE §5).
 *
 * 1. verify: the app proves it holds the legacy account's identity key by signing a fresh challenge with the key it
 *    derived from the recovery key. The recovery key itself never leaves the phone. Success gives a single-use ticket.
 * 2. complete: the ticket plus name, email and password create the account, linked to the existing users row, so every
 *    membership, conversation and history item stays where it is. The person then verifies the email and signs in.
 *
 * Nothing is linked until both steps succeed. A link whose email was never verified can be redone (a typo in the
 * address mustn't lock the person out); a verified one can't.
 */
export class LegacyMigrationService {
  private readonly failedByUsername = new SlidingWindow(FAILURES_PER_USERNAME, HOUR_MS);
  private readonly failedByNetwork = new SlidingWindow(FAILURES_PER_NETWORK, HOUR_MS);

  constructor(
    private readonly ctx: AppContext,
    private readonly accounts: AccountService,
  ) {}

  private requireOpen(): void {
    if (!this.ctx.config.accounts.legacy.migration) throw closed();
  }

  async verify(body: LegacyVerifyBody, ip: string, reply: { header: (k: string, v: string) => unknown }): Promise<LegacyVerified> {
    this.requireOpen();
    const network = networkKey(ip);
    const wait = Math.max(this.failedByUsername.retryAfterMs(body.username), this.failedByNetwork.retryAfterMs(network));
    if (wait > 0) {
      reply.header("retry-after", String(Math.ceil(wait / 1000)));
      throw new ApiError(429, "too_many_attempts", "Too many attempts. Wait a while and try again.");
    }
    const user = this.ctx.identity.get<{ id: string; username: string; display_name: string; identity_key: string; disabled_at: number | null }>("users", {
      username: body.username,
      home_server_id: null,
    });
    // Unknown username and wrong key answer alike, so this doesn't reveal which usernames exist.
    const proven = !!user && verifyEd25519(user.identity_key, canonical.legacyMigration(user.username, body.nonce), body.signature);
    if (!user || !proven || !consumeChallenge(this.ctx, body.nonce)) {
      const t = now();
      this.failedByUsername.record(body.username, t);
      this.failedByNetwork.record(network, t);
      throw verificationFailed();
    }
    if (user.disabled_at) throw new ApiError(403, "account_disabled", "This account is disabled.");
    const linked = await this.accounts.store.accountByUserId(user.id);
    if (linked?.email_verified_at) {
      throw new ApiError(409, "already_migrated", `This account has already moved to email sign-in. Sign in with ${maskEmail(linked.email)}.`, {
        emailHint: maskEmail(linked.email),
      });
    }
    const ticket = crypto.randomBytes(32).toString("base64url");
    const t = now();
    await this.accounts.store.insertTicket({ ticket_hash: sha256Hex(ticket), user_id: user.id, created_at: t, expires_at: t + TICKET_TTL_MS, used_at: null, account_id: null });
    this.ctx.audit({ actorId: user.id, action: "legacy.verify", target: user.id });
    return { ticket, expiresAt: t + TICKET_TTL_MS, legacyUser: { username: user.username, displayName: user.display_name } };
  }

  async complete(body: LegacyCompleteBody): Promise<{ email: string }> {
    this.requireOpen();
    const store = this.accounts.store;
    if (!this.accounts.mailer.available) throw new ApiError(503, "email_unavailable", "This server can't send email yet, so new accounts can't be verified. Try again later.");
    const hash = sha256Hex(body.ticket);
    const ticket = await store.ticket(hash);
    const t = now();
    if (!ticket || ticket.expires_at <= t) throw invalidTicket();
    if (ticket.used_at) {
      // A retry of a request that already went through: same answer, and the code again if it's still unverified.
      const done = ticket.account_id ? await store.accountById(ticket.account_id) : undefined;
      if (!done || done.email !== body.email) throw invalidTicket();
      if (!done.email_verified_at) await this.accounts.sendCode(done, "verify_email", null);
      return { email: done.email };
    }
    const weak = weakPassword(body.password, body.email);
    if (weak) throw weak;
    const passwordHash = await hashPassword(body.password, this.ctx.config.accounts.scryptLogN);
    const account = await store.transaction(() => this.link(ticket.user_id, hash, body, passwordHash, now()));
    this.ctx.audit({ actorId: ticket.user_id, action: "account.legacy_link", target: account.id });
    // The ticket already proved who this is: only the account's own allowance applies.
    await this.accounts.sendCode(account, "verify_email", null);
    return { email: account.email };
  }

  /** Creates or redoes the link inside one transaction; refuses an address or a legacy account someone already verified. */
  private async link(userId: string, ticketHash: string, body: LegacyCompleteBody, passwordHash: string, t: number): Promise<AccountRow> {
    const store = this.accounts.store;
    const linked = await store.accountByUserId(userId);
    if (linked?.email_verified_at) {
      throw new ApiError(409, "already_migrated", `This account has already moved to email sign-in. Sign in with ${maskEmail(linked.email)}.`, {
        emailHint: maskEmail(linked.email),
      });
    }
    const byEmail = await store.accountByEmail(body.email);
    if (byEmail && byEmail.id !== linked?.id && (byEmail.email_verified_at || byEmail.user_id)) {
      throw new ApiError(409, "email_taken", "That email already has a Meldiq account. Use another address, or sign in with it.");
    }
    // An unverified, unlinked sign-up with this address (nobody proved it) gives way to the proven legacy account.
    if (byEmail && byEmail.id !== linked?.id) await store.deleteUnverifiedAccount(byEmail.id);
    let id: string;
    if (linked) {
      // The earlier link was never verified (perhaps a mistyped address): it takes the new details.
      await store.updateAccount(linked.id, { name: body.name, password_hash: passwordHash, password_changed_at: t, legacy_linked_at: t }, t);
      await store.updateEmail(linked.id, body.email, t);
      id = linked.id;
    } else {
      id = newId("acc");
      const ok = await store.insertAccount({
        id,
        email: body.email,
        name: body.name,
        password_hash: passwordHash,
        password_changed_at: t,
        email_verified_at: null,
        user_id: userId,
        legacy_linked_at: t,
        selected_workspace_id: null,
        admitted_via: "legacy",
        created_at: t,
        updated_at: t,
        disabled_at: null,
      });
      if (!ok) throw new ApiError(409, "email_taken", "That email already has a Meldiq account. Use another address, or sign in with it.");
    }
    await store.useTicket(ticketHash, id, t);
    return (await store.accountById(id))!;
  }
}
