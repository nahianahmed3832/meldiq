import type { DB } from "../../infrastructure/database/db.js";
import type { RowWriter, SqliteRows } from "../../infrastructure/database/rows/index.js";

export interface AccountRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  password_changed_at: number;
  email_verified_at: number | null;
  user_id: string | null;
  legacy_linked_at: number | null;
  selected_workspace_id: string | null;
  admitted_via: string | null;
  created_at: number;
  updated_at: number;
  disabled_at: number | null;
}

export interface SessionRow {
  id: string;
  account_id: string;
  device_id: string | null;
  label: string;
  access_hash: string;
  access_expires_at: number;
  refresh_hash: string;
  previous_refresh_hash: string | null;
  /** The current pair, sealed with the refresh token it replaced (migration 021, src/accounts/sessions.ts). */
  previous_refresh_answer: string | null;
  refresh_expires_at: number;
  expires_at: number;
  created_at: number;
  refreshed_at: number;
  last_used_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
}

/** A session with what decides whether it may still be used: its account, encryption identity and device. */
export interface ActiveSession extends SessionRow {
  user_id: string | null;
  account_disabled_at: number | null;
  user_disabled_at: number | null;
  device_revoked_at: number | null;
}

export type CodePurpose = "verify_email" | "reset_password";

export interface CodeRow {
  account_id: string;
  purpose: CodePurpose;
  code_hash: string;
  attempts: number;
  created_at: number;
  expires_at: number;
}

export interface TicketRow {
  ticket_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  account_id: string | null;
}

export type AccountPatch = Partial<
  Pick<
    AccountRow,
    "name" | "password_hash" | "password_changed_at" | "email_verified_at" | "user_id" | "legacy_linked_at" | "selected_workspace_id" | "admitted_via" | "disabled_at"
  >
>;

export type SessionRotation = Pick<
  SessionRow,
  | "access_hash"
  | "access_expires_at"
  | "refresh_hash"
  | "previous_refresh_hash"
  | "previous_refresh_answer"
  | "refresh_expires_at"
  | "refreshed_at"
  | "last_used_at"
>;

/** Taking an invite's use for a new account (SQLite rows): returns `accounts.admitted_via`, or throws when unusable. */
/** Taking an invite's use for a new account; both run in an identity rows unit ([w]). */
export interface Admission {
  take: (w: RowWriter) => string;
  /** Gives the use back (the account wasn't made after all). */
  undo: (w: RowWriter) => void;
}

/**
 * Where the account module keeps its rows (migration 014): SQLite, or MongoDB when MONGODB_DOMAINS includes "accounts"
 * (src/mongo/accounts.ts, docs/MONGODB.md). Async so both look the same to the service.
 *
 * Steps that also write the encryption identity's rows (users, devices, registration invites) are single methods here
 * ([createAccount], [linkIdentity], [bindDeviceWith]): SQLite runs them in one transaction with the account rows;
 * MongoDB runs the identity part as its own rows unit and undoes it, or its own part, when the other fails.
 */
export interface AccountStore {
  readonly backend: "sqlite" | "mongodb";
  /**
   * Runs [fn] atomically over this store's rows. [fn] may only call this store's methods: no other tables, and nothing
   * else asynchronous (the SQLite store relies on that to keep one transaction open across its awaits).
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  accountByEmail(email: string): Promise<AccountRow | undefined>;
  accountById(id: string): Promise<AccountRow | undefined>;
  accountByUserId(userId: string): Promise<AccountRow | undefined>;
  /** False when the email is taken. */
  insertAccount(row: AccountRow): Promise<boolean>;
  /** Inserts [row] after taking [admission]'s invite use, both or neither; null when the email is taken (use given back). */
  createAccount(row: AccountRow, admission: Admission | null): Promise<AccountRow | null>;
  updateAccount(id: string, patch: AccountPatch, at: number): Promise<void>;
  /** Changes the address of an account whose address isn't verified yet (a legacy link redone). */
  updateEmail(id: string, email: string, at: number): Promise<void>;
  /**
   * Moves an account to a new address its owner just proved (recovery): the address counts as verified from [at].
   * False when another account took the address in the meantime.
   */
  changeVerifiedEmail(id: string, email: string, at: number): Promise<boolean>;
  /** Removes an account nobody verified and no identity is linked to; false when it doesn't qualify. */
  deleteUnverifiedAccount(id: string): Promise<boolean>;
  /**
   * Removes an account for good (account deletion, docs/ACCOUNT_DELETION.md) with everything that hangs off it: its
   * sessions, email codes and legacy tickets. The encryption identity (users row) is anonymised separately. False when
   * the account was already gone.
   */
  deleteAccount(id: string): Promise<boolean>;
  /**
   * Links a new encryption identity: [createRows] makes its identity rows (user, first device) and returns
   * the device id; the account gets [userId] and the session that device. Null when the account already has an
   * identity (nothing is made).
   */
  linkIdentity(accountId: string, userId: string, sessionId: string, at: number, createRows: (w: RowWriter) => string): Promise<string | null>;
  /** Clears a link to an identity whose rows don't exist (a link interrupted half-way). False when it doesn't qualify. */
  releaseIdentity(accountId: string, userId: string, at: number): Promise<boolean>;
  /** [deviceRows] makes or changes identity rows and returns the device the session is then bound to. */
  bindDeviceWith(sessionId: string, deviceRows: (w: RowWriter) => string): Promise<string>;

  insertSession(row: SessionRow): Promise<void>;
  sessionById(id: string): Promise<ActiveSession | undefined>;
  sessionByAccessHash(hash: string): Promise<ActiveSession | undefined>;
  /** Rotates only if the session's refresh hash is still [expectedRefreshHash]; false when another refresh won. */
  rotateSession(id: string, rotation: SessionRotation, expectedRefreshHash: string): Promise<boolean>;
  bindSessionDevice(id: string, deviceId: string): Promise<void>;
  touchSession(id: string, at: number): Promise<void>;
  revokeSession(id: string, reason: string, at: number): Promise<boolean>;
  revokeAccountSessions(accountId: string, reason: string, at: number, exceptSessionId?: string): Promise<string[]>;
  revokeDeviceSessions(deviceId: string, reason: string, at: number): Promise<void>;
  activeSessions(accountId: string, at: number): Promise<SessionRow[]>;
  /** Every session of [accountId] still valid or ended since [since] (the platform console's session list), newest first. */
  recentSessions(accountId: string, since: number, limit: number): Promise<SessionRow[]>;
  /** How many accounts hold at least one valid session at [at]. */
  sessionHolders(at: number): Promise<number>;
  /** The most recently used session of each of [deviceIds] that has one (the console's device inventory). */
  latestSessionOfDevices(deviceIds: readonly string[]): Promise<Map<string, string>>;

  putCode(row: CodeRow): Promise<void>;
  code(accountId: string, purpose: CodePurpose): Promise<CodeRow | undefined>;
  countCodeAttempt(accountId: string, purpose: CodePurpose): Promise<void>;
  /** False when the code was already used (two requests with the same code: only one wins). */
  deleteCode(accountId: string, purpose: CodePurpose, codeHash: string): Promise<boolean>;

  insertTicket(row: TicketRow): Promise<void>;
  ticket(hash: string): Promise<TicketRow | undefined>;
  useTicket(hash: string, accountId: string, at: number): Promise<void>;

  /** Expired sessions, codes and tickets (the retention job). Returns how many rows went. */
  purgeExpired(at: number): Promise<number>;
}

const ACTIVE_SESSION = `SELECT s.*, a.user_id, a.disabled_at AS account_disabled_at, u.disabled_at AS user_disabled_at, d.revoked_at AS device_revoked_at
  FROM account_sessions s JOIN accounts a ON a.id = s.account_id
  LEFT JOIN users u ON u.id = a.user_id LEFT JOIN devices d ON d.id = s.device_id`;

const PATCHABLE = new Set<keyof AccountPatch>([
  "name",
  "password_hash",
  "password_changed_at",
  "email_verified_at",
  "user_id",
  "legacy_linked_at",
  "selected_workspace_id",
  "admitted_via",
  // Suspension by a platform admin (the Platform Admin Console, 2026-10-23).
  "disabled_at",
]);

export class SqliteAccountStore implements AccountStore {
  readonly backend = "sqlite" as const;
  private inTransaction = false;
  /** [identity]: the identity domain's rows, in this same database (accounts in SQLite keep their identity there too). */
  constructor(
    private readonly db: DB,
    private readonly identity: SqliteRows,
  ) {}

  /**
   * One SQLite transaction across [fn]'s awaits. Safe because every method of this store finishes synchronously: [fn]
   * runs to its end in one turn of the event loop, so no other request's statements can land inside the transaction.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }

  async accountByEmail(email: string): Promise<AccountRow | undefined> {
    return this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as AccountRow | undefined;
  }

  async accountById(id: string): Promise<AccountRow | undefined> {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  }

  async accountByUserId(userId: string): Promise<AccountRow | undefined> {
    return this.db.prepare("SELECT * FROM accounts WHERE user_id = ?").get(userId) as AccountRow | undefined;
  }

  async insertAccount(r: AccountRow): Promise<boolean> {
    return this.insertSync(r);
  }

  async updateAccount(id: string, patch: AccountPatch, at: number): Promise<void> {
    const keys = (Object.keys(patch) as (keyof AccountPatch)[]).filter((k) => PATCHABLE.has(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.db.prepare(`UPDATE accounts SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), at, id);
  }

  async updateEmail(id: string, email: string, at: number): Promise<void> {
    this.db.prepare("UPDATE accounts SET email = ?, updated_at = ? WHERE id = ? AND email_verified_at IS NULL").run(email, at, id);
  }

  async changeVerifiedEmail(id: string, email: string, at: number): Promise<boolean> {
    try {
      return this.db.prepare("UPDATE accounts SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ?").run(email, at, at, id).changes === 1;
    } catch (e) {
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return false;
      throw e;
    }
  }

  async deleteUnverifiedAccount(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM accounts WHERE id = ? AND email_verified_at IS NULL AND user_id IS NULL").run(id).changes === 1;
  }

  async deleteAccount(id: string): Promise<boolean> {
    // Sessions, codes, legacy tickets and recovery codes and tickets go with it (ON DELETE CASCADE).
    return this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes === 1;
  }

  async insertSession(r: SessionRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO account_sessions (id, account_id, device_id, label, access_hash, access_expires_at, refresh_hash, previous_refresh_hash, previous_refresh_answer, refresh_expires_at, expires_at, created_at, refreshed_at, last_used_at, revoked_at, revoke_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.account_id, r.device_id, r.label, r.access_hash, r.access_expires_at, r.refresh_hash, r.previous_refresh_hash, r.previous_refresh_answer, r.refresh_expires_at, r.expires_at, r.created_at, r.refreshed_at, r.last_used_at, r.revoked_at, r.revoke_reason);
  }

  async sessionById(id: string): Promise<ActiveSession | undefined> {
    return this.db.prepare(`${ACTIVE_SESSION} WHERE s.id = ?`).get(id) as ActiveSession | undefined;
  }

  async sessionByAccessHash(hash: string): Promise<ActiveSession | undefined> {
    return this.db.prepare(`${ACTIVE_SESSION} WHERE s.access_hash = ?`).get(hash) as ActiveSession | undefined;
  }

  async rotateSession(id: string, r: SessionRotation, expectedRefreshHash: string): Promise<boolean> {
    return (
      this.db
        .prepare(
          "UPDATE account_sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, previous_refresh_hash = ?, previous_refresh_answer = ?, refresh_expires_at = ?, refreshed_at = ?, last_used_at = ? WHERE id = ? AND refresh_hash = ?",
        )
        .run(r.access_hash, r.access_expires_at, r.refresh_hash, r.previous_refresh_hash, r.previous_refresh_answer, r.refresh_expires_at, r.refreshed_at, r.last_used_at, id, expectedRefreshHash)
        .changes === 1
    );
  }

  async bindSessionDevice(id: string, deviceId: string): Promise<void> {
    this.db.prepare("UPDATE account_sessions SET device_id = ? WHERE id = ?").run(deviceId, id);
  }

  async touchSession(id: string, at: number): Promise<void> {
    this.db.prepare("UPDATE account_sessions SET last_used_at = ? WHERE id = ? AND last_used_at < ?").run(at, id, at - 60_000);
  }

  async revokeSession(id: string, reason: string, at: number): Promise<boolean> {
    return this.db.prepare("UPDATE account_sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL").run(at, reason, id).changes === 1;
  }

  async revokeAccountSessions(accountId: string, reason: string, at: number, exceptSessionId?: string): Promise<string[]> {
    const rows = this.db
      .prepare("UPDATE account_sessions SET revoked_at = ?, revoke_reason = ? WHERE account_id = ? AND revoked_at IS NULL AND id IS NOT ? RETURNING device_id")
      .all(at, reason, accountId, exceptSessionId ?? null) as { device_id: string | null }[];
    return rows.flatMap((r) => (r.device_id ? [r.device_id] : []));
  }

  async revokeDeviceSessions(deviceId: string, reason: string, at: number): Promise<void> {
    this.db.prepare("UPDATE account_sessions SET revoked_at = ?, revoke_reason = ? WHERE device_id = ? AND revoked_at IS NULL").run(at, reason, deviceId);
  }

  async latestSessionOfDevices(deviceIds: readonly string[]): Promise<Map<string, string>> {
    if (deviceIds.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT device_id, id FROM account_sessions s WHERE device_id IN (SELECT value FROM json_each(?))
          AND last_used_at = (SELECT MAX(last_used_at) FROM account_sessions s2 WHERE s2.device_id = s.device_id)`,
      )
      .all(JSON.stringify(deviceIds)) as { device_id: string; id: string }[];
    return new Map(rows.map((r) => [r.device_id, r.id]));
  }

  async activeSessions(accountId: string, at: number): Promise<SessionRow[]> {
    return this.db
      .prepare("SELECT * FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ? AND refresh_expires_at > ? ORDER BY last_used_at DESC")
      .all(accountId, at, at) as SessionRow[];
  }

  async recentSessions(accountId: string, since: number, limit: number): Promise<SessionRow[]> {
    return this.db
      .prepare("SELECT * FROM account_sessions WHERE account_id = ? AND (revoked_at IS NULL OR revoked_at > ?) AND expires_at > ? ORDER BY last_used_at DESC LIMIT ?")
      .all(accountId, since, since, limit) as SessionRow[];
  }

  async sessionHolders(at: number): Promise<number> {
    return (
      this.db
        .prepare("SELECT COUNT(DISTINCT account_id) n FROM account_sessions WHERE revoked_at IS NULL AND expires_at > ? AND refresh_expires_at > ?")
        .get(at, at) as { n: number }
    ).n;
  }

  async putCode(r: CodeRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO account_codes (account_id, purpose, code_hash, attempts, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT (account_id, purpose) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      )
      .run(r.account_id, r.purpose, r.code_hash, r.created_at, r.expires_at);
  }

  async code(accountId: string, purpose: CodePurpose): Promise<CodeRow | undefined> {
    return this.db.prepare("SELECT * FROM account_codes WHERE account_id = ? AND purpose = ?").get(accountId, purpose) as CodeRow | undefined;
  }

  async countCodeAttempt(accountId: string, purpose: CodePurpose): Promise<void> {
    this.db.prepare("UPDATE account_codes SET attempts = attempts + 1 WHERE account_id = ? AND purpose = ?").run(accountId, purpose);
  }

  async deleteCode(accountId: string, purpose: CodePurpose, codeHash: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM account_codes WHERE account_id = ? AND purpose = ? AND code_hash = ?").run(accountId, purpose, codeHash).changes === 1;
  }

  async insertTicket(r: TicketRow): Promise<void> {
    this.db
      .prepare("INSERT INTO legacy_tickets (ticket_hash, user_id, created_at, expires_at, used_at, account_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(r.ticket_hash, r.user_id, r.created_at, r.expires_at, r.used_at, r.account_id);
  }

  async ticket(hash: string): Promise<TicketRow | undefined> {
    return this.db.prepare("SELECT * FROM legacy_tickets WHERE ticket_hash = ?").get(hash) as TicketRow | undefined;
  }

  async useTicket(hash: string, accountId: string, at: number): Promise<void> {
    this.db.prepare("UPDATE legacy_tickets SET used_at = ?, account_id = ? WHERE ticket_hash = ?").run(at, accountId, hash);
  }

  async purgeExpired(at: number): Promise<number> {
    return this.db.transaction(() => {
      // Revoked or expired sessions are kept a day so a late refresh still gets "session ended" instead of a generic 401.
      const grace = at - 86_400_000;
      const sessions = this.db
        .prepare("DELETE FROM account_sessions WHERE expires_at <= ? OR refresh_expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)")
        .run(grace, grace, grace).changes;
      const codes = this.db.prepare("DELETE FROM account_codes WHERE expires_at <= ?").run(at).changes;
      const tickets = this.db.prepare("DELETE FROM legacy_tickets WHERE expires_at <= ?").run(grace).changes;
      return sessions + codes + tickets;
    })();
  }

  async createAccount(row: AccountRow, admission: Admission | null): Promise<AccountRow | null> {
    try {
      return this.db.transaction(() => {
        const r = { ...row, admitted_via: admission ? this.identity.writeSync(admission.take) : row.admitted_via };
        if (!this.insertSync(r)) throw new EmailTaken();
        return r;
      })();
    } catch (e) {
      // The transaction rolled the invite use back with it.
      if (e instanceof EmailTaken) return null;
      throw e;
    }
  }

  async linkIdentity(accountId: string, userId: string, sessionId: string, at: number, createRows: (w: RowWriter) => string): Promise<string | null> {
    // One synchronous transaction: the check and the writes can't interleave with another request.
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT user_id FROM accounts WHERE id = ?").get(accountId) as { user_id: string | null } | undefined;
      if (!current || current.user_id) return null;
      const deviceId = this.identity.writeSync(createRows);
      this.db.prepare("UPDATE accounts SET user_id = ?, updated_at = ? WHERE id = ?").run(userId, at, accountId);
      this.db.prepare("UPDATE account_sessions SET device_id = ? WHERE id = ?").run(deviceId, sessionId);
      return deviceId;
    })();
  }

  async releaseIdentity(accountId: string, userId: string, at: number): Promise<boolean> {
    return this.db.prepare("UPDATE accounts SET user_id = NULL, updated_at = ? WHERE id = ? AND user_id = ?").run(at, accountId, userId).changes === 1;
  }

  async bindDeviceWith(sessionId: string, deviceRows: (w: RowWriter) => string): Promise<string> {
    return this.db.transaction(() => {
      const deviceId = this.identity.writeSync(deviceRows);
      this.db.prepare("UPDATE account_sessions SET device_id = ? WHERE id = ?").run(deviceId, sessionId);
      return deviceId;
    })();
  }

  private insertSync(r: AccountRow): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO accounts (id, email, name, password_hash, password_changed_at, email_verified_at, user_id, legacy_linked_at, selected_workspace_id, admitted_via, created_at, updated_at, disabled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(r.id, r.email, r.name, r.password_hash, r.password_changed_at, r.email_verified_at, r.user_id, r.legacy_linked_at, r.selected_workspace_id, r.admitted_via, r.created_at, r.updated_at, r.disabled_at);
    return res.changes === 1;
  }
}

/** Thrown inside [SqliteAccountStore.createAccount]'s transaction when the email is taken: rolls the invite use back. */
class EmailTaken extends Error {}
