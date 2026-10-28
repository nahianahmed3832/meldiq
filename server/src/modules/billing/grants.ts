import { randomBytes } from "node:crypto";
import type { RowReader, Rows, RowWriter, Where } from "../../infrastructure/database/rows/index.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import type { TrialConfig } from "./config.js";

/**
 * Free Meldiq Mojo periods no payment provider is involved in (docs/BILLING.md › Trials and invite links): every
 * account's trial, and invite links that give both people extra days. A grant only says "this account has this plan
 * until then"; the entitlements read it like a subscription that doesn't renew. Nothing a client says creates one:
 * the trial comes from the account's own sign-up time, a referral from a code the server issued to someone else.
 */
export type GrantSource = "signup_trial" | "referral_invitee" | "referral_inviter" | "gift" | "operator";
export const GRANT_SOURCES: readonly GrantSource[] = ["signup_trial", "referral_invitee", "referral_inviter", "gift", "operator"];

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

/** Who gave an operator grant and why, and whether an operator ended a grant early (billing_grant_notes, API 0.58.0). */
export interface GrantNoteRow {
  grant_id: string;
  granted_by: string | null;
  note: string | null;
  ended_at: number | null;
  ended_by: string | null;
  original_starts_at: number | null;
  original_ends_at: number | null;
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
    private readonly rows: Rows,
    private readonly program: () => TrialConfig | null,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The program as it applies now (program.ts: the console's settings, else the environment). */
  get config(): TrialConfig | null {
    return this.program();
  }

  /** The account's grant that applies at [t] (the one lasting longest when several overlap), if any. */
  active(accountId: string, t: number): GrantRow | null {
    return this.rows.get<GrantRow>("billing_grants", { account_id: accountId, starts_at: { lte: t }, ends_at: { gt: t } }, [["ends_at", "desc"]]) ?? null;
  }

  /** Every grant that applies at [t] to the account (a gift and a trial may overlap: the higher plan wins). */
  allActive(accountId: string, t: number): GrantRow[] {
    return this.rows.all<GrantRow>("billing_grants", { where: { account_id: accountId, starts_at: { lte: t }, ends_at: { gt: t } } });
  }

  /** The grant that applies at [t] to the account whose encryption identity is [userId] (the quota engine's question). */
  activeForUser(userId: string, t: number): GrantRow | null {
    return this.rows.get<GrantRow>("billing_grants", { user_id: userId, starts_at: { lte: t }, ends_at: { gt: t } }, [["ends_at", "desc"]]) ?? null;
  }

  /** Every grant that applies at [t] to the account whose encryption identity is [userId]. */
  allActiveForUser(userId: string, t: number): GrantRow[] {
    return this.rows.all<GrantRow>("billing_grants", { where: { user_id: userId, starts_at: { lte: t }, ends_at: { gt: t } } });
  }

  /** Records the account's trial if trials are on and it has none: [days] from sign-up, or from the day trials started. */
  async ensureSignupTrial(a: GrantAccount): Promise<void> {
    const c = this.config;
    if (!c || this.clock() < c.startsAt) return;
    const starts = Math.max(a.createdAt, c.startsAt);
    if (c.days === 0) return;
    const onceKey = `${a.accountId}:signup_trial`;
    if (this.rows.get("billing_grants", { once_key: onceKey })) return;
    await this.rows.write((w) =>
      w.insert(
        "billing_grants",
        { id: newId("grt"), account_id: a.accountId, user_id: a.userId, plan_key: c.planKey, source: "signup_trial", once_key: onceKey, starts_at: starts, ends_at: starts + c.days * DAY_MS, created_at: this.clock() },
        { orIgnore: true },
      ),
    );
  }

  /** Records the account's encryption identity on its grants (it may have signed up on the website before having one). */
  async linkUser(accountId: string, userId: string): Promise<void> {
    const where = { account_id: accountId, $or: [{ user_id: null }, { user_id: { ne: userId } }] };
    if (!this.rows.get("billing_grants", where)) return;
    await this.rows.write((w) => w.update("billing_grants", where, { user_id: userId }));
  }

  /** A gift's free period (docs/MOJO.md › Gifts), written in the gift's own unit. */
  addGift(w: RowWriter, g: { accountId: string; userId: string | null; planKey: string; giftId: string; startsAt: number; endsAt: number }): string {
    const id = newId("grt");
    w.insert("billing_grants", {
      id, account_id: g.accountId, user_id: g.userId, plan_key: g.planKey, source: "gift", reference: g.giftId, starts_at: g.startsAt, ends_at: g.endsAt, created_at: this.clock(),
    });
    return id;
  }

  /** The latest end of the account's grants for any of [planKeys] that haven't ended at [t] (a gift starts after them). */
  latestEnd(accountId: string, planKeys: readonly string[], t: number, r: RowReader = this.rows): number | null {
    const g = r.get<{ ends_at: number }>("billing_grants", { account_id: accountId, plan_key: { in: planKeys }, ends_at: { gt: t } }, [["ends_at", "desc"]]);
    return g?.ends_at ?? null;
  }

  /** The account's own invite code, made the first time it's asked for. */
  async codeFor(accountId: string): Promise<string> {
    const existing = this.rows.get<{ code: string }>("billing_referral_codes", { account_id: accountId });
    if (existing) return existing.code;
    for (let i = 0; i < 5; i++) {
      const code = newReferralCode();
      const inserted = await this.rows.write((w) => w.insert("billing_referral_codes", { account_id: accountId, code, created_at: this.clock() }, { orIgnore: true }).inserted);
      if (inserted) return code;
      const now = this.rows.get<{ code: string }>("billing_referral_codes", { account_id: accountId });
      if (now) return now.code;
    }
    throw new Error("could not make an invite code");
  }

  /** Bonus days [accountId] earned by inviting people in the 365 days before [t]. */
  bonusDaysInYear(accountId: string, t: number, r: RowReader = this.rows): number {
    return r
      .all<{ inviter_days: number }>("billing_referrals", { where: { inviter_account_id: accountId, created_at: { gt: t - YEAR_MS } } })
      .reduce((n, x) => n + x.inviter_days, 0);
  }

  /** An account's invite link details: its code, how many people joined through it, the bonus days this year and the cap. */
  async stats(accountId: string) {
    const t = this.clock();
    const c = this.config;
    const invited = this.rows.count("billing_referrals", { inviter_account_id: accountId });
    return {
      available: !!c && t >= c.startsAt,
      code: await this.codeFor(accountId),
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
  async claim(invitee: GrantAccount, code: string): Promise<{ inviteeEndsAt: number; inviterDays: number }> {
    const c = this.config;
    const t = this.clock();
    if (!c || t < c.startsAt) throw new ApiError(409, "billing_unavailable", "Invite links aren't active yet");
    const normalized = code.trim().toUpperCase();
    const owner = this.rows.get<{ account_id: string }>("billing_referral_codes", { code: normalized });
    if (!owner) throw notFound("That invite link isn't valid");
    if (owner.account_id === invitee.accountId) throw conflict("You can't use your own invite link");
    if (t - invitee.createdAt > c.claimWindowDays * DAY_MS) throw conflict("Invite links only count for accounts created in the last few days");
    return this.rows.write((w) => {
      if (w.get("billing_referrals", { invitee_account_id: invitee.accountId })) throw conflict("This account already joined through an invite link");
      const inviterDays = Math.max(0, Math.min(c.referralDays, c.referralCapDays - this.bonusDaysInYear(owner.account_id, t, w)));
      const referralId = newId("ref");
      w.insert("billing_referrals", { id: referralId, inviter_account_id: owner.account_id, invitee_account_id: invitee.accountId, code: normalized, inviter_days: inviterDays, created_at: t });
      const starts = Math.max(invitee.createdAt, c.startsAt);
      const inviteeEndsAt = starts + c.referralDays * DAY_MS;
      w.insert("billing_grants", {
        id: newId("grt"), account_id: invitee.accountId, user_id: invitee.userId, plan_key: c.planKey, source: "referral_invitee", reference: referralId,
        once_key: `${invitee.accountId}:referral_invitee`, starts_at: starts, ends_at: inviteeEndsAt, created_at: t,
      });
      if (inviterDays > 0) {
        // Bonus days follow on from what the inviter already has, so two invites in a row give 60 days, not 30 twice.
        const latest = w.get<{ ends_at: number }>("billing_grants", { account_id: owner.account_id }, [["ends_at", "desc"]])?.ends_at ?? 0;
        const from = Math.max(t, latest);
        const userId = w.get<{ user_id: string }>("billing_grants", { account_id: owner.account_id, user_id: { ne: null } })?.user_id ?? null;
        w.insert("billing_grants", {
          id: newId("grt"), account_id: owner.account_id, user_id: userId, plan_key: c.planKey, source: "referral_inviter", reference: referralId,
          starts_at: from, ends_at: from + inviterDays * DAY_MS, created_at: t,
        });
      }
      return { inviteeEndsAt, inviterDays };
    });
  }

  /** The encryption identities known for an account's grants (where its devices are reached). */
  userIdsOf(accountId: string): string[] {
    return [...new Set(this.rows.all<{ user_id: string }>("billing_grants", { where: { account_id: accountId, user_id: { ne: null } } }).map((r) => r.user_id))];
  }

  /** The account owning [code], for the realtime notice after a claim. */
  inviterOf(code: string): string | null {
    return this.rows.get<{ account_id: string }>("billing_referral_codes", { code: code.trim().toUpperCase() })?.account_id ?? null;
  }

  // ───────────── The console (API 0.58.0) ─────────────

  /**
   * A free period an operator gives: [days] of [planKey], after whatever free period of that plan or a higher one the
   * account already has. Works whether or not the trial program is on.
   */
  async give(a: GrantAccount, g: { planKey: string; days: number; actor: string; note: string; laterThan: readonly string[] }): Promise<GrantRow> {
    const t = this.clock();
    const id = newId("grt");
    await this.rows.write((w) => {
      const from = Math.max(t, this.latestEnd(a.accountId, g.laterThan, t, w) ?? 0);
      w.insert("billing_grants", {
        id, account_id: a.accountId, user_id: a.userId, plan_key: g.planKey, source: "operator", starts_at: from, ends_at: from + g.days * DAY_MS, created_at: t,
      });
      w.insert("billing_grant_notes", { grant_id: id, granted_by: g.actor, note: g.note });
    });
    return this.get(id)!;
  }

  get(id: string): GrantRow | null {
    return this.rows.get<GrantRow>("billing_grants", { id }) ?? null;
  }

  /** Notes kept for [ids] (operator details, early endings). */
  notes(ids: readonly string[]): Map<string, GrantNoteRow> {
    if (ids.length === 0) return new Map();
    return new Map(this.rows.all<GrantNoteRow>("billing_grant_notes", { where: { grant_id: { in: [...ids] } } }).map((n) => [n.grant_id, n]));
  }

  /**
   * Ends a grant early. Its dates are shortened so every reader sees it over (to now, or to an instant already past if
   * it hadn't started); the original dates and who ended it are kept in billing_grant_notes. Ending one that has
   * already run out changes nothing.
   */
  async end(id: string, actor: string): Promise<{ grant: GrantRow; changed: boolean }> {
    const t = this.clock();
    const g = this.get(id);
    if (!g) throw notFound("No such free period");
    if (g.ends_at <= t) return { grant: g, changed: false };
    const starts = Math.min(g.starts_at, t - 1);
    await this.rows.write((w) => {
      w.update("billing_grants", { id }, { starts_at: starts, ends_at: t });
      const note = { ended_at: t, ended_by: actor, original_starts_at: g.starts_at, original_ends_at: g.ends_at };
      w.upsert("billing_grant_notes", { grant_id: id, ...note }, note);
    });
    return { grant: this.get(id)!, changed: true };
  }

  /** Grants newest first, keyset-paged by (created_at, id); one row more than [limit] says another page follows. */
  list(q: { accountId?: string; source?: GrantSource; state?: "active" | "upcoming" | "over"; after?: { createdAt: number; id: string } | null; limit: number }): GrantRow[] {
    const t = this.clock();
    const where: Where = {};
    if (q.accountId) where.account_id = q.accountId;
    if (q.source) where.source = q.source;
    if (q.state === "active") Object.assign(where, { starts_at: { lte: t }, ends_at: { gt: t } });
    else if (q.state === "upcoming") Object.assign(where, { starts_at: { gt: t } });
    else if (q.state === "over") where.ends_at = { lte: t };
    const after = q.after;
    return this.rows
      .all<GrantRow>("billing_grants", { where, orderBy: [["created_at", "desc"], ["id", "desc"]] })
      .filter((r) => !after || r.created_at < after.createdAt || (r.created_at === after.createdAt && r.id < after.id))
      .slice(0, q.limit + 1);
  }

  /** Program figures for the console: free periods running now by source, invites, and bonus days given. */
  figures(t: number) {
    const running = this.rows.all<GrantRow>("billing_grants", { where: { starts_at: { lte: t }, ends_at: { gt: t } } });
    const referrals = this.rows.all<{ inviter_account_id: string; inviter_days: number; created_at: number }>("billing_referrals");
    return {
      accountsInFreePeriod: new Set(running.map((g) => g.account_id)).size,
      activeBySource: Object.fromEntries(GRANT_SOURCES.map((s) => [s, running.filter((g) => g.source === s).length])) as Record<GrantSource, number>,
      referrals: {
        total: referrals.length,
        last30Days: referrals.filter((r) => r.created_at > t - 30 * DAY_MS).length,
        inviters: new Set(referrals.map((r) => r.inviter_account_id)).size,
        bonusDaysGiven: referrals.reduce((n, r) => n + r.inviter_days, 0),
        atCap: referrals.filter((r) => r.inviter_days === 0).length,
      },
    };
  }

  /** Recent invites, newest first. */
  referrals(limit: number) {
    return this.rows.all<{ id: string; inviter_account_id: string; invitee_account_id: string; code: string; inviter_days: number; created_at: number }>("billing_referrals", {
      orderBy: [["created_at", "desc"], ["id", "desc"]],
      limit,
    });
  }

  /** The account's invite code if it has made one (the console never makes one for it). */
  existingCode(accountId: string): string | null {
    return this.rows.get<{ code: string }>("billing_referral_codes", { account_id: accountId })?.code ?? null;
  }

  invitedCount(accountId: string): number {
    return this.rows.count("billing_referrals", { inviter_account_id: accountId });
  }

  /** Who invited [accountId], if it joined through a link. */
  invitedBy(accountId: string): { inviterAccountId: string; at: number } | null {
    const r = this.rows.get<{ inviter_account_id: string; created_at: number }>("billing_referrals", { invitee_account_id: accountId });
    return r ? { inviterAccountId: r.inviter_account_id, at: r.created_at } : null;
  }
}
