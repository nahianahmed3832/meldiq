import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { ENTITLEMENT_KEYS, type EntitlementKey, isEntitlementKey } from "../administration/index.js";

/**
 * The plan catalog (docs/BILLING.md › Catalog). A plan's terms are versions: a draft may be edited, publishing freezes
 * it (a database trigger refuses any later change) and makes it the version new subscribers get. The previous version
 * stops being offered but every subscription on it keeps it: editing the catalog never reprices anyone.
 */
export type PlanStatus = "draft" | "active" | "archived";
/** Who a plan is for: a person's own account, or an organization (bought by its owner, used by its members). */
export type PlanAudience = "personal" | "organization";
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
  /** The quota plan (modules/quotas) subscribers are on while the plan grants; null: none. */
  quotaPlanId?: string | null;
}

export interface PlanMeta {
  name: string;
  description: string;
  segment: string;
  public: boolean;
  /** Fixed when the plan is created (default "organization"); never changed afterwards. */
  audience?: PlanAudience;
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
  quota_plan_id: string | null;
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
  audience: PlanAudience;
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

/** Whether a quota plan id names an existing, unarchived quota plan (the quota module answers). */
export type QuotaPlanCheck = (id: string) => boolean;

function validateTerms(t: PlanTerms, quotaPlanExists: QuotaPlanCheck): void {
  if (t.quotaPlanId && !quotaPlanExists(t.quotaPlanId)) throw new ApiError(400, "bad_request", `No quota plan "${t.quotaPlanId}"`);
  if (!CURRENCIES.has(t.currency)) throw new ApiError(400, "bad_request", `${t.currency} isn't an ISO 4217 currency code`);
  for (const [k, v] of Object.entries(t.limits)) {
    if (!isEntitlementKey(k)) throw new ApiError(400, "bad_request", `Unknown limit "${k}" (known: ${ENTITLEMENT_KEYS.join(", ")})`);
    if (!Number.isSafeInteger(v) || v < 0) throw new ApiError(400, "bad_request", `The ${k} limit must be a whole number, 0 or more`);
  }
}

export class PlanCatalog {
  constructor(
    private readonly rows: Rows,
    private readonly quotaPlanExists: QuotaPlanCheck = () => false,
  ) {}

  plan(id: string): PlanRow | null {
    return this.rows.get<PlanRow>("billing_plans", { id }) ?? null;
  }

  versions(planId: string): VersionRow[] {
    return this.rows.all<VersionRow>("billing_plan_versions", { where: { plan_id: planId }, orderBy: [["version", "desc"]] });
  }

  version(id: string): VersionRow | null {
    return this.rows.get<VersionRow>("billing_plan_versions", { id }) ?? null;
  }

  /** The version new subscribers get: the newest published one that isn't retired, on a plan that's active. */
  current(planId: string): VersionRow | null {
    if (this.plan(planId)?.status !== "active") return null;
    return this.rows.get<VersionRow>("billing_plan_versions", { plan_id: planId, published_at: { ne: null }, retired_at: null }, [["version", "desc"]]) ?? null;
  }

  /** A published version by its provider price: how a provider's subscription finds its terms. */
  byPrice(provider: string, priceRef: string): VersionRow | null {
    return this.rows.get<VersionRow>("billing_plan_versions", { provider, provider_price_ref: priceRef, published_at: { ne: null } }) ?? null;
  }

  byKey(key: string): PlanRow | null {
    return this.rows.get<PlanRow>("billing_plans", { key }) ?? null;
  }

  /** Every version of the plan with [key] (the Spark add-on's: its subscriptions sit beside a plan's). */
  versionIdsOf(key: string): Set<string> {
    const plan = this.byKey(key);
    return new Set(plan ? this.versions(plan.id).map((v) => v.id) : []);
  }

  all(): PlanRow[] {
    // Archived plans last, then by name (SQLite's ORDER BY status = 'archived', name).
    return this.rows
      .all<PlanRow>("billing_plans", { orderBy: [["name", "asc"]] })
      .sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived"));
  }

  /** How many subscriptions are on each version (any state), for "who keeps these terms". */
  subscriberCounts(): Map<string, { total: number; live: number }> {
    const counts = new Map<string, { total: number; live: number }>();
    for (const s of this.rows.all<{ plan_version_id: string; status: string }>("billing_subscriptions")) {
      const c = counts.get(s.plan_version_id) ?? { total: 0, live: 0 };
      counts.set(s.plan_version_id, { total: c.total + 1, live: c.live + (s.status === "canceled" || s.status === "incomplete_expired" ? 0 : 1) });
    }
    return counts;
  }

  /** A new plan with its first draft. */
  async create(key: string, meta: PlanMeta, terms: PlanTerms, actor: string, t: number): Promise<PlanRow> {
    validateTerms(terms, this.quotaPlanExists);
    const id = newId("pl");
    await this.rows.write((w) => {
      if (w.get("billing_plans", { key })) throw conflict(`A plan with the key "${key}" exists already`);
      w.insert("billing_plans", {
        id, key, name: meta.name, description: meta.description, segment: meta.segment, public: meta.public ? 1 : 0, audience: meta.audience ?? "organization", status: "draft",
        created_by: actor, created_at: t, updated_at: t,
      });
      this.insertDraft(w, id, 1, terms, actor, t);
    });
    return this.plan(id)!;
  }

  private insertDraft(w: RowWriter, planId: string, version: number, terms: PlanTerms, actor: string, t: number): void {
    w.insert("billing_plan_versions", {
      id: newId("pv"), plan_id: planId, version, interval: terms.interval, currency: terms.currency, amount_minor: terms.amountMinor, provider_price_ref: terms.providerPriceRef,
      trial_days: terms.trialDays, grace_days: terms.graceDays, limits: JSON.stringify(terms.limits), notes: terms.notes, quota_plan_id: terms.quotaPlanId ?? null,
      created_by: actor, created_at: t, updated_at: t,
    });
  }

  async updateMeta(planId: string, meta: PlanMeta, t: number): Promise<PlanRow> {
    const changed = await this.rows.write((w) =>
      w.update("billing_plans", { id: planId }, { name: meta.name, description: meta.description, segment: meta.segment, public: meta.public ? 1 : 0, updated_at: t }),
    );
    if (changed === 0) throw notFound("No such plan");
    return this.plan(planId)!;
  }

  /** Saves the plan's draft terms, starting a new draft version when every version is published. */
  async saveDraft(planId: string, terms: PlanTerms, actor: string, t: number): Promise<VersionRow> {
    validateTerms(terms, this.quotaPlanExists);
    await this.rows.write((w) => {
      const plan = w.get<PlanRow>("billing_plans", { id: planId });
      if (!plan) throw notFound("No such plan");
      if (plan.status === "archived") throw conflict("This plan is archived");
      const latest = w.get<VersionRow>("billing_plan_versions", { plan_id: planId }, [["version", "desc"]]);
      // A published version is never changed (SQLite also refuses it with a trigger): only the draft is edited.
      if (latest && latest.published_at === null) {
        w.update("billing_plan_versions", { id: latest.id }, {
          interval: terms.interval, currency: terms.currency, amount_minor: terms.amountMinor, provider_price_ref: terms.providerPriceRef, trial_days: terms.trialDays,
          grace_days: terms.graceDays, limits: JSON.stringify(terms.limits), notes: terms.notes, quota_plan_id: terms.quotaPlanId ?? null, updated_at: t,
        });
      } else {
        this.insertDraft(w, planId, (latest?.version ?? 0) + 1, terms, actor, t);
      }
    });
    return this.versions(planId)[0]!;
  }

  /**
   * Publishes the draft for [provider]: it becomes what new subscribers get, and the version before it stops being
   * offered (its subscribers keep it). Needs the provider's price id, unused by any other published version.
   */
  async publish(planId: string, provider: string, actor: string, t: number): Promise<{ published: VersionRow; retired: VersionRow | null }> {
    const previous = this.current(planId);
    const draftId = await this.rows.write((w) => {
      const plan = w.get<PlanRow>("billing_plans", { id: planId });
      if (!plan) throw notFound("No such plan");
      if (plan.status === "archived") throw conflict("This plan is archived");
      const draft = w.get<VersionRow>("billing_plan_versions", { plan_id: planId }, [["version", "desc"]]);
      if (!draft || draft.published_at !== null) throw conflict("There's no draft to publish: save new terms first");
      if (!draft.provider_price_ref) throw conflict("Add the billing provider's price id before publishing");
      if (w.get("billing_plan_versions", { provider, provider_price_ref: draft.provider_price_ref, id: { ne: draft.id } })) {
        throw conflict("Another plan version already uses this provider price id");
      }
      w.update("billing_plan_versions", { id: draft.id }, { provider, published_at: t, published_by: actor, updated_at: t });
      w.update("billing_plan_versions", { plan_id: planId, published_at: { ne: null }, retired_at: null, id: { ne: draft.id } }, { retired_at: t });
      w.update("billing_plans", { id: planId }, { status: "active", updated_at: t });
      return draft.id;
    });
    return { published: this.version(draftId)!, retired: previous ? this.version(previous.id) : null };
  }

  /** Stops offering the plan. Its subscribers keep their terms until their subscriptions end at the provider. */
  async archive(planId: string, t: number): Promise<PlanRow> {
    await this.rows.write((w) => {
      const plan = w.get<PlanRow>("billing_plans", { id: planId });
      if (!plan) throw notFound("No such plan");
      if (plan.status === "archived") throw conflict("This plan is archived already");
      w.update("billing_plan_versions", { plan_id: planId, published_at: { ne: null }, retired_at: null }, { retired_at: t });
      w.update("billing_plans", { id: planId }, { status: "archived", updated_at: t });
    });
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
    quotaPlanId: v.quota_plan_id,
  };
}
