import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import type { BlobKind } from "../../infrastructure/storage/index.js";
import { type Abandoned, type AttachmentRow, type FileStore, KEPT_FOREVER, type PendingBlobDelete, type UploadRow, type Usage, type UsageFilter } from "./store.js";

const attachmentColumns = "id,conversation_id,uploader_user_id,size,created_at,expires_at,pending_message_until,message_id,sha256";
const uploadColumns = "id,user_id,device_id,conversation_id,size,sha256,multipart_id,part_size,created_at,expires_at";

/** Metadata only. Blob keys, signed URLs, multipart verification and limits stay in the existing S3 service.
 * DELETE ... RETURNING makes completion/expiry/cancellation compete for the actual open session. Cleanup is
 * inserted in the same statement as removal, so a failed enqueue cannot leave an untracked object.
 */
export class PostgresFileStore implements FileStore {
  readonly backend = "postgres" as const;
  private pending = new Set<Promise<void>>();
  private failures: unknown[] = [];

  constructor(private readonly db: MeldiqPostgres) {}

  async attachment(id: string): Promise<AttachmentRow | null> {
    return (await this.db.query<AttachmentRow>("SELECT * FROM meldiq.attachments WHERE id=$1", [id])).rows[0] ?? null;
  }
  async recordAttachment(row: Omit<AttachmentRow, "kept">): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.attachments (${attachmentColumns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, attachmentValues(row));
  }
  async keep(id: string, expiresAt: number): Promise<void> {
    // Concurrent retention requests cannot shorten an already extended lifetime.
    await this.db.query("UPDATE meldiq.attachments SET kept=1,expires_at=greatest(expires_at,$2),pending_message_until=NULL WHERE id=$1", [id, expiresAt]);
  }
  async publish(id: string, messageId: string, expiresAt?: number): Promise<void> {
    await this.db.query("UPDATE meldiq.attachments SET message_id=coalesce(message_id,$2),pending_message_until=NULL,expires_at=greatest(expires_at,coalesce($3::bigint,expires_at)) WHERE id=$1", [id,messageId,expiresAt??null]);
  }
  async storedUsage(filter: UsageFilter): Promise<Usage> {
    return this.usage("attachments", filter, "uploader_user_id");
  }
  async pendingUsage(filter: Omit<UsageFilter, "kept">): Promise<Usage> {
    return this.usage("attachment_uploads", filter, "user_id");
  }
  private async usage(table: "attachments" | "attachment_uploads", filter: UsageFilter, userColumn: "uploader_user_id" | "user_id"): Promise<Usage> {
    const terms: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, operator: string, value: unknown) => {
      params.push(value);
      terms.push(`${column} ${operator} $${params.length}`);
    };
    const list = (column: string, ids: readonly string[]) => {
      params.push([...ids]);
      terms.push(`${column}=ANY($${params.length}::text[])`);
    };
    if (filter.uploaders) list(userColumn, filter.uploaders);
    if (filter.conversations) list("conversation_id", filter.conversations);
    if (filter.createdAfter !== undefined) add("created_at", ">", filter.createdAfter);
    if (filter.liveAt !== undefined) add("expires_at", ">", filter.liveAt);
    if (table === "attachments" && filter.kept !== undefined) add("kept", "=", filter.kept ? 1 : 0);
    return (await this.db.query<Usage>(`SELECT count(*) AS count,coalesce(sum(size),0)::bigint AS bytes FROM meldiq.${table}${terms.length ? ` WHERE ${terms.join(" AND ")}` : ""}`, params)).rows[0];
  }
  async attachmentIdsIn(conversationIds: readonly string[]): Promise<string[]> {
    if (!conversationIds.length) return [];
    return (await this.db.query<{id: string}>("SELECT id FROM meldiq.attachments WHERE conversation_id=ANY($1::text[]) ORDER BY id", [[...conversationIds]])).rows.map(row => row.id);
  }
  async upload(id: string): Promise<UploadRow | null> {
    return (await this.db.query<UploadRow>("SELECT * FROM meldiq.attachment_uploads WHERE id=$1", [id])).rows[0] ?? null;
  }
  async startUpload(row: UploadRow): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.attachment_uploads (${uploadColumns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, uploadColumns.split(",").map(column => row[column as keyof UploadRow]));
  }
  async setMultipart(id: string, multipartId: string): Promise<void> {
    await this.db.query("UPDATE meldiq.attachment_uploads SET multipart_id=$2 WHERE id=$1", [id, multipartId]);
  }
  async abandonUpload(upload: Pick<UploadRow, "id" | "multipart_id">): Promise<void> {
    // A stale cancellation must not delete the object after another request successfully completed the upload.
    await this.db.query(`WITH removed AS (DELETE FROM meldiq.attachment_uploads WHERE id=$1 RETURNING id,multipart_id)
      INSERT INTO meldiq.abandoned_uploads(id,multipart_id,attempts,next_at)
      SELECT id,multipart_id,0,0 FROM removed ON CONFLICT(id) DO NOTHING`, [upload.id]);
  }
  async dropUpload(id: string): Promise<void> {
    await this.db.query("DELETE FROM meldiq.attachment_uploads WHERE id=$1", [id]);
  }
  async completeUpload(id: string, attachment: Omit<AttachmentRow, "kept">): Promise<boolean> {
    if (id !== attachment.id) throw new Error("Attachment must retain its upload ID");
    const result = await this.db.query(`WITH removed AS (DELETE FROM meldiq.attachment_uploads WHERE id=$1 RETURNING id)
      INSERT INTO meldiq.attachments (${attachmentColumns}) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 FROM removed`, attachmentValues(attachment));
    return result.rowCount === 1;
  }
  async keepAllForever(now: number): Promise<number> {
    return (await this.db.query("UPDATE meldiq.attachments SET expires_at=$1 WHERE expires_at>$2 AND expires_at<$1 AND pending_message_until IS NULL", [KEPT_FOREVER, now])).rowCount ?? 0;
  }
  async purgeExpired(now: number): Promise<string[]> {
    const result = await this.db.query<{id: string}>(`WITH removed AS (
      DELETE FROM meldiq.attachments WHERE expires_at<=$1 RETURNING id
    ), queued AS (
      INSERT INTO meldiq.pending_blob_deletes(kind,blob_id,attempts,next_at)
      SELECT 'attachments',id,0,0 FROM removed ON CONFLICT(kind,blob_id) DO NOTHING
    ) SELECT id FROM removed ORDER BY id`, [now]);
    return result.rows.map(row => row.id);
  }
  async expireUploads(now: number): Promise<number> {
    return (await this.db.query<{count: number}>(`WITH removed AS (
      DELETE FROM meldiq.attachment_uploads WHERE expires_at<=$1 RETURNING id,multipart_id
    ), queued AS (
      INSERT INTO meldiq.abandoned_uploads(id,multipart_id,attempts,next_at)
      SELECT id,multipart_id,0,0 FROM removed ON CONFLICT(id) DO NOTHING
    ) SELECT count(*) AS count FROM removed`, [now])).rows[0].count;
  }
  async dueAbandoned(now: number, limit: number): Promise<Abandoned[]> {
    return (await this.db.query<Abandoned>("SELECT id,multipart_id,attempts FROM meldiq.abandoned_uploads WHERE next_at<=$1 ORDER BY next_at,id LIMIT $2", [now, checkedLimit(limit)])).rows;
  }
  async abandonedDone(id: string): Promise<void> {
    await this.db.query("DELETE FROM meldiq.abandoned_uploads WHERE id=$1", [id]);
  }
  async abandonedRetry(id: string, attempts: number, nextAt: number): Promise<void> {
    await this.db.query("UPDATE meldiq.abandoned_uploads SET attempts=$2,next_at=$3 WHERE id=$1", [id, attempts, nextAt]);
  }
  queueBlobDelete(kind: BlobKind, id: string): void {
    this.later(() => this.enqueueBlobDelete(kind, id));
  }
  /** Await this method from new async services; the void method only supports existing synchronous call sites. */
  async enqueueBlobDelete(kind: BlobKind, id: string): Promise<void> {
    await this.db.query("INSERT INTO meldiq.pending_blob_deletes(kind,blob_id,attempts,next_at) VALUES($1,$2,0,0) ON CONFLICT(kind,blob_id) DO NOTHING", [kind, id]);
  }
  async dueBlobDeletes(now: number, limit: number): Promise<PendingBlobDelete[]> {
    return (await this.db.query<PendingBlobDelete>("SELECT kind,blob_id,attempts FROM meldiq.pending_blob_deletes WHERE next_at<=$1 ORDER BY next_at,kind,blob_id LIMIT $2", [now, checkedLimit(limit)])).rows;
  }
  async blobDeleteDone(kind: BlobKind, id: string): Promise<void> {
    await this.db.query("DELETE FROM meldiq.pending_blob_deletes WHERE kind=$1 AND blob_id=$2", [kind, id]);
  }
  async blobDeleteRetry(kind: BlobKind, id: string, attempts: number, nextAt: number): Promise<void> {
    await this.db.query("UPDATE meldiq.pending_blob_deletes SET attempts=$3,next_at=$4 WHERE kind=$1 AND blob_id=$2", [kind, id, attempts, nextAt]);
  }
  async knows(id: string): Promise<boolean> {
    return (await this.db.query<{known: boolean}>("SELECT EXISTS(SELECT 1 FROM meldiq.attachments WHERE id=$1 UNION ALL SELECT 1 FROM meldiq.attachment_uploads WHERE id=$1) AS known", [id])).rows[0].known;
  }
  forgetConversation(conversationId: string): void {
    this.later(() => this.forgetConversationAsync(conversationId));
  }
  async forgetConversationAsync(conversationId: string): Promise<void> {
    await this.db.query(`WITH removed AS (
      DELETE FROM meldiq.attachments WHERE conversation_id=$1 RETURNING id
    ), queued AS (
      INSERT INTO meldiq.pending_blob_deletes(kind,blob_id,attempts,next_at)
      SELECT 'attachments',id,0,0 FROM removed ON CONFLICT(kind,blob_id) DO NOTHING
    ), uploads AS (
      DELETE FROM meldiq.attachment_uploads WHERE conversation_id=$1 RETURNING id,multipart_id
    ) INSERT INTO meldiq.abandoned_uploads(id,multipart_id,attempts,next_at)
      SELECT id,multipart_id,0,0 FROM uploads ON CONFLICT(id) DO NOTHING`, [conversationId]);
  }
  forgetUploader(userId: string): void {
    this.later(() => this.forgetUploaderAsync(userId));
  }
  async forgetUploaderAsync(userId: string): Promise<void> {
    await this.db.query(`WITH removed AS (
      DELETE FROM meldiq.attachment_uploads WHERE user_id=$1 RETURNING id,multipart_id
    ) INSERT INTO meldiq.abandoned_uploads(id,multipart_id,attempts,next_at)
      SELECT id,multipart_id,0,0 FROM removed ON CONFLICT(id) DO NOTHING`, [userId]);
  }
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
    const failures = this.failures.splice(0);
    if (failures.length) throw new AggregateError(failures, "Attachment cleanup was not persisted");
  }
  private later(operation: () => Promise<void>): void {
    // The existing Rows callbacks are synchronous. Their callers must drain settled() before responding/closing.
    // Do not swallow a failed cleanup and acknowledge success as if it were durable.
    const run = new Promise<void>(resolve => setImmediate(resolve)).then(operation)
      .catch(error => { this.failures.push(error); }).finally(() => this.pending.delete(run));
    this.pending.add(run);
  }
}

function attachmentValues(row: Omit<AttachmentRow, "kept">): unknown[] {
  return attachmentColumns.split(",").map(column => row[column as keyof typeof row] ?? null);
}
function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Cleanup limit must be between 1 and 5000");
  return limit;
}
