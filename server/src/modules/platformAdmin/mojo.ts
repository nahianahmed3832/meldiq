import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import type { AccountRow } from "../accounts/index.js";
import {
  giftRows,
  type GrantNoteRow,
  type GrantRow,
  type GrantSource,
  isAddonPlanKey,
  LIMIT_BOUNDS,
  levelsWith,
  type LevelOverrides,
  type PlanOverrides,
  PLAN_PERKS,
  plansWith,
  type ProgramSettings,
  type ProgramState,
  resolveEntitlements,
  settingsOfEnvironment,
  SPARK_LEVELS,
  mojoFigures,
  sparkOrgIds,
} from "../billing/index.js";
import { effectiveFileMaxBytes } from "../../app/config.js";
import { orgNames } from "../organizations/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { decodeCursor, page } from "./pagination.js";
import { can } from "./permissions.js";
import { flatDetail } from "./quotasAdmin.js";

const REFERRALS_SHOWN = 25;
const ACCOUNT_GRANTS_SHOWN = 50;
const SPARK_COMMUNITIES_SHOWN = 100;

type ProgramBody = ({ useEnvironment: true } | ProgramSettings) & { reason: string };

/**
 * Meldiq Mojo in the console (docs/BILLING.md › Running trials from the console, docs/MOJO.md › Running Mojo from the
 * console): the trial and invite program, every account's free periods, free periods operators give or end, whether
 * plan limits are enforced and their numbers, and gifts and Sparks as metadata. Paid subscriptions are never touched
 * here; they change only through the provider's verified events. Every change is audited with its before and after.
 */
export class AdminMojo {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
  ) {}

  private record(p: AdminPrincipal, action: string, targetType: string, targetId: string, reason: string, meta: RequestMeta, detail: Record<string, unknown>) {
    this.audit.record({
      action,
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType,
      targetId,
      reason,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail: flatDetail(detail),
    });
  }

  /** Accounts by id, read once each (grants, referrals and admins on one page share a few accounts). */
  private async accounts(ids: (string | null)[]): Promise<Map<string, AccountRow>> {
    const out = new Map<string, AccountRow>();
    for (const id of new Set(ids.filter((x): x is string => !!x))) {
      const a = await this.ctx.accounts.store.accountById(id);
      if (a) out.set(id, a);
    }
    return out;
  }

  private accountRef(p: AdminPrincipal, id: string, known: Map<string, AccountRow>) {
    const a = known.get(id);
    return { accountId: id, name: a?.name ?? null, email: a && can(p.grant.role, "users.view_email") ? a.email : null, userId: a?.user_id ?? null };
  }

  private adminRef(id: string | null, known: Map<string, AccountRow>) {
    return id ? { accountId: id, name: known.get(id)?.name ?? null } : null;
  }

  private grantView(p: AdminPrincipal, g: GrantRow, note: GrantNoteRow | undefined, known: Map<string, AccountRow>, t: number) {
    const ended = note?.ended_at ?? null;
    const state = ended !== null ? "ended" : g.ends_at <= t ? "over" : g.starts_at > t ? "upcoming" : "active";
    return {
      id: g.id,
      account: this.accountRef(p, g.account_id, known),
      planKey: g.plan_key,
      source: g.source,
      // An ended grant shows the dates it had; when it ended is endedAt.
      startsAt: note?.original_starts_at ?? g.starts_at,
      endsAt: note?.original_ends_at ?? g.ends_at,
      createdAt: g.created_at,
      state: state as "active" | "upcoming" | "over" | "ended",
      grantedBy: this.adminRef(note?.granted_by ?? null, known),
      note: note?.note ?? null,
      endedAt: ended,
      endedBy: this.adminRef(note?.ended_by ?? null, known),
    };
  }

  private async grantViews(p: AdminPrincipal, grants: GrantRow[]) {
    const notes = this.ctx.billing.grants.notes(grants.map((g) => g.id));
    const known = await this.accounts(grants.flatMap((g) => [g.account_id, notes.get(g.id)?.granted_by ?? null, notes.get(g.id)?.ended_by ?? null]));
    const t = now();
    return grants.map((g) => this.grantView(p, g, notes.get(g.id), known, t));
  }

  // ───────────── The program ─────────────

  private warnings(s: ProgramSettings): string[] {
    const plan = this.ctx.billing.catalog.byKey(s.planKey);
    const out: string[] = [];
    if (!plan) out.push(`There's no plan with the key "${s.planKey}" yet. Free periods still record it, and apply its limits once the plan exists.`);
    else if (plan.audience !== "personal") out.push(`${plan.name} is an organization plan; free periods are for people's own accounts.`);
    if (s.enabled && s.startsAt !== null && s.startsAt > now()) out.push(`The program starts on ${new Date(s.startsAt).toISOString()}; until then nobody gets a trial.`);
    if (s.enabled && s.referralDays > 0 && s.referralCapDays === 0) out.push("The yearly cap is 0, so inviters get no bonus days.");
    return out;
  }

  async program(p: AdminPrincipal) {
    const state = this.ctx.billing.program.state();
    const env = this.ctx.config.billing.trials;
    const t = now();
    const referrals = this.ctx.billing.grants.referrals(REFERRALS_SHOWN);
    const known = await this.accounts([state.updatedBy, ...referrals.flatMap((r) => [r.inviter_account_id, r.invitee_account_id])]);
    const live = this.ctx.billing.grants.config;
    return {
      source: state.source,
      settings: state.settings,
      live: !!live && t >= live.startsAt,
      environment: settingsOfEnvironment(env),
      updatedBy: this.adminRef(state.updatedBy, known),
      updatedAt: state.updatedAt,
      plans: this.ctx.billing.catalog
        .all()
        .filter((plan) => !isAddonPlanKey(plan.key))
        .sort((a, b) => (a.audience === b.audience ? a.key.localeCompare(b.key) : a.audience === "personal" ? -1 : 1))
        .map((plan) => {
          const v = this.ctx.billing.catalog.current(plan.id);
          return { key: plan.key, name: plan.name, audience: plan.audience, status: plan.status, hasLimits: !!v && (v.quota_plan_id !== null || v.limits !== "{}" || plan.key in PLAN_PERKS) };
        }),
      warnings: this.warnings(state.settings),
      figures: this.ctx.billing.grants.figures(t),
      referrals: referrals.map((r) => ({
        id: r.id,
        inviter: this.accountRef(p, r.inviter_account_id, known),
        invitee: this.accountRef(p, r.invitee_account_id, known),
        inviterDays: r.inviter_days,
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * Saves the program (or hands it back to the environment). Turning it on without a start date starts it now. Grants
   * already given keep their dates either way: turning the program off stops new trials and invite bonuses only.
   */
  async setProgram(p: AdminPrincipal, b: ProgramBody, meta: RequestMeta) {
    const t = now();
    let before: ProgramState;
    if ("useEnvironment" in b) {
      before = await this.ctx.billing.program.useEnvironment();
    } else {
      const { reason: _r, ...settings } = b;
      const startsAt = settings.enabled && settings.startsAt === null ? t : settings.startsAt;
      if (settings.claimWindowDays === 0 && settings.enabled && settings.referralDays > 0) {
        throw new ApiError(400, "invalid_policy", "With a claim window of 0 days no invite link can count. Use at least 1 day, or set invite days to 0.");
      }
      before = await this.ctx.billing.program.save({ ...settings, startsAt }, p.account.id, t);
    }
    const after = this.ctx.billing.program.state();
    this.record(p, "billing.program_update", "billing_program", "trials", b.reason, meta, { before: { source: before.source, ...before.settings }, after: { source: after.source, ...after.settings } });
    return this.program(p);
  }

  // ───────────── Free periods ─────────────

  async grants(p: AdminPrincipal, q: { account?: string; source?: GrantSource; state?: "active" | "upcoming" | "over"; cursor?: string; limit: number }) {
    const rows = this.ctx.billing.grants.list({ accountId: q.account, source: q.source, state: q.state, after: decodeCursor(q.cursor), limit: q.limit });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    return { grants: await this.grantViews(p, shown), nextCursor };
  }

  private async target(p: AdminPrincipal, b: { accountId?: string; email?: string }): Promise<AccountRow> {
    if (b.email !== undefined && !can(p.grant.role, "users.view_email")) throw forbidden("Your console role can't look people up by email. Give it from their page instead.");
    const a = b.accountId ? await this.ctx.accounts.store.accountById(b.accountId) : await this.ctx.accounts.store.accountByEmail(b.email!);
    if (!a) throw notFound("No account with that id or email");
    return a;
  }

  async give(p: AdminPrincipal, b: { accountId?: string; email?: string; days: number; planKey?: string; reason: string }, meta: RequestMeta) {
    const a = await this.target(p, b);
    const planKey = b.planKey ?? this.ctx.billing.program.state().settings.planKey;
    // After any free period of the same or a higher plan (as gifts do), so days add up.
    const laterThan = planKey === "go" ? ["go", "plus"] : [planKey];
    const g = await this.ctx.billing.grants.give({ accountId: a.id, createdAt: a.created_at, userId: a.user_id }, { planKey, days: b.days, actor: p.account.id, note: b.reason, laterThan });
    this.record(p, "billing.grant_give", "account", a.id, b.reason, meta, { grant: g.id, plan: planKey, days: b.days, from: new Date(g.starts_at).toISOString(), until: new Date(g.ends_at).toISOString() });
    this.ctx.billing.changed({ kind: "account", accountId: a.id });
    return { grant: (await this.grantViews(p, [g]))[0]!, changed: true };
  }

  async end(p: AdminPrincipal, grantId: string, reason: string, meta: RequestMeta) {
    const { grant, changed } = await this.ctx.billing.grants.end(grantId, p.account.id);
    if (changed) {
      this.record(p, "billing.grant_end", "account", grant.account_id, reason, meta, { grant: grant.id, source: grant.source, wasUntil: new Date(grant.ends_at).toISOString() });
      this.ctx.billing.changed({ kind: "account", accountId: grant.account_id });
    }
    return { grant: (await this.grantViews(p, [grant]))[0]!, changed };
  }

  // ───────────── One account ─────────────

  async account(p: AdminPrincipal, accountId: string) {
    const a = await this.ctx.accounts.store.accountById(accountId);
    if (!a) throw notFound("No such account");
    const t = now();
    const grants = this.ctx.billing.grants.list({ accountId, limit: ACCOUNT_GRANTS_SHOWN }).slice(0, ACCOUNT_GRANTS_SHOWN);
    const invitedBy = this.ctx.billing.grants.invitedBy(accountId);
    const known = await this.accounts([accountId, invitedBy?.inviterAccountId ?? null]);
    const personal = resolveEntitlements(this.ctx.billing, { accountId, userId: a.user_id, organizations: [] }, () => [], t).personal;
    const subscription = this.ctx.billing.subscriptions.liveForOwner({ kind: "account", accountId });
    return {
      account: { ...this.accountRef(p, accountId, known), createdAt: a.created_at },
      current: {
        plan: personal.plan,
        from: (personal.trial ? "free_period" : personal.plan ? "subscription" : "none") as "subscription" | "free_period" | "none",
        accessUntil: personal.accessUntil,
        renews: personal.renews,
      },
      subscriptionId: subscription?.id ?? null,
      grants: await this.grantViews(p, grants),
      referral: {
        code: this.ctx.billing.grants.existingCode(accountId),
        invited: this.ctx.billing.grants.invitedCount(accountId),
        bonusDaysThisYear: this.ctx.billing.grants.bonusDaysInYear(accountId, t),
        invitedBy: invitedBy ? this.accountRef(p, invitedBy.inviterAccountId, known) : null,
      },
    };
  }

  // ───────────── Enforcement and limits ─────────────

  private figures() {
    return mojoFigures(this.ctx.billing, (orgId, t) => this.ctx.mojo.levelOf(orgId, t).level, now());
  }

  async controls() {
    const c = this.ctx.billing.mojoControls;
    const state = c.state();
    const known = await this.accounts([state.updatedBy]);
    const environment = this.ctx.config.mojoEnforce;
    const plans = plansWith(state.plans);
    return {
      enforced: this.ctx.mojo.enforced(),
      enforce: { console: state.enforce, environment, effective: state.enforce ?? environment },
      plans: Object.values(plans).map((x) => ({ ...x, screen: [...x.screen] })),
      builtInPlans: Object.values(PLAN_PERKS).map((x) => ({ ...x, screen: [...x.screen] })),
      levels: levelsWith(state.levels).map((l) => ({ ...l, screen: [...l.screen] })),
      builtInLevels: SPARK_LEVELS.map((l) => ({ ...l, screen: [...l.screen] })),
      overrides: { plans: state.plans as Record<string, Record<string, number>>, levels: state.levels as Record<string, Record<string, number>> },
      bounds: LIMIT_BOUNDS as Record<string, { min: number; max: number }>,
      serverFileMaxBytes: effectiveFileMaxBytes(this.ctx.config),
      catalogVersion: c.version(),
      updatedBy: this.adminRef(state.updatedBy, known),
      updatedAt: state.updatedAt,
      figures: this.figures(),
    };
  }

  /**
   * Saves enforcement and the limits (checked against their bounds; Spark thresholds must rise). Applies at once: every
   * limit is read through Mojo on each request, and clients read the catalog again when its version changes.
   */
  async setControls(p: AdminPrincipal, b: { enforce: "on" | "off" | "auto" | null; plans: PlanOverrides; levels: LevelOverrides; reason: string }, meta: RequestMeta) {
    const strip = <T extends Record<string, Record<string, number | undefined> | undefined>>(o: T) =>
      Object.fromEntries(
        Object.entries(o)
          .map(([k, v]) => [k, Object.fromEntries(Object.entries(v ?? {}).filter(([, n]) => n !== undefined))])
          .filter(([, v]) => Object.keys(v as object).length > 0),
      );
    const before = this.ctx.billing.mojoControls.state();
    const enforcedBefore = this.ctx.mojo.enforced();
    await this.ctx.billing.mojoControls.save({ enforce: b.enforce, plans: strip(b.plans) as PlanOverrides, levels: strip(b.levels) as LevelOverrides }, p.account.id, now());
    const after = this.ctx.billing.mojoControls.state();
    this.record(p, "mojo.controls_update", "mojo_controls", "mojo", b.reason, meta, {
      enforceBefore: before.enforce ?? "environment",
      enforceAfter: after.enforce ?? "environment",
      enforcedBefore,
      enforcedAfter: this.ctx.mojo.enforced(),
      plansBefore: before.plans,
      plansAfter: after.plans,
      levelsBefore: before.levels,
      levelsAfter: after.levels,
    });
    return this.controls();
  }

  // ───────────── Gifts and Sparks (metadata) ─────────────

  async gifts(p: AdminPrincipal, q: { status?: string; cursor?: string; limit: number }) {
    const after = decodeCursor(q.cursor);
    const rows = giftRows(this.ctx.billing, { status: q.status, after: after ?? null, limit: q.limit });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    const known = await this.accounts(shown.map((g) => g.buyer_account_id));
    return {
      gifts: shown.map((g) => ({
        id: g.id,
        buyer: this.accountRef(p, g.buyer_account_id, known),
        recipientUserId: g.recipient_user_id,
        planKey: g.plan_key,
        months: g.months,
        currency: g.currency,
        amountMinor: g.amount_minor,
        status: g.status,
        provider: g.provider,
        createdAt: g.created_at,
        paidAt: g.paid_at,
        redeemedAt: g.redeemed_at,
      })),
      nextCursor,
    };
  }

  sparks() {
    const t = now();
    const orgs = sparkOrgIds(this.ctx.billing);
    const names = orgNames(this.ctx.ws, orgs);
    const levels = this.ctx.billing.mojoControls.levels();
    const communities = orgs
      .map((orgId) => {
        const l = this.ctx.mojo.levelOf(orgId, t);
        const next = levels.find((x) => x.level === l.level + 1);
        return { orgId, name: names.get(orgId) ?? null, active: l.active, level: l.level, nextAt: next ? next.sparks : null };
      })
      .sort((a, b) => b.active - a.active || a.orgId.localeCompare(b.orgId))
      .slice(0, SPARK_COMMUNITIES_SHOWN);
    return { communities };
  }
}
