import type { DB } from "../../infrastructure/database/db.js";
import type { SubscriptionRow } from "./subscriptions.js";

/**
 * Read models for the Platform Admin Console's billing pages (platformAdmin/billing.ts). Bounded and keyset-paged:
 * [after] is the last row's (time, id) of the previous page, and one row more than [limit] is read.
 */
export interface After {
  createdAt: number;
  id: string;
}

export function subscriptionRows(db: DB, q: { status?: string; plan?: string; org?: string; after?: After; limit: number }): SubscriptionRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) (where.push("s.status = ?"), params.push(q.status));
  if (q.org) (where.push("s.org_id = ?"), params.push(q.org));
  if (q.plan) (where.push("p.key = ?"), params.push(q.plan));
  if (q.after) (where.push("(s.created_at < ? OR (s.created_at = ? AND s.id < ?))"), params.push(q.after.createdAt, q.after.createdAt, q.after.id));
  return db
    .prepare(
      `SELECT s.* FROM billing_subscriptions s JOIN billing_plan_versions v ON v.id = s.plan_version_id JOIN billing_plans p ON p.id = v.plan_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    )
    .all(...params, q.limit + 1) as SubscriptionRow[];
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
export function subscriptionRecords(db: DB, id: string, limit: number) {
  return {
    history: db
      .prepare("SELECT at, from_status, to_status, plan_version_id, source, detail FROM billing_subscription_history WHERE subscription_id = ? ORDER BY id DESC LIMIT ?")
      .all(id, limit) as HistoryRow[],
    invoices: db.prepare("SELECT * FROM billing_invoices WHERE subscription_id = ? ORDER BY issued_at DESC LIMIT ?").all(id, limit) as InvoiceRow[],
    events: db
      .prepare("SELECT id, type, status, received_at, last_error FROM billing_provider_events WHERE subscription_id = ? ORDER BY received_at DESC LIMIT ?")
      .all(id, limit) as { id: string; type: string; status: EventStatus; received_at: number; last_error: string | null }[],
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

export function eventRows(db: DB, q: { status?: string; after?: After; limit: number }): EventListRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) (where.push("status = ?"), params.push(q.status));
  if (q.after) (where.push("(received_at < ? OR (received_at = ? AND id < ?))"), params.push(q.after.createdAt, q.after.createdAt, q.after.id));
  return db
    .prepare(
      `SELECT id, provider, event_ref, type, status, attempts, provider_created_at, received_at AS created_at, processed_at, next_attempt_at, last_error, subscription_id
       FROM billing_provider_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, q.limit + 1) as EventListRow[];
}
