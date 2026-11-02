import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import { RECOVERY_TICKET_GRACE_MS, type RecoveryCodeRow, type RecoveryStore, type RecoveryTicketRow } from "./recoveryStore.js";

/** Preserve hashed recovery material and one-use checks; plaintext codes never enter this repository. */
export class PostgresRecoveryStore implements RecoveryStore {
  constructor(private readonly db: MeldiqPostgres) {}
  async replaceCodes(accountId: string, rows: RecoveryCodeRow[]): Promise<void> {
    await this.db.transaction(async () => {
      // Serialize complete replacement even when the account has no existing recovery-code rows to lock.
      await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended('meldiq-recovery:' || $1,0))", [accountId]);
      await this.db.query("DELETE FROM meldiq.account_recovery_codes WHERE account_id=$1", [accountId]);
      for (const row of rows) await this.db.query(`INSERT INTO meldiq.account_recovery_codes(id,account_id,code_hash,created_at,used_at)
        VALUES($1,$2,$3,$4,NULL)`, [row.id, accountId, row.code_hash, row.created_at]);
    });
  }
  async deleteCodes(accountId: string): Promise<number> {
    return (await this.db.query("DELETE FROM meldiq.account_recovery_codes WHERE account_id=$1", [accountId])).rowCount ?? 0;
  }
  async deleteForAccount(accountId: string): Promise<void> {
    await this.db.query(`WITH codes AS (DELETE FROM meldiq.account_recovery_codes WHERE account_id=$1)
      DELETE FROM meldiq.account_recovery_tickets WHERE account_id=$1`, [accountId]);
  }
  async codes(accountId: string): Promise<RecoveryCodeRow[]> {
    return (await this.db.query<RecoveryCodeRow>("SELECT * FROM meldiq.account_recovery_codes WHERE account_id=$1 ORDER BY created_at,id", [accountId])).rows;
  }
  async useCode(accountId: string, codeHash: string, at: number): Promise<boolean> {
    return (await this.db.query("UPDATE meldiq.account_recovery_codes SET used_at=$3 WHERE account_id=$1 AND code_hash=$2 AND used_at IS NULL", [accountId, codeHash, at])).rowCount === 1;
  }
  async insertTicket(row: RecoveryTicketRow): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.account_recovery_tickets(ticket_hash,account_id,new_email,email_code_hash,attempts,created_at,expires_at,used_at)
      VALUES($1,$2,$3,$4,0,$5,$6,NULL)`, [row.ticket_hash, row.account_id, row.new_email, row.email_code_hash, row.created_at, row.expires_at]);
  }
  async ticket(hash: string): Promise<RecoveryTicketRow | undefined> {
    return (await this.db.query<RecoveryTicketRow>("SELECT * FROM meldiq.account_recovery_tickets WHERE ticket_hash=$1", [hash])).rows[0];
  }
  async countTicketAttempt(hash: string): Promise<void> {
    await this.db.query("UPDATE meldiq.account_recovery_tickets SET attempts=attempts+1 WHERE ticket_hash=$1", [hash]);
  }
  async useTicket(hash: string, at: number): Promise<boolean> {
    return (await this.db.query("UPDATE meldiq.account_recovery_tickets SET used_at=$2 WHERE ticket_hash=$1 AND used_at IS NULL AND expires_at>$2", [hash, at])).rowCount === 1;
  }
  async purgeExpired(at: number): Promise<number> {
    return (await this.db.query("DELETE FROM meldiq.account_recovery_tickets WHERE expires_at<=$1", [at - RECOVERY_TICKET_GRACE_MS])).rowCount ?? 0;
  }
}
