import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import type { RulesStore, StoredAgreement, StoredRules } from "./store.js";

export class PostgresRulesStore implements RulesStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async all(): Promise<StoredRules[]> {
    return (await this.db.query<StoredRules>(`SELECT id AS "orgId",channel_id AS "channelId",required,rules,
      updated_at AS "updatedAt",updated_by AS "updatedBy" FROM meldiq.community_rules ORDER BY id`)).rows;
  }
  async agreements(): Promise<StoredAgreement[]> {
    return (await this.db.query<StoredAgreement>('SELECT org_id AS "orgId",user_id AS "userId",agreed_at AS "agreedAt" FROM meldiq.community_rule_agreements ORDER BY id')).rows;
  }
  async put(rules: StoredRules): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.community_rules(id,channel_id,required,rules,updated_at,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)
      ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,required=excluded.required,rules=excluded.rules,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    [rules.orgId, rules.channelId, rules.required, JSON.stringify(rules.rules), rules.updatedAt, rules.updatedBy]);
  }
  async removeOrg(orgId: string): Promise<void> {
    await this.db.query(`WITH agreements AS (DELETE FROM meldiq.community_rule_agreements WHERE org_id=$1)
      DELETE FROM meldiq.community_rules WHERE id=$1`, [orgId]);
  }
  async agree(agreement: StoredAgreement): Promise<boolean> {
    return (await this.db.query(`INSERT INTO meldiq.community_rule_agreements(id,org_id,user_id,agreed_at) VALUES($1,$2,$3,$4)
      ON CONFLICT DO NOTHING`, [`${agreement.orgId}|${agreement.userId}`, agreement.orgId, agreement.userId, agreement.agreedAt])).rowCount === 1;
  }
  async forget(orgId: string, userId: string): Promise<void> {
    await this.db.query("DELETE FROM meldiq.community_rule_agreements WHERE org_id=$1 AND user_id=$2", [orgId, userId]);
  }
  async deleteForUser(userId: string): Promise<void> { await this.db.query("DELETE FROM meldiq.community_rule_agreements WHERE user_id=$1", [userId]); }
}
