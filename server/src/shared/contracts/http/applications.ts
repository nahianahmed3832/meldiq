import { z } from "zod/v4";
import { ApplicationStatus, IdParamsNonEmpty, OkResult, OrgParamsNonEmpty } from "./community.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Join applications (batch B4b): a public community can ask up to five questions; people answer and wait; holders of
 * `members.approve` approve (the person joins, with the same checks as joining openly) or deny. Answers are plaintext
 * the applicant writes for moderators.
 */

/** At most this many questions. */
export const MAX_QUESTIONS = 5;

/** Someone named in an answer; username and displayName are null when the account is gone. */
export const PersonRef = z.strictObject({ id: z.string(), username: z.string().nullable(), displayName: z.string().nullable() });

export const ApplicationView = z.strictObject({
  id: z.string(),
  orgId: z.string(),
  user: PersonRef,
  /** The community's current questions (empty once it stops taking applications). */
  questions: z.array(z.string()),
  answers: z.array(z.string()),
  status: ApplicationStatus,
  createdAt: zTime,
  handledAt: zTime.nullable(),
  handledByName: z.string().nullable(),
  note: z.string().nullable(),
});

export const ApplicationQuestionsBody = z.strictObject({ questions: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_QUESTIONS).nullable() });
export const ApplyBody = z.strictObject({ answers: z.array(z.string().trim().max(1000)).max(MAX_QUESTIONS) });
export const ApplicationsQuery = z.object({ status: z.enum(["pending", "closed"]).default("pending") });
export const ApplicationAnswerBody = z.strictObject({ status: z.enum(["approved", "denied"]), note: z.string().trim().max(300).optional() });

const tag = "applications";

export const applicationRoutes = [
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/application",
    tag,
    summary: "Turn join applications on with these questions, change them, or turn them off (null).",
    auth: true,
    params: OrgParamsNonEmpty,
    body: ApplicationQuestionsBody,
    response: z.strictObject({ questions: z.array(z.string()).nullable() }),
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "POST",
    url: "/v1/communities/:id/apply",
    tag,
    summary: "Apply to join with an answer to every question; a pending application is answered again (repeated).",
    auth: true,
    params: IdParamsNonEmpty,
    body: ApplyBody,
    response: z.strictObject({ application: ApplicationView, repeated: z.boolean() }),
    errors: ["not_found", "conflict", "banned", "invites_paused", "community_locked", "account_too_new"],
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/applications",
    tag,
    summary: "The community's pending (or answered) applications, newest first (at most 100), and how many are pending.",
    auth: true,
    params: OrgParamsNonEmpty,
    query: ApplicationsQuery,
    response: z.strictObject({ applications: z.array(ApplicationView), pending: zCount }),
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "PATCH",
    url: "/v1/applications/:id",
    tag,
    summary: "Approve (the person joins) or deny an application.",
    auth: true,
    params: IdParamsNonEmpty,
    body: ApplicationAnswerBody,
    response: z.strictObject({ application: ApplicationView }),
    errors: ["not_found", "conflict", "banned", "limit_reached", "community_locked", "account_too_new"],
  }),
  route({
    method: "GET",
    url: "/v1/me/applications",
    tag,
    summary: "The person's own applications (pending and answered), newest first (at most 50).",
    auth: true,
    response: z.strictObject({
      applications: z.array(z.strictObject({ id: z.string(), orgId: z.string(), orgName: z.string().nullable(), status: ApplicationStatus, createdAt: zTime })),
    }),
  }),
  route({
    method: "DELETE",
    url: "/v1/applications/:id",
    tag,
    summary: "Withdraw one's own application (an answered one stays as it is).",
    auth: true,
    params: IdParamsNonEmpty,
    response: OkResult,
    errors: ["not_found"],
  }),
];
