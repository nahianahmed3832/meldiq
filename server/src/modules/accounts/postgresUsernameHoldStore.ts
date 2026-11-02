import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import type { UsernameHold, UsernameHoldStore } from "./usernameHoldStore.js";

export class PostgresUsernameHoldStore implements UsernameHoldStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async live(at: number): Promise<UsernameHold[]> {
    return (await this.db.query<UsernameHold>(`SELECT id AS username,user_id AS "userId",created_at AS "createdAt",expires_at AS "expiresAt"
      FROM meldiq.username_holds WHERE expires_at>$1 ORDER BY id`, [at])).rows;
  }
  async put(hold: UsernameHold): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.username_holds(id,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,created_at=excluded.created_at,expires_at=excluded.expires_at`,
    [hold.username, hold.userId, hold.createdAt, hold.expiresAt]);
  }
  async remove(username: string): Promise<void> { await this.db.query("DELETE FROM meldiq.username_holds WHERE id=$1", [username]); }
  async removeExpired(at: number): Promise<void> { await this.db.query("DELETE FROM meldiq.username_holds WHERE expires_at<=$1", [at]); }
  async deleteForUser(userId: string): Promise<void> { await this.db.query("DELETE FROM meldiq.username_holds WHERE user_id=$1", [userId]); }
}
