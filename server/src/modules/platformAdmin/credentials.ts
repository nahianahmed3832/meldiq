import type { AppContext } from "../../app/context.js";
import { networkKey, SlidingWindow } from "../../app/middleware/abuse.js";
import { ApiError } from "../../shared/errors.js";
import { sha256Hex } from "../../shared/utilities/util.js";
import { type AccountRow, burnPasswordCheck, verifyPassword } from "../accounts/index.js";
import type { PlatformAudit } from "./audit.js";
import { type AdminGrantRow, PlatformAdminStore } from "./store.js";

/** What every request to the console carries for its audit rows. */
export interface RequestMeta {
  ip: string;
  requestId: string;
}

export interface Reply {
  header: (k: string, v: string) => unknown;
}

const MINUTE_MS = 60_000;
/** Password attempts (right or wrong) per network per minute, and wrong ones per network and per address. */
const ATTEMPTS_PER_MINUTE = 10;
const FAILURES_PER_WINDOW = 10;
const FAILURES_PER_EMAIL = 5;
const FAILURE_WINDOW_MS = 15 * MINUTE_MS;

/** The same answer for every reason a sign-in is refused, so it says nothing about which accounts are admins. */
export const refused = () => new ApiError(401, "invalid_credentials", "That email and password don't match a console account.");

/**
 * Step one of every console sign-in and enrolment: the account's password, for an account with an active platform
 * grant. Stricter limits than the apps' sign-in, kept apart from them, and every refusal is audited (unknown addresses
 * by a hash prefix, never the address).
 */
export class AdminCredentials {
  private readonly attempts = new SlidingWindow(ATTEMPTS_PER_MINUTE, MINUTE_MS);
  private readonly failuresByNetwork = new SlidingWindow(FAILURES_PER_WINDOW, FAILURE_WINDOW_MS);
  private readonly failuresByEmail = new SlidingWindow(FAILURES_PER_EMAIL, FAILURE_WINDOW_MS);

  constructor(
    private readonly ctx: AppContext,
    private readonly store: PlatformAdminStore,
    private readonly audit: PlatformAudit,
  ) {}

  private async throttle(network: string, emailKey: string, meta: RequestMeta, reply: Reply): Promise<void> {
    const wait = Math.max(
      this.attempts.retryAfterMs(network),
      this.failuresByNetwork.retryAfterMs(network),
      this.failuresByEmail.retryAfterMs(emailKey),
    );
    if (wait <= 0) return;
    await this.audit.record({ action: "admin.login", outcome: "denied", network, requestId: meta.requestId, detail: { why: "throttled", email: emailKey.slice(0, 12) } });
    reply.header("retry-after", String(Math.ceil(wait / 1000)));
    throw new ApiError(429, "login_throttled", "Too many attempts. Wait a few minutes and try again.");
  }

  private async fail(network: string, emailKey: string, meta: RequestMeta, why: string, accountId: string | null, step: string): Promise<never> {
    this.failuresByNetwork.record(network);
    this.failuresByEmail.record(emailKey);
    await this.audit.record({
      action: "admin.login",
      outcome: accountId ? "denied" : "failed",
      actorAccountId: accountId,
      network,
      requestId: meta.requestId,
      detail: { step, why, email: accountId ? null : emailKey.slice(0, 12) },
    });
    throw refused();
  }

  /** The account and its active grant, if [password] is right and both are in good standing; else a refusal. */
  async check(email: string, password: string, meta: RequestMeta, reply: Reply, step: string): Promise<{ account: AccountRow; grant: AdminGrantRow }> {
    const network = networkKey(meta.ip);
    const emailKey = sha256Hex(`admin-email:${email}`);
    await this.throttle(network, emailKey, meta, reply);
    this.attempts.record(network);
    const account = await this.ctx.accounts.store.accountByEmail(email);
    if (!account) {
      await burnPasswordCheck(password, this.ctx.config.accounts.scryptLogN);
      return this.fail(network, emailKey, meta, "unknown_email", null, step);
    }
    if (!(await verifyPassword(password, account.password_hash))) return this.fail(network, emailKey, meta, "wrong_password", account.id, step);
    const problem = this.standing(account);
    if (problem) return this.fail(network, emailKey, meta, problem, account.id, step);
    const grant = this.store.activeGrant(account.id);
    if (!grant) return this.fail(network, emailKey, meta, "no_grant", account.id, step);
    this.failuresByEmail.clear(emailKey);
    return { account, grant };
  }

  /** Why [account] can't use the console now, or null. */
  standing(account: AccountRow): string | null {
    if (account.disabled_at) return "account_disabled";
    if (!account.email_verified_at) return "email_unverified";
    if (account.user_id && this.ctx.accounts.identityBlocked(account.user_id)) return "user_disabled";
    return null;
  }
}
