import type { DB } from "../../infrastructure/database/db.js";
import type { BlobKind } from "../../infrastructure/storage/index.js";

/**
 * The files module's records (docs/ATTACHMENTS.md, docs/STORAGE_AND_DATA.md): attachments (metadata of ciphertext
 * stored on the disk or in S3), direct-upload sessions, uploads to clean up, and stored bytes waiting to be deleted.
 * The bytes themselves live in the blob store; this is only what the server knows about them.
 *
 * SQLite (SqliteFileStore) or MongoDB (MongoFileStore, MONGODB_DOMAINS includes "files"). The `forget*` cascades and
 * `queueBlobDelete` return nothing: SQLite runs them at once (inside the caller's transaction), MongoDB right after the
 * caller's synchronous step.
 */

export interface AttachmentRow {
  id: string;
  conversation_id: string;
  uploader_user_id: string;
  size: number;
  created_at: number;
  expires_at: number;
  /** 1: kept for encrypted history beyond the relay window (POST /v1/attachments/:id/keep). */
  kept: number;
}

export interface UploadRow {
  id: string;
  user_id: string;
  device_id: string;
  conversation_id: string;
  size: number;
  /** base64 SHA-256 of the whole ciphertext, as the app declared it. */
  sha256: string;
  multipart_id: string | null;
  part_size: number | null;
  created_at: number;
  expires_at: number;
}

export interface Abandoned {
  id: string;
  multipart_id: string | null;
  attempts: number;
}

export interface PendingBlobDelete {
  kind: BlobKind;
  blob_id: string;
  attempts: number;
}

/** Which files to add up. Every field narrows; none means all. Ids are passed in, so no other module's table is read. */
export interface UsageFilter {
  uploaders?: readonly string[];
  conversations?: readonly string[];
  /** created_at after this. */
  createdAfter?: number;
  /** Not expired at this time. */
  liveAt?: number;
  /** Stored files only: kept for history (true) or not (false). */
  kept?: boolean;
}

export interface Usage {
  count: number;
  bytes: number;
}

/** The expiry of a file kept for good (9999-12-31T23:59:59Z): every "is it still here" check stays true. */
export const KEPT_FOREVER = 253_402_300_799_000;

export interface FileStore {
  readonly backend: "sqlite" | "mongodb" | "postgres";
  attachment(id: string): Promise<AttachmentRow | null>;
  recordAttachment(row: Omit<AttachmentRow, "kept">): Promise<void>;
  keep(id: string, expiresAt: number): Promise<void>;
  /** Stored attachments matching [f]. */
  storedUsage(f: UsageFilter): Promise<Usage>;
  /** Open direct uploads matching [f] (their size counts as if stored). */
  pendingUsage(f: Omit<UsageFilter, "kept">): Promise<Usage>;
  /** Ids of the attachments in these conversations (to report and delete them with a conversation). */
  attachmentIdsIn(conversationIds: readonly string[]): Promise<string[]>;

  upload(id: string): Promise<UploadRow | null>;
  startUpload(row: UploadRow): Promise<void>;
  setMultipart(id: string, multipartId: string): Promise<void>;
  /** Removes an upload session and schedules whatever reached storage for cleanup. */
  abandonUpload(u: Pick<UploadRow, "id" | "multipart_id">): Promise<void>;
  /** Removes an upload session that stored nothing (the store refused to start it). */
  dropUpload(id: string): Promise<void>;
  /** Turns an open upload into an attachment, atomically; false when the session was gone (expired meanwhile). */
  completeUpload(id: string, attachment: Omit<AttachmentRow, "kept">): Promise<boolean>;

  /** Keeps every attachment still stored (not expired at [now]) for good; returns how many changed. */
  keepAllForever(now: number): Promise<number>;
  /** Deletes expired attachments, schedules their bytes for deletion, and returns their ids. */
  purgeExpired(now: number): Promise<string[]>;
  /** Upload sessions past their time become abandoned; returns how many. */
  expireUploads(now: number): Promise<number>;
  dueAbandoned(now: number, limit: number): Promise<Abandoned[]>;
  abandonedDone(id: string): Promise<void>;
  abandonedRetry(id: string, attempts: number, nextAt: number): Promise<void>;
  /** Schedules stored bytes for deletion (their record is gone, so nobody can fetch them). */
  queueBlobDelete(kind: BlobKind, id: string): void;
  dueBlobDeletes(now: number, limit: number): Promise<PendingBlobDelete[]>;
  blobDeleteDone(kind: BlobKind, id: string): Promise<void>;
  blobDeleteRetry(kind: BlobKind, id: string, attempts: number, nextAt: number): Promise<void>;
  /** Whether an attachment or an open upload has this id (the operator's orphan sweep). */
  knows(id: string): Promise<boolean>;

  /** A deleted conversation: its attachments' bytes scheduled for deletion, its uploads abandoned, its records gone. */
  forgetConversation(conversationId: string): void;
  /** A deleted account: its open uploads abandoned. */
  forgetUploader(userId: string): void;
  /** Resolves once every `forget*` and `queueBlobDelete` started so far has finished (a command-line run before it exits). */
  settled(): Promise<void>;
}

export class SqliteFileStore implements FileStore {
  readonly backend = "sqlite" as const;

  constructor(private readonly db: DB) {}

  async attachment(id: string): Promise<AttachmentRow | null> {
    return (this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined) ?? null;
  }

  async recordAttachment(r: Omit<AttachmentRow, "kept">): Promise<void> {
    this.db
      .prepare("INSERT INTO attachments (id, conversation_id, uploader_user_id, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(r.id, r.conversation_id, r.uploader_user_id, r.size, r.created_at, r.expires_at);
  }

  async keep(id: string, expiresAt: number): Promise<void> {
    this.db.prepare("UPDATE attachments SET kept = 1, expires_at = ? WHERE id = ?").run(expiresAt, id);
  }

  async storedUsage(f: UsageFilter): Promise<Usage> {
    const w = where(f, "uploader_user_id");
    if (f.kept !== undefined) w.sql.push(`kept = ${f.kept ? 1 : 0}`);
    return this.usage("attachments", w);
  }

  async pendingUsage(f: Omit<UsageFilter, "kept">): Promise<Usage> {
    return this.usage("attachment_uploads", where(f, "user_id"));
  }

  async attachmentIdsIn(conversationIds: readonly string[]): Promise<string[]> {
    if (conversationIds.length === 0) return [];
    return (
      this.db.prepare(`SELECT id FROM attachments WHERE conversation_id IN (${conversationIds.map(() => "?").join(",")})`).all(...conversationIds) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }

  async upload(id: string): Promise<UploadRow | null> {
    return (this.db.prepare("SELECT * FROM attachment_uploads WHERE id = ?").get(id) as UploadRow | undefined) ?? null;
  }

  async startUpload(u: UploadRow): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO attachment_uploads (id, user_id, device_id, conversation_id, size, sha256, multipart_id, part_size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(u.id, u.user_id, u.device_id, u.conversation_id, u.size, u.sha256, u.multipart_id, u.part_size, u.created_at, u.expires_at);
  }

  async setMultipart(id: string, multipartId: string): Promise<void> {
    this.db.prepare("UPDATE attachment_uploads SET multipart_id = ? WHERE id = ?").run(multipartId, id);
  }

  async abandonUpload(u: Pick<UploadRow, "id" | "multipart_id">): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM attachment_uploads WHERE id = ?").run(u.id);
      this.db.prepare("INSERT OR IGNORE INTO abandoned_uploads (id, multipart_id, attempts, next_at) VALUES (?, ?, 0, 0)").run(u.id, u.multipart_id);
    })();
  }

  async dropUpload(id: string): Promise<void> {
    this.db.prepare("DELETE FROM attachment_uploads WHERE id = ?").run(id);
  }

  async completeUpload(id: string, a: Omit<AttachmentRow, "kept">): Promise<boolean> {
    // Exactly one of this and the expiry job wins: the attachment exists only if this upload session was still open.
    return this.db.transaction(() => {
      if (this.db.prepare("DELETE FROM attachment_uploads WHERE id = ?").run(id).changes === 0) return false;
      this.db
        .prepare("INSERT INTO attachments (id, conversation_id, uploader_user_id, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(a.id, a.conversation_id, a.uploader_user_id, a.size, a.created_at, a.expires_at);
      return true;
    })();
  }

  async keepAllForever(now: number): Promise<number> {
    return this.db.prepare("UPDATE attachments SET expires_at = ? WHERE expires_at > ? AND expires_at < ?").run(KEPT_FOREVER, now, KEPT_FOREVER).changes;
  }

  async purgeExpired(now: number): Promise<string[]> {
    return this.db.transaction(() => {
      const ids = (this.db.prepare("DELETE FROM attachments WHERE expires_at <= ? RETURNING id").all(now) as { id: string }[]).map((r) => r.id);
      for (const id of ids) this.queueBlobDelete("attachments", id);
      return ids;
    })();
  }

  async expireUploads(now: number): Promise<number> {
    return this.db.transaction(() => {
      const rows = this.db.prepare("DELETE FROM attachment_uploads WHERE expires_at <= ? RETURNING id, multipart_id").all(now) as Pick<UploadRow, "id" | "multipart_id">[];
      const add = this.db.prepare("INSERT OR IGNORE INTO abandoned_uploads (id, multipart_id, attempts, next_at) VALUES (?, ?, 0, 0)");
      for (const r of rows) add.run(r.id, r.multipart_id);
      return rows.length;
    })();
  }

  async dueAbandoned(now: number, limit: number): Promise<Abandoned[]> {
    return this.db.prepare("SELECT id, multipart_id, attempts FROM abandoned_uploads WHERE next_at <= ? LIMIT ?").all(now, limit) as Abandoned[];
  }

  async abandonedDone(id: string): Promise<void> {
    this.db.prepare("DELETE FROM abandoned_uploads WHERE id = ?").run(id);
  }

  async abandonedRetry(id: string, attempts: number, nextAt: number): Promise<void> {
    this.db.prepare("UPDATE abandoned_uploads SET attempts = ?, next_at = ? WHERE id = ?").run(attempts, nextAt, id);
  }

  queueBlobDelete(kind: BlobKind, id: string): void {
    this.db.prepare("INSERT OR IGNORE INTO pending_blob_deletes (kind, blob_id, attempts, next_at) VALUES (?, ?, 0, 0)").run(kind, id);
  }

  async dueBlobDeletes(now: number, limit: number): Promise<PendingBlobDelete[]> {
    return this.db.prepare("SELECT kind, blob_id, attempts FROM pending_blob_deletes WHERE next_at <= ? LIMIT ?").all(now, limit) as PendingBlobDelete[];
  }

  async blobDeleteDone(kind: BlobKind, id: string): Promise<void> {
    this.db.prepare("DELETE FROM pending_blob_deletes WHERE kind = ? AND blob_id = ?").run(kind, id);
  }

  async blobDeleteRetry(kind: BlobKind, id: string, attempts: number, nextAt: number): Promise<void> {
    this.db.prepare("UPDATE pending_blob_deletes SET attempts = ?, next_at = ? WHERE kind = ? AND blob_id = ?").run(attempts, nextAt, kind, id);
  }

  async knows(id: string): Promise<boolean> {
    return !!this.db.prepare("SELECT 1 FROM attachments WHERE id = ? UNION SELECT 1 FROM attachment_uploads WHERE id = ?").get(id, id);
  }

  forgetConversation(conversationId: string): void {
    for (const r of this.db.prepare("SELECT id FROM attachments WHERE conversation_id = ?").all(conversationId) as { id: string }[]) {
      this.queueBlobDelete("attachments", r.id);
    }
    this.db
      .prepare(
        "INSERT OR IGNORE INTO abandoned_uploads (id, multipart_id, attempts, next_at) SELECT id, multipart_id, 0, 0 FROM attachment_uploads WHERE conversation_id = ?",
      )
      .run(conversationId);
    this.db.prepare("DELETE FROM attachment_uploads WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM attachments WHERE conversation_id = ?").run(conversationId);
  }

  forgetUploader(userId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO abandoned_uploads (id, multipart_id, attempts, next_at) SELECT id, multipart_id, 0, 0 FROM attachment_uploads WHERE user_id = ?")
      .run(userId);
    this.db.prepare("DELETE FROM attachment_uploads WHERE user_id = ?").run(userId);
  }

  async settled(): Promise<void> {}

  private usage(table: string, w: { sql: string[]; params: unknown[] }): Usage {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM ${table}${w.sql.length ? ` WHERE ${w.sql.join(" AND ")}` : ""}`)
      .get(...w.params) as Usage;
    return { count: r.count, bytes: r.bytes };
  }
}

function where(f: Omit<UsageFilter, "kept">, userColumn: string): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  const list = (column: string, ids: readonly string[]) => {
    // An empty list matches nothing (as "IN ()" would mean).
    sql.push(ids.length ? `${column} IN (${ids.map(() => "?").join(",")})` : "0");
    params.push(...ids);
  };
  if (f.uploaders) list(userColumn, f.uploaders);
  if (f.conversations) list("conversation_id", f.conversations);
  if (f.createdAfter !== undefined) {
    sql.push("created_at > ?");
    params.push(f.createdAfter);
  }
  if (f.liveAt !== undefined) {
    sql.push("expires_at > ?");
    params.push(f.liveAt);
  }
  return { sql, params };
}
