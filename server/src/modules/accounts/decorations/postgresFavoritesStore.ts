import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import type { FavoriteStore } from "./favoritesStore.js";

export class PostgresFavoriteStore implements FavoriteStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async list(userId: string): Promise<string[]> {
    return (await this.db.query<{decoration_id: string}>("SELECT decoration_id FROM meldiq.decoration_favorites WHERE user_id=$1 ORDER BY created_at DESC,id DESC", [userId])).rows.map(row => row.decoration_id);
  }
  async count(userId: string): Promise<number> {
    return (await this.db.query<{count: number}>("SELECT count(*) AS count FROM meldiq.decoration_favorites WHERE user_id=$1", [userId])).rows[0].count;
  }
  async add(userId: string, decorationId: string, at: number): Promise<boolean> {
    return (await this.db.query(`INSERT INTO meldiq.decoration_favorites(id,user_id,decoration_id,created_at) VALUES($1,$2,$3,$4)
      ON CONFLICT DO NOTHING`, [`${userId}|${decorationId}`, userId, decorationId, at])).rowCount === 1;
  }
  async remove(userId: string, decorationId: string): Promise<void> {
    await this.db.query("DELETE FROM meldiq.decoration_favorites WHERE user_id=$1 AND decoration_id=$2", [userId, decorationId]);
  }
  async deleteForUser(userId: string): Promise<void> { await this.db.query("DELETE FROM meldiq.decoration_favorites WHERE user_id=$1", [userId]); }
}
