import type { PostgresRows } from "../../../infrastructure/database/rows/postgresRows.js";
import type { RowWriter } from "../../../infrastructure/database/rows/types.js";
import { DuplicateSubmission, type QueueInsert, type QueueItemRow, type RelayStats, type RelayStore, type Submission } from "./store.js";

/** Existing per-device encrypted delivery/ack protocol, backed by the same PostgreSQL writer as identity changes.
 * This preserves legacy devices during the Realtime transition; it is not a second persistent database.
 */
export class PostgresRelayStore implements RelayStore {
  readonly backend = "postgres" as const;
  private pending = new Set<Promise<void>>();
  private failures: unknown[] = [];
  constructor(private readonly rows: PostgresRows) {
    for (const table of ["delivery_queue", "submitted_messages"]) if (!rows.has(table)) throw new Error(`Relay writer is missing ${table}`);
  }
  async submission(messageId: string): Promise<Submission | null> { return this.rows.get("submitted_messages", {message_id: messageId}) ?? null; }
  async accept(submission: Submission, items: QueueInsert[]): Promise<QueueItemRow[]> {
    return this.rows.write(writer => {
      if (!writer.insert("submitted_messages", {...submission}, {orIgnore: true}).inserted) throw new DuplicateSubmission(submission.message_id);
      return this.insert(writer, items);
    });
  }
  async acceptEvent(event: import("../store/messageStore.js").MessageEvent, submission: Submission, items: QueueInsert[]): Promise<QueueItemRow[]> {
    return this.rows.writeMessage(event, writer => {
      if (!writer.insert("submitted_messages", {...submission}, {orIgnore: true}).inserted) throw new DuplicateSubmission(submission.message_id);
      return this.insert(writer, items);
    });
  }
  async enqueue(items: QueueInsert[]): Promise<QueueItemRow[]> { return this.rows.write(writer => this.insert(writer, items)); }
  private insert(writer: RowWriter, items: QueueInsert[]): QueueItemRow[] {
    const result: QueueItemRow[] = [];
    for (const item of items) {
      const inserted = writer.insert("delivery_queue", {...item}, {orIgnore: true});
      if (inserted.inserted) result.push({...item, id: inserted.id!});
    }
    return result;
  }
  async backlog(deviceId: string, now: number, limit: number): Promise<QueueItemRow[]> {
    return this.rows.all("delivery_queue", {where: {recipient_device_id: deviceId, expires_at: {gt: now}}, orderBy: [["id", "asc"]], limit});
  }
  async take(deviceId: string, ids: readonly number[]): Promise<QueueItemRow[]> {
    return this.rows.write(writer => {
      const taken: QueueItemRow[] = [];
      for (const id of ids) {
        const row = writer.get<QueueItemRow>("delivery_queue", {id, recipient_device_id: deviceId});
        if (row) { writer.delete("delivery_queue", {id, recipient_device_id: deviceId}); taken.push(row); }
      }
      return taken;
    });
  }
  async hasEnvelopeSince(deviceId: string, since: number, now: number): Promise<boolean> {
    return !!this.rows.get("delivery_queue", {recipient_device_id: deviceId, kind: {in: ["envelope", "message"]}, created_at: {gte: since}, expires_at: {gt: now}});
  }
  async purgeExpired(now: number): Promise<{queue: number; submitted: number}> {
    return this.rows.write(writer => ({queue: writer.delete("delivery_queue", {expires_at: {lte: now}}), submitted: writer.delete("submitted_messages", {expires_at: {lte: now}})}));
  }
  async stats(): Promise<RelayStats> {
    const queue = this.rows.all<QueueItemRow>("delivery_queue");
    return {envelopes: queue.filter(row => row.kind !== "receipt").length, receipts: queue.filter(row => row.kind === "receipt").length,
      oldestCreatedAt: queue.reduce<number | null>((oldest, row) => oldest === null ? row.created_at : Math.min(oldest, row.created_at), null)};
  }
  async countInConversations(conversationIds: readonly string[]): Promise<number> {
    return this.rows.count("delivery_queue", {conversation_id: {in: conversationIds}});
  }
  forgetDevice(deviceId: string): void { this.track(this.rows.write(writer => { writer.delete("delivery_queue", {recipient_device_id: deviceId}); })); }
  forgetConversation(conversationId: string): void {
    this.track(this.rows.write(writer => { writer.delete("delivery_queue", {conversation_id: conversationId}); writer.delete("submitted_messages", {conversation_id: conversationId}); }));
  }
  forgetConversationFor(conversationId: string, deviceIds: readonly string[]): void {
    this.track(this.rows.write(writer => { writer.delete("delivery_queue", {conversation_id: conversationId, recipient_device_id: {in: deviceIds}}); }));
  }
  forgetSender(userId: string): void {
    this.track(this.rows.write(writer => { writer.delete("delivery_queue", {sender_user_id: userId}); writer.delete("submitted_messages", {sender_user_id: userId}); }));
  }
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
    const failures = this.failures.splice(0);
    if (failures.length) throw new AggregateError(failures, "Relay cleanup was not persisted");
  }
  private track(operation: Promise<void>): void {
    const pending = operation.catch(error => { this.failures.push(error); }).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }
}
