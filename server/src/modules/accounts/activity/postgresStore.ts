import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import type { ActivityStore, StoredActivity } from "./store.js";

/** Durable activity TTL metadata; online presence and typing still use ephemeral Realtime channels. */
export class PostgresActivityStore implements ActivityStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async live(at: number): Promise<StoredActivity[]> {
    return (await this.db.query<StoredActivity>(`SELECT id AS "userId",activity,updated_at AS "updatedAt",expires_at AS "expiresAt"
      FROM meldiq.user_activities WHERE expires_at>$1 ORDER BY id`, [at])).rows;
  }
  async put(entry: StoredActivity): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.user_activities(id,activity,updated_at,expires_at) VALUES($1,$2::jsonb,$3,$4)
      ON CONFLICT(id) DO UPDATE SET activity=excluded.activity,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
    [entry.userId, JSON.stringify(entry.activity), entry.updatedAt, entry.expiresAt]);
  }
  async remove(userId: string): Promise<void> { await this.db.query("DELETE FROM meldiq.user_activities WHERE id=$1", [userId]); }
  async removeLapsed(at: number): Promise<void> { await this.db.query("DELETE FROM meldiq.user_activities WHERE expires_at<=$1", [at]); }
}
