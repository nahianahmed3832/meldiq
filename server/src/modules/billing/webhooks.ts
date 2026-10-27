import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../../infrastructure/database/db.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import type { BillingProvider, NormalizedEvent } from "./providers/types.js";
import { WebhookRejected } from "./providers/types.js";
import { BillingEventError, type Subscriptions } from "./subscriptions.js";

/**
 * Provider webhooks (docs/BILLING.md › Webhooks). A delivery is trusted only after its signature verifies; it is then
 * stored once per provider event id (a repeat is acknowledged and skipped) before anything is applied, so an
 * acknowledged event is never lost. Applying runs in one transaction; a failure is kept with its reason and retried
 * with backoff, then marked dead for an operator to replay.
 */
export type EventStatus = "received" | "processed" | "ignored" | "failed" | "dead";

export interface EventRow {
  id: string;
  provider: string;
  event_ref: string;
  type: string;
  provider_created_at: number;
  received_at: number;
  status: EventStatus;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  processed_at: number | null;
  subscription_id: string | null;
  summary: string;
}

export const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 3_600_000;
const RETRY_BATCH = 50;

export const retryDelay = (attempts: number) => Math.min(RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_MS);

export class BillingWebhooks {
  constructor(
    private readonly db: DB,
    private readonly provider: BillingProvider | null,
    private readonly subscriptions: Subscriptions,
    private readonly log: FastifyBaseLogger,
    private readonly clock: () => number = Date.now,
  ) {}

  private reject(provider: string, reason: string): void {
    this.db
      .prepare("INSERT INTO billing_webhook_rejections (day, provider, reason, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, provider, reason) DO UPDATE SET count = count + 1")
      .run(new Date(this.clock()).toISOString().slice(0, 10), provider, reason);
  }

  /** Verifies, stores and applies one delivery. Answers what happened; throws 400 for anything untrusted. */
  receive(providerId: string, headers: Readonly<Record<string, string | string[] | undefined>>, rawBody: string): { received: true; duplicate: boolean; status: EventStatus } {
    // Only the configured provider has an endpoint; anything else looks like an unknown route.
    if (!this.provider || this.provider.id !== providerId) throw notFound();
    const t = this.clock();
    let event: NormalizedEvent;
    try {
      event = this.provider.verifyWebhook(headers, rawBody, t);
    } catch (e) {
      if (!(e instanceof WebhookRejected)) throw e;
      this.reject(providerId, e.reason);
      this.log.warn({ provider: providerId, reason: e.reason }, "billing webhook refused");
      throw new ApiError(400, "bad_signature", "The webhook couldn't be verified");
    }
    const id = newId("bev");
    const inserted = this.db
      .prepare(
        "INSERT INTO billing_provider_events (id, provider, event_ref, type, provider_created_at, received_at, status, summary) VALUES (?, ?, ?, ?, ?, ?, 'received', ?) ON CONFLICT(provider, event_ref) DO NOTHING",
      )
      .run(id, providerId, event.ref, event.type, event.createdAt, t, JSON.stringify(event));
    if (inserted.changes === 0) {
      const row = this.db.prepare("SELECT status FROM billing_provider_events WHERE provider = ? AND event_ref = ?").get(providerId, event.ref) as { status: EventStatus };
      return { received: true, duplicate: true, status: row.status };
    }
    return { received: true, duplicate: false, status: this.process(id) };
  }

  /** Applies a stored event. Never throws: the outcome is written on the event's row. */
  process(id: string): EventStatus {
    const row = this.db.prepare("SELECT * FROM billing_provider_events WHERE id = ?").get(id) as EventRow | undefined;
    if (!row || row.status === "processed" || row.status === "ignored") return row?.status ?? "dead";
    const event = JSON.parse(row.summary) as NormalizedEvent;
    const t = this.clock();
    try {
      const outcome = this.db.transaction(() => {
        if (event.kind === "subscription") return this.subscriptions.applySnapshot(row.provider, event.subscription, event.createdAt, row.id, t);
        if (event.kind === "invoice") return this.subscriptions.applyInvoice(row.provider, event.invoice, event.createdAt, t);
        return null;
      })();
      const status: EventStatus = outcome && outcome.result === "applied" ? "processed" : "ignored";
      this.db
        .prepare("UPDATE billing_provider_events SET status = ?, attempts = attempts + 1, processed_at = ?, next_attempt_at = NULL, last_error = NULL, subscription_id = ? WHERE id = ?")
        .run(status, t, outcome?.subscriptionId ?? null, row.id);
      return status;
    } catch (e) {
      const code = e instanceof BillingEventError ? e.code : "internal_error";
      if (!(e instanceof BillingEventError)) this.log.error({ err: e, event: row.id }, "billing event failed");
      const attempts = row.attempts + 1;
      const status: EventStatus = attempts >= MAX_ATTEMPTS ? "dead" : "failed";
      this.db
        .prepare("UPDATE billing_provider_events SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
        .run(status, attempts, status === "failed" ? t + retryDelay(attempts) : null, code, row.id);
      return status;
    }
  }

  /** Retries failed events whose time has come (the cleanup job, every minute). Returns how many were tried. */
  retryDue(): number {
    const due = this.db
      .prepare("SELECT id FROM billing_provider_events WHERE status = 'failed' AND next_attempt_at <= ? ORDER BY provider_created_at LIMIT ?")
      .all(this.clock(), RETRY_BATCH) as { id: string }[];
    for (const { id } of due) this.process(id);
    return due.length;
  }

  /** An operator's replay of a failed or dead event (audited by the caller). */
  replay(id: string): EventStatus {
    const row = this.db.prepare("SELECT status FROM billing_provider_events WHERE id = ?").get(id) as { status: EventStatus } | undefined;
    if (!row) throw notFound("No such provider event");
    if (row.status !== "failed" && row.status !== "dead") throw conflict("Only failed or dead events can be replayed");
    this.db.prepare("UPDATE billing_provider_events SET status = 'failed', attempts = 0 WHERE id = ?").run(id);
    return this.process(id);
  }
}
