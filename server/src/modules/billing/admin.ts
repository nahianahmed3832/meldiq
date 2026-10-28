import type { RowReader, Where } from "../../infrastructure/database/rows/index.js";
import type { GiftRow } from "./gifts.js";
import type { GrantRow } from "./grants.js";
import type { SparkAssignmentRow } from "./mojo.js";
import type { Billing } from "./service.js";
import type { SubscriptionRow } from "./subscriptions.js";

/**
 * Read models for the Platform Admin Console's billing pages (platformAdmin/billing.ts). Bounded and keyset-paged:
 * [after] is the last row's (time, id) of the previous page, and one row more than [limit] is read.
 */
export interface After {
  createdAt: number;
  id: string;
}

/** Keyset paging on (time, id) descending: rows at or before [after]'s time (the same-time rows are cut by [pageAfter]). */
function afterWhere(timeColumn: string, after: After | undefined): Where {
  return after ? { [timeColumn]: { lte: after.createdAt } } : {};
}

/** The page after [after] of rows sorted (time, id) descending: one more than [limit], like the SQL it replaces. */
function pageAfter<R extends { id: string }>(rows: R[], time: (r: R) => number, after: After | undefined, limit: number): R[] {
  const rest = after ? rows.filter((r) => time(r) < after.createdAt || (time(r) === after.createdAt && r.id < after.id)) : rows;
  return rest.sort((a, b) => time(b) - time(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, limit + 1);
}

export function subscriptionRows(rows: RowReader, q: { status?: string; plan?: string; org?: string; after?: After; limit: number }): SubscriptionRow[] {
  const where: Where = { ...afterWhere("created_at", q.after) };
  if (q.status) where.status = q.status;
  if (q.org) where.org_id = q.org;
  if (q.plan) {
    const plan = rows.get<{ id: string }>("billing_plans", { key: q.plan });
    where.plan_version_id = { in: plan ? rows.all<{ id: string }>("billing_plan_versions", { where: { plan_id: plan.id } }).map((v) => v.id) : [] };
  }
  return pageAfter(rows.all<SubscriptionRow>("billing_subscriptions", { where }), (r) => r.created_at, q.after, q.limit);
}

export interface HistoryRow {
  at: number;
  from_status: string | null;
  to_status: string;
  plan_version_id: string;
  source: string;
  detail: string | null;
}

export interface InvoiceRow {
  id: string;
  provider_invoice_ref: string;
  status: string;
  currency: string;
  amount_due_minor: number;
  amount_paid_minor: number;
  amount_refunded_minor: number;
  tax_minor: number | null;
  period_start: number | null;
  period_end: number | null;
  issued_at: number;
  paid_at: number | null;
}

export type EventStatus = "received" | "processed" | "ignored" | "failed" | "dead";

/** A subscription's latest history, invoices and provider events, newest first, [limit] of each. */
export function subscriptionRecords(rows: RowReader, id: string, limit: number) {
  return {
    history: rows.all<HistoryRow>("billing_subscription_history", { where: { subscription_id: id }, orderBy: [["id", "desc"]], limit }),
    invoices: rows.all<InvoiceRow>("billing_invoices", { where: { subscription_id: id }, orderBy: [["issued_at", "desc"]], limit }),
    events: rows.all<{ id: string; type: string; status: EventStatus; received_at: number; last_error: string | null }>("billing_provider_events", {
      where: { subscription_id: id },
      orderBy: [["received_at", "desc"]],
      limit,
    }),
  };
}

export interface EventListRow {
  id: string;
  provider: string;
  event_ref: string;
  type: string;
  status: EventStatus;
  attempts: number;
  provider_created_at: number;
  /** received_at, named for keyset paging. */
  created_at: number;
  processed_at: number | null;
  next_attempt_at: number | null;
  last_error: string | null;
  subscription_id: string | null;
}

export function eventRows(rows: RowReader, q: { status?: string; after?: After; limit: number }): EventListRow[] {
  const where: Where = { ...afterWhere("received_at", q.after) };
  if (q.status) where.status = q.status;
  const all = rows.all<Omit<EventListRow, "created_at"> & { received_at: number }>("billing_provider_events", { where });
  return pageAfter(all, (r) => r.received_at, q.after, q.limit).map(({ received_at, ...e }) => ({ ...e, created_at: received_at }));
}

// ───────────── Meldiq Mojo in the console (API 0.58.0) ─────────────

/** Accounts on each plan now (a granting subscription or a free period), Sparks by level, and gifts by state. */
export function mojoFigures(billing: Billing, levelOf: (orgId: string, t: number) => number, t: number) {
  const byPlan = new Map<string, Set<string>>();
  const add = (plan: string | undefined, account: string | null) => {
    if (plan && account) byPlan.set(plan, (byPlan.get(plan) ?? new Set()).add(account));
  };
  for (const s of billing.rows.all<SubscriptionRow>("billing_subscriptions", { where: { owner_kind: "account" } })) {
    if (billing.subscriptions.isAddonVersion(s.plan_version_id) || !billing.subscriptions.grants(s, t)) continue;
    const v = billing.catalog.version(s.plan_version_id);
    add(v ? billing.catalog.plan(v.plan_id)?.key : undefined, s.account_id);
  }
  for (const g of billing.rows.all<GrantRow>("billing_grants", { where: { starts_at: { lte: t }, ends_at: { gt: t } } })) add(g.plan_key, g.account_id);
  const assignments = billing.rows.all<SparkAssignmentRow>("spark_assignments", { where: { removed_at: null } });
  const orgs = [...new Set(assignments.map((a) => a.org_id))];
  const byLevel: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0 };
  for (const o of orgs) {
    const level = String(levelOf(o, t));
    byLevel[level] = (byLevel[level] ?? 0) + 1;
  }
  const gifts: Record<string, number> = {};
  for (const g of billing.rows.all<GiftRow>("mojo_gifts")) gifts[g.status] = (gifts[g.status] ?? 0) + 1;
  return { accountsByPlan: Object.fromEntries([...byPlan].map(([k, v]) => [k, v.size])), sparks: { assigned: assignments.length, communitiesWithSparks: orgs.length, byLevel }, gifts };
}

/** Gifts newest first, keyset-paged by (created_at, id); one row more than [limit] says another page follows. */
export function giftRows(billing: Billing, q: { status?: string; after: { createdAt: number; id: string } | null; limit: number }): GiftRow[] {
  const after = q.after;
  return billing.rows
    .all<GiftRow>("mojo_gifts", { where: q.status ? { status: q.status } : {}, orderBy: [["created_at", "desc"], ["id", "desc"]] })
    .filter((g) => !after || g.created_at < after.createdAt || (g.created_at === after.createdAt && g.id < after.id))
    .slice(0, q.limit + 1);
}

/** Communities with at least one Spark given to them (active or paused). */
export function sparkOrgIds(billing: Billing): string[] {
  return [...new Set(billing.rows.all<SparkAssignmentRow>("spark_assignments", { where: { removed_at: null } }).map((a) => a.org_id))];
}
