import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import type { KeyBackupRow, KeyBackupStore, KeyUnlockRow } from "./keyBackupStore.js";

/** Ciphertext, salt, iteration policy and encryption identity are copied exactly; no decrypt/re-encrypt step. */
export class PostgresKeyBackupStore implements KeyBackupStore {
  constructor(private readonly db: MeldiqPostgres) {}
  async backup(accountId: string): Promise<KeyBackupRow | undefined> {
    return (await this.db.query<KeyBackupRow>("SELECT * FROM meldiq.account_key_backups WHERE account_id=$1", [accountId])).rows[0];
  }
  async putBackup(row: KeyBackupRow): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.account_key_backups(account_id,identity_key,password_changed_at,version,iterations,salt,nonce,ciphertext,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id) DO UPDATE SET identity_key=excluded.identity_key,
      password_changed_at=excluded.password_changed_at,version=excluded.version,iterations=excluded.iterations,salt=excluded.salt,
      nonce=excluded.nonce,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`,
    [row.account_id, row.identity_key, row.password_changed_at, row.version, row.iterations, row.salt, row.nonce, row.ciphertext, row.created_at, row.updated_at]);
  }
  async deleteBackup(accountId: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM meldiq.account_key_backups WHERE account_id=$1", [accountId])).rowCount === 1;
  }
  async putUnlock(row: KeyUnlockRow): Promise<void> {
    await this.db.query(`INSERT INTO meldiq.account_key_unlocks(account_id,session_id,code_hash,attempts,created_at,expires_at) VALUES($1,$2,$3,0,$4,$5)
      ON CONFLICT(account_id) DO UPDATE SET session_id=excluded.session_id,code_hash=excluded.code_hash,attempts=0,
      created_at=excluded.created_at,expires_at=excluded.expires_at`, [row.account_id, row.session_id, row.code_hash, row.created_at, row.expires_at]);
  }
  async unlock(accountId: string): Promise<KeyUnlockRow | undefined> {
    return (await this.db.query<KeyUnlockRow>("SELECT * FROM meldiq.account_key_unlocks WHERE account_id=$1", [accountId])).rows[0];
  }
  async countUnlockAttempt(accountId: string): Promise<void> {
    await this.db.query("UPDATE meldiq.account_key_unlocks SET attempts=attempts+1 WHERE account_id=$1", [accountId]);
  }
  async useUnlock(accountId: string, codeHash: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM meldiq.account_key_unlocks WHERE account_id=$1 AND code_hash=$2", [accountId, codeHash])).rowCount === 1;
  }
  async deleteForAccount(accountId: string): Promise<void> {
    await this.db.query(`WITH backup AS (DELETE FROM meldiq.account_key_backups WHERE account_id=$1)
      DELETE FROM meldiq.account_key_unlocks WHERE account_id=$1`, [accountId]);
  }
  async purgeExpired(at: number): Promise<number> {
    return (await this.db.query("DELETE FROM meldiq.account_key_unlocks WHERE expires_at<=$1", [at])).rowCount ?? 0;
  }
}
