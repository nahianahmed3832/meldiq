import type { DB } from "../../../infrastructure/database/db.js";

/** Why someone reports (the reporter picks one; [REPORT_REASONS] in this order is what the apps offer). */
export const REPORT_REASONS = [
  "spam",
  "harassment",
  "harmful",
  "private_info",
  "illegal",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportStatus = "open" | "actioned" | "dismissed";

/** A report as stored (the same field names in SQLite and MongoDB). [content] is sealed (src/reports/seal.ts). */
export interface ReportRow {
  id: string;
  org_id: string | null;
  reporter_id: string;
  target_user_id: string;
  /** Community reports use the reporter only as the legacy FK anchor; APIs never expose that anchor as the target. */
  target_org_id?: string | null;
  conversation_id: string | null;
  message_id: string | null;
  reason: ReportReason;
  note: string | null;
  content: string | null;
  status: ReportStatus;
  handled_by: string | null;
  handled_note: string | null;
  created_at: number;
  handled_at: number | null;
}

/**
 * Where reports live (batch B4): SQLite, or MongoDB when MONGODB_DOMAINS includes "reports" (src/mongo/reports.ts).
 * [orgId] null is Meldiq's operators' queue.
 */
export interface AdminReportQuery {
  status?: ReportStatus;
  orgId?: string;
  targetUserId?: string;
  q?: string;
  after?: { createdAt: number; id: string };
  limit: number;
}

export interface ReportStore {
  adminList(q: AdminReportQuery): Promise<ReportRow[]>;
  adminCounts(
    q: Omit<AdminReportQuery, "after" | "limit">,
  ): Promise<Record<ReportStatus, number>>;
  readonly backend: "sqlite" | "mongodb" | "postgres";
  create(r: ReportRow): Promise<void>;
  get(id: string): Promise<ReportRow | null>;
  /** An open or closed report [reporterId] already made about [messageId] (reporting twice returns the first). */
  byReporterMessage(
    reporterId: string,
    messageId: string,
  ): Promise<ReportRow | null>;
  /** How many reports [reporterId] made since [since] (the hourly limit). */
  countSince(reporterId: string, since: number): Promise<number>;
  /** Open ones, or closed ones (actioned and dismissed), newest first, before [before] (a created_at) when paging. */
  list(
    orgId: string | null,
    closed: boolean,
    limit: number,
    before?: number,
  ): Promise<ReportRow[]>;
  countOpen(orgId: string | null): Promise<number>;
  /** Sets the status; returns the updated report, or null when there's no such report. */
  setStatus(
    id: string,
    status: ReportStatus,
    by: string,
    note: string | null,
    at: number,
  ): Promise<ReportRow | null>;
  /** Atomic semantic transition. Retries preserve the original handler/time and have no side effects. */
  resolve(
    id: string,
    status: ReportStatus,
    by: string,
    note: string | null,
    at: number,
  ): Promise<{ row: ReportRow | null; changed: boolean }>;
  /** Closed reports handled before [before] go (retention). Returns how many. */
  purgeClosed(before: number): Promise<number>;
  /** An account was deleted: reports it made or that are about it go. */
  deleteForUser(userId: string): Promise<number>;
  /** A community was deleted. */
  deleteForOrg(orgId: string): Promise<number>;
}

export class SqliteReportStore implements ReportStore {
  readonly backend = "sqlite" as const;
  constructor(private readonly db: DB) {}

  async adminList(q: AdminReportQuery): Promise<ReportRow[]> {
    const where: string[] = ["1 = 1"];
    const args: (string | number)[] = [];
    for (const [col, value] of [
      ["status", q.status],
      ["org_id", q.orgId],
      ["target_user_id", q.targetUserId],
    ] as const) {
      if (value) {
        where.push(`${col} = ?`);
        args.push(value);
      }
    }
    if (q.q) {
      where.push("(id = ? OR target_user_id = ? OR reason = ?)");
      args.push(q.q, q.q, q.q);
    }
    if (q.after) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(q.after.createdAt, q.after.createdAt, q.after.id);
    }
    return this.db
      .prepare(
        `SELECT * FROM reports WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, q.limit) as ReportRow[];
  }

  async adminCounts(
    q: Omit<AdminReportQuery, "after" | "limit">,
  ): Promise<Record<ReportStatus, number>> {
    const where: string[] = ["1 = 1"],
      args: string[] = [];
    for (const [column, value] of [
      ["status", q.status],
      ["org_id", q.orgId],
      ["target_user_id", q.targetUserId],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`);
        args.push(value);
      }
    }
    if (q.q) {
      where.push("(id = ? OR target_user_id = ? OR reason = ?)");
      args.push(q.q, q.q, q.q);
    }
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM reports WHERE ${where.join(" AND ")} GROUP BY status`,
      )
      .all(...args) as { status: ReportStatus; count: number }[];
    return {
      open: 0,
      actioned: 0,
      dismissed: 0,
      ...Object.fromEntries(rows.map((r) => [r.status, r.count])),
    };
  }

  async create(r: ReportRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO reports (id, org_id, reporter_id, target_user_id, conversation_id, message_id, reason, note, content, status, handled_by, handled_note, created_at, handled_at, target_org_id)
         VALUES (@id, @org_id, @reporter_id, @target_user_id, @conversation_id, @message_id, @reason, @note, @content, @status, @handled_by, @handled_note, @created_at, @handled_at, @target_org_id)`,
      )
      .run({ ...r, target_org_id: r.target_org_id ?? null });
  }

  async get(id: string): Promise<ReportRow | null> {
    return (
      (this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as
        ReportRow | undefined) ?? null
    );
  }

  async byReporterMessage(
    reporterId: string,
    messageId: string,
  ): Promise<ReportRow | null> {
    return (
      (this.db
        .prepare(
          "SELECT * FROM reports WHERE reporter_id = ? AND message_id = ? LIMIT 1",
        )
        .get(reporterId, messageId) as ReportRow | undefined) ?? null
    );
  }

  async countSince(reporterId: string, since: number): Promise<number> {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM reports WHERE reporter_id = ? AND created_at >= ?",
        )
        .get(reporterId, since) as { n: number }
    ).n;
  }

  async list(
    orgId: string | null,
    closed: boolean,
    limit: number,
    before = Number.MAX_SAFE_INTEGER,
  ): Promise<ReportRow[]> {
    return this.db
      .prepare(
        `SELECT * FROM reports WHERE org_id IS ? AND (status = 'open') = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(orgId, closed ? 0 : 1, before, limit) as ReportRow[];
  }

  async countOpen(orgId: string | null): Promise<number> {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM reports WHERE org_id IS ? AND status = 'open'",
        )
        .get(orgId) as { n: number }
    ).n;
  }

  async setStatus(
    id: string,
    status: ReportStatus,
    by: string,
    note: string | null,
    at: number,
  ): Promise<ReportRow | null> {
    const closed = status !== "open";
    this.db
      .prepare(
        "UPDATE reports SET status = ?, handled_by = ?, handled_note = ?, handled_at = ? WHERE id = ?",
      )
      .run(
        status,
        closed ? by : null,
        closed ? note : null,
        closed ? at : null,
        id,
      );
    return this.get(id);
  }

  async purgeClosed(before: number): Promise<number> {
    return this.db
      .prepare("DELETE FROM reports WHERE status != 'open' AND handled_at < ?")
      .run(before).changes;
  }

  async resolve(
    id: string,
    status: ReportStatus,
    by: string,
    note: string | null,
    at: number,
  ) {
    const closed = status !== "open";
    const changed =
      this.db
        .prepare(
          `UPDATE reports SET status = ?, handled_by = ?, handled_note = ?, handled_at = ?
      WHERE id = ? AND (status != ? OR handled_note IS NOT ?)`,
        )
        .run(
          status,
          closed ? by : null,
          closed ? note : null,
          closed ? at : null,
          id,
          status,
          closed ? note : null,
        ).changes > 0;
    return { row: await this.get(id), changed };
  }

  async deleteForUser(userId: string): Promise<number> {
    return this.db
      .prepare(
        "DELETE FROM reports WHERE reporter_id = ? OR target_user_id = ?",
      )
      .run(userId, userId).changes;
  }

  async deleteForOrg(orgId: string): Promise<number> {
    return this.db
      .prepare("DELETE FROM reports WHERE org_id = ? OR target_org_id = ?")
      .run(orgId, orgId).changes;
  }
}
