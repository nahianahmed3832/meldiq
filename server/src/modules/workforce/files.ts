import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { DB } from "../../infrastructure/database/db.js";
import type { BlobStore } from "../../infrastructure/storage/index.js";
import { ApiError } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";

/**
 * Files people send to agents and files agents make (docs/AI_WORKFORCE.md §2): bytes in the blob store under
 * "ai-files" (the server's disk or S3, never in the database), a row with name, type, size and SHA-256. Every write is
 * read back and compared with its hash before the row exists, so a job never completes with a file that isn't there.
 * Not end-to-end encrypted: people chose to send these to an AI service.
 */
export type FileRole = "input" | "artifact" | "avatar";
export type ApprovalState = "not_required" | "pending" | "approved" | "rejected" | "superseded";

export interface AiFileRow {
  id: string;
  org_id: string;
  role: FileRole;
  job_id: string | null;
  /** A person's submission for a human task (migration 052). */
  task_id: string | null;
  install_id: string | null;
  agent_id: string | null;
  skill_version: number | null;
  conversation_id: string | null;
  uploaded_by: string | null;
  kind: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  blob_key: string;
  artifact_version: number;
  supersedes: string | null;
  approval_state: ApprovalState;
  created_at: number;
  expires_at: number;
  deleted_at: number | null;
}

/** What people may send and agents may make. Anything executable or scriptable in a browser is refused. */
export const INPUT_MIMES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;
export const ARTIFACT_MIMES = new Set<string>([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/calendar",
  "text/x-diff",
  "application/x-subrip",
  "image/png",
  "image/jpeg",
  "image/webp",
  "audio/mpeg",
  "video/mp4",
]);
/** Types a browser may show inline; everything else downloads as an attachment. */
export const INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "audio/mpeg", "text/plain"]);

export const MAX_INPUT_BYTES = 500 * 1024 * 1024;
export const RETENTION_MS = 30 * 86_400_000;

/** A file name safe to show and to put in a Content-Disposition header. */
export function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return clean.length ? clean : "file";
}

/** The type from the first bytes, for the types where that's reliable; null when it doesn't match [claimed]. */
export function sniffMatches(bytes: Buffer, claimed: string): boolean {
  const head = bytes.subarray(0, 16);
  const starts = (sig: number[], at = 0) => sig.every((b, i) => head[at + i] === b);
  switch (claimed) {
    case "image/png":
      return starts([0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "image/gif":
      return head.subarray(0, 4).toString("latin1") === "GIF8";
    case "image/webp":
      return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
    case "application/pdf":
      return head.subarray(0, 5).toString("latin1") === "%PDF-";
    case "video/mp4":
    case "video/quicktime":
    case "audio/mp4":
      return head.subarray(4, 8).toString("latin1") === "ftyp";
    case "audio/wav":
    case "audio/x-wav":
      return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WAVE";
    case "video/webm":
    case "audio/webm":
      return starts([0x1a, 0x45, 0xdf, 0xa3]);
    case "audio/ogg":
      return head.subarray(0, 4).toString("latin1") === "OggS";
    case "audio/mpeg":
      return head.subarray(0, 3).toString("latin1") === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
    default:
      // Text formats: no NUL bytes in the first 8 KiB.
      return !bytes.subarray(0, 8192).includes(0);
  }
}

async function readStream(s: Readable, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of s) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    n += b.length;
    if (n > limit) throw new ApiError(413, "too_large", "The file is larger than expected.");
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** SHA-256 of a stream, read chunk by chunk (never whole in memory). */
async function hashStream(s: Readable): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const c of s) h.update(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return h.digest("hex");
}

/** SHA-256 and size of a file on disk, streamed. */
async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const size = (await fs.promises.stat(file)).size;
  return { sha256: await hashStream(fs.createReadStream(file)), size };
}

export interface NewFile {
  orgId: string;
  role: FileRole;
  jobId?: string | null;
  installId?: string | null;
  agentId?: string | null;
  skillVersion?: number | null;
  conversationId?: string | null;
  uploadedBy?: string | null;
  kind?: string | null;
  name: string;
  mime: string;
  supersedes?: string | null;
  approvalState?: ApprovalState;
}

export class AiFiles {
  constructor(
    private readonly db: DB,
    private readonly blobs: BlobStore,
    private readonly clock: () => number,
  ) {}

  row(id: string): AiFileRow | null {
    return (this.db.prepare("SELECT * FROM ai_files WHERE id = ? AND deleted_at IS NULL").get(id) as AiFileRow | undefined) ?? null;
  }

  /** Writes [bytes], reads them back and checks the hash, then records the file. */
  async store(f: NewFile & { bytes: Buffer }): Promise<AiFileRow> {
    const { bytes, ...meta } = f;
    const spool = path.join(this.blobs.spoolDir, `${crypto.randomBytes(18).toString("base64url")}.part`);
    await fs.promises.writeFile(spool, bytes);
    try {
      return await this.storeFile(meta, spool);
    } finally {
      await fs.promises.rm(spool, { force: true });
    }
  }

  /**
   * Records the file at [file] (moved into the store, so it's gone from there afterwards): hashed while streamed, put in
   * the store, read back as a stream and compared before the row exists. Large files never sit in memory.
   */
  async storeFile(f: NewFile, file: string): Promise<AiFileRow> {
    const blobKey = crypto.randomBytes(18).toString("base64url");
    // The disk store moves the file into place: from elsewhere (a render's temporary folder, maybe another filesystem)
    // it's copied into the spool folder first.
    let source = file;
    if (path.dirname(path.resolve(file)) !== path.resolve(this.blobs.spoolDir)) {
      source = path.join(this.blobs.spoolDir, `${blobKey}.part`);
      await fs.promises.copyFile(file, source);
    }
    try {
      const { sha256, size } = await hashFile(source);
      await this.blobs.putFile("ai-files", blobKey, source, size, sha256);
      return await this.recordStored(f, blobKey, sha256, size);
    } finally {
      if (source !== file) await fs.promises.rm(source, { force: true });
    }
  }

  private async recordStored(f: NewFile, blobKey: string, sha256: string, size: number): Promise<AiFileRow> {
    const back = await this.blobs.get("ai-files", blobKey);
    if (!back || (await hashStream(back)) !== sha256) {
      await this.blobs.delete("ai-files", blobKey).catch(() => undefined);
      throw new ApiError(500, "internal", "The file couldn't be stored intact.");
    }
    const id = newId("aif");
    const prev = f.supersedes ? this.row(f.supersedes) : null;
    const t = this.clock();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ai_files (id, org_id, role, job_id, install_id, agent_id, skill_version, conversation_id, uploaded_by, kind, name, mime, size, sha256, blob_key,
                                 artifact_version, supersedes, approval_state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          f.orgId,
          f.role,
          f.jobId ?? null,
          f.installId ?? null,
          f.agentId ?? null,
          f.skillVersion ?? null,
          f.conversationId ?? null,
          f.uploadedBy ?? null,
          f.kind ?? null,
          safeName(f.name),
          f.mime,
          size,
          sha256,
          blobKey,
          prev ? prev.artifact_version + 1 : 1,
          prev?.id ?? null,
          f.approvalState ?? "not_required",
          t,
          t + RETENTION_MS,
        );
      if (prev) this.db.prepare("UPDATE ai_files SET approval_state = 'superseded' WHERE id = ?").run(prev.id);
    })();
    return this.row(id)!;
  }

  /**
   * Stores an upload as it arrives: into a spool file with its hash computed on the way and [limit] enforced, then
   * [check] sees its first bytes, then the store gets it and it's read back like store()'s files.
   */
  async storeStream(
    meta: { orgId: string; role: "input"; uploadedBy: string; name: string; mime: string },
    body: Readable,
    limit: number,
    check: (head: Buffer, size: number) => void,
  ): Promise<AiFileRow> {
    const id = newId("aif");
    const blobKey = crypto.randomBytes(18).toString("base64url");
    const spool = path.join(this.blobs.spoolDir, `${blobKey}.part`);
    const hash = crypto.createHash("sha256");
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      const out = fs.createWriteStream(spool);
      try {
        for await (const c of body) {
          const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
          size += b.length;
          if (size > limit) throw new ApiError(413, "too_large", `A file for an agent is at most ${Math.round(limit / 1024 / 1024)} MB.`);
          if (head.length < 8192) head = Buffer.concat([head, b.subarray(0, 8192 - head.length)]);
          hash.update(b);
          if (!out.write(b)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
      } finally {
        await new Promise<void>((resolve) => out.end(resolve));
      }
      check(head, size);
      const sha256 = hash.digest("hex");
      await this.blobs.putFile("ai-files", blobKey, spool, size, sha256);
      const back = await this.blobs.get("ai-files", blobKey);
      if (!back || (await hashStream(back)) !== sha256) {
        await this.blobs.delete("ai-files", blobKey).catch(() => undefined);
        throw new ApiError(500, "internal", "The file couldn't be stored intact.");
      }
      const t = this.clock();
      this.db
        .prepare(
          `INSERT INTO ai_files (id, org_id, role, uploaded_by, name, mime, size, sha256, blob_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, meta.orgId, meta.role, meta.uploadedBy, safeName(meta.name), meta.mime, size, sha256, blobKey, t, t + RETENTION_MS);
      return this.row(id)!;
    } finally {
      await fs.promises.rm(spool, { force: true });
    }
  }

  async read(id: string, limit = MAX_INPUT_BYTES): Promise<{ row: AiFileRow; bytes: Buffer }> {
    const row = this.row(id);
    if (!row) throw new ApiError(404, "not_found", "No such file.");
    const s = await this.blobs.get("ai-files", row.blob_key);
    if (!s) throw new ApiError(404, "not_found", "The file's bytes are missing.");
    return { row, bytes: await readStream(s, Math.min(limit, row.size)) };
  }

  async stream(row: AiFileRow, range?: { start: number; end: number }): Promise<Readable | null> {
    return this.blobs.get("ai-files", row.blob_key, range);
  }

  /** Reads the stored bytes again, as a stream, and compares them with the recorded hash. */
  async verify(id: string): Promise<boolean> {
    const row = this.row(id);
    if (!row) return false;
    try {
      const s = await this.blobs.get("ai-files", row.blob_key);
      return s !== null && (await hashStream(s)) === row.sha256;
    } catch {
      return false;
    }
  }

  /** Files people submitted for [taskIds] (human tasks, migration 052). */
  ofTasks(taskIds: string[]): AiFileRow[] {
    if (!taskIds.length) return [];
    return this.db
      .prepare(`SELECT * FROM ai_files WHERE deleted_at IS NULL AND role = 'input' AND task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...taskIds) as AiFileRow[];
  }

  ofJobs(jobIds: string[], role?: FileRole): AiFileRow[] {
    if (!jobIds.length) return [];
    return this.db
      .prepare(`SELECT * FROM ai_files WHERE deleted_at IS NULL AND job_id IN (${jobIds.map(() => "?").join(",")}) ${role ? "AND role = ?" : ""} ORDER BY created_at`)
      .all(...jobIds, ...(role ? [role] : [])) as AiFileRow[];
  }

  /** Inputs uploaded before their job existed are attached to it when the job is created. */
  attach(fileIds: string[], jobId: string, orgId: string, userId: string): void {
    for (const id of fileIds) {
      const ok = this.db.prepare("UPDATE ai_files SET job_id = ? WHERE id = ? AND org_id = ? AND uploaded_by = ? AND role = 'input' AND job_id IS NULL AND deleted_at IS NULL").run(jobId, id, orgId, userId).changes;
      if (!ok) throw new ApiError(400, "bad_request", "A file isn't yours, belongs to another request, or is gone. Upload it again.");
    }
  }

  setApproval(id: string, state: ApprovalState): void {
    this.db.prepare("UPDATE ai_files SET approval_state = ? WHERE id = ?").run(state, id);
  }

  artifacts(orgId: string, opts: { installId?: string; conversationIds?: string[] | null; before?: number }, limit: number): AiFileRow[] {
    const where = ["org_id = ?", "role = 'artifact'", "deleted_at IS NULL"];
    const args: (string | number)[] = [orgId];
    if (opts.installId) (where.push("install_id = ?"), args.push(opts.installId));
    if (opts.before) (where.push("created_at < ?"), args.push(opts.before));
    return this.db.prepare(`SELECT * FROM ai_files WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...args, limit) as AiFileRow[];
  }

  /** Bytes of AI files [userId] uploaded (inputs and avatars), kept now. */
  bytesUploadedBy(userId: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(size), 0) n FROM ai_files WHERE uploaded_by = ? AND deleted_at IS NULL").get(userId) as { n: number }).n;
  }

  /** Bytes of inputs [userId] uploaded but hasn't sent with a request yet (removed after a day). */
  pendingInputBytes(userId: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(size), 0) n FROM ai_files WHERE uploaded_by = ? AND role = 'input' AND job_id IS NULL AND deleted_at IS NULL").get(userId) as { n: number }).n;
  }

  bytesUsed(orgId: string | null): number {
    const r = (orgId
      ? this.db.prepare("SELECT COALESCE(SUM(size), 0) n FROM ai_files WHERE org_id = ? AND deleted_at IS NULL").get(orgId)
      : this.db.prepare("SELECT COALESCE(SUM(size), 0) n FROM ai_files WHERE deleted_at IS NULL").get()) as { n: number };
    return r.n;
  }

  totals(): { files: number; bytes: number; artifacts: number; inputs: number } {
    return this.db
      .prepare("SELECT COUNT(*) files, COALESCE(SUM(size),0) bytes, COALESCE(SUM(role = 'artifact'),0) artifacts, COALESCE(SUM(role = 'input'),0) inputs FROM ai_files WHERE deleted_at IS NULL")
      .get() as { files: number; bytes: number; artifacts: number; inputs: number };
  }

  async remove(id: string): Promise<void> {
    const row = this.row(id);
    if (!row) return;
    this.db.prepare("UPDATE ai_files SET deleted_at = ? WHERE id = ?").run(this.clock(), id);
    await this.blobs.delete("ai-files", row.blob_key).catch(() => undefined);
  }

  /** Files past their retention, and inputs never attached to a job within a day. */
  async purgeExpired(): Promise<number> {
    const t = this.clock();
    const rows = this.db
      .prepare("SELECT id FROM ai_files WHERE deleted_at IS NULL AND role <> 'avatar' AND (expires_at < ? OR (role = 'input' AND job_id IS NULL AND created_at < ?)) LIMIT 500")
      .all(t, t - 86_400_000) as { id: string }[];
    for (const r of rows) await this.remove(r.id);
    return rows.length;
  }
}
