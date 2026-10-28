import { randomBytes } from "node:crypto";
import type { DB } from "../../infrastructure/database/db.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import type { TrialConfig } from "./config.js";

/**
 * Free Meldiq Mojo periods no payment provider is involved in (docs/BILLING.md › Trials and invite links): every
 * account's trial, and invite links that give both people extra days. A grant only says "this account has this plan
 * until then"; the entitlements read it like a subscription that doesn't renew. Nothing a client says creates one:
 * the trial comes from the account's own sign-up time, a referral from a code the server issued to someone else.
 */
export type GrantSource = "signup_trial" | "referral_invitee" | "referral_inviter";

export interface GrantRow {
  id: string;
  account_id: string;
  user_id: string | null;
  plan_key: string;
  source: GrantSource;
  reference: string | null;
  starts_at: number;
  ends_at: number;
  created_at: number;
}

/** What the server knows about an account for its grants (accounts.created_at is its sign-up time). */
export interface GrantAccount {
  accountId: string;
  createdAt: number;
  userId: string | null;
}

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
/** Invite codes: 10 characters without look-alikes (0/O, 1/I/L). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newReferralCode(): string {
  const bytes = randomBytes(10);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export class Grants {
  constructor(
    private readonly db: DB,
    readonly config: TrialConfig | null,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The account's grant that applies at [t] (the one lasting longest when several overlap), if any. */
  active(accountId: string, t: number): GrantRow | null {
    return (
      (this.db.prepare("SELECT * FROM billing_grants WHERE account_id = ? AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1").get(accountId, t, t) as
        | GrantRow
        | undefined) ?? null
    );
  }

  /** The grant that applies at [t] to the account whose encryption identity is [userId] (the quota engine's question). */
  activeForUser(userId: string, t: number): GrantRow | null {
    return (
      (this.db.prepare("SELECT * FROM billing_grants WHERE user_id = ? AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1").get(userId, t, t) as
        | GrantRow
        | undefined) ?? null
    );
  }

  /** Records the account's trial if trials are on and it has none: [days] from sign-up, or from the day trials started. */
  ensureSignupTrial(a: GrantAccount): void {
    const c = this.config;
    if (!c || this.clock() < c.startsAt) return;
    const starts = Math.max(a.createdAt, c.startsAt);
    if (c.days === 0) return;
    this.db
      .prepare(
        "INSERT INTO billing_grants (id, account_id, user_id, plan_key, source, once_key, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, 'signup_trial', ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(newId("grt"), a.accountId, a.userId, c.planKey, `${a.accountId}:signup_trial`, starts, starts + c.days * DAY_MS, this.clock());
  }

  /** Records the account's encryption identity on its grants (it may have signed up on the website before having one). */
  linkUser(accountId: string, userId: string): void {
    this.db.prepare("UPDATE billing_grants SET user_id = ? WHERE account_id = ? AND (user_id IS NULL OR user_id != ?)").run(userId, accountId, userId);
  }

  /** The account's own invite code, made the first time it's asked for. */
  codeFor(accountId: string): string {
    const existing = this.db.prepare("SELECT code FROM billing_referral_codes WHERE account_id = ?").get(accountId) as { code: string } | undefined;
    if (existing) return existing.code;
    for (let i = 0; i < 5; i++) {
      const code = newReferralCode();
      const r = this.db.prepare("INSERT INTO billing_referral_codes (account_id, code, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(accountId, code, this.clock());
      if (r.changes === 1) return code;
      const now = this.db.prepare("SELECT code FROM billing_referral_codes WHERE account_id = ?").get(accountId) as { code: string } | undefined;
      if (now) return now.code;
    }
    throw new Error("could not make an invite code");
  }

  /** Bonus days [accountId] earned by inviting people in the 365 days before [t]. */
  bonusDaysInYear(accountId: string, t: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(inviter_days), 0) d FROM billing_referrals WHERE inviter_account_id = ? AND created_at > ?").get(accountId, t - YEAR_MS) as { d: number }).d;
  }

  /** An account's invite link details: its code, how many people joined through it, the bonus days this year and the cap. */
  stats(accountId: string) {
    const t = this.clock();
    const c = this.config;
    const invited = (this.db.prepare("SELECT COUNT(*) n FROM billing_referrals WHERE inviter_account_id = ?").get(accountId) as { n: number }).n;
    return {
      available: !!c && t >= c.startsAt,
      code: this.codeFor(accountId),
      invited,
      bonusDaysThisYear: this.bonusDaysInYear(accountId, t),
      yearlyCapDays: c?.referralCapDays ?? 0,
      daysEach: c?.referralDays ?? 0,
    };
  }

  /**
   * [invitee] signed up through the invite link with [code]: it gets the referral trial (from its sign-up), and the
   * link's owner gets bonus days added after whatever grant they have, up to the yearly cap. Only a new account (within
   * the claim window), once, and never with its own code.
   */
  claim(invitee: GrantAccount, code: string): { inviteeEndsAt: number; inviterDays: number } {
    const c = this.config;
    const t = this.clock();
    if (!c || t < c.startsAt) throw new ApiError(409, "billing_unavailable", "Invite links aren't active yet");
    const owner = this.db.prepare("SELECT account_id FROM billing_referral_codes WHERE code = ?").get(code.trim().toUpperCase()) as { account_id: string } | undefined;
    if (!owner) throw notFound("That invite link isn't valid");
    if (owner.account_id === invitee.accountId) throw conflict("You can't use your own invite link");
    if (t - invitee.createdAt > c.claimWindowDays * DAY_MS) throw conflict("Invite links only count for accounts created in the last few days");
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM billing_referrals WHERE invitee_account_id = ?").get(invitee.accountId)) {
        throw conflict("This account already joined through an invite link");
      }
      const inviterDays = Math.max(0, Math.min(c.referralDays, c.referralCapDays - this.bonusDaysInYear(owner.account_id, t)));
      const referralId = newId("ref");
      this.db
        .prepare("INSERT INTO billing_referrals (id, inviter_account_id, invitee_account_id, code, inviter_days, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(referralId, owner.account_id, invitee.accountId, code.trim().toUpperCase(), inviterDays, t);
      const starts = Math.max(invitee.createdAt, c.startsAt);
      const inviteeEndsAt = starts + c.referralDays * DAY_MS;
      this.db
        .prepare(
          "INSERT INTO billing_grants (id, account_id, user_id, plan_key, source, reference, once_key, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, 'referral_invitee', ?, ?, ?, ?, ?)",
        )
        .run(newId("grt"), invitee.accountId, invitee.userId, c.planKey, referralId, `${invitee.accountId}:referral_invitee`, starts, inviteeEndsAt, t);
      if (inviterDays > 0) {
        // Bonus days follow on from what the inviter already has, so two invites in a row give 60 days, not 30 twice.
        const latest = (this.db.prepare("SELECT MAX(ends_at) e FROM billing_grants WHERE account_id = ?").get(owner.account_id) as { e: number | null }).e ?? 0;
        const from = Math.max(t, latest);
        const userId = (this.db.prepare("SELECT user_id FROM billing_grants WHERE account_id = ? AND user_id IS NOT NULL LIMIT 1").get(owner.account_id) as { user_id: string } | undefined)?.user_id ?? null;
        this.db
          .prepare(
            "INSERT INTO billing_grants (id, account_id, user_id, plan_key, source, reference, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, 'referral_inviter', ?, ?, ?, ?)",
          )
          .run(newId("grt"), owner.account_id, userId, c.planKey, referralId, from, from + inviterDays * DAY_MS, t);
      }
      return { inviteeEndsAt, inviterDays };
    })();
  }

  /** The encryption identities known for an account's grants (where its devices are reached). */
  userIdsOf(accountId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT user_id u FROM billing_grants WHERE account_id = ? AND user_id IS NOT NULL").all(accountId) as { u: string }[]).map((r) => r.u);
  }

  /** The account owning [code], for the realtime notice after a claim. */
  inviterOf(code: string): string | null {
    return (this.db.prepare("SELECT account_id FROM billing_referral_codes WHERE code = ?").get(code.trim().toUpperCase()) as { account_id: string } | undefined)?.account_id ?? null;
  }
}
