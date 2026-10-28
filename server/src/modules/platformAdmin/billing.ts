import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { ENTITLEMENT_KEYS, ENTITLEMENT_LABELS, type EntitlementKey, orgLimitOverrides } from "../administration/index.js";
import {
  BILLING_DEFINITIONS,
  billingMetrics,
  eventRows,
  type PlanMeta,
  type PlanRow,
  type PlanTerms,
  subscriptionRecords,
  subscriptionRows,
  type SubscriptionRow,
  termsOf,
  type VersionRow,
} from "../billing/index.js";
import { orgNames, orgRecord } from "../organizations/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { decodeCursor, page } from "./pagination.js";

const DAY_MS = 86_400_000;
/** The longest an operator limit may run before it must be set again (a super admin may choose no end). */
const MAX_LIMIT_DAYS = 366;
const DETAIL_ROWS = 50;

const limitsOf = (ctx: AppContext, orgId: string) => ENTITLEMENT_KEYS.map((key) => ({ key, ...ctx.entitlements.limitFor(key, orgId) }));

/**
 * Billing in the console (docs/BILLING.md): operator limits, the plan catalog, subscriptions, invoices and provider
 * events. Subscription state is never edited here: it comes only from verified provider events. What operators can do is
 * prepare and publish plans, set time-bounded limits, and replay a provider event that failed. Every change is audited.
 */
export class AdminBilling {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
  ) {}

  private record(p: AdminPrincipal, action: string, targetType: string, targetId: string, reason: string | null, meta: RequestMeta, detail: Record<string, string | number | boolean | null>) {
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
      detail,
    });
  }

  setup() {
    const provider = this.ctx.billing.provider;
    return {
      provider: provider ? { id: provider.id, mode: provider.mode } : null,
      reason: this.ctx.billing.unavailableReason,
      webhookPath: provider ? `/v1/billing/webhooks/${provider.id}` : null,
      entitlementKeys: ENTITLEMENT_KEYS.map((key) => ({ key, label: ENTITLEMENT_LABELS[key] })),
    };
  }

  // ───────────── Operator limits ─────────────

  overview() {
    const t = now();
    const overrides = orgLimitOverrides(this.ctx.db, t);
    const names = orgNames(this.ctx.db, [...new Set(overrides.map((o) => o.org_id))]);
    const server = this.ctx.config.entitlements.limits;
    return {
      billing: { available: !!this.ctx.billing.provider, reason: this.ctx.billing.unavailableReason },
      keys: ENTITLEMENT_KEYS.map((key) => ({ key, label: ENTITLEMENT_LABELS[key] })),
      serverLimits: ENTITLEMENT_KEYS.filter((k) => server[k] !== undefined).map((key) => ({ key, limit: server[key]! })),
      overrides: overrides.map((o) => ({ orgId: o.org_id, orgName: names.get(o.org_id) ?? null, key: o.key, limit: o.limit_value, setAt: o.set_at, expiresAt: o.expires_at, reason: o.reason })),
    };
  }

  /**
   * Sets or clears ([null]) an organization's own limits; the change and its before/after are audited together. Setting
   * a limit needs an end date within a year; no end ([expiresAt] null) is a super admin's explicit choice.
   */
  setLimits(p: AdminPrincipal, orgId: string, limits: Partial<Record<EntitlementKey, number | null>>, expiresAt: number | null | undefined, reason: string, meta: RequestMeta) {
    if (!orgRecord(this.ctx.db, orgId)) throw notFound("No such workspace or community");
    const t = now();
    const setting = Object.values(limits).some((v) => v !== null && v !== undefined);
    if (setting && expiresAt === undefined) throw new ApiError(400, "bad_request", "Choose when these limits end");
    if (setting && expiresAt === null && p.grant.role !== "super_admin") throw forbidden("Only a super admin may set a limit with no end date");
    if (setting && expiresAt != null && (expiresAt <= t || expiresAt > t + MAX_LIMIT_DAYS * DAY_MS)) throw new ApiError(400, "bad_request", "The end date must be in the next 366 days");
    const before = Object.fromEntries(limitsOf(this.ctx, orgId).filter((l) => l.source === "workspace").map((l) => [l.key, l.limit]));
    this.ctx.db.transaction(() => {
      this.ctx.entitlements.setLimits(orgId, `platform:${p.account.id}`, limits, t, expiresAt ?? null, reason);
      this.record(p, "org.limits", "org", orgId, reason, meta, {
        ...Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, `${before[k] ?? "default"} -> ${v ?? "default"}`])),
        ...(setting ? { until: expiresAt === null ? "no end" : new Date(expiresAt!).toISOString() } : {}),
      });
    })();
    return { limits: limitsOf(this.ctx, orgId) };
  }

  // ───────────── Plan catalog ─────────────

  private planView(plan: PlanRow, counts: Map<string, { total: number; live: number }>) {
    const versions = this.ctx.billing.catalog.versions(plan.id);
    const current = this.ctx.billing.catalog.current(plan.id);
    return {
      id: plan.id,
      key: plan.key,
      name: plan.name,
      description: plan.description,
      segment: plan.segment,
      public: plan.public === 1,
      audience: plan.audience,
      status: plan.status,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      versions: versions.map((v: VersionRow) => ({
        id: v.id,
        version: v.version,
        state: v.published_at === null ? ("draft" as const) : v.id === current?.id ? ("current" as const) : ("retired" as const),
        provider: v.provider,
        terms: termsOf(v),
        createdAt: v.created_at,
        publishedAt: v.published_at,
        retiredAt: v.retired_at,
        subscriptions: counts.get(v.id) ?? { total: 0, live: 0 },
      })),
    };
  }

  plans() {
    const counts = this.ctx.billing.catalog.subscriberCounts();
    return { setup: this.setup(), plans: this.ctx.billing.catalog.all().map((p) => this.planView(p, counts)) };
  }

  private one(planId: string) {
    const plan = this.ctx.billing.catalog.plan(planId);
    if (!plan) throw notFound("No such plan");
    return this.planView(plan, this.ctx.billing.catalog.subscriberCounts());
  }

  createPlan(p: AdminPrincipal, b: { key: string; terms: PlanTerms; reason: string } & PlanMeta, meta: RequestMeta) {
    const plan = this.ctx.db.transaction(() => {
      const created = this.ctx.billing.catalog.create(b.key, b, b.terms, p.account.id, now());
      this.record(p, "billing.plan_create", "billing_plan", created.id, b.reason, meta, { key: b.key, name: b.name });
      return created;
    })();
    return this.one(plan.id);
  }

  updatePlan(p: AdminPrincipal, planId: string, b: PlanMeta & { reason: string }, meta: RequestMeta) {
    this.ctx.db.transaction(() => {
      this.ctx.billing.catalog.updateMeta(planId, b, now());
      this.record(p, "billing.plan_update", "billing_plan", planId, b.reason, meta, { name: b.name, public: b.public });
    })();
    return this.one(planId);
  }

  saveDraft(p: AdminPrincipal, planId: string, terms: PlanTerms, reason: string, meta: RequestMeta) {
    this.ctx.db.transaction(() => {
      const v = this.ctx.billing.catalog.saveDraft(planId, terms, p.account.id, now());
      this.record(p, "billing.plan_draft", "billing_plan", planId, reason, meta, {
        version: v.version,
        price: `${terms.amountMinor} ${terms.currency}/${terms.interval}`,
        providerPriceRef: terms.providerPriceRef,
        limits: JSON.stringify(terms.limits),
      });
    })();
    return this.one(planId);
  }

  /** Publishes the draft for new subscribers. Existing subscribers keep the version they're on. */
  publish(p: AdminPrincipal, planId: string, reason: string, meta: RequestMeta) {
    const provider = this.ctx.billing.provider;
    if (!provider) throw new ApiError(409, "billing_unavailable", this.ctx.billing.unavailableReason ?? "Billing isn't available");
    this.ctx.db.transaction(() => {
      const { published, retired } = this.ctx.billing.catalog.publish(planId, provider.id, p.account.id, now());
      this.record(p, "billing.plan_publish", "billing_plan", planId, reason, meta, { version: published.version, provider: provider.id, retiredVersion: retired?.version ?? null });
    })();
    return this.one(planId);
  }

  archive(p: AdminPrincipal, planId: string, reason: string, meta: RequestMeta) {
    this.ctx.db.transaction(() => {
      this.ctx.billing.catalog.archive(planId, now());
      this.record(p, "billing.plan_archive", "billing_plan", planId, reason, meta, {});
    })();
    return this.one(planId);
  }

  // ───────────── Subscriptions ─────────────

  private summary(s: SubscriptionRow, names: Map<string, string>, t: number) {
    const v = this.ctx.billing.catalog.version(s.plan_version_id)!;
    const plan = this.ctx.billing.catalog.plan(v.plan_id)!;
    return {
      id: s.id,
      owner: { kind: s.owner_kind, id: s.org_id ?? s.account_id! },
      org: s.org_id ? { id: s.org_id, name: names.get(s.org_id) ?? null } : null,
      plan: { key: plan.key, name: plan.name, version: v.version },
      status: s.status,
      standing: this.ctx.billing.subscriptions.standingOf(s, t),
      provider: s.provider,
      providerSubscriptionRef: s.provider_subscription_ref,
      currentPeriodEnd: s.current_period_end,
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  }

  subscriptions(q: { status?: string; plan?: string; org?: string; cursor?: string; limit: number }) {
    const rows = subscriptionRows(this.ctx.db, { ...q, after: decodeCursor(q.cursor) });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    const names = orgNames(this.ctx.db, [...new Set(shown.flatMap((s) => (s.org_id ? [s.org_id] : [])))]);
    const t = now();
    return { subscriptions: shown.map((s) => this.summary(s, names, t)), nextCursor };
  }

  subscription(id: string) {
    const s = this.ctx.billing.subscriptions.get(id);
    if (!s) throw notFound("No such subscription");
    const t = now();
    const names = orgNames(this.ctx.db, s.org_id ? [s.org_id] : []);
    const v = this.ctx.billing.catalog.version(s.plan_version_id)!;
    const versionOf = (vid: string) => this.ctx.billing.catalog.version(vid)?.version ?? null;
    const { history, invoices, events } = subscriptionRecords(this.ctx.db, id, DETAIL_ROWS);
    return {
      subscription: {
        ...this.summary(s, names, t),
        billingUserId: s.billing_user_id,
        providerCustomerRef: s.provider_customer_ref,
        currentPeriodStart: s.current_period_start,
        trialEnd: s.trial_end,
        canceledAt: s.canceled_at,
        pastDueSince: s.past_due_since,
        terms: termsOf(v),
      },
      history: history.map((h) => ({ at: h.at, from: h.from_status, to: h.to_status, planVersion: versionOf(h.plan_version_id), source: h.source, detail: h.detail ? (JSON.parse(h.detail) as Record<string, unknown>) : {} })),
      invoices: invoices.map((i) => ({
        id: i.id,
        providerInvoiceRef: i.provider_invoice_ref,
        status: i.status,
        currency: i.currency,
        amountDueMinor: i.amount_due_minor,
        amountPaidMinor: i.amount_paid_minor,
        amountRefundedMinor: i.amount_refunded_minor,
        taxMinor: i.tax_minor,
        periodStart: i.period_start,
        periodEnd: i.period_end,
        issuedAt: i.issued_at,
        paidAt: i.paid_at,
      })),
      limits: s.org_id ? limitsOf(this.ctx, s.org_id) : [],
      events: events.map((e) => ({ id: e.id, type: e.type, status: e.status, receivedAt: e.received_at, lastError: e.last_error })),
    };
  }

  /** The organization's subscription for its console page, if one isn't over. */
  orgSubscription(orgId: string) {
    const s = this.ctx.billing.subscriptions.liveFor(orgId);
    if (!s) return null;
    const v = this.ctx.billing.catalog.version(s.plan_version_id)!;
    return { id: s.id, plan: this.ctx.billing.catalog.plan(v.plan_id)!.name, status: s.status, standing: this.ctx.billing.subscriptions.standingOf(s, now()), currentPeriodEnd: s.current_period_end };
  }

  // ───────────── Provider events and figures ─────────────

  events(q: { status?: string; cursor?: string; limit: number }) {
    const rows = eventRows(this.ctx.db, { status: q.status, after: decodeCursor(q.cursor), limit: q.limit });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    return {
      events: shown.map((e) => ({
        id: e.id,
        provider: e.provider,
        eventRef: e.event_ref,
        type: e.type,
        status: e.status,
        attempts: e.attempts,
        providerCreatedAt: e.provider_created_at,
        receivedAt: e.created_at,
        processedAt: e.processed_at,
        nextAttemptAt: e.next_attempt_at,
        lastError: e.last_error,
        subscriptionId: e.subscription_id,
      })),
      nextCursor,
    };
  }

  replay(p: AdminPrincipal, eventId: string, reason: string, meta: RequestMeta) {
    const status = this.ctx.billing.webhooks.replay(eventId);
    this.record(p, "billing.event_replay", "billing_event", eventId, reason, meta, { status });
    return { status };
  }

  metrics(days: number) {
    return { setup: this.setup(), ...billingMetrics(this.ctx.db, days, now()), definitions: BILLING_DEFINITIONS };
  }
}
