import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import { PostgresDocuments } from "../../../infrastructure/database/postgres/documents.js";
import type { PinStore, StoredAward, StoredPin } from "./store.js";

export class PostgresPinStore implements PinStore {
  readonly backend = "postgres" as const;
  private readonly store: PostgresDocuments<StoredPin>;
  constructor(private readonly db: MeldiqPostgres) { this.store = new PostgresDocuments(db, "community_pins"); }
  pins(): Promise<StoredPin[]> { return this.store.find({}); }
  async awards(): Promise<StoredAward[]> {
    return (await this.db.query<StoredAward>(`SELECT pin_id AS "pinId",org_id AS "orgId",user_id AS "userId",awarded_by AS "awardedBy",awarded_at AS "awardedAt"
      FROM meldiq.community_pin_awards ORDER BY id`)).rows;
  }
  async insertPin(pin: StoredPin): Promise<void> { await this.store.insert(pin); }
  async removePin(id: string): Promise<void> { await this.store.take(id); }
  async award(award: StoredAward): Promise<boolean> {
    return (await this.db.query(`INSERT INTO meldiq.community_pin_awards(id,pin_id,org_id,user_id,awarded_by,awarded_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING`, [`${award.pinId}:${award.userId}`, award.pinId, award.orgId, award.userId, award.awardedBy, award.awardedAt])).rowCount === 1;
  }
  async revoke(pinId: string, userId: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM meldiq.community_pin_awards WHERE pin_id=$1 AND user_id=$2", [pinId, userId])).rowCount === 1;
  }
}
