import type { DB } from "../../infrastructure/database/db.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { ENTITLEMENT_KEYS, type EntitlementKey, isEntitlementKey } from "../administration/index.js";

/**
 * The plan catalog (docs/BILLING.md › Catalog). A plan's terms are versions: a draft may be edited, publishing freezes
 * it (a database trigger refuses any later change) and makes it the version new subscribers get. The previous version
 * stops being offered but every subscription on it keeps it: editing the catalog never reprices anyone.
 */
export type PlanStatus = "draft" | "active" | "archived";
export type PlanLimits = Partial<Record<EntitlementKey, number>>;

export interface PlanTerms {
  interval: "month" | "year";
  currency: string;
  amountMinor: number;
  providerPriceRef: string | null;
  trialDays: number;
  graceDays: number;
  limits: PlanLimits;
  notes: string;
}

export interface PlanMeta {
  name: string;
  description: string;
  segment: string;
  public: boolean;
}

export interface VersionRow {
  id: string;
  plan_id: string;
  version: number;
  interval: "month" | "year";
  currency: string;
  amount_minor: number;
  provider: string | null;
  provider_price_ref: string | null;
  trial_days: number;
  grace_days: number;
  limits: string;
  notes: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  published_by: string | null;
  retired_at: number | null;
}

export interface PlanRow {
  id: string;
  key: string;
  name: string;
  description: string;
  segment: string;
  public: number;
  status: PlanStatus;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));

/** Plan limits from their stored JSON, keeping only keys this server knows. */
export function parseLimits(json: string): PlanLimits {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => isEntitlementKey(k) && Number.isSafeInteger(v) && (v as number) >= 0)) as PlanLimits;
}

function validateTerms(t: PlanTerms): void {
  if (!CURRENCIES.has(t.currency)) throw new ApiError(400, "bad_request", `${t.currency} isn't an ISO 4217 currency code`);
  for (const [k, v] of Object.entries(t.limits)) {
    if (!isEntitlementKey(k)) throw new ApiError(400, "bad_request", `Unknown limit "${k}" (known: ${ENTITLEMENT_KEYS.join(", ")})`);
    if (!Number.isSafeInteger(v) || v < 0) throw new ApiError(400, "bad_request", `The ${k} limit must be a whole number, 0 or more`);
  }
}

export class PlanCatalog {
  constructor(private readonly db: DB) {}

  plan(id: string): PlanRow | null {
    return (this.db.prepare("SELECT * FROM billing_plans WHERE id = ?").get(id) as PlanRow | undefined) ?? null;
  }

  versions(planId: string): VersionRow[] {
    return this.db.prepare("SELECT * FROM billing_plan_versions WHERE plan_id = ? ORDER BY version DESC").all(planId) as VersionRow[];
  }

  version(id: string): VersionRow | null {
    return (this.db.prepare("SELECT * FROM billing_plan_versions WHERE id = ?").get(id) as VersionRow | undefined) ?? null;
  }

  /** The version new subscribers get: the newest published one that isn't retired, on a plan that's active. */
  current(planId: string): VersionRow | null {
    return (
      (this.db
        .prepare("SELECT v.* FROM billing_plan_versions v JOIN billing_plans p ON p.id = v.plan_id WHERE v.plan_id = ? AND p.status = 'active' AND v.published_at IS NOT NULL AND v.retired_at IS NULL ORDER BY v.version DESC LIMIT 1")
        .get(planId) as VersionRow | undefined) ?? null
    );
  }

  /** A published version by its provider price: how a provider's subscription finds its terms. */
  byPrice(provider: string, priceRef: string): VersionRow | null {
    return (
      (this.db.prepare("SELECT * FROM billing_plan_versions WHERE provider = ? AND provider_price_ref = ? AND published_at IS NOT NULL").get(provider, priceRef) as VersionRow | undefined) ?? null
    );
  }

  byKey(key: string): PlanRow | null {
    return (this.db.prepare("SELECT * FROM billing_plans WHERE key = ?").get(key) as PlanRow | undefined) ?? null;
  }

  all(): PlanRow[] {
    return this.db.prepare("SELECT * FROM billing_plans ORDER BY status = 'archived', name").all() as PlanRow[];
  }

  /** How many subscriptions are on each version (any state), for "who keeps these terms". */
  subscriberCounts(): Map<string, { total: number; live: number }> {
    const rows = this.db
      .prepare("SELECT plan_version_id id, COUNT(*) total, SUM(status NOT IN ('canceled', 'incomplete_expired')) live FROM billing_subscriptions GROUP BY plan_version_id")
      .all() as { id: string; total: number; live: number | null }[];
    return new Map(rows.map((r) => [r.id, { total: r.total, live: r.live ?? 0 }]));
  }

  /** A new plan with its first draft. */
  create(key: string, meta: PlanMeta, terms: PlanTerms, actor: string, t: number): PlanRow {
    validateTerms(terms);
    if (this.byKey(key)) throw conflict(`A plan with the key "${key}" exists already`);
    const id = newId("pl");
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO billing_plans (id, key, name, description, segment, public, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)")
        .run(id, key, meta.name, meta.description, meta.segment, meta.public ? 1 : 0, actor, t, t);
      this.insertDraft(id, 1, terms, actor, t);
    })();
    return this.plan(id)!;
  }

  private insertDraft(planId: string, version: number, terms: PlanTerms, actor: string, t: number): void {
    this.db
      .prepare(
        `INSERT INTO billing_plan_versions (id, plan_id, version, interval, currency, amount_minor, provider_price_ref, trial_days, grace_days, limits, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId("pv"), planId, version, terms.interval, terms.currency, terms.amountMinor, terms.providerPriceRef, terms.trialDays, terms.graceDays, JSON.stringify(terms.limits), terms.notes, actor, t, t);
  }

  updateMeta(planId: string, meta: PlanMeta, t: number): PlanRow {
    if (!this.plan(planId)) throw notFound("No such plan");
    this.db.prepare("UPDATE billing_plans SET name = ?, description = ?, segment = ?, public = ?, updated_at = ? WHERE id = ?").run(meta.name, meta.description, meta.segment, meta.public ? 1 : 0, t, planId);
    return this.plan(planId)!;
  }

  /** Saves the plan's draft terms, starting a new draft version when every version is published. */
  saveDraft(planId: string, terms: PlanTerms, actor: string, t: number): VersionRow {
    validateTerms(terms);
    const plan = this.plan(planId);
    if (!plan) throw notFound("No such plan");
    if (plan.status === "archived") throw conflict("This plan is archived");
    const [latest] = this.versions(planId);
    if (latest && latest.published_at === null) {
      this.db
        .prepare("UPDATE billing_plan_versions SET interval = ?, currency = ?, amount_minor = ?, provider_price_ref = ?, trial_days = ?, grace_days = ?, limits = ?, notes = ?, updated_at = ? WHERE id = ?")
        .run(terms.interval, terms.currency, terms.amountMinor, terms.providerPriceRef, terms.trialDays, terms.graceDays, JSON.stringify(terms.limits), terms.notes, t, latest.id);
    } else {
      this.insertDraft(planId, (latest?.version ?? 0) + 1, terms, actor, t);
    }
    return this.versions(planId)[0]!;
  }

  /**
   * Publishes the draft for [provider]: it becomes what new subscribers get, and the version before it stops being
   * offered (its subscribers keep it). Needs the provider's price id, unused by any other published version.
   */
  publish(planId: string, provider: string, actor: string, t: number): { published: VersionRow; retired: VersionRow | null } {
    const plan = this.plan(planId);
    if (!plan) throw notFound("No such plan");
    if (plan.status === "archived") throw conflict("This plan is archived");
    const [draft] = this.versions(planId);
    if (!draft || draft.published_at !== null) throw conflict("There's no draft to publish: save new terms first");
    if (!draft.provider_price_ref) throw conflict("Add the billing provider's price id before publishing");
    const taken = this.db.prepare("SELECT 1 FROM billing_plan_versions WHERE provider = ? AND provider_price_ref = ? AND id != ?").get(provider, draft.provider_price_ref, draft.id);
    if (taken) throw conflict("Another plan version already uses this provider price id");
    const previous = this.current(planId);
    this.db.transaction(() => {
      this.db.prepare("UPDATE billing_plan_versions SET provider = ?, published_at = ?, published_by = ?, updated_at = ? WHERE id = ?").run(provider, t, actor, t, draft.id);
      this.db.prepare("UPDATE billing_plan_versions SET retired_at = ? WHERE plan_id = ? AND published_at IS NOT NULL AND retired_at IS NULL AND id != ?").run(t, planId, draft.id);
      this.db.prepare("UPDATE billing_plans SET status = 'active', updated_at = ? WHERE id = ?").run(t, planId);
    })();
    return { published: this.version(draft.id)!, retired: previous ? this.version(previous.id) : null };
  }

  /** Stops offering the plan. Its subscribers keep their terms until their subscriptions end at the provider. */
  archive(planId: string, t: number): PlanRow {
    const plan = this.plan(planId);
    if (!plan) throw notFound("No such plan");
    if (plan.status === "archived") throw conflict("This plan is archived already");
    this.db.transaction(() => {
      this.db.prepare("UPDATE billing_plan_versions SET retired_at = ? WHERE plan_id = ? AND published_at IS NOT NULL AND retired_at IS NULL").run(t, planId);
      this.db.prepare("UPDATE billing_plans SET status = 'archived', updated_at = ? WHERE id = ?").run(t, planId);
    })();
    return this.plan(planId)!;
  }
}

export function termsOf(v: VersionRow): PlanTerms {
  return {
    interval: v.interval,
    currency: v.currency,
    amountMinor: v.amount_minor,
    providerPriceRef: v.provider_price_ref,
    trialDays: v.trial_days,
    graceDays: v.grace_days,
    limits: parseLimits(v.limits),
    notes: v.notes,
  };
}
