import fs from "node:fs";
import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { type BlobKind, type BlobRange, type BlobStore, type DirectUploads, type PresignedRequest, checkId } from "./blobstore.js";

export interface S3Config {
  bucket: string;
  region: string;
  /** Custom endpoint (S3-compatible stores, tests); absent: AWS's regional endpoint. */
  endpoint: string | null;
  forcePathStyle: boolean;
  /** Prepended to every object key, e.g. "orbit/". */
  prefix: string;
  /**
   * Static credentials from the server's environment, or null to use the AWS SDK's default chain (AWS_* variables,
   * a shared config profile, or `credential_process`, which is how IAM Roles Anywhere supplies temporary credentials).
   */
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null;
  /** Server-side encryption requested on every write (in addition to Meldiq's own end-to-end encryption). */
  sse: "AES256" | "aws:kms" | null;
  kmsKeyId: string | null;
  /** Downloads redirect to a short-lived presigned URL instead of streaming through this server. */
  presignedDownloads: boolean;
  presignTtlSeconds: number;
  /** Files larger than this are uploaded in parts (by the server, and by apps uploading directly). */
  multipartThreshold: number;
  partSize: number;
  spoolDir: string;
}

/** A store request failed. Carries only the status and S3's error code: never credentials, keys or signed URLs. */
export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    op: string,
  ) {
    super(`S3 ${op} failed: HTTP ${status}${code ? ` ${code}` : ""}`);
  }
}

/**
 * Amazon S3 (or a compatible store) as Meldiq's blob store, through the AWS SDK for JavaScript v3. Objects are private:
 * the bucket needs no public access. Object keys are "<prefix><kind>/<random id>": no names, conversations or users.
 */
export class S3BlobStore implements BlobStore {
  readonly backend = "s3" as const;
  readonly spoolDir: string;
  readonly client: S3Client;
  readonly direct: DirectUploads;

  constructor(private cfg: S3Config) {
    fs.mkdirSync(cfg.spoolDir, { recursive: true });
    this.spoolDir = cfg.spoolDir;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint ?? undefined,
      forcePathStyle: cfg.forcePathStyle,
      credentials: cfg.credentials ?? undefined,
      maxAttempts: 4,
      // Checksums are explicit (SHA-256 where Meldiq has one), never computed implicitly into presigned URLs.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    this.direct = new S3DirectUploads(this);
  }

  key(kind: BlobKind, id: string): string {
    return `${this.cfg.prefix}${kind}/${checkId(id)}`;
  }

  get bucket() {
    return this.cfg.bucket;
  }

  sseParams(): { ServerSideEncryption?: "AES256" | "aws:kms"; SSEKMSKeyId?: string } {
    if (!this.cfg.sse) return {};
    return this.cfg.sse === "aws:kms" && this.cfg.kmsKeyId ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.cfg.kmsKeyId } : { ServerSideEncryption: this.cfg.sse };
  }

  get multipartThreshold() {
    return this.cfg.multipartThreshold;
  }

  get partSize() {
    return this.cfg.partSize;
  }

  /** Runs one SDK call, turning its failures into an [S3Error] that never carries request details. */
  async call<T>(op: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      throw asS3Error(e, op);
    }
  }

  async putFile(kind: BlobKind, id: string, file: string, size: number, sha256Hex?: string): Promise<void> {
    const Key = this.key(kind, id);
    try {
      if (size > this.cfg.multipartThreshold) await this.putMultipart(Key, file, size);
      else {
        // The SDK can't retry a stream it has consumed, so a failed attempt reopens the file (3 tries in all).
        for (let attempt = 1; ; attempt++) {
          try {
            await this.call("put", () =>
              this.client.send(
                new PutObjectCommand({
                  Bucket: this.cfg.bucket,
                  Key,
                  Body: fs.createReadStream(file),
                  ContentLength: size,
                  ContentType: "application/octet-stream",
                  ChecksumSHA256: sha256Hex ? Buffer.from(sha256Hex, "hex").toString("base64") : undefined,
                  // Never replace an existing object: ids are random, so a clash means a bug, not an update.
                  IfNoneMatch: "*",
                  ...this.sseParams(),
                }),
              ),
            );
            break;
          } catch (e) {
            const transient = e instanceof S3Error && (e.status === 0 || e.status >= 500 || e.status === 429);
            if (!transient || attempt >= 3) throw e;
            await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
          }
        }
      }
    } finally {
      await fs.promises.rm(file, { force: true });
    }
  }

  private async putMultipart(Key: string, file: string, size: number): Promise<void> {
    const { UploadId } = await this.call("create-multipart", () =>
      this.client.send(new CreateMultipartUploadCommand({ Bucket: this.cfg.bucket, Key, ContentType: "application/octet-stream", ...this.sseParams() })),
    );
    if (!UploadId) throw new S3Error(0, "NoUploadId", "create-multipart");
    try {
      const parts: { PartNumber: number; ETag: string }[] = [];
      const fh = await fs.promises.open(file, "r");
      try {
        for (let n = 1, off = 0; off < size; n++, off += this.cfg.partSize) {
          const len = Math.min(this.cfg.partSize, size - off);
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, off);
          const r = await this.call("upload-part", () =>
            this.client.send(new UploadPartCommand({ Bucket: this.cfg.bucket, Key, UploadId, PartNumber: n, Body: buf, ContentLength: len })),
          );
          if (!r.ETag) throw new S3Error(0, "NoETag", "upload-part");
          parts.push({ PartNumber: n, ETag: r.ETag });
        }
      } finally {
        await fh.close();
      }
      await this.call("complete-multipart", () =>
        this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.cfg.bucket, Key, UploadId, MultipartUpload: { Parts: parts } })),
      );
    } catch (e) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.cfg.bucket, Key, UploadId })).catch(() => {});
      throw e;
    }
  }

  async get(kind: BlobKind, id: string, range?: BlobRange): Promise<Readable | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(kind, id), Range: range ? `bytes=${range.start}-${range.end}` : undefined }),
      );
      return (r.Body as Readable | undefined) ?? null;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw asS3Error(e, "get");
    }
  }

  async exists(kind: BlobKind, id: string): Promise<boolean> {
    return (await this.direct.head(kind, id)) !== null;
  }

  async delete(kind: BlobKind, id: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(kind, id) }));
    } catch (e) {
      if (!isNotFound(e)) throw asS3Error(e, "delete");
    }
  }

  async presignedGet(kind: BlobKind, id: string, head = false): Promise<string | null> {
    if (!this.cfg.presignedDownloads) return null;
    const object = { Bucket: this.cfg.bucket, Key: this.key(kind, id) };
    return getSignedUrl(this.client, head ? new HeadObjectCommand(object) : new GetObjectCommand(object), { expiresIn: this.cfg.presignTtlSeconds });
  }

  async *listIds(kind: BlobKind): AsyncIterable<{ id: string; size: number; modifiedAt: number }> {
    const Prefix = `${this.cfg.prefix}${kind}/`;
    let ContinuationToken: string | undefined;
    do {
      const r = await this.call("list", () => this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix, ContinuationToken })));
      for (const o of r.Contents ?? []) {
        if (!o.Key) continue;
        yield { id: o.Key.slice(Prefix.length), size: o.Size ?? 0, modifiedAt: o.LastModified?.getTime() ?? 0 };
      }
      ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }
}

interface PresignOptions {
  expiresIn: number;
  signableHeaders: Set<string>;
  unhoistableHeaders: Set<string>;
}

class S3DirectUploads implements DirectUploads {
  constructor(private s: S3BlobStore) {}

  get multipartThreshold() {
    return this.s.multipartThreshold;
  }

  get partSize() {
    return this.s.partSize;
  }

  private async presign(sign: (o: PresignOptions) => Promise<string>, headers: Record<string, string>, ttlSeconds: number): Promise<PresignedRequest> {
    // Every header the app must send is signed and left as a header (not moved into the query string), so S3 refuses
    // a request whose size, checksum, encryption or no-overwrite condition differs from what the server authorized.
    const names = new Set(Object.keys(headers));
    const url = await sign({ expiresIn: ttlSeconds, signableHeaders: names, unhoistableHeaders: names });
    return { method: "PUT", url, headers, expiresAt: Date.now() + ttlSeconds * 1000 };
  }

  async presignPut(kind: BlobKind, id: string, size: number, sha256B64: string, ttlSeconds: number): Promise<PresignedRequest> {
    const sse = this.s.sseParams();
    const headers: Record<string, string> = {
      "content-length": String(size),
      "content-type": "application/octet-stream",
      "x-amz-checksum-sha256": sha256B64,
      "if-none-match": "*",
    };
    if (sse.ServerSideEncryption) headers["x-amz-server-side-encryption"] = sse.ServerSideEncryption;
    if (sse.SSEKMSKeyId) headers["x-amz-server-side-encryption-aws-kms-key-id"] = sse.SSEKMSKeyId;
    const command = new PutObjectCommand({
      Bucket: this.s.bucket,
      Key: this.s.key(kind, id),
      ContentLength: size,
      ContentType: "application/octet-stream",
      ChecksumSHA256: sha256B64,
      IfNoneMatch: "*",
      ...sse,
    });
    return this.presign((o) => getSignedUrl(this.s.client, command, o), headers, ttlSeconds);
  }

  async createMultipart(kind: BlobKind, id: string): Promise<string> {
    const r = await this.s.call("create-multipart", () =>
      this.s.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.s.bucket,
          Key: this.s.key(kind, id),
          ContentType: "application/octet-stream",
          ChecksumAlgorithm: "SHA256",
          ...this.s.sseParams(),
        }),
      ),
    );
    if (!r.UploadId) throw new S3Error(0, "NoUploadId", "create-multipart");
    return r.UploadId;
  }

  async presignPart(kind: BlobKind, id: string, uploadId: string, partNumber: number, size: number, sha256B64: string, ttlSeconds: number): Promise<PresignedRequest> {
    const command = new UploadPartCommand({
      Bucket: this.s.bucket,
      Key: this.s.key(kind, id),
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: size,
      ChecksumSHA256: sha256B64,
    });
    return this.presign((o) => getSignedUrl(this.s.client, command, o), { "content-length": String(size), "x-amz-checksum-sha256": sha256B64 }, ttlSeconds);
  }

  async listParts(kind: BlobKind, id: string, uploadId: string) {
    const out: { partNumber: number; etag: string; size: number; sha256: string | null }[] = [];
    let PartNumberMarker: string | undefined;
    do {
      const r = await this.s.call("list-parts", () =>
        this.s.client.send(new ListPartsCommand({ Bucket: this.s.bucket, Key: this.s.key(kind, id), UploadId: uploadId, PartNumberMarker })),
      );
      for (const p of r.Parts ?? []) {
        if (p.PartNumber && p.ETag) out.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0, sha256: p.ChecksumSHA256 ?? null });
      }
      PartNumberMarker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
    } while (PartNumberMarker);
    return out;
  }

  async completeMultipart(kind: BlobKind, id: string, uploadId: string, parts: { partNumber: number; etag: string; sha256: string }[]) {
    await this.s.call("complete-multipart", () =>
      this.s.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.s.bucket,
          Key: this.s.key(kind, id),
          UploadId: uploadId,
          IfNoneMatch: "*",
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag, ChecksumSHA256: p.sha256 })) },
        }),
      ),
    );
  }

  async abortMultipart(kind: BlobKind, id: string, uploadId: string) {
    try {
      await this.s.client.send(new AbortMultipartUploadCommand({ Bucket: this.s.bucket, Key: this.s.key(kind, id), UploadId: uploadId }));
    } catch (e) {
      if (!isNotFound(e)) throw asS3Error(e, "abort-multipart");
    }
  }

  async head(kind: BlobKind, id: string) {
    try {
      const r = await this.s.client.send(new HeadObjectCommand({ Bucket: this.s.bucket, Key: this.s.key(kind, id), ChecksumMode: "ENABLED" }));
      return { size: r.ContentLength ?? 0, sha256: r.ChecksumSHA256 ?? null };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw asS3Error(e, "head");
    }
  }
}

function isNotFound(e: unknown): boolean {
  if (!(e instanceof S3ServiceException)) return false;
  return e.$metadata?.httpStatusCode === 404 || e.name === "NoSuchKey" || e.name === "NotFound" || e.name === "NoSuchUpload";
}

function asS3Error(e: unknown, op: string): S3Error {
  if (e instanceof S3Error) return e;
  if (e instanceof S3ServiceException) return new S3Error(e.$metadata?.httpStatusCode ?? 0, e.name, op);
  // Network and SDK errors: their message, which never includes credentials or signed URLs.
  const code = (e as { code?: string; name?: string })?.code ?? (e as { name?: string })?.name ?? "Error";
  return new S3Error(0, String(code), op);
}
