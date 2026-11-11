import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import type { RowReader, Rows, Where } from "../../infrastructure/database/rows/index.js";
import { BugReportBody, FeedbackCategory } from "../../shared/contracts/http/users.js";
import { ApiError, conflict, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validation/index.js";
import { newId, now } from "../../shared/utilities/util.js";
import { me, requireAuth } from "../auth/index.js";

/**
 * Bug reports (API 0.46.0, docs/ACCOUNT_SAFETY.md): people describe what went wrong from Settings; staff review them
 * with the operator CLI (`admin.js bug-reports`, `bug-report <id> <status>`). A report staff confirm or fix earns its
 * reporter the Bug Hunter badge, shown on their profile. Nothing from the person's messages is attached.
 */
export const BUG_STATUSES = ["open", "confirmed", "fixed", "not_a_bug", "duplicate"] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];
const PER_DAY = 10;

export interface BugReportRow {
  id: string;
  user_id: string;
  category?: (typeof FeedbackCategory.options)[number];
  summary: string;
  details: string;
  page: string | null;
  client: string | null;
  status: BugStatus;
  staff_note: string | null;
  created_at: number;
  updated_at: number;
}

const view = (r: BugReportRow) => ({ id: r.id, summary: r.summary, category: r.category, details: r.details, page: r.page, status: r.status, staffNote: r.staff_note, createdAt: r.created_at, updatedAt: r.updated_at });

/** Whether [userId] has a report staff confirmed or fixed (the Bug Hunter badge). */
export function isBugHunter(safety: Rows, userId: string): boolean {
  return !!safety.get("bug_reports", { user_id: userId, ...(safety.backend === "postgres" ? { category: "bug" } : {}), status: { in: ["confirmed", "fixed"] } });
}

export function setBugStatus(safety: Rows, id: string, status: BugStatus, note: string | null): Promise<boolean> {
  return safety.write((w) => {
    const current = w.get<BugReportRow>("bug_reports", { id });
    return !!current && w.update("bug_reports", { id }, { status, ...(note !== null ? { staff_note: note } : {}), updated_at: Math.max(now(), current.updated_at + 1) }) === 1;
  });
}

/** Canonical, deliberately submitted feedback; callers enforce their administrative view/field grants. */
export function bugReport(safety: RowReader, id: string): BugReportRow | undefined {
  return safety.get<BugReportRow>("bug_reports", { id });
}

export function bugReportsPage(safety: RowReader, q: { status?: BugStatus; userId?: string; after?: { createdAt: number; id: string }; limit: number }): BugReportRow[] {
  const where: Where = { ...(q.status ? { status: q.status } : {}), ...(q.userId ? { user_id: q.userId } : {}) };
  if (q.after) where.$or = [{ created_at: { lt: q.after.createdAt } }, { created_at: q.after.createdAt, id: { lt: q.after.id } }];
  return safety.all<BugReportRow>("bug_reports", { where, orderBy: [["created_at", "desc"], ["id", "desc"]], limit: Math.min(101, Math.max(1, q.limit)) });
}

/** Compare-and-set with an exact accepted-write replay for the platform review journal. */
export async function applyBugReview(safety: Rows, id: string, review: { expectedAt: number; applyAt: number; status: BugStatus; note: string | null }): Promise<void> {
  await safety.write(w => {
    const current = bugReport(w, id);
    if (!current) throw notFound("Submitted feedback not found.");
    if (current.updated_at === review.applyAt && current.status === review.status && current.staff_note === review.note) return;
    if (current.updated_at !== review.expectedAt) throw conflict("This feedback changed. Reload it and review the latest status before saving.");
    w.update("bug_reports", { id, updated_at: review.expectedAt }, { status: review.status, staff_note: review.note, updated_at: review.applyAt });
  });
}

/** Reports newest first, with their reporters' usernames (reports of people no longer here are left out). */
export function listBugReports(safety: RowReader, identity: RowReader, status: BugStatus | null, limit = 50): (BugReportRow & { username: string })[] {
  const out: (BugReportRow & { username: string })[] = [];
  for (const b of safety.all<BugReportRow>("bug_reports", { where: status ? { status } : {}, orderBy: [["created_at", "desc"]], limit })) {
    if (out.length >= limit) break;
    const u = identity.get<{ username: string }>("users", { id: b.user_id });
    if (u) out.push({ ...b, username: u.username });
  }
  return out;
}

export default async function bugReportRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.post("/v1/bug-reports", auth, async (req, reply) => {
    const { userId } = me(req);
    const body = parse(BugReportBody, req.body);
    const t = now();
    const categorized = ctx.safety.backend === "postgres";
    const category = categorized ? (body.category ?? "bug") : "bug";
    const { row, created } = await ctx.safety.write((w) => {
      const recent = w.all<BugReportRow>("bug_reports", {
        where: { user_id: userId, created_at: { gt: t - 86_400_000 } },
        orderBy: [["created_at", "desc"]],
        limit: PER_DAY,
      });
      const same = (a: string, b: string) => a.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase() === b.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
      const previous = recent.find((r) => (r.category ?? "bug") === category && same(r.summary, body.summary) && same(r.details, body.details));
      if (previous) return { row: previous, created: false };
      if (recent.length >= PER_DAY) throw new ApiError(429, "rate_limited", "You can send up to 10 feedback submissions per day.");
      const row: BugReportRow = {
        id: newId("bug"), user_id: userId, ...(categorized ? { category } : {}), summary: body.summary, details: body.details,
        page: body.page ?? null, client: body.client ?? null, status: "open", staff_note: null, created_at: t, updated_at: t,
      };
      w.insert("bug_reports", { ...row });
      return { row, created: true };
    });
    if (created) ctx.audit({ actorId: userId, action: "bug.report", target: row.id });
    reply.header("cache-control", "no-store");
    reply.code(201);
    return { report: view(row) };
  });

  app.get("/v1/bug-reports", { preHandler: requireAuth(ctx) }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { userId } = me(req);
    const rows = ctx.safety.all<BugReportRow>("bug_reports", { where: { user_id: userId }, orderBy: [["created_at", "desc"]], limit: 100 });
    return { reports: rows.map(view), bugHunter: isBugHunter(ctx.safety, userId) };
  });
}
