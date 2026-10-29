import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Templates from a community (community parity batch E, feature "template-links", docs/COMMUNITY_PARITY_API.md ›
 * Discovery): a copy of a community's channels, categories, roles and @everyone defaults (never messages or members)
 * behind a share code. Anyone signed in previews a code; POST /v1/orgs with `templateCode` makes a community from it.
 */

/** Share codes: 12 letters and digits (no look-alikes), any case when typed. */
export const TEMPLATE_CODE = /^[A-Za-z0-9]{8,16}$/;
export const TEMPLATE_NAME_MAX = 100;

const OrgOnly = z.object({ orgId: z.string().min(1).max(64) });
export const TemplateCodeParams = z.object({ code: z.string().regex(TEMPLATE_CODE, "Not a template code") });

const Counts = z.strictObject({ categories: zCount, channels: zCount, roles: zCount });

/** The template as the community's editors see it. */
export const CommunityTemplate = z.strictObject({
  code: z.string(),
  name: z.string(),
  /** Communities made from it. */
  uses: zCount,
  counts: Counts,
  /** The community changed since the template was made or last synced. */
  outOfDate: z.boolean(),
  createdAt: zTime,
  updatedAt: zTime,
});

const PreviewChannel = z.strictObject({ name: z.string(), kind: z.enum(["PUBLIC", "PRIVATE", "ANNOUNCEMENT"]), voice: z.boolean(), format: z.enum(["text", "forum"]), topic: z.string().nullable() });

/** What anyone with the code sees before making a community from it. */
export const TemplatePreview = z.strictObject({
  code: z.string(),
  name: z.string(),
  /** The community it was made from (a template goes when its community does). */
  source: z.strictObject({ id: z.string(), name: z.string(), photoRev: z.number().int().nullable() }).nullable(),
  uses: zCount,
  counts: Counts,
  updatedAt: zTime,
  /** Channels outside any category first (name null), then each category in order. */
  categories: z.array(z.strictObject({ name: z.string().nullable(), channels: z.array(PreviewChannel) })),
  roles: z.array(z.strictObject({ name: z.string(), color: z.string().nullable() })),
});

export const TemplateCreateBody = z.strictObject({ name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX).optional() });
export const TemplateResult = z.strictObject({ template: CommunityTemplate });

const tag = "template-links";
const off = ["feature_disabled"] as const;

export const communityTemplateRoutes = [
  route({ method: "GET", url: "/v1/orgs/:orgId/templates", tag, summary: "The community's template, or null (Edit community).", auth: true, params: OrgOnly, response: z.strictObject({ template: CommunityTemplate.nullable() }), errors: [...off, "not_found", "forbidden"] }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/templates",
    tag,
    summary: "Make a template link from the community: channels, categories, roles and @everyone defaults, no messages or members (one per community).",
    auth: true,
    params: OrgOnly,
    body: TemplateCreateBody,
    response: TemplateResult,
    status: 201,
    errors: [...off, "not_found", "forbidden", "template_exists"],
  }),
  route({ method: "POST", url: "/v1/orgs/:orgId/templates/sync", tag, summary: "Copy the community again into its template (same code).", auth: true, params: OrgOnly, response: TemplateResult, errors: [...off, "not_found", "forbidden", "template_not_found"] }),
  route({ method: "DELETE", url: "/v1/orgs/:orgId/templates", tag, summary: "Delete the template: its code stops working.", auth: true, params: OrgOnly, response: z.strictObject({ deleted: z.boolean() }), errors: [...off, "not_found", "forbidden"] }),
  route({ method: "GET", url: "/v1/templates/:code", tag, summary: "Preview a template by its code.", auth: true, params: TemplateCodeParams, response: z.strictObject({ template: TemplatePreview }), errors: [...off, "template_not_found"] }),
];
