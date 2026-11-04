import { z } from "zod/v4";
import { PersonRef } from "./applications.js";
import { IdParamsNonEmpty, OrgParamsNonEmpty } from "./community.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Reports (batch B4). Messages are end-to-end encrypted, so a report carries only what the reporter's app chose to
 * share after a review step: the decrypted message, its attachments' names and hashes, and up to five messages of
 * context, sealed with the server's reports key. A community's moderators (`reports.view`) see its reports, never who
 * sent them; direct messages, groups and illegal content go to Meldiq's operators.
 */

/** Why someone reports, in the order the apps offer them (the server's REPORT_REASONS, kept equal at compile time). */
export const REPORT_REASON_KEYS = [
  "spam",
  "harassment",
  "harmful",
  "private_info",
  "illegal",
  "other",
] as const;
export const ReportReason = z.enum(REPORT_REASON_KEYS);
export const ReportStatus = z.enum(["open", "actioned", "dismissed"]);

const zRefId = z.string().min(1).max(64);

/** What the reporter's app shares: sealed on arrival, opened only for moderators. */
export const ReportContent = z.strictObject({
  text: z.string().max(4000).nullish(),
  sentAt: z.number().int().nullish(),
  attachments: z
    .array(
      z.strictObject({
        name: z.string().max(200),
        size: z.number().int().min(0).nullish(),
        sha256: z.string().max(128).nullish(),
      }),
    )
    .max(10)
    .nullish(),
  context: z
    .array(
      z.strictObject({
        senderUserId: zRefId,
        text: z.string().max(2000),
        sentAt: z.number().int(),
      }),
    )
    .max(5)
    .nullish(),
});

export const ReportBody = z.strictObject({
  targetUserId: zRefId,
  conversationId: zRefId.optional(),
  messageId: zRefId.optional(),
  /** For a report about a member that isn't about a message: the community both people are in. */
  orgId: zRefId.optional(),
  reason: ReportReason,
  note: z.string().trim().max(500).optional(),
  content: ReportContent.optional(),
});

/** What the reporter learns: where it went, and whether this message was already reported by them. */
export const ReportReceipt = z.strictObject({
  report: z.strictObject({
    id: z.string(),
    status: ReportStatus,
    to: z.enum(["community", "meldiq"]),
    repeated: z.boolean(),
  }),
});

/** A report as moderators see it: never who reported it. */
export const ModeratorReportView = z.strictObject({
  id: z.string(),
  orgId: z.string(),
  reason: ReportReason,
  note: z.string().nullable(),
  status: ReportStatus,
  createdAt: zTime,
  handledAt: zTime.nullable(),
  handledBy: PersonRef.nullable(),
  handledNote: z.string().nullable(),
  target: PersonRef,
  conversationId: z.string().nullable(),
  conversationName: z.string().nullable(),
  messageId: z.string().nullable(),
  /** null without shared content, or when it no longer opens. */
  content: ReportContent.nullable(),
});

export const ReportsQuery = z.object({
  status: z.enum(["open", "closed"]).default("open"),
  before: z.coerce.number().int().min(1).optional(),
});
export const ReportStatusBody = z.strictObject({
  status: z.enum(["open", "actioned", "dismissed"]),
  note: z.string().trim().max(500).optional(),
});
export const CommunityReportBody = z.strictObject({
  reason: ReportReason,
  note: z.string().trim().max(500).optional(),
});

const tag = "reports";

export const reportRoutes = [
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/report",
    tag,
    summary:
      "Privately report this community to Meldiq operators; repeat submissions return the first receipt.",
    auth: true,
    params: OrgParamsNonEmpty,
    body: CommunityReportBody,
    response: ReportReceipt,
    errors: ["not_found", "report_limit"],
  }),
  route({
    method: "POST",
    url: "/v1/reports",
    tag,
    summary:
      "Report someone (optionally a message, with what the reporter chose to share), at most 10 an hour.",
    auth: true,
    body: ReportBody,
    response: ReportReceipt,
    errors: ["not_found", "report_limit"],
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/reports",
    tag,
    summary:
      "The community's open (or closed) reports, newest first in pages of 50, and how many are open.",
    auth: true,
    params: OrgParamsNonEmpty,
    query: ReportsQuery,
    response: z.strictObject({
      reports: z.array(ModeratorReportView),
      open: zCount,
      nextBefore: zTime.nullable(),
    }),
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "PATCH",
    url: "/v1/reports/:id",
    tag,
    summary:
      "Action, dismiss or reopen a community report (not one about yourself, unless you own the community).",
    auth: true,
    params: IdParamsNonEmpty,
    body: ReportStatusBody,
    response: z.strictObject({ report: ModeratorReportView }),
    errors: ["not_found", "own_report"],
  }),
];
