import { z } from "zod/v4";
import { route } from "./route.js";
import { OrgParamsNonEmpty } from "./community.js";
export const PartnerChecklist = z.strictObject({
  guidelines: z.literal(true),
  moderation: z.literal(true),
  safety: z.literal(true),
  activity: z.literal(true),
});
export const PartnerSubmission = z.strictObject({
  baseRev: z.number().int().nonnegative(),
  statement: z.string().trim().min(1).max(2000),
  checklist: PartnerChecklist,
});
export const PartnerReview = z.strictObject({
  baseRev: z.number().int().positive(),
  status: z.enum(["approved", "declined"]),
  reason: z.string().trim().min(10).max(500),
});
export const PartnerApplication = z.strictObject({
  orgId: z.string(),
  statement: z.string(),
  checklist: PartnerChecklist,
  status: z.enum(["submitted", "approved", "declined"]),
  rev: z.number().int().positive(),
  submittedAt: z.number(),
  reviewedAt: z.number().nullable(),
  reviewNote: z.string().nullable(),
});
export const PartnerResult = z.strictObject({
  application: PartnerApplication.nullable(),
});
export const PartnerEligibility = z.strictObject({
  eligible: z.boolean(),
  activeSparks: z.number().int().nonnegative(),
  members: z.number().int().nonnegative(),
  hasRules: z.boolean(),
  activeMods: z.number().int().nonnegative(),
  verification: z.string(),
  ageDays: z.number().int().nonnegative(),
  cleanStanding: z.boolean(),
});
export const PartnerQueue = z.strictObject({
  applications: z.array(PartnerApplication),
  nextAfter: z.string().nullable(),
});
export const partnerContracts = [
  route({
    method: "GET", url: "/v1/orgs/:orgId/partner-eligibility", tag: "community",
    summary: "The requirements and current eligibility for a community partner application.",
    auth: true, params: OrgParamsNonEmpty, response: PartnerEligibility, errors: ["not_found"],
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/partner-application",
    tag: "community",
    summary: "Private partner application for the current community owner.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: PartnerResult,
    errors: ["not_found"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/partner-application",
    tag: "community",
    summary:
      "Submit an eligible community for partner review, or revise an unreviewed application.",
    auth: true,
    params: OrgParamsNonEmpty,
    body: PartnerSubmission,
    response: PartnerResult,
    errors: ["not_found", "stale_revision", "conflict"],
  }),
  route({
    method: "GET",
    url: "/admin/v1/partner-applications",
    requires: "admin_console",
    tag: "platform-admin",
    summary: "Private manual partner review queue.",
    auth: true,
    scheme: "console",
    query: z.object({
      after: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    response: PartnerQueue,
  }),
  route({
    method: "PUT",
    url: "/admin/v1/partner-applications/:orgId",
    requires: "admin_console",
    tag: "platform-admin",
    summary:
      "Review an eligible application and award the Partner badge on approval.",
    auth: true,
    scheme: "console",
    params: OrgParamsNonEmpty,
    body: PartnerReview,
    response: PartnerResult,
    errors: ["not_found", "forbidden", "stale_revision", "conflict"],
  }),
];
