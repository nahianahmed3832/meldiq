import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AdminFeedbackQuery,
  AdminFeedbackParams,
  AdminFeedbackReview,
  AdminFeedbackCaseBody,
} from "../../shared/contracts/http/platformAdmin.js";
import { parse } from "../../shared/validation/index.js";
import { conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { applyBugReview, bugReport, bugReportsPage, type BugReportRow } from "../accounts/index.js";
import type { AdminDeps } from "./dataRoutes.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import { allowed } from "./permissions.js";
import type { AdminPrincipal } from "./auth.js";
import { decodeCursor, page } from "./pagination.js";
import { AdminIncidents } from "./incidents.js";

type Status = "open" | "confirmed" | "fixed" | "not_a_bug" | "duplicate";
type Feedback = BugReportRow;
interface Review {
  id: string;
  feedback_id: string;
  actor_account_id: string;
  request_key: string;
  request_hash: string;
  status: "requested" | "applied" | "failed";
  expected_at: number;
  apply_at: number;
  desired_status: Status;
  created_at: number;
  completed_at: number | null;
}

/** Operator review of content deliberately submitted in Settings; never a conversation or message-content query. */
export default async function supportFeedbackRoutes(
  app: FastifyInstance,
  d: AdminDeps,
) {
  const needs = (permission: "incidents.view" | "incidents.manage") => ({
    preHandler: requirePermission(d.auth, d.audit, permission),
  });
  const cases = new AdminIncidents(d.ctx, d.store, d.audit);
  const row = (id: string) => {
    const value = bugReport(d.ctx.safety, id);
    if (!value) throw notFound("Submitted feedback not found.");
    return value;
  };
  const view = (p: AdminPrincipal, value: Feedback) => ({
    id: value.id,
    userId: allowed(p.grant, "users.view") ? value.user_id : null,
    summary: value.summary,
    details: value.details,
    category: value.category ?? "bug",
    status: value.status,
    page: value.page,
    client: value.client,
    staffNote: value.staff_note,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    caseId:
      d.ctx.platform.get<{ id: string }>("platform_incidents", {
        intake_ref: value.id,
      })?.id ?? null,
  });
  const detail = (p: AdminPrincipal, id: string) => ({
    feedback: view(p, row(id)),
    reviews: d.ctx.platform
      .all<Review>("platform_feedback_reviews", {
        where: { feedback_id: id },
        orderBy: [
          ["created_at", "desc"],
          ["id", "desc"],
        ],
        limit: 20,
      })
      .map((r) => ({
        id: r.id,
        actorAccountId: r.actor_account_id,
        status: r.status,
        desiredStatus: r.desired_status,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      })),
  });
  app.get(
    "/admin/v1/support/feedback",
    needs("incidents.view"),
    async (req) => {
      const q = parse(AdminFeedbackQuery, req.query),
        p = principal(req);
      if (q.userId && !allowed(p.grant, "users.view"))
        throw forbidden(
          "Viewing people is required to filter feedback by account.",
        );
      const result = page(
        bugReportsPage(d.ctx.safety, { status: q.status, userId: q.userId, after: decodeCursor(q.cursor), limit: q.limit + 1 }),
        q.limit,
      );
      return {
        feedback: result.rows.map((value) => view(p, value)),
        nextCursor: result.nextCursor,
      };
    },
  );
  app.get(
    "/admin/v1/support/feedback/:feedbackId",
    needs("incidents.view"),
    async (req) =>
      detail(principal(req), parse(AdminFeedbackParams, req.params).feedbackId),
  );
  app.post(
    "/admin/v1/support/feedback/:feedbackId/case",
    needs("incidents.manage"),
    async (req) => {
      const id = parse(AdminFeedbackParams, req.params).feedbackId,
        b = parse(AdminFeedbackCaseBody, req.body),
        p = principal(req),
        f = row(id);
      return cases.create(
        p,
        {
          requestKey: b.requestKey,
          title: f.summary,
          kind: "support",
          severity: "sev3",
          description: b.reason,
          userRef: f.user_id,
          feedbackRef: id,
        },
        metaOf(req),
      );
    },
  );
  app.patch(
    "/admin/v1/support/feedback/:feedbackId",
    needs("incidents.manage"),
    async (req) => {
      const id = parse(AdminFeedbackParams, req.params).feedbackId,
        b = parse(AdminFeedbackReview, req.body),
        p = principal(req),
        meta = metaOf(req);
      row(id);
      const hash = createHash("sha256")
          .update(JSON.stringify({ id, ...b }))
          .digest("hex"),
        at = now();
      const operation = await d.ctx.platform.write((w) => {
        const existing = w.get<Review>("platform_feedback_reviews", {
          actor_account_id: p.account.id,
          request_key: b.requestKey,
        });
        if (existing) {
          if (existing.request_hash !== hash)
            throw conflict(
              "This request key already belongs to another feedback review.",
            );
          return existing;
        }
        const value: Review = {
          id: newId("fbr"),
          feedback_id: id,
          actor_account_id: p.account.id,
          request_key: b.requestKey,
          request_hash: hash,
          status: "requested",
          expected_at: b.expectedUpdatedAt,
          apply_at: Math.max(at, b.expectedUpdatedAt + 1),
          desired_status: b.status,
          created_at: at,
          completed_at: null,
        };
        w.insert("platform_feedback_reviews", { ...value });
        d.audit.append(w, {
          actorAccountId: p.account.id,
          actorRole: p.grant.role,
          action: "feedback.review_requested",
          outcome: "success",
          targetType: "feedback",
          targetId: id,
          reason: b.reason,
          requestId: meta.requestId,
          detail: { operation: value.id, desiredStatus: b.status },
        });
        return value;
      });
      if (operation.status === "applied") return detail(p, id);
      if (operation.status === "failed")
        throw conflict(
          "This feedback review previously failed. Reload the current feedback before making a new review.",
        );
      try {
        await applyBugReview(d.ctx.safety, id, { expectedAt: operation.expected_at, applyAt: operation.apply_at, status: operation.desired_status, note: b.staffNote });
        await d.ctx.platform.write((w) => {
          const current = w.get<Review>("platform_feedback_reviews", {
            id: operation.id,
          });
          if (current?.status === "applied") return;
          w.update(
            "platform_feedback_reviews",
            { id: operation.id },
            { status: "applied", completed_at: now() },
          );
          d.audit.append(w, {
            actorAccountId: p.account.id,
            actorRole: p.grant.role,
            action: "feedback.review",
            outcome: "success",
            targetType: "feedback",
            targetId: id,
            reason: b.reason,
            requestId: meta.requestId,
            detail: {
              operation: operation.id,
              status: operation.desired_status,
            },
          });
        });
      } catch (error) {
        // Preserve uncertain requests if the canonical write succeeded but bookkeeping was interrupted.
        const current = bugReport(d.ctx.safety, id);
        if (!(
          current?.updated_at === operation.apply_at &&
          current.status === operation.desired_status &&
          current.staff_note === b.staffNote
        ))
          await d.ctx.platform.write((w) => {
            w.update(
              "platform_feedback_reviews",
              { id: operation.id },
              { status: "failed", completed_at: now() },
            );
            d.audit.append(w, {
              actorAccountId: p.account.id,
              actorRole: p.grant.role,
              action: "feedback.review",
              outcome: "failed",
              targetType: "feedback",
              targetId: id,
              reason: b.reason,
              requestId: meta.requestId,
              detail: { operation: operation.id },
            });
          });
        throw error;
      }
      return detail(p, id);
    },
  );
}
