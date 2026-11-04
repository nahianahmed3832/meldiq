import type { Collection } from "mongodb";
import type {
  AdminReportQuery,
  ReportRow,
  ReportStatus,
  ReportStore,
} from "./store.js";
import type { MeldiqMongo } from "../../../infrastructure/database/mongo/client.js";

/** reports: the SQLite row (same field names, docs/MONGODB.md §3) keyed by the report id. */
type ReportDoc = ReportRow & { _id: string };

/** Reports in MongoDB (MONGODB_DOMAINS includes "reports"). Every write is one document, so no transaction is needed. */
export class MongoReportStore implements ReportStore {
  readonly backend = "mongodb" as const;
  private readonly col: Collection<ReportDoc>;

  constructor(private readonly mongo: MeldiqMongo) {
    this.col = mongo.db.collection<ReportDoc>("reports");
  }

  private row(d: ReportDoc | null): ReportRow | null {
    if (!d) return null;
    const { _id: _ignored, ...r } = d;
    return r;
  }

  async adminList(q: AdminReportQuery): Promise<ReportRow[]> {
    const filter: import("mongodb").Filter<ReportDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.orgId) filter.org_id = q.orgId;
    if (q.targetUserId) filter.target_user_id = q.targetUserId;
    const groups: import("mongodb").Filter<ReportDoc>[] = [];
    if (q.q)
      groups.push({
        $or: [
          { id: q.q },
          { target_user_id: q.q },
          { reason: q.q as ReportRow["reason"] },
        ],
      });
    if (q.after)
      groups.push({
        $or: [
          { created_at: { $lt: q.after.createdAt } },
          { created_at: q.after.createdAt, _id: { $lt: q.after.id } },
        ],
      });
    if (groups.length) filter.$and = groups;
    const docs = await this.col
      .find(filter, {
        session: this.mongo.session(),
        sort: { created_at: -1, _id: -1 },
        limit: q.limit,
      })
      .toArray();
    return docs.map((d) => this.row(d)!);
  }

  async create(r: ReportRow): Promise<void> {
    await this.col.insertOne(
      { _id: r.id, ...r },
      { session: this.mongo.session() },
    );
  }

  async get(id: string): Promise<ReportRow | null> {
    return this.row(
      await this.col.findOne({ _id: id }, { session: this.mongo.session() }),
    );
  }

  async byReporterMessage(
    reporterId: string,
    messageId: string,
  ): Promise<ReportRow | null> {
    return this.row(
      await this.col.findOne(
        { reporter_id: reporterId, message_id: messageId },
        { session: this.mongo.session() },
      ),
    );
  }

  async countSince(reporterId: string, since: number): Promise<number> {
    return this.col.countDocuments(
      { reporter_id: reporterId, created_at: { $gte: since } },
      { session: this.mongo.session() },
    );
  }

  async list(
    orgId: string | null,
    closed: boolean,
    limit: number,
    before = Number.MAX_SAFE_INTEGER,
  ): Promise<ReportRow[]> {
    const docs = await this.col
      .find(
        {
          org_id: orgId,
          status: closed ? { $ne: "open" } : "open",
          created_at: { $lt: before },
        },
        {
          session: this.mongo.session(),
          sort: { created_at: -1, _id: -1 },
          limit,
        },
      )
      .toArray();
    return docs.map((d) => this.row(d)!);
  }

  async countOpen(orgId: string | null): Promise<number> {
    return this.col.countDocuments(
      { org_id: orgId, status: "open" },
      { session: this.mongo.session() },
    );
  }

  async setStatus(
    id: string,
    status: ReportStatus,
    by: string,
    note: string | null,
    at: number,
  ): Promise<ReportRow | null> {
    const closed = status !== "open";
    const d = await this.col.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status,
          handled_by: closed ? by : null,
          handled_note: closed ? note : null,
          handled_at: closed ? at : null,
        },
      },
      { session: this.mongo.session(), returnDocument: "after" },
    );
    return this.row(d);
  }

  async purgeClosed(before: number): Promise<number> {
    return (
      await this.col.deleteMany(
        { status: { $ne: "open" }, handled_at: { $lt: before } },
        { session: this.mongo.session() },
      )
    ).deletedCount;
  }
  async resolve(
    id: string,
    status: ReportStatus,
    by: string,
    note: string | null,
    at: number,
  ) {
    const closed = status !== "open";
    const handledNote = closed ? note : null;
    const row = this.row(
      await this.col.findOneAndUpdate(
        {
          _id: id,
          $or: [
            { status: { $ne: status } },
            { handled_note: { $ne: handledNote } },
          ],
        },
        {
          $set: {
            status,
            handled_by: closed ? by : null,
            handled_note: handledNote,
            handled_at: closed ? at : null,
          },
        },
        { session: this.mongo.session(), returnDocument: "after" },
      ),
    );
    return { row: row ?? (await this.get(id)), changed: !!row };
  }

  async deleteForUser(userId: string): Promise<number> {
    return (
      await this.col.deleteMany(
        { $or: [{ reporter_id: userId }, { target_user_id: userId }] },
        { session: this.mongo.session() },
      )
    ).deletedCount;
  }

  async deleteForOrg(orgId: string): Promise<number> {
    return (
      await this.col.deleteMany(
        { $or: [{ org_id: orgId }, { target_org_id: orgId }] },
        { session: this.mongo.session() },
      )
    ).deletedCount;
  }
}
