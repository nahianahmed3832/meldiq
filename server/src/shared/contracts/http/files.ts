import { z } from "zod/v4";
import { idParams, zCount, zRef, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Attachments (docs/ATTACHMENTS.md, docs/STORAGE_AND_DATA.md): apps encrypt files before upload; the server stores
 * ciphertext (S3 or its disk) and the envelope that references the attachment id carries the key.
 */

export const AttachmentDownloadQuery = z.object({
  proxy: z.literal("1").optional(),
});

export const Sha256B64 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "Expected a base64 SHA-256");

/** A request the app sends straight to storage (S3): method, URL and the headers it must send. */
export const PresignedRequest = z.strictObject({
  method: z.literal("PUT"),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: zTime,
});

export const StoredAttachment = z.strictObject({
  id: zRef,
  size: zCount,
  expiresAt: zTime,
});

export const UploadStartBody = z.object({
  conversationId: z.string().max(64),
  size: z.number().int().positive(),
  sha256: Sha256B64,
});
export const UploadStart = z.discriminatedUnion("mode", [
  /** Upload the whole file with one PUT. */
  z.strictObject({
    uploadId: zRef,
    mode: z.literal("single"),
    upload: PresignedRequest,
    expiresAt: zTime,
  }),
  /** Upload parts of [partSize] bytes (the last one shorter), each presigned through /parts. */
  z.strictObject({
    uploadId: zRef,
    mode: z.literal("multipart"),
    partSize: zCount,
    partCount: zCount,
    expiresAt: zTime,
  }),
]);
export const PartsBody = z.object({
  parts: z
    .array(
      z.object({
        n: z.number().int().min(1).max(10_000),
        size: z.number().int().positive(),
        sha256: Sha256B64,
      }),
    )
    .min(1)
    .max(100),
});
export const CompleteBody = z.object({
  parts: z
    .array(
      z.object({
        n: z.number().int().min(1),
        etag: z.string().max(200),
        sha256: Sha256B64,
      }),
    )
    .max(10_000)
    .optional(),
});
export const ConversationQuery = z.object({
  conversationId: z.string().max(64),
});

export const fileRoutes = [
  route({
    method: "POST",
    url: "/v1/attachments",
    tag: "files",
    summary: "Upload an encrypted file in one request through the server (small files; large ones use /v1/attachments/uploads).",
    auth: true,
    query: ConversationQuery,
    binary: "request",
    response: StoredAttachment,
    errors: ["not_found", "forbidden", "too_large", "storage_full", "too_many_uploads", "quota_exceeded"],
  }),
  route({
    method: "GET",
    url: "/v1/attachments/:id",
    tag: "files",
    summary: "Download an attachment's ciphertext (supports Range), or a redirect to a short-lived storage URL.",
    auth: true,
    params: idParams,
    query: AttachmentDownloadQuery,
    binary: "response",
    response: z.unknown(),
    errors: ["not_found", "range_not_satisfiable"],
  }),
  route({
    method: "POST",
    url: "/v1/attachments/:id/keep",
    tag: "files",
    summary: "Keep an attachment longer than the queue lifetime (when the server allows it).",
    auth: true,
    params: idParams,
    response: z.strictObject({ kept: z.boolean(), expiresAt: zTime }),
    errors: ["not_found"],
  }),
  route({
    method: "POST",
    url: "/v1/attachments/uploads",
    tag: "files",
    summary: "Start a direct upload to storage: one presigned PUT, or a multipart upload.",
    auth: true,
    body: UploadStartBody,
    response: UploadStart,
    errors: ["not_found", "forbidden", "too_large", "storage_full", "too_many_uploads", "quota_exceeded", "direct_upload_unavailable", "storage_unavailable"],
  }),
  route({
    method: "POST",
    url: "/v1/attachments/uploads/:id/url",
    tag: "files",
    summary: "A fresh presigned PUT for a single-mode upload (the first one expired).",
    auth: true,
    params: idParams,
    response: z.strictObject({ upload: PresignedRequest }),
    errors: ["not_found", "upload_expired", "storage_unavailable"],
  }),
  route({
    method: "POST",
    url: "/v1/attachments/uploads/:id/parts",
    tag: "files",
    summary: "Presign parts of a multipart upload (at most 100 per request).",
    auth: true,
    params: idParams,
    body: PartsBody,
    response: z.strictObject({
      parts: z.array(
        z.strictObject({
          n: z.number().int().positive(),
          upload: PresignedRequest,
        }),
      ),
    }),
    errors: ["not_found", "upload_expired", "storage_unavailable"],
  }),
  route({
    method: "GET",
    url: "/v1/attachments/uploads/:id/parts",
    tag: "files",
    summary: "The parts storage already has (to resume an interrupted upload).",
    auth: true,
    params: idParams,
    response: z.strictObject({
      parts: z.array(
        z.strictObject({
          n: z.number().int().positive(),
          etag: z.string(),
          size: zCount,
          sha256: z.string().nullable(),
        }),
      ),
    }),
    errors: ["not_found", "upload_expired", "storage_unavailable"],
  }),
  route({
    method: "POST",
    url: "/v1/attachments/uploads/:id/complete",
    tag: "files",
    summary: "Finish an upload: checked against its size and checksums, then usable in an envelope. Idempotent.",
    auth: true,
    params: idParams,
    body: CompleteBody,
    response: StoredAttachment,
    errors: ["not_found", "forbidden", "not_uploaded", "upload_incomplete", "upload_corrupt", "upload_expired", "storage_unavailable"],
  }),
  route({
    method: "DELETE",
    url: "/v1/attachments/uploads/:id",
    tag: "files",
    summary: "Cancel an upload.",
    auth: true,
    params: idParams,
    response: z.strictObject({ ok: z.literal(true) }),
    errors: ["not_found"],
  }),
];
