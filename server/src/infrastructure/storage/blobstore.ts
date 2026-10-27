import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * Where the server keeps files (docs/STORAGE_AND_DATA.md): encrypted attachments and profile photos. Two backends:
 * the server's disk (the default, unchanged layout) and Amazon S3 or a compatible store (STORAGE_BACKEND=s3).
 * The database stays the source of truth for what exists, who may read it and when it expires; the store only holds
 * bytes, under keys that carry no names, conversation ids or message metadata.
 */

/** "ai-files": what people sent to AI agents and what agents made (docs/retired/AI_WORKFORCE.md, AI removed in 0.47.0); kept, never end-to-end encrypted. */
export type BlobKind = "attachments" | "profile-photos" | "ai-files";

export interface BlobRange {
  start: number;
  /** Inclusive. */
  end: number;
}

export interface BlobStore {
  readonly backend: "local" | "s3";
  /** Where uploads are written while they are received and checked, before they enter the store. */
  readonly spoolDir: string;
  /** Moves a finished, checked local file into the store. The file is consumed. [sha256Hex] lets S3 verify the bytes. */
  putFile(kind: BlobKind, id: string, file: string, size: number, sha256Hex?: string): Promise<void>;
  /** The object, or a byte range of it; null when it doesn't exist. */
  get(kind: BlobKind, id: string, range?: BlobRange): Promise<Readable | null>;
  exists(kind: BlobKind, id: string): Promise<boolean>;
  delete(kind: BlobKind, id: string): Promise<void>;
  /** A short-lived link the client can download from directly (S3 with presigned downloads on); null to stream through the server. */
  presignedGet(kind: BlobKind, id: string): Promise<string | null>;
  /** Uploads straight from the app to the store with presigned requests (S3 only); null when the store can't. */
  readonly direct: DirectUploads | null;
  /** Ids of stored attachments, for the orphan check (admin CLI). */
  listIds(kind: BlobKind): AsyncIterable<{ id: string; size: number; modifiedAt: number }>;
}

/** A presigned request the app sends as it is: the URL, and headers it must send exactly (they're signed). */
export interface PresignedRequest {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

/**
 * Direct uploads (2026-10-17, docs/STORAGE_AND_DATA.md): the server authorizes and presigns, the app sends the
 * ciphertext to the store, the server verifies it before recording the attachment. Presigned uploads are bound to the
 * exact size and SHA-256 and can't overwrite an existing object.
 */
export interface DirectUploads {
  /** Uploads larger than this go in parts of [partSize] bytes (the last one smaller). */
  readonly multipartThreshold: number;
  readonly partSize: number;
  /** One PUT of [size] bytes whose SHA-256 is [sha256B64]. */
  presignPut(kind: BlobKind, id: string, size: number, sha256B64: string, ttlSeconds: number): Promise<PresignedRequest>;
  /** Starts a multipart upload (per-part SHA-256 checksums); returns its upload id. */
  createMultipart(kind: BlobKind, id: string): Promise<string>;
  presignPart(kind: BlobKind, id: string, uploadId: string, partNumber: number, size: number, sha256B64: string, ttlSeconds: number): Promise<PresignedRequest>;
  /** The parts the store already has (to resume, and to check them before completing). */
  listParts(kind: BlobKind, id: string, uploadId: string): Promise<{ partNumber: number; etag: string; size: number; sha256: string | null }[]>;
  completeMultipart(kind: BlobKind, id: string, uploadId: string, parts: { partNumber: number; etag: string; sha256: string }[]): Promise<void>;
  abortMultipart(kind: BlobKind, id: string, uploadId: string): Promise<void>;
  /** Size and stored SHA-256 (for a single PUT; multipart objects carry a checksum of their parts) of an object, or null. */
  head(kind: BlobKind, id: string): Promise<{ size: number; sha256: string | null } | null>;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;

export function checkId(id: string): string {
  if (!ID.test(id)) throw new Error("bad blob id");
  return id;
}

/** The original layout on the server's disk: DATA_DIR/attachments/<id> and DATA_DIR/profile-photos/<id>.jpg. */
export class LocalBlobStore implements BlobStore {
  readonly backend = "local" as const;
  readonly spoolDir: string;

  private readonly dirs: Record<BlobKind, string>;

  /** [dirs]["ai-files"] defaults to an "ai-files" folder next to the attachments folder. */
  constructor(dirs: Record<Exclude<BlobKind, "ai-files">, string> & { "ai-files"?: string }) {
    this.dirs = { ...dirs, "ai-files": dirs["ai-files"] ?? path.join(path.dirname(dirs.attachments), "ai-files") };
    for (const d of Object.values(this.dirs)) fs.mkdirSync(d, { recursive: true });
    this.spoolDir = this.dirs.attachments;
  }

  pathOf(kind: BlobKind, id: string): string {
    return path.join(this.dirs[kind], checkId(id) + (kind === "profile-photos" ? ".jpg" : ""));
  }

  async putFile(kind: BlobKind, id: string, file: string): Promise<void> {
    await fs.promises.rename(file, this.pathOf(kind, id));
  }

  async get(kind: BlobKind, id: string, range?: BlobRange): Promise<Readable | null> {
    const p = this.pathOf(kind, id);
    const st = await fs.promises.stat(p).catch(() => null);
    if (!st?.isFile()) return null;
    // Always with an explicit end: the stream then finishes right after its last byte instead of waiting for one more
    // read to report end-of-file. That extra read occasionally never completed in tests (2026-10-17), leaving the
    // response open after the client had the whole file.
    const end = range ? Math.min(range.end, st.size - 1) : st.size - 1;
    if (end < (range?.start ?? 0)) return Readable.from([]);
    return fs.createReadStream(p, { start: range?.start ?? 0, end });
  }

  async exists(kind: BlobKind, id: string): Promise<boolean> {
    return fs.existsSync(this.pathOf(kind, id));
  }

  async delete(kind: BlobKind, id: string): Promise<void> {
    await fs.promises.rm(this.pathOf(kind, id), { force: true });
  }

  async presignedGet(): Promise<string | null> {
    return null;
  }

  readonly direct = null;

  async *listIds(kind: BlobKind): AsyncIterable<{ id: string; size: number; modifiedAt: number }> {
    for (const f of await fs.promises.readdir(this.dirs[kind])) {
      if (f.endsWith(".part")) continue;
      const id = kind === "profile-photos" ? f.replace(/\.jpg$/, "") : f;
      if (!ID.test(id)) continue;
      const st = await fs.promises.stat(path.join(this.dirs[kind], f)).catch(() => null);
      if (st?.isFile()) yield { id, size: st.size, modifiedAt: st.mtimeMs };
    }
  }
}

/** Reads a whole object into memory (small objects only: profile photos, federation pushes up to the attachment limit). */
export async function readAll(s: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(parts);
}
