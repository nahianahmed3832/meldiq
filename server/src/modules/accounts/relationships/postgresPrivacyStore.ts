import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import type { PrivacyChoices, PrivacyStore } from "./privacyStore.js";

export class PostgresPrivacyStore implements PrivacyStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async get(userId: string): Promise<PrivacyChoices | null> {
    return (await this.db.query<PrivacyChoices>('SELECT group_add_policy AS "groupAddPolicy",suggestable FROM meldiq.privacy_settings WHERE id=$1', [userId])).rows[0] ?? null;
  }
  async many(userIds: readonly string[]): Promise<Map<string, PrivacyChoices>> {
    const rows = (await this.db.query<PrivacyChoices & {id: string}>('SELECT id,group_add_policy AS "groupAddPolicy",suggestable FROM meldiq.privacy_settings WHERE id=ANY($1::text[])', [[...userIds]])).rows;
    return new Map(rows.map(({id, ...choices}) => [id, choices]));
  }
  async put(userId: string, choices: PrivacyChoices, at: number): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.privacy_settings(id,group_add_policy,suggestable,updated_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET group_add_policy=excluded.group_add_policy,suggestable=excluded.suggestable,updated_at=excluded.updated_at`,
    [userId, choices.groupAddPolicy, choices.suggestable, at]);
  }
  async deleteForUser(userId: string): Promise<void> { await this.db.query("DELETE FROM meldiq.privacy_settings WHERE id=$1", [userId]); }
}
