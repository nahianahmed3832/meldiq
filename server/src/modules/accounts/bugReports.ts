import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import type { RowReader, Rows } from "../../infrastructure/database/rows/index.js";
import { BugReportBody, FeedbackCategory } from "../../shared/contracts/http/users.js";
import { ApiError } from "../../shared/errors.js";
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
  return safety.write((w) => w.update("bug_reports", { id }, { status, ...(note !== null ? { staff_note: note } : {}), updated_at: now() }) === 1);
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
