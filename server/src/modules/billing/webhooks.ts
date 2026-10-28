import type { FastifyBaseLogger } from "fastify";
import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import type { BillingProvider, CheckoutSnapshot, NormalizedEvent, PaymentSnapshot } from "./providers/types.js";
import { WebhookRejected } from "./providers/types.js";
import { type ApplyOutcome, BillingEventError, type Subscriptions } from "./subscriptions.js";

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

/** Told after an event's changes are committed (reconciliation and change notices; never inside the transaction). */
export type AfterApply = (event: NormalizedEvent, outcome: ApplyOutcome) => void;

/**
 * One-time payments (gifts, docs/MOJO.md) take their checkout and refund events here first: null when the event isn't
 * one of theirs, so it goes on to the subscriptions.
 */
export interface PaymentEvents {
  applyCheckout(w: RowWriter, provider: string, snap: CheckoutSnapshot, t: number): ApplyOutcome | null;
  applyPayment(w: RowWriter, provider: string, p: PaymentSnapshot, t: number): ApplyOutcome | null;
}

export class BillingWebhooks {
  afterApply: AfterApply | null = null;
  payments: PaymentEvents | null = null;

  constructor(
    private readonly rows: Rows,
    private readonly provider: BillingProvider | null,
    private readonly subscriptions: Subscriptions,
    private readonly log: FastifyBaseLogger,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Counts a refused delivery per day, provider and reason (operators see the counts, never the bodies). */
  async reject(provider: string, reason: string): Promise<void> {
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    await this.rows.write((w) => {
      const row = w.get<{ count: number }>("billing_webhook_rejections", { day, provider, reason });
      if (row) w.update("billing_webhook_rejections", { day, provider, reason }, { count: row.count + 1 });
      else w.insert("billing_webhook_rejections", { day, provider, reason, count: 1 });
    });
  }

  /** Verifies, stores and applies one delivery. Answers what happened; throws 400 for anything untrusted. */
  async receive(providerId: string, headers: Readonly<Record<string, string | string[] | undefined>>, rawBody: string): Promise<{ received: true; duplicate: boolean; status: EventStatus }> {
    // Only the configured provider has an endpoint; anything else looks like an unknown route.
    if (!this.provider || this.provider.id !== providerId) throw notFound();
    const t = this.clock();
    let event: NormalizedEvent;
    try {
      event = this.provider.verifyWebhook(headers, rawBody, t);
    } catch (e) {
      if (!(e instanceof WebhookRejected)) throw e;
      await this.reject(providerId, e.reason);
      this.log.warn({ provider: providerId, reason: e.reason }, "billing webhook refused");
      throw new ApiError(400, "bad_signature", "The webhook couldn't be verified");
    }
    const { outcome: _outcome, ...answer } = await this.ingest(providerId, event);
    return answer;
  }

  /**
   * Stores and applies one event already known to be the provider's (a verified webhook, or what an app store's API
   * answered when the server asked it): once per provider event ref, a repeat is acknowledged and skipped.
   */
  async ingest(providerId: string, event: NormalizedEvent): Promise<{ received: true; duplicate: boolean; status: EventStatus; outcome: ApplyOutcome | null }> {
    const t = this.clock();
    const id = newId("bev");
    const inserted = await this.rows.write(
      (w) =>
        w.insert(
          "billing_provider_events",
          { id, provider: providerId, event_ref: event.ref, type: event.type, provider_created_at: event.createdAt, received_at: t, status: "received", summary: JSON.stringify(event) },
          { orIgnore: true },
        ).inserted,
    );
    if (!inserted) {
      const row = this.rows.get<{ status: EventStatus }>("billing_provider_events", { provider: providerId, event_ref: event.ref })!;
      return { received: true, duplicate: true, status: row.status, outcome: null };
    }
    const outcome: { value: ApplyOutcome | null } = { value: null };
    const status = await this.process(id, outcome);
    return { received: true, duplicate: false, status, outcome: outcome.value };
  }

  private applyEvent(w: RowWriter, row: EventRow, event: NormalizedEvent, t: number): ApplyOutcome | null {
    if (event.kind === "subscription") return this.subscriptions.applySnapshot(w, row.provider, event.subscription, event.createdAt, `provider_event:${row.id}`, t);
    if (event.kind === "invoice") return this.subscriptions.applyInvoice(w, row.provider, event.invoice, event.createdAt, t);
    if (event.kind === "checkout") return this.payments?.applyCheckout(w, row.provider, event.checkout, t) ?? this.subscriptions.applyCheckout(w, row.provider, event.checkout, t);
    if (event.kind === "payment") {
      return this.payments?.applyPayment(w, row.provider, event.payment, t) ?? this.subscriptions.applyPayment(w, row.provider, event.payment, `provider_event:${row.id}`, t);
    }
    return null;
  }

  /** Applies a stored event. Never throws: the outcome is written on the event's row. */
  async process(id: string, applied?: { value: ApplyOutcome | null }): Promise<EventStatus> {
    const row = this.rows.get<EventRow>("billing_provider_events", { id });
    if (!row || row.status === "processed" || row.status === "ignored") return row?.status ?? "dead";
    const event = JSON.parse(row.summary) as NormalizedEvent;
    const t = this.clock();
    try {
      // The event's changes and its "processed" mark are one unit: applied together or not at all.
      const outcome = await this.rows.write((w) => {
        // Units run one at a time: a retry and a delivery of the same event can't both apply it.
        const current = w.get<EventRow>("billing_provider_events", { id: row.id });
        if (!current || current.status === "processed" || current.status === "ignored") return null;
        const applied = this.applyEvent(w, row, event, t);
        const status: EventStatus = applied && applied.result === "applied" ? "processed" : "ignored";
        w.update("billing_provider_events", { id: row.id }, {
          status, attempts: row.attempts + 1, processed_at: t, next_attempt_at: null, last_error: null, subscription_id: applied?.subscriptionId ?? null,
        });
        return applied;
      });
      const status: EventStatus = outcome && outcome.result === "applied" ? "processed" : "ignored";
      if (applied) applied.value = outcome;
      if (outcome && status === "processed") this.notifyApplied(event, outcome);
      return status;
    } catch (e) {
      const code = e instanceof BillingEventError ? e.code : "internal_error";
      if (!(e instanceof BillingEventError)) this.log.error({ err: e, event: row.id }, "billing event failed");
      const attempts = row.attempts + 1;
      const status: EventStatus = attempts >= MAX_ATTEMPTS ? "dead" : "failed";
      await this.rows.write((w) =>
        w.update("billing_provider_events", { id: row.id }, { status, attempts, next_attempt_at: status === "failed" ? t + retryDelay(attempts) : null, last_error: code }),
      );
      return status;
    }
  }

  private notifyApplied(event: NormalizedEvent, outcome: ApplyOutcome): void {
    try {
      this.afterApply?.(event, outcome);
    } catch (e) {
      this.log.error({ err: e }, "billing after-apply hook failed");
    }
  }

  /** Retries failed events whose time has come (the cleanup job, every minute). Returns how many were tried. */
  async retryDue(): Promise<number> {
    const due = this.rows.all<{ id: string }>("billing_provider_events", {
      where: { status: "failed", next_attempt_at: { lte: this.clock() } },
      orderBy: [["provider_created_at", "asc"]],
      limit: RETRY_BATCH,
    });
    for (const { id } of due) await this.process(id);
    return due.length;
  }

  /** An operator's replay of a failed or dead event (audited by the caller). */
  async replay(id: string): Promise<EventStatus> {
    const row = this.rows.get<{ status: EventStatus }>("billing_provider_events", { id });
    if (!row) throw notFound("No such provider event");
    if (row.status !== "failed" && row.status !== "dead") throw conflict("Only failed or dead events can be replayed");
    await this.rows.write((w) => w.update("billing_provider_events", { id }, { status: "failed", attempts: 0 }));
    return this.process(id);
  }
}
