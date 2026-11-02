import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import { PostgresDocuments } from "../../../infrastructure/database/postgres/documents.js";
import type { DecorationStatus } from "../../../shared/contracts/http/decorations.js";
import type { DecorationPage, DecorationStore, StoredDecoration } from "./store.js";

export class PostgresDecorationStore implements DecorationStore {
  readonly backend = "postgres" as const;
  private readonly store: PostgresDocuments<StoredDecoration>;
  constructor(private readonly db: MeldiqPostgres) { this.store = new PostgresDocuments(db, "profile_decorations"); }
  async insert(decoration: StoredDecoration): Promise<void> { await this.store.insert(decoration); }
  get(id: string): Promise<StoredDecoration | null> { return this.store.get(id); }
  approved(): Promise<StoredDecoration[]> { return this.store.find({status: "approved"}, {newestBy: "createdAt"}); }
  byCreator(creatorId: string): Promise<StoredDecoration[]> { return this.store.find({creatorId}, {newestBy: "createdAt"}); }
  countPending(creatorId: string): Promise<number> { return this.store.count({creatorId, status: "pending"}); }
  async page(status: DecorationStatus, before: number | null, limit: number): Promise<DecorationPage> {
    const rows = await this.store.find({status}, {newestBy: "createdAt", ...(before === null ? {} : {before}), limit: limit + 1});
    const items = rows.slice(0, limit);
    return {items, next: rows.length > limit && items.length ? items[items.length - 1].createdAt : null};
  }
  async review(id: string, from: readonly DecorationStatus[], change: Pick<StoredDecoration, "status" | "reviewedAt" | "reviewedBy" | "reason">): Promise<boolean> {
    return (await this.db.query(`UPDATE meldiq.profile_decorations SET status=$3,reviewed_at=$4,reviewed_by=$5,reason=$6 WHERE id=$1 AND status=ANY($2::text[])`,
      [id, [...from], change.status, change.reviewedAt, change.reviewedBy, change.reason])).rowCount === 1;
  }
  async remove(id: string): Promise<void> { await this.store.take(id); }
  async addWearers(id: string, by: number): Promise<void> {
    await this.db.query("UPDATE meldiq.profile_decorations SET wearers=greatest(0,wearers+$2) WHERE id=$1", [id, by]);
  }
  async setWearers(id: string, count: number): Promise<void> {
    await this.db.query("UPDATE meldiq.profile_decorations SET wearers=$2 WHERE id=$1", [id, count]);
  }
}
