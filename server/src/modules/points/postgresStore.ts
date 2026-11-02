import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import type { AchievementAward } from "./achievements.js";
import type { DaySet, InviteJoin, InviteState, PointsAccount, PointsDay, PointsEntry, PointsKind, PointsStore } from "./store.js";

const accountColumns = 'id AS "userId",balance,earned_total AS "earnedTotal",level,streak,last_visit_day AS "lastVisitDay"';
const entryColumns = 'id,user_id AS "userId",kind,amount,detail,day,at';
const inviteColumns = 'id,inviter_id AS "inviterId",joiner_id AS "joinerId",org_id AS "orgId",joined_at AS "joinedAt",state,settled_at AS "settledAt"';

/** Server-earned points only. Ledger idempotency, account/day totals and level purchases commit together. */
export class PostgresPointsStore implements PointsStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async account(userId: string): Promise<PointsAccount | null> {
    return (await this.db.query<PointsAccount>(`SELECT ${accountColumns} FROM meldiq.points_accounts WHERE id=$1`, [userId])).rows[0] ?? null;
  }
  async leaderboard(metric: "level" | "embers" | "invites"): Promise<{userId: string; count: number}[]> {
    if (metric === "invites") return (await this.db.query<{userId: string; count: number}>(`SELECT inviter_id AS "userId",count(*) AS count FROM meldiq.points_invites WHERE state='credited' GROUP BY inviter_id`)).rows;
    return (await this.db.query<{userId: string; count: number}>(`SELECT id AS "userId",${metric === "level" ? "level" : "earned_total"} AS count FROM meldiq.points_accounts`)).rows;
  }
  async levels(): Promise<Map<string, number>> {
    const rows = (await this.db.query<{id: string; level: number}>("SELECT id,level FROM meldiq.points_accounts WHERE level>1")).rows;
    return new Map(rows.map(row => [row.id, row.level]));
  }
  async achievementAwards(userId?: string): Promise<AchievementAward[]> {
    const rows = (await this.db.query<{userId: string; detail: string; at: number}>(`SELECT user_id AS "userId",detail,at FROM meldiq.points_ledger
      WHERE ($1::text IS NULL OR user_id=$1) AND kind='quest' AND amount=0 AND starts_with(detail,'achievement:')`, [userId ?? null])).rows;
    return rows.map(row => ({userId: row.userId, achievementId: row.detail.slice("achievement:".length), at: row.at}));
  }
  async earn(entry: PointsEntry): Promise<boolean> {
    if (!Number.isSafeInteger(entry.amount) || entry.amount < 0) throw new Error("Earnings must be nonnegative exact integers");
    return this.db.transaction(async () => {
      await this.lock(entry.userId);
      // A queued earning must not recreate deleted private records after account deletion's cleanup.
      if (await this.deleted(entry.userId)) return false;
      if (!await this.insertEntry(entry, true)) return false;
      await this.db.query(`INSERT INTO meldiq.points_accounts(id,balance,earned_total,level,streak,last_visit_day,updated_at) VALUES($1,$2,$2,1,0,NULL,$3)
        ON CONFLICT(id) DO UPDATE SET balance=points_accounts.balance+excluded.balance,earned_total=points_accounts.earned_total+excluded.earned_total,updated_at=excluded.updated_at`,
      [entry.userId, entry.amount, entry.at]);
      await this.ensureDay(entry.userId, entry.day);
      await this.db.query("UPDATE meldiq.points_days SET earned=earned+$2 WHERE id=$1", [`${entry.userId}|${entry.day}`, entry.amount]);
      // Reject unsafe API totals before committing, rather than round them after the ledger is already durable.
      await this.account(entry.userId);
      return true;
    });
  }
  async levelUp(userId: string, cost: number, entry: (level: number) => PointsEntry): Promise<PointsAccount | null> {
    if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error("Level cost must be a positive exact integer");
    return this.db.transaction(async () => {
      await this.lock(userId);
      if (await this.deleted(userId)) return null;
      const next = (await this.db.query<PointsAccount>(`UPDATE meldiq.points_accounts SET balance=balance-$2,level=level+1 WHERE id=$1 AND balance>=$2 RETURNING ${accountColumns}`, [userId, cost])).rows[0];
      if (!next) return null;
      const record = entry(next.level);
      if (record.userId !== userId || record.amount !== -cost || record.kind !== "level") throw new Error("Level ledger does not match the debit");
      await this.insertEntry(record, false);
      await this.db.query("UPDATE meldiq.points_accounts SET updated_at=$2 WHERE id=$1", [userId, record.at]);
      return next;
    });
  }
  async setStreak(userId: string, day: string, streak: number): Promise<void> {
    await this.db.query("UPDATE meldiq.points_accounts SET streak=$3,last_visit_day=$2 WHERE id=$1", [userId, day, streak]);
  }
  async day(userId: string, day: string): Promise<PointsDay | null> {
    return (await this.db.query<PointsDay>("SELECT earned,minutes,chats,reacted,replied FROM meldiq.points_days WHERE id=$1", [`${userId}|${day}`])).rows[0] ?? null;
  }
  async addToDay(userId: string, day: string, set: DaySet, value: string | number, cap: number): Promise<number | null> {
    if (!Number.isSafeInteger(cap)) throw new Error("Day set cap must be an integer");
    if (cap <= 0) return null;
    if (!["minutes", "chats", "reacted", "replied"].includes(set)) throw new Error("Unknown points day set");
    if (set === "minutes" ? !Number.isSafeInteger(value) : typeof value !== "string") throw new Error("Invalid points day value");
    return this.db.transaction(async () => {
      await this.lock(userId);
      if (await this.deleted(userId)) return null;
      await this.ensureDay(userId, day);
      const row = (await this.db.query<{size: number}>(`UPDATE meldiq.points_days SET "${set}"=array_append("${set}",$2)
        WHERE id=$1 AND NOT ($2=ANY("${set}")) AND cardinality("${set}")<$3 RETURNING cardinality("${set}") AS size`, [`${userId}|${day}`, value, cap])).rows[0];
      return row?.size ?? null;
    });
  }
  async recorded(ids: readonly string[]): Promise<Set<string>> {
    return new Set((await this.db.query<{id: string}>("SELECT id FROM meldiq.points_ledger WHERE id=ANY($1::text[])", [[...ids]])).rows.map(row => row.id));
  }
  async history(userId: string, limit: number): Promise<PointsEntry[]> {
    return (await this.db.query<PointsEntry>(`SELECT ${entryColumns} FROM meldiq.points_ledger WHERE user_id=$1 ORDER BY at DESC,id DESC LIMIT $2`, [userId, limit])).rows;
  }
  async countSince(userId: string, kind: PointsKind, since: number): Promise<number> {
    return (await this.db.query<{count: number}>("SELECT count(*) AS count FROM meldiq.points_ledger WHERE user_id=$1 AND kind=$2 AND at>=$3 AND amount>0", [userId, kind, since])).rows[0].count;
  }
  async addInvite(invite: InviteJoin): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.points_invites(id,inviter_id,joiner_id,org_id,joined_at,state,settled_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [invite.id, invite.inviterId, invite.joinerId, invite.orgId, invite.joinedAt, invite.state, invite.settledAt]);
  }
  async invitesBy(inviterId: string): Promise<InviteJoin[]> {
    return (await this.db.query<InviteJoin>(`SELECT ${inviteColumns} FROM meldiq.points_invites WHERE inviter_id=$1`, [inviterId])).rows;
  }
  async settleInvite(id: string, state: Exclude<InviteState, "pending">, at: number): Promise<boolean> {
    return (await this.db.query("UPDATE meldiq.points_invites SET state=$2,settled_at=$3 WHERE id=$1 AND state='pending'", [id, state, at])).rowCount === 1;
  }
  async deleteForUser(userId: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.lock(userId);
      await this.db.query("DELETE FROM meldiq.points_accounts WHERE id=$1", [userId]);
      await this.db.query("DELETE FROM meldiq.points_ledger WHERE user_id=$1", [userId]);
      await this.db.query("DELETE FROM meldiq.points_days WHERE user_id=$1", [userId]);
      await this.db.query("DELETE FROM meldiq.points_invites WHERE inviter_id=$1 OR joiner_id=$1", [userId]);
    });
  }
  private async insertEntry(entry: PointsEntry, ignoreDuplicate: boolean): Promise<boolean> {
    return (await this.db.query(`INSERT INTO meldiq.points_ledger(id,user_id,kind,amount,detail,day,at) VALUES($1,$2,$3,$4,$5,$6,$7)
      ${ignoreDuplicate ? "ON CONFLICT(id) DO NOTHING" : ""}`, [entry.id, entry.userId, entry.kind, entry.amount, entry.detail, entry.day, entry.at])).rowCount === 1;
  }
  private async ensureDay(userId: string, day: string): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.points_days(id,user_id,day,earned,minutes,chats,reacted,replied)
      VALUES($1,$2,$3,0,'{}'::bigint[],'{}'::text[],'{}'::text[],'{}'::text[]) ON CONFLICT(id) DO NOTHING`, [`${userId}|${day}`, userId, day]);
  }
  private async lock(userId: string): Promise<void> {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended('meldiq-points:' || $1,0))", [userId]);
  }
  private async deleted(userId: string): Promise<boolean> {
    const user = (await this.db.query<{deleted_at: number | null}>("SELECT deleted_at FROM meldiq.users WHERE id=$1 FOR SHARE", [userId])).rows[0];
    return user?.deleted_at != null;
  }
}
