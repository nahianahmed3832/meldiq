import { randomUUID } from "node:crypto";
import type { MeldiqPostgres } from "./client.js";

export interface OutboxEvent { sequence: number; event_id: string; aggregate_id: string; topic: string; event_type: string; payload: Record<string, unknown>; attempts: number; lease_id: string; }

/** Durable per-aggregate delivery. A dead event blocks later events until explicitly replayed.
 * Network/push delivery is at least once: consumers deduplicate event_id, never infer payment success from it.
 */
export class PostgresOutbox {
  constructor(private readonly db: MeldiqPostgres, private readonly maxAttempts = 8) {}

  async claim(destination: "realtime" | "push", limit = 25): Promise<OutboxEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid outbox batch size");
    const lease = randomUUID();
    const result = await this.db.query<OutboxEvent>(`
      WITH candidates AS (
        SELECT o.sequence FROM meldiq_private.outbox o
        WHERE o.destination = $1 AND o.delivered_at IS NULL AND o.dead_at IS NULL
          AND o.available_at <= now() AND (o.lease_until IS NULL OR o.lease_until < now())
          AND NOT EXISTS (SELECT 1 FROM meldiq_private.outbox older
            WHERE older.aggregate_id = o.aggregate_id AND older.destination = o.destination
              AND older.sequence < o.sequence AND older.delivered_at IS NULL)
        ORDER BY o.sequence FOR UPDATE SKIP LOCKED LIMIT $2
      ) UPDATE meldiq_private.outbox o SET lease_id = $3, lease_until = now() + interval '30 seconds', attempts = attempts + 1
        FROM candidates c WHERE o.sequence = c.sequence RETURNING o.*`, [destination, limit, lease]);
    return result.rows;
  }

  async fail(event: OutboxEvent, code: "unavailable" | "invalid_event" = "unavailable") {
    // Only non-sensitive machine codes are persisted; never an SDK exception or push token.
    const delaySeconds = Math.min(3600, 2 ** Math.min(event.attempts, 12)) + Math.floor(Math.random() * 5);
    await this.db.query(`UPDATE meldiq_private.outbox SET lease_id = NULL, lease_until = NULL,
      available_at = now() + make_interval(secs => $3), last_error_code = $4,
      dead_at = CASE WHEN attempts >= $5 THEN now() ELSE NULL END
      WHERE sequence = $1 AND lease_id = $2 AND lease_until > now() AND delivered_at IS NULL`,
      [event.sequence, event.lease_id, delaySeconds, code, this.maxAttempts]);
  }

  async acknowledge(event: OutboxEvent): Promise<boolean> {
    const result = await this.db.query(`UPDATE meldiq_private.outbox SET delivered_at = now(), lease_id = NULL, lease_until = NULL
      WHERE sequence = $1 AND lease_id = $2 AND lease_until > now() AND delivered_at IS NULL`, [event.sequence, event.lease_id]);
    return result.rowCount === 1;
  }

  /** realtime.send and acknowledgment commit together; a failed transaction sends neither. */
  async publishRealtime(event: OutboxEvent): Promise<boolean> {
    return this.db.transaction(async client => {
      const current = await client.query(`SELECT sequence FROM meldiq_private.outbox
        WHERE sequence = $1 AND lease_id = $2 AND lease_until > now() AND delivered_at IS NULL FOR UPDATE`, [event.sequence, event.lease_id]);
      if (!current.rowCount) return false;
      await client.query("SELECT realtime.send($1::jsonb, $2, $3, true)", [JSON.stringify({ ...event.payload, eventId: event.event_id }), event.event_type, event.topic]);
      return this.acknowledge(event);
    });
  }

  async runRealtimeOnce(limit = 25) {
    const events = await this.claim("realtime", limit);
    let delivered = 0;
    for (const event of events) {
      try { if (await this.publishRealtime(event)) delivered++; }
      catch { await this.fail(event); }
    }
    return { claimed: events.length, delivered };
  }

  async replay(sequence: number) {
    await this.db.query(`UPDATE meldiq_private.outbox SET dead_at = NULL, attempts = 0, available_at = now(),
      lease_id = NULL, lease_until = NULL, last_error_code = NULL WHERE sequence = $1 AND delivered_at IS NULL`, [sequence]);
  }
}
