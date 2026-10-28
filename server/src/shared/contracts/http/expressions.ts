import { z } from "zod/v4";
import { IdParamsNonEmpty, OkResult, OrgParamsNonEmpty } from "./community.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * A community's own emoji and stickers (batch B9). Members see and use them; people with `expressions.manage` upload
 * (PNG, GIF or WebP up to 256 KiB), rename and remove them. Messages carry the emoji's id and hash next to its `:name:`,
 * inside the encryption, so a phone can fetch the image and check it.
 */

export const ExpressionKind = z.enum(["emoji", "sticker"]);

export const ExpressionView = z.strictObject({
  id: z.string(),
  orgId: z.string(),
  kind: ExpressionKind,
  /** 2–32 of a-z, 0-9 and _. */
  name: z.string(),
  animated: z.boolean(),
  /** The image's SHA-256, hex. */
  sha256: z.string(),
  size: zCount,
  /** The uploader's display name (null once the account is gone). */
  createdBy: z.string().nullable(),
  createdAt: zTime,
  /**
   * Over a limit (API 0.54.0, docs/MOJO.md): "slots", beyond the community's Spark level; "plan", beyond its adder's
   * plan. Kept and shown in sent messages, not offered for new ones. Absent: usable.
   */
  locked: z.enum(["slots", "plan"]).optional(),
});
export const ExpressionOnly = z.strictObject({ expression: ExpressionView });

/** The name is checked against 2–32 of a-z, 0-9 and _ after trimming and lowercasing (a 400 otherwise). */
export const ExpressionUploadQuery = z.object({ kind: ExpressionKind.default("emoji"), name: z.string().trim().toLowerCase() });
export const ExpressionRenameBody = z.strictObject({ name: z.string().trim().toLowerCase() });

const tag = "expressions";

export const expressionRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/expressions",
    tag,
    summary: "The community's emoji and stickers, and how many of each it has room for.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: z.strictObject({ expressions: z.array(ExpressionView), limits: z.strictObject({ emoji: zCount, sticker: zCount }) }),
    errors: ["not_found"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/expressions",
    tag,
    summary: "Upload an emoji or sticker: the PNG, GIF or WebP image (up to 256 KiB) as the body.",
    auth: true,
    params: OrgParamsNonEmpty,
    query: ExpressionUploadQuery,
    binary: "request",
    response: ExpressionOnly,
    errors: ["not_found", "forbidden", "limit_reached", "conflict", "too_large", "storage_unavailable"],
  }),
  route({
    method: "PATCH",
    url: "/v1/expressions/:id",
    tag,
    summary: "Rename an emoji or sticker.",
    auth: true,
    params: IdParamsNonEmpty,
    body: ExpressionRenameBody,
    response: ExpressionOnly,
    errors: ["not_found", "forbidden", "conflict"],
  }),
  route({
    method: "DELETE",
    url: "/v1/expressions/:id",
    tag,
    summary: "Remove an emoji or sticker (ok when it's already gone).",
    auth: true,
    params: IdParamsNonEmpty,
    response: OkResult,
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "GET",
    url: "/v1/expressions/:id/image",
    tag,
    summary: "The image, for the community's members (its own content type; ETag is the SHA-256).",
    auth: true,
    params: IdParamsNonEmpty,
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
];
