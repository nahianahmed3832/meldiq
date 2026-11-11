import type { FastifyInstance } from "fastify";
import { networkKey } from "../../app/middleware/abuse.js";
import {
  AdminReportDetail,
  AdminReportRecoveryBody,
  AdminReportParams,
  AdminReportQuery,
  AdminReportUpdate,
} from "../../shared/contracts/http/platformAdmin.js";
import { parse } from "../../shared/validation/index.js";
import { conflict, badRequest, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import type { ReportRow } from "../organizations/index.js";
import type { AdminDeps } from "./dataRoutes.js";
import { metaOf, principal, requirePermission } from "./guards.js";
import { allowed } from "./permissions.js";
import { decodeCursor, page } from "./pagination.js";
import { ReportRecoveryOperations } from "./reportRecoveryOperations.js";

interface CaseRow {
  report_id: string;
  assignee_account_id: string | null;
  priority: string;
  appeal_status: string;
  sync_status: string;
  intended_status: string | null;
  version: number;
  updated_at: number;
}
interface EventRow {
  at: number;
  actor_account_id: string;
  kind: string;
  body: string;
}

/** The existing report store owns report state; the platform domain holds assignment and an audited resolution saga.
 * Never opens reportSealer or returns reporter identity or conversation contents. Ordinary report notes stay hidden;
 * only the approved whole-community report's submitted note is shown to its authorized operator reviewers. */
export default async function moderationRoutes(
  app: FastifyInstance,
  d: AdminDeps,
) {
  const needs = (permission: "reports.view" | "reports.manage") => ({
    preHandler: requirePermission(d.auth, d.audit, permission),
  });
  const caseOf = (id: string) =>
    d.ctx.platform.get<CaseRow>("platform_report_cases", { report_id: id });
  const view = (r: ReportRow) => {
    const c = caseOf(r.id);
    return {
      id: r.id,
      orgId: r.org_id,
      targetUserId: r.target_org_id ? null : r.target_user_id,
      ...(r.target_org_id
        ? { targetCommunityId: r.target_org_id, communityNote: r.note }
        : {}),
      reason: r.reason,
      kind: r.target_org_id
        ? ("community" as const)
        : r.message_id
          ? ("message" as const)
          : ("profile" as const),
      messageId: r.message_id,
      status: r.status,
      createdAt: r.created_at,
      handledAt: r.handled_at,
      assigneeAccountId: c?.assignee_account_id ?? null,
      priority: c?.priority ?? "normal",
      appealStatus: c?.appeal_status ?? "none",
      syncStatus: c?.sync_status ?? "synced",
      intendedStatus: c?.intended_status ?? null,
      version: c?.version ?? 0,
    };
  };
  const detail = async (id: string) => {
    const r = await d.ctx.reports.get(id);
    if (!r) throw notFound("Report not found");
    const events = d.ctx.platform.all<EventRow>("platform_report_events", {
      where: { report_id: id },
      orderBy: [["id", "desc"]],
      limit: 100,
    });
    return AdminReportDetail.parse({
      report: view(r),
      events: events.map((e) => ({
        at: e.at,
        actorAccountId: e.actor_account_id,
        kind: e.kind,
        body: e.body,
      })),
    });
  };
  const recovery = new ReportRecoveryOperations(d);
  app.get("/admin/v1/reports/recovery", needs("reports.view"), async () => recovery.history());
  app.post("/admin/v1/reports/recovery", { ...needs("reports.manage"), config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => recovery.run(principal(req), parse(AdminReportRecoveryBody, req.body), metaOf(req)));
  app.get("/admin/v1/reports/summary", needs("reports.view"), async (req) => {
    const q = parse(AdminReportQuery, req.query);
    const counts = await d.ctx.reports.adminCounts(q);
    return { generatedAt: now(), ...counts, total: counts.open + counts.actioned + counts.dismissed };
  });
  app.get("/admin/v1/reports", needs("reports.view"), async (req) => {
    const q = parse(AdminReportQuery, req.query);
    const rows = await d.ctx.reports.adminList({
      ...q,
      after: decodeCursor(q.cursor),
      limit: q.limit + 1,
    });
    const result = page(rows, q.limit);
    return { reports: result.rows.map(view), nextCursor: result.nextCursor };
  });
  app.get("/admin/v1/reports/assignees", needs("reports.manage"), async () => ({
    assignees: await Promise.all(
      d.store
        .grants()
        .filter((g) => g.revoked_at === null && allowed(g, "reports.manage"))
        .map(async (g) => ({
          accountId: g.account_id,
          name:
            (await d.ctx.accounts.store.accountById(g.account_id))?.name ??
            null,
        })),
    ),
  }));
  app.get("/admin/v1/reports/:reportId", needs("reports.view"), async (req) =>
    detail(parse(AdminReportParams, req.params).reportId),
  );
  app.patch(
    "/admin/v1/reports/:reportId",
    needs("reports.manage"),
    async (req) => {
      const { reportId } = parse(AdminReportParams, req.params);
      const b = parse(AdminReportUpdate, req.body);
      const p = principal(req);
      const meta = metaOf(req);
      const t = now();
      const report = await d.ctx.reports.get(reportId);
      if (!report) throw notFound("Report not found");
      if (
        p.account.user_id === report.target_user_id ||
        p.account.user_id === report.reporter_id
      )
        throw badRequest(
          "Another moderator must handle a report involving you.",
        );
      if (b.assigneeAccountId) {
        const assignee = d.store.activeGrant(b.assigneeAccountId);
        if (!assignee || !allowed(assignee, "reports.manage"))
          throw badRequest("Choose an active report moderator.");
      }
      await d.ctx.platform.write((w) => {
        const previous = w.get<CaseRow>("platform_report_cases", {
          report_id: reportId,
        });
        if ((previous?.version ?? 0) !== b.version)
          throw conflict("This report changed. Refresh it before saving.");
        if (
          previous?.sync_status === "pending" &&
          previous.updated_at > t - 60_000
        )
          throw conflict(
            "A resolution is still being applied. Refresh in a moment.",
          );
        const after = {
          assignee_account_id:
            b.assigneeAccountId === undefined
              ? (previous?.assignee_account_id ?? null)
              : b.assigneeAccountId,
          priority: b.priority ?? previous?.priority ?? "normal",
          appeal_status: b.appealStatus ?? previous?.appeal_status ?? "none",
          version: b.version + 1,
          updated_at: t,
          sync_status: b.status
            ? "pending"
            : (previous?.sync_status ?? "synced"),
          intended_status: b.status ?? previous?.intended_status ?? null,
        };
        w.upsert(
          "platform_report_cases",
          { report_id: reportId, ...after },
          after,
        );
        w.insert("platform_report_events", {
          report_id: reportId,
          actor_account_id: p.account.id,
          at: t,
          kind: b.status ? "resolution_requested" : "updated",
          body: b.note || b.reason,
        });
        d.audit.append(w, {
          action: "report.update",
          outcome: "success",
          actorAccountId: p.account.id,
          actorRole: p.grant.role,
          targetType: "report",
          targetId: reportId,
          reason: b.reason,
          requestId: meta.requestId,
          network: networkKey(meta.ip),
          detail: {
            beforeStatus: report.status,
            requestedStatus: b.status ?? null,
            beforeAssignee: previous?.assignee_account_id ?? null,
            assignee: after.assignee_account_id,
            beforePriority: previous?.priority ?? "normal",
            priority: after.priority,
            beforeAppeal: previous?.appeal_status ?? "none",
            appeal: after.appeal_status,
          },
        });
      });
      if (b.status) {
        try {
          if (
            !(await d.ctx.reports.setStatus(
              reportId,
              b.status,
              `platform:${p.account.id}`,
              b.reason,
              now(),
            ))
          )
            throw notFound("Report no longer exists");
          await d.ctx.platform.write((w) => {
            const current = w.get<CaseRow>("platform_report_cases", {
              report_id: reportId,
            });
            if (
              current?.version !== b.version + 1 ||
              current.sync_status !== "pending"
            )
              return;
            w.update(
              "platform_report_cases",
              { report_id: reportId },
              { sync_status: "synced", intended_status: null },
            );
            w.insert("platform_report_events", {
              report_id: reportId,
              actor_account_id: p.account.id,
              at: now(),
              kind: "resolved",
              body: b.status!,
            });
            d.audit.append(w, {
              action: "report.resolve",
              outcome: "success",
              actorAccountId: p.account.id,
              actorRole: p.grant.role,
              targetType: "report",
              targetId: reportId,
              reason: b.reason,
              detail: { status: b.status! },
            });
          });
        } catch (e) {
          await d.ctx.platform.write((w) => {
            const current = w.get<CaseRow>("platform_report_cases", {
              report_id: reportId,
            });
            if (
              current?.version !== b.version + 1 ||
              current.sync_status !== "pending"
            )
              return;
            w.update(
              "platform_report_cases",
              { report_id: reportId },
              { sync_status: "failed" },
            );
            d.audit.append(w, {
              action: "report.resolve",
              outcome: "failed",
              actorAccountId: p.account.id,
              actorRole: p.grant.role,
              targetType: "report",
              targetId: reportId,
              reason: b.reason,
            });
          });
          throw e;
        }
      }
      return detail(reportId);
    },
  );
}
