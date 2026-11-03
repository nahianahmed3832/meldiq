import type { Readable } from "node:stream";
import type { BlobKind, BlobRange, BlobStore } from "./blobstore.js";

/**
 * A switch between the server's disk and S3 without moving files (STORAGE_READ_FALLBACK, docs/STORAGE_AND_DATA.md):
 * new files go to [primary] only, while files stored before the switch are still read from [fallback] until they
 * expire or are replaced, and deleted from wherever they are. Works in both directions, so a switch to S3 and a
 * rollback to the disk both keep every file readable. Uploads, direct uploads and listings use the primary only.
 */
export class FallbackBlobStore implements BlobStore {
  readonly backend: BlobStore["backend"];
  readonly spoolDir: string;
  readonly previousUploads: BlobStore["previousUploads"];
  readonly direct: BlobStore["direct"];

  constructor(
    private readonly primary: BlobStore,
    private readonly fallback: BlobStore,
  ) {
    this.backend = primary.backend;
    this.spoolDir = primary.spoolDir;
    this.direct = primary.direct;
    this.previousUploads = primary.previousUploads;
  }

  putFile(kind: BlobKind, id: string, file: string, size: number, sha256Hex?: string): Promise<void> {
    return this.primary.putFile(kind, id, file, size, sha256Hex);
  }

  async get(kind: BlobKind, id: string, range?: BlobRange): Promise<Readable | null> {
    return (await this.primary.get(kind, id, range)) ?? this.fallback.get(kind, id, range);
  }

  async exists(kind: BlobKind, id: string): Promise<boolean> {
    return (await this.primary.exists(kind, id)) || this.fallback.exists(kind, id);
  }

  async delete(kind: BlobKind, id: string): Promise<void> {
    await Promise.all([this.primary.delete(kind, id), this.fallback.delete(kind, id)]);
  }

  /** A link from whichever store holds the file (only S3 gives one); null streams it through the server. */
  async presignedGet(kind: BlobKind, id: string, head = false): Promise<string | null> {
    if (await this.primary.exists(kind, id)) return this.primary.presignedGet(kind, id, head);
    if (await this.fallback.exists(kind, id)) return this.fallback.presignedGet(kind, id, head);
    return null;
  }

  listIds(kind: BlobKind): AsyncIterable<{ id: string; size: number; modifiedAt: number }> {
    return this.primary.listIds(kind);
  }
}
