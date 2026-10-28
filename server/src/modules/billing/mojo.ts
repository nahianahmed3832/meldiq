import type { Rows } from "../../infrastructure/database/rows/index.js";
import { ApiError, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import {
  isPlanKey,
  PLAN_PERKS,
  PLAN_RANK,
  type PlanKey,
  type PlanPerks,
  type ScreenPresetId,
  SPARK_PLAN_KEY,
  sparkLevel,
  type SparkLevel,
  unionPresets,
} from "./perks.js";
import type { Billing } from "./service.js";

/**
 * Meldiq Mojo's perks as they apply now (docs/MOJO.md): a person's plan (the highest of a paid subscription and any
 * free period: trial, invite bonus or gift), their Meldiq Sparks, and each server's Spark level. Everything is worked
 * out from verified billing rows on each call: a lapsed plan, a cancelled Spark or a member who left changes the answer
 * at once, with no job to run and nothing deleted.
 *
 * Sparks: a person has their plan's included Sparks plus the Spark add-on's quantity. Their assignments count oldest
 * first up to that many; the rest are paused (kept, and counting again when there's room). Only assignments of
 * current members count towards a server's level.
 */
export interface SparkAssignmentRow {
  id: string;
  user_id: string;
  org_id: string;
  assigned_at: number;
  removed_at: number | null;
  removed_reason: string | null;
}

/**
 * Whether plan limits are enforced (MOJO_ENFORCE): "on", "off", or "auto" (the default), which enforces them once Mojo
 * Go or Plus can actually be bought (a payment provider with the plans published). Until then nobody could raise a
 * limit, so people keep what they had: the server's own limits.
 */
export type MojoEnforce = "on" | "off" | "auto";

export function mojoEnforceFrom(env: NodeJS.ProcessEnv): MojoEnforce {
  const v = (env.MOJO_ENFORCE ?? "auto").trim().toLowerCase();
  if (v === "on" || v === "off" || v === "auto") return v;
  throw new Error('MOJO_ENFORCE must be "on", "off" or "auto"');
}

export interface MojoDeps {
  /** Whether [userId] is a member of [orgId] now (authorisation's answer). */
  isMember: (orgId: string, userId: string) => boolean;
  enforce?: MojoEnforce;
  /** Tells a community's members its Spark level may have changed (a realtime notice; they read it again). */
  notifyOrg?: (orgId: string) => void;
}

/** Oldest first, then by id: the order Sparks (and locked custom items) are counted in, the same on every backend. */
const byAge = <R extends { id: string }>(time: (r: R) => number) => (a: R, b: R) => time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class Mojo {
  constructor(
    private readonly billing: Billing,
    private readonly rows: Rows,
    private readonly deps: MojoDeps,
    private readonly clock: () => number = Date.now,
  ) {}

  // ───────────── plans ─────────────

  /** The plan that applies to [userId] (users.id) at [t]: the highest of a granting subscription and its free periods. */
  planOf(userId: string, t = this.clock()): PlanKey {
    let best: PlanKey = "free";
    const consider = (key: string | undefined) => {
      if (key && isPlanKey(key) && PLAN_RANK[key] > PLAN_RANK[best]) best = key;
    };
    for (const s of this.billing.subscriptions.liveForUser(userId)) {
      if (this.billing.subscriptions.isAddonVersion(s.plan_version_id) || !this.billing.subscriptions.grants(s, t)) continue;
      const v = this.billing.catalog.version(s.plan_version_id);
      consider(v ? this.billing.catalog.plan(v.plan_id)?.key : undefined);
    }
    for (const g of this.billing.grants.allActiveForUser(userId, t)) consider(g.plan_key);
    return best;
  }

  perksOf(userId: string, t = this.clock()): PlanPerks {
    return PLAN_PERKS[this.planOf(userId, t)];
  }

  // ───────────── Sparks ─────────────

  /** [userId]'s Sparks at [t]: included with their plan, and bought (the Spark add-on's quantity while it grants). */
  sparkSlots(userId: string, t = this.clock()): { included: number; purchased: number; total: number } {
    const included = this.perksOf(userId, t).sparks;
    let purchased = 0;
    for (const s of this.billing.subscriptions.liveForUser(userId)) {
      if (this.billing.subscriptions.isAddonVersion(s.plan_version_id) && this.billing.subscriptions.grants(s, t)) purchased += s.quantity;
    }
    return { included, purchased, total: included + purchased };
  }

  /** [userId]'s assignments that haven't been removed, oldest first (the first [total] of them are active). */
  assignmentsOf(userId: string): SparkAssignmentRow[] {
    return this.rows.all<SparkAssignmentRow>("spark_assignments", { where: { user_id: userId, removed_at: null } }).sort(byAge((r) => r.assigned_at));
  }

  /** Assignments that count now for [orgId]: by members, within each giver's Sparks. */
  activeFor(orgId: string, t = this.clock()): SparkAssignmentRow[] {
    const here = this.rows.all<SparkAssignmentRow>("spark_assignments", { where: { org_id: orgId, removed_at: null } });
    const givers = [...new Set(here.map((a) => a.user_id))].filter((u) => this.deps.isMember(orgId, u));
    return givers.flatMap((u) => {
      const active = new Set(this.assignmentsOf(u).slice(0, this.sparkSlots(u, t).total).map((a) => a.id));
      return here.filter((a) => a.user_id === u && active.has(a.id));
    });
  }

  /** The server's level now and what it gives everyone in it. */
  levelOf(orgId: string | null, t = this.clock()): SparkLevel & { active: number } {
    const active = orgId ? this.activeFor(orgId, t).length : 0;
    return { ...sparkLevel(active), active };
  }

  /** Gives one of [userId]'s free Sparks to [orgId], where they must be a member. */
  async assign(userId: string, orgId: string): Promise<SparkAssignmentRow> {
    if (!this.deps.isMember(orgId, userId)) throw notFound("Community not found");
    const t = this.clock();
    const total = this.sparkSlots(userId, t).total;
    const id = newId("spk");
    await this.rows.write((w) => {
      // Checked in the write unit, which runs alone: two taps at once can't give the same Spark twice.
      const held = w.count("spark_assignments", { user_id: userId, removed_at: null });
      if (total === 0) throw new ApiError(409, "no_sparks", "You don't have any Sparks. Mojo Go includes one, Mojo Plus two, and you can buy more.");
      if (held >= total) throw new ApiError(409, "no_free_sparks", "All your Sparks are given. Move one, or get another.");
      w.insert("spark_assignments", { id, user_id: userId, org_id: orgId, assigned_at: t, removed_at: null, removed_reason: null });
    });
    return this.rows.get<SparkAssignmentRow>("spark_assignments", { id })!;
  }

  /** Takes a Spark back (the row stays, as history). */
  async remove(userId: string, assignmentId: string): Promise<void> {
    const t = this.clock();
    const changed = await this.rows.write((w) => {
      const a = w.get<SparkAssignmentRow>("spark_assignments", { id: assignmentId });
      if (!a || a.removed_at !== null) throw notFound("Spark not found");
      if (a.user_id !== userId) throw forbidden("That Spark isn't yours");
      return w.update("spark_assignments", { id: assignmentId, removed_at: null }, { removed_at: t, removed_reason: "removed" });
    });
    if (changed === 0) throw notFound("Spark not found");
  }

  /** Moves a Spark to another community the person is in, in one step (no moment where it's in neither). */
  async move(userId: string, assignmentId: string, orgId: string): Promise<SparkAssignmentRow> {
    if (!this.deps.isMember(orgId, userId)) throw notFound("Community not found");
    const t = this.clock();
    const id = newId("spk");
    await this.rows.write((w) => {
      const a = w.get<SparkAssignmentRow>("spark_assignments", { id: assignmentId });
      if (!a || a.removed_at !== null) throw notFound("Spark not found");
      if (a.user_id !== userId) throw forbidden("That Spark isn't yours");
      if (a.org_id === orgId) throw conflict("That Spark is already there");
      w.update("spark_assignments", { id: assignmentId }, { removed_at: t, removed_reason: "moved" });
      // It keeps its place in the count: the moved Spark is as old as the one it replaces.
      w.insert("spark_assignments", { id, user_id: userId, org_id: orgId, assigned_at: a.assigned_at, removed_at: null, removed_reason: null });
    });
    return this.rows.get<SparkAssignmentRow>("spark_assignments", { id })!;
  }

  /** [userId]'s Sparks for their Mojo page: each with where it is and whether it counts now. */
  sparksView(userId: string, orgName: (orgId: string) => string | null, t = this.clock()) {
    const slots = this.sparkSlots(userId, t);
    const assignments = this.assignmentsOf(userId).map((a, i) => ({
      id: a.id,
      orgId: a.org_id,
      orgName: orgName(a.org_id),
      assignedAt: a.assigned_at,
      // Beyond the person's Sparks now (a plan ended): kept, and counting again when there's room.
      paused: i >= slots.total,
      member: this.deps.isMember(a.org_id, userId),
    }));
    return { ...slots, free: Math.max(0, slots.total - assignments.filter((a) => !a.paused).length), assignments };
  }

  notifyOrg(orgId: string): void {
    this.deps.notifyOrg?.(orgId);
  }

  /** Whether plan limits apply now (see [MojoEnforce]). Sparks, levels, gifts and badges work either way. */
  enforced(): boolean {
    const mode = this.deps.enforce ?? "auto";
    if (mode !== "auto") return mode === "on";
    const provider = this.billing.provider;
    if (!provider) return false;
    return (["go", "plus"] as const).some((key) => {
      const plan = this.billing.catalog.byKey(key);
      const v = plan && plan.public && plan.status === "active" ? this.billing.catalog.current(plan.id) : null;
      return !!v && v.provider === provider.id && !!v.provider_price_ref;
    });
  }

  /** The limits that apply to [userId] now: their plan's, or none of the plan limits while they aren't enforced. */
  limitsOf(userId: string, t = this.clock()): PlanPerks | null {
    return this.enforced() ? this.perksOf(userId, t) : null;
  }

  // ───────────── what applies where ─────────────

  /** The largest single file [userId] may share in [orgId] (or outside a community): the higher of plan and level. */
  uploadBytes(userId: string, orgId: string | null, t = this.clock()): number {
    if (!this.enforced()) return Number.MAX_SAFE_INTEGER;
    const personal = this.perksOf(userId, t).uploadBytes;
    const server = this.levelOf(orgId, t).uploadBytes ?? 0;
    return Math.max(personal, server);
  }

  /** Screen-share ceilings [userId] may use in [orgId]: their plan's and the server level's together. */
  screenPresets(userId: string, orgId: string | null, t = this.clock()): ScreenPresetId[] {
    // Not enforced: every preset, as before plans existed.
    if (!this.enforced()) return unionPresets(PLAN_PERKS.plus.screen, ["720p30", "720p60", "1080p30"]);
    return unionPresets(this.perksOf(userId, t).screen, this.levelOf(orgId, t).screen);
  }

  voiceKbps(orgId: string | null, t = this.clock()): number {
    return this.levelOf(orgId, t).voiceKbps;
  }

  // ───────────── badges ─────────────

  /** The badges [userIds] show (their plan's, unless they hid it), for member lists and profiles. */
  badges(userIds: readonly string[], t = this.clock()): Map<string, { badge: "go" | "plus"; check: boolean }> {
    const out = new Map<string, { badge: "go" | "plus"; check: boolean }>();
    for (const userId of new Set(userIds)) {
      const perks = this.perksOf(userId, t);
      if (!perks.badge || this.badgeHidden(userId)) continue;
      out.set(userId, { badge: perks.badge, check: perks.check });
    }
    return out;
  }

  badgeHidden(userId: string): boolean {
    return this.rows.get<{ badge_hidden: number }>("mojo_profile", { user_id: userId })?.badge_hidden === 1;
  }

  async setBadgeHidden(userId: string, hidden: boolean): Promise<void> {
    const t = this.clock();
    await this.rows.write((w) => w.upsert("mojo_profile", { user_id: userId, badge_hidden: hidden ? 1 : 0, updated_at: t }, { badge_hidden: hidden ? 1 : 0, updated_at: t }));
  }

  /** Whether the Spark add-on can be bought now (a published plan with the key "spark" at the configured provider). */
  sparksOnSale(): boolean {
    const plan = this.billing.catalog.byKey(SPARK_PLAN_KEY);
    const v = plan ? this.billing.catalog.current(plan.id) : null;
    return !!this.billing.provider && !!v && v.provider === this.billing.provider.id && !!v.provider_price_ref;
  }
}
