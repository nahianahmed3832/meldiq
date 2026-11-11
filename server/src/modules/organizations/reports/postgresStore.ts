import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import type {
  AdminReportQuery,
  ReportRow,
  ReportStatus,
  ReportStore,
} from "./store.js";

const columns =
  "id,org_id,reporter_id,target_user_id,conversation_id,message_id,reason,note,content,status,handled_by,handled_note,created_at,handled_at,target_org_id";

/** Report content remains sealed by the existing service. Raw client access is denied by RLS. */
export class PostgresReportStore implements ReportStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async create(row: ReportRow): Promise<void> {
    await this.db.query(
      `INSERT INTO meldiq.reports(${columns}) VALUES(${columns
        .split(",")
        .map((_, n) => `$${n + 1}`)
        .join(",")})`,
      columns.split(",").map((column) => row[column as keyof ReportRow]),
    );
  }
  async get(id: string): Promise<ReportRow | null> {
    return (
      (
        await this.db.query<ReportRow>(
          "SELECT * FROM meldiq.reports WHERE id=$1",
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async byReporterMessage(
    reporterId: string,
    messageId: string,
  ): Promise<ReportRow | null> {
    return (
      (
        await this.db.query<ReportRow>(
          "SELECT * FROM meldiq.reports WHERE reporter_id=$1 AND message_id=$2 LIMIT 1",
          [reporterId, messageId],
        )
      ).rows[0] ?? null
    );
  }
  async countSince(reporterId: string, since: number): Promise<number> {
    return (
      await this.db.query<{ count: number }>(
        "SELECT count(*) AS count FROM meldiq.reports WHERE reporter_id=$1 AND created_at>=$2",
        [reporterId, since],
      )
    ).rows[0].count;
  }
  async list(
    orgId: string | null,
    closed: boolean,
    limit: number,
    before = Number.MAX_SAFE_INTEGER,
  ): Promise<ReportRow[]> {
    return (
      await this.db.query<ReportRow>(
        `SELECT * FROM meldiq.reports WHERE org_id IS NOT DISTINCT FROM $1 AND (status='open')=$2
      AND created_at<$3 ORDER BY created_at DESC,id DESC LIMIT $4`,
        [orgId, !closed, before, limit],
      )
    ).rows;
  }
  async adminList(query: AdminReportQuery): Promise<ReportRow[]> {
    const where: string[] = [],
      params: unknown[] = [];
    for (const [column, value] of [
      ["status", query.status],
      ["org_id", query.orgId],
      ["target_user_id", query.targetUserId],
    ] as const) {
      if (value) {
        params.push(value);
        where.push(`${column}=$${params.length}`);
      }
    }
    if (query.q) {
      params.push(query.q);
      where.push(
        `(id=$${params.length} OR target_user_id=$${params.length} OR reason=$${params.length})`,
      );
    }
    if (query.after) {
      params.push(query.after.createdAt, query.after.id);
      where.push(`(created_at,id)<($${params.length - 1},$${params.length})`);
    }
    params.push(query.limit);
    return (
      await this.db.query<ReportRow>(
        `SELECT * FROM meldiq.reports${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,
        params,
      )
    ).rows;
  }
  async adminCounts(
    q: Omit<AdminReportQuery, "after" | "limit">,
  ): Promise<Record<ReportStatus, number>> {
    const where: string[] = [],
      params: string[] = [];
    for (const [column, value] of [
      ["status", q.status],
      ["org_id", q.orgId],
      ["target_user_id", q.targetUserId],
    ] as const) {
      if (value) {
        params.push(value);
        where.push(`${column}=$${params.length}`);
      }
    }
    if (q.q) {
      params.push(q.q);
      where.push(
        `(id=$${params.length} OR target_user_id=$${params.length} OR reason=$${params.length})`,
      );
    }
    const result = await this.db.query<{ status: ReportStatus; count: number }>(
      `SELECT status, count(*) AS count FROM meldiq.reports${where.length ? ` WHERE ${where.join(" AND ")}` : ""} GROUP BY status`,
      params,
    );
    return {
      open: 0,
      actioned: 0,
      dismissed: 0,
      ...Object.fromEntries(
        result.rows.map((r) => [r.status, Number(r.count)]),
      ),
    };
  }
  async countOpen(orgId: string | null): Promise<number> {
    return (
      await this.db.query<{ count: number }>(
        "SELECT count(*) AS count FROM meldiq.reports WHERE org_id IS NOT DISTINCT FROM $1 AND status='open'",
        [orgId],
      )
    ).rows[0].count;
  }
  async setStatus(
    id: string,
    status: ReportStatus,
    by: string,
    note: string | null,
    at: number,
  ): Promise<ReportRow | null> {
    const closed = status !== "open";
    return (
      (
        await this.db.query<ReportRow>(
          `UPDATE meldiq.reports SET status=$2,handled_by=$3,handled_note=$4,handled_at=$5 WHERE id=$1 RETURNING *`,
          [
            id,
            status,
            closed ? by : null,
            closed ? note : null,
            closed ? at : null,
          ],
        )
      ).rows[0] ?? null
    );
  }
  async purgeClosed(before: number): Promise<number> {
    return (
      (
        await this.db.query(
          "DELETE FROM meldiq.reports WHERE status<>'open' AND handled_at<$1",
          [before],
        )
      ).rowCount ?? 0
    );
  }
  async resolve(
    id: string,
    status: ReportStatus,
    by: string,
    note: string | null,
    at: number,
  ) {
    const closed = status !== "open";
    const row = (
      await this.db.query<ReportRow>(
        `UPDATE meldiq.reports SET status=$2,handled_by=$3,handled_note=$4,handled_at=$5
      WHERE id=$1 AND (status<>$2 OR handled_note IS DISTINCT FROM $4) RETURNING *`,
        [
          id,
          status,
          closed ? by : null,
          closed ? note : null,
          closed ? at : null,
        ],
      )
    ).rows[0];
    return { row: row ?? (await this.get(id)), changed: !!row };
  }
  async deleteForUser(userId: string): Promise<number> {
    return (
      (
        await this.db.query(
          "DELETE FROM meldiq.reports WHERE reporter_id=$1 OR target_user_id=$1",
          [userId],
        )
      ).rowCount ?? 0
    );
  }
  async deleteForOrg(orgId: string): Promise<number> {
    return (
      (
        await this.db.query(
          "DELETE FROM meldiq.reports WHERE org_id=$1 OR target_org_id=$1",
          [orgId],
        )
      ).rowCount ?? 0
    );
  }
}
