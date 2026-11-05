import type { PostgresRows } from "../../infrastructure/database/rows/postgresRows.js";
import { ConstraintError, type RowWriter } from "../../infrastructure/database/rows/types.js";
import type { AccountPatch, AccountRow, AccountStore, ActiveSession, Admission, CodePurpose, CodeRow, PendingSignup, SessionRotation, SessionRow, TicketRow } from "./store.js";

const patchable = new Set(["name", "password_hash", "password_changed_at", "email_verified_at", "user_id", "legacy_linked_at", "selected_workspace_id", "admitted_via", "disabled_at"]);
class AccountConflict extends Error {}

/** Account and synchronous identity rules use the SAME PostgreSQL writer. A transaction stages changes in an
 * isolated request overlay and publishes only after one durable SQL commit. No compensating identity writes or
 * SQLite side database: invite consumption, identity/device creation, session binding and account updates are atomic.
 * This remains the bounded single-writer compatibility mode, not a horizontally scalable account repository.
 */
export class PostgresAccountStore implements AccountStore {
  readonly backend = "postgres" as const;
  constructor(private readonly rows: PostgresRows) {
    for (const table of ["accounts", "account_sessions", "account_session_factors", "account_codes", "legacy_tickets", "users", "devices"])
      if (!rows.has(table)) throw new Error(`Account writer is missing ${table}`);
  }
  transaction<T>(run: () => Promise<T>): Promise<T> { return this.rows.transaction(run); }
  async accountByEmail(email: string): Promise<AccountRow | undefined> { return this.rows.get("accounts", {email}); }
  async accountById(id: string): Promise<AccountRow | undefined> { return this.rows.get("accounts", {id}); }
  async accountByUserId(userId: string): Promise<AccountRow | undefined> { return this.rows.get("accounts", {user_id: userId}); }
  async insertAccount(row: AccountRow): Promise<boolean> {
    return this.rows.write(writer => writer.insert("accounts", {...row}, {orIgnore: true}).inserted);
  }
  async createAccount(row: AccountRow, admission: Admission | null): Promise<AccountRow | null> {
    try {
      return await this.rows.write(writer => {
        const account = {...row, admitted_via: admission ? admission.take(writer) : row.admitted_via};
        if (!writer.insert("accounts", account, {orIgnore: true}).inserted) throw new AccountConflict();
        return account;
      });
    } catch (error) { if (error instanceof AccountConflict) return null; throw error; }
  }
  async updateAccount(id: string, patch: AccountPatch, at: number): Promise<void> {
    const values = Object.fromEntries(Object.entries(patch).filter(([key]) => patchable.has(key)).map(([key, value]) => [key, value ?? null]));
    if (Object.keys(values).length) await this.rows.write(writer => writer.update("accounts", {id}, {...values, updated_at: at}));
  }
  async replacePendingSignup(id: string, row: PendingSignup, at: number): Promise<boolean> {
    return this.rows.write(w => w.update("accounts", { id, email_verified_at: null, legacy_linked_at: null }, { ...row, updated_at: at }) === 1);
  }
  async updateEmail(id: string, email: string, at: number): Promise<void> {
    await this.rows.write(writer => writer.update("accounts", {id, email_verified_at: null}, {email, updated_at: at}));
  }
  async changeVerifiedEmail(id: string, email: string, at: number): Promise<boolean> {
    try { return await this.rows.write(writer => writer.update("accounts", {id}, {email, email_verified_at: at, updated_at: at}) === 1); }
    catch (error) { if (error instanceof ConstraintError) return false; throw error; }
  }
  async deleteUnverifiedAccount(id: string): Promise<boolean> {
    return this.rows.write(writer => writer.delete("accounts", {id, email_verified_at: null, user_id: null}) === 1);
  }
  async deleteAccount(id: string): Promise<boolean> {
    return this.rows.write(writer => {
      if (this.rows.has("account_social_identities")) writer.delete("account_social_identities", {account_id: id});
      return writer.delete("accounts", {id}) === 1;
    });
  }
  async linkIdentity(accountId: string, userId: string, sessionId: string, at: number, createRows: (writer: RowWriter) => string): Promise<string | null> {
    return this.rows.write(writer => {
      const current = writer.get<AccountRow>("accounts", {id: accountId});
      if (!current || current.user_id) return null;
      const session = writer.get<SessionRow>("account_sessions", {id: sessionId, account_id: accountId});
      if (!session) throw new Error("Identity binding requires the account's session");
      const deviceId = createRows(writer);
      const device = writer.get<{user_id: string}>("devices", {id: deviceId});
      if (device?.user_id !== userId) throw new Error("Identity device ownership mismatch");
      writer.update("accounts", {id: accountId}, {user_id: userId, updated_at: at});
      writer.update("account_sessions", {id: sessionId}, {device_id: deviceId});
      return deviceId;
    });
  }
  async releaseIdentity(accountId: string, userId: string, at: number): Promise<boolean> {
    return this.rows.write(writer => writer.update("accounts", {id: accountId, user_id: userId}, {user_id: null, updated_at: at}) === 1);
  }
  async bindDeviceWith(sessionId: string, deviceRows: (writer: RowWriter) => string): Promise<string> {
    return this.rows.write(writer => {
      const session = writer.get<SessionRow>("account_sessions", {id: sessionId});
      const account = session && writer.get<AccountRow>("accounts", {id: session.account_id});
      if (!account?.user_id) throw new Error("Device binding requires a linked account session");
      const deviceId = deviceRows(writer);
      if (writer.get<{user_id: string}>("devices", {id: deviceId})?.user_id !== account.user_id) throw new Error("Session device ownership mismatch");
      writer.update("account_sessions", {id: sessionId}, {device_id: deviceId});
      return deviceId;
    });
  }
  async insertSession(row: SessionRow): Promise<void> {
    const {second_factor_at, ...session} = row;
    await this.rows.write(writer => {
      writer.insert("account_sessions", session);
      if (second_factor_at != null) writer.insert("account_session_factors", {id: row.id, account_id: row.account_id, verified_at: second_factor_at, expires_at: second_factor_at + 600_000});
    });
  }
  private active(session: SessionRow | undefined): ActiveSession | undefined {
    if (!session) return undefined;
    const account = this.rows.get<AccountRow>("accounts", {id: session.account_id});
    if (!account) return undefined;
    const factor = this.rows.get<{verified_at: number}>("account_session_factors", {id: session.id});
    return {...session, second_factor_at: factor?.verified_at ?? null, user_id: account.user_id, account_disabled_at: account.disabled_at,
      user_disabled_at: account.user_id ? this.rows.get<{disabled_at: number | null}>("users", {id: account.user_id})?.disabled_at ?? null : null,
      device_revoked_at: session.device_id ? this.rows.get<{revoked_at: number | null}>("devices", {id: session.device_id})?.revoked_at ?? null : null};
  }
  async sessionById(id: string): Promise<ActiveSession | undefined> { return this.active(this.rows.get("account_sessions", {id})); }
  async sessionByAccessHash(hash: string): Promise<ActiveSession | undefined> { return this.active(this.rows.get("account_sessions", {access_hash: hash})); }
  async rotateSession(id: string, rotation: SessionRotation, expectedRefreshHash: string): Promise<boolean> {
    return this.rows.write(writer => writer.update("account_sessions", {id, refresh_hash: expectedRefreshHash}, {...rotation}) === 1);
  }
  async bindSessionDevice(id: string, deviceId: string): Promise<void> {
    await this.bindDeviceWith(id, () => deviceId);
  }
  async touchSession(id: string, at: number): Promise<void> {
    await this.rows.write(writer => writer.update("account_sessions", {id, last_used_at: {lt: at - 60_000}}, {last_used_at: at}));
  }
  async revokeSession(id: string, reason: string, at: number): Promise<boolean> {
    return this.rows.write(writer => writer.update("account_sessions", {id, revoked_at: null}, {revoked_at: at, revoke_reason: reason}) === 1);
  }
  async revokeAccountSessions(accountId: string, reason: string, at: number, exceptSessionId?: string): Promise<string[]> {
    return this.rows.write(writer => {
      const where = {account_id: accountId, revoked_at: null, ...(exceptSessionId ? {id: {ne: exceptSessionId}} : {})};
      const sessions = writer.all<SessionRow>("account_sessions", {where});
      writer.update("account_sessions", where, {revoked_at: at, revoke_reason: reason});
      const bindings = {account_id: accountId, revoked_at: null, ...(exceptSessionId ? {id: {ne: exceptSessionId}} : {})};
      const bound = this.rows.has("auth_device_sessions") ? writer.all<{device_id: string}>("auth_device_sessions", {where: bindings}) : [];
      if (this.rows.has("auth_device_sessions")) writer.update("auth_device_sessions", bindings, {revoked_at: at});
      return [...new Set([...sessions.flatMap(session => session.device_id ? [session.device_id] : []), ...bound.map(session => session.device_id)])];
    });
  }
  async revokeDeviceSessions(deviceId: string, reason: string, at: number): Promise<void> {
    await this.rows.write(writer => {
      writer.update("account_sessions", {device_id: deviceId, revoked_at: null}, {revoked_at: at, revoke_reason: reason});
      if (this.rows.has("auth_device_sessions")) writer.update("auth_device_sessions", {device_id: deviceId, revoked_at: null}, {revoked_at: at});
    });
  }
  async activeSessions(accountId: string, at: number): Promise<SessionRow[]> {
    return this.rows.all("account_sessions", {where: {account_id: accountId, revoked_at: null, expires_at: {gt: at}, refresh_expires_at: {gt: at}}, orderBy: [["last_used_at", "desc"]]});
  }
  async recentSessions(accountId: string, since: number, limit: number): Promise<SessionRow[]> {
    return this.rows.all("account_sessions", {where: {account_id: accountId, $or: [{revoked_at: null}, {revoked_at: {gt: since}}], expires_at: {gt: since}}, orderBy: [["last_used_at", "desc"]], limit});
  }
  async sessionHolders(at: number): Promise<number> {
    return new Set(this.rows.all<SessionRow>("account_sessions", {where: {revoked_at: null, expires_at: {gt: at}, refresh_expires_at: {gt: at}}}).map(session => session.account_id)).size;
  }
  async latestSessionOfDevices(deviceIds: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const session of this.rows.all<SessionRow>("account_sessions", {where: {device_id: {in: deviceIds}}, orderBy: [["last_used_at", "desc"], ["id", "desc"]]})) {
      if (session.device_id && !result.has(session.device_id)) result.set(session.device_id, session.id);
    }
    return result;
  }
  async putCode(row: CodeRow): Promise<void> {
    const value = {...row, attempts: 0};
    await this.rows.write(writer => writer.upsert("account_codes", value, value));
  }
  async code(accountId: string, purpose: CodePurpose): Promise<CodeRow | undefined> { return this.rows.get("account_codes", {account_id: accountId, purpose}); }
  async countCodeAttempt(accountId: string, purpose: CodePurpose): Promise<void> {
    await this.rows.write(writer => {
      const code = writer.get<CodeRow>("account_codes", {account_id: accountId, purpose});
      if (code) writer.update("account_codes", {account_id: accountId, purpose}, {attempts: code.attempts + 1});
    });
  }
  async deleteCode(accountId: string, purpose: CodePurpose, codeHash: string): Promise<boolean> {
    return this.rows.write(writer => writer.delete("account_codes", {account_id: accountId, purpose, code_hash: codeHash}) === 1);
  }
  async insertTicket(row: TicketRow): Promise<void> { await this.rows.write(writer => writer.insert("legacy_tickets", {...row})); }
  async ticket(hash: string): Promise<TicketRow | undefined> { return this.rows.get("legacy_tickets", {ticket_hash: hash}); }
  async useTicket(hash: string, accountId: string, at: number): Promise<void> {
    await this.rows.write(writer => writer.update("legacy_tickets", {ticket_hash: hash}, {used_at: at, account_id: accountId}));
  }
  async purgeExpired(at: number): Promise<number> {
    return this.rows.write(writer => {
      const grace = at - 86_400_000;
      writer.delete("account_session_factors", {expires_at: {lte: at}});
      const sessions = writer.delete("account_sessions", {$or: [{expires_at: {lte: grace}}, {refresh_expires_at: {lte: grace}}, {revoked_at: {lte: grace}}]});
      const codes = writer.delete("account_codes", {expires_at: {lte: at}});
      const tickets = writer.delete("legacy_tickets", {expires_at: {lte: grace}});
      return sessions + codes + tickets;
    });
  }
}
