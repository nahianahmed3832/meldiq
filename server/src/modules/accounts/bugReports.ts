import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import type { DB } from "../../infrastructure/database/db.js";
import { BugReportBody } from "../../shared/contracts/http/users.js";
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
  summary: string;
  details: string;
  page: string | null;
  client: string | null;
  status: BugStatus;
  staff_note: string | null;
  created_at: number;
  updated_at: number;
}

const view = (r: BugReportRow) => ({ id: r.id, summary: r.summary, details: r.details, page: r.page, status: r.status, staffNote: r.staff_note, createdAt: r.created_at, updatedAt: r.updated_at });

/** Whether [userId] has a report staff confirmed or fixed (the Bug Hunter badge). */
export function isBugHunter(db: DB, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM bug_reports WHERE user_id = ? AND status IN ('confirmed', 'fixed') LIMIT 1").get(userId);
}

export function setBugStatus(db: DB, id: string, status: BugStatus, note: string | null): boolean {
  return db.prepare("UPDATE bug_reports SET status = ?, staff_note = COALESCE(?, staff_note), updated_at = ? WHERE id = ?").run(status, note, now(), id).changes === 1;
}

export function listBugReports(db: DB, status: BugStatus | null, limit = 50): (BugReportRow & { username: string })[] {
  const where = status ? "WHERE b.status = ?" : "";
  return db
    .prepare(`SELECT b.*, u.username FROM bug_reports b JOIN users u ON u.id = b.user_id ${where} ORDER BY b.created_at DESC LIMIT ?`)
    .all(...(status ? [status, limit] : [limit])) as (BugReportRow & { username: string })[];
}

export default async function bugReportRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.post("/v1/bug-reports", auth, async (req, reply) => {
    const { userId } = me(req);
    const body = parse(BugReportBody, req.body);
    const t = now();
    const today = (ctx.db.prepare("SELECT COUNT(*) n FROM bug_reports WHERE user_id = ? AND created_at > ?").get(userId, t - 86_400_000) as { n: number }).n;
    if (today >= PER_DAY) throw new ApiError(429, "rate_limited", `You can send up to ${PER_DAY} bug reports a day. Thanks for all of them!`);
    const row: BugReportRow = {
      id: newId("bug"),
      user_id: userId,
      summary: body.summary,
      details: body.details,
      page: body.page ?? null,
      client: body.client ?? null,
      status: "open",
      staff_note: null,
      created_at: t,
      updated_at: t,
    };
    ctx.db
      .prepare("INSERT INTO bug_reports (id, user_id, summary, details, page, client, status, staff_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.user_id, row.summary, row.details, row.page, row.client, row.status, row.staff_note, row.created_at, row.updated_at);
    ctx.audit({ actorId: userId, action: "bug.report", target: row.id });
    reply.code(201);
    return { report: view(row) };
  });

  app.get("/v1/bug-reports", { preHandler: requireAuth(ctx) }, async (req) => {
    const { userId } = me(req);
    const rows = ctx.db.prepare("SELECT * FROM bug_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(userId) as BugReportRow[];
    return { reports: rows.map(view), bugHunter: rows.some((r) => r.status === "confirmed" || r.status === "fixed") };
  });
}
