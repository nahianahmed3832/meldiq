import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import type { PlatformRole } from "./permissions.js";

/** Rows of migration 046, and what the console needs of them. */
export interface AdminGrantRow {
  account_id: string;
  role: PlatformRole;
  granted_by: string | null;
  granted_at: number;
  updated_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  note: string | null;
}

export interface AdminPasskeyRow {
  id: string;
  account_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  name: string;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

export interface EnrolmentRow {
  account_id: string;
  code_hash: string;
  attempts: number;
  issued_by: string | null;
  created_at: number;
  expires_at: number;
}

export type ChallengePurpose = "login" | "register" | "reauth";

export interface ChallengeRow {
  id: string;
  purpose: ChallengePurpose;
  account_id: string;
  session_id: string | null;
  challenge: string;
  created_at: number;
  expires_at: number;
}

export interface AdminSessionRow {
  id: string;
  token_hash: string;
  account_id: string;
  created_at: number;
  last_used_at: number;
  idle_expires_at: number;
  expires_at: number;
  reauth_at: number;
  network: string;
  revoked_at: number | null;
  revoke_reason: string | null;
}

/**
 * The console's rows: grants and console passkeys (platform domain), enrolment codes, ceremonies and console sessions
 * (short-lived rows). Reads are synchronous; writes are units, so each resolves once durable. The [w] variants write
 * inside the caller's platform unit.
 */
export class PlatformAdminStore {
  constructor(
    readonly platform: Rows,
    readonly ephemeral: Rows,
  ) {}

  // ───────────── Grants ─────────────

  grant(accountId: string): AdminGrantRow | undefined {
    return this.platform.get<AdminGrantRow>("platform_admins", { account_id: accountId });
  }

  activeGrant(accountId: string): AdminGrantRow | undefined {
    const g = this.grant(accountId);
    return g && g.revoked_at === null ? g : undefined;
  }

  grants(): AdminGrantRow[] {
    return this.platform.all<AdminGrantRow>("platform_admins", { orderBy: [["granted_at", "asc"]] });
  }

  activeSuperAdmins(): number {
    return this.platform.count("platform_admins", { role: "super_admin", revoked_at: null });
  }

  /** Grants [role] (again, after a revocation), or changes an active grant's role. */
  putGrant(w: RowWriter, accountId: string, role: PlatformRole, by: string | null, note: string | null, t: number): void {
    const before = w.get<AdminGrantRow>("platform_admins", { account_id: accountId });
    if (!before) {
      w.insert("platform_admins", { account_id: accountId, role, granted_by: by, granted_at: t, updated_at: t, note });
      return;
    }
    const regrant = before.revoked_at !== null;
    w.update(
      "platform_admins",
      { account_id: accountId },
      { role, updated_at: t, note, granted_by: regrant ? by : before.granted_by, granted_at: regrant ? t : before.granted_at, revoked_at: null, revoked_by: null },
    );
  }

  revokeGrant(w: RowWriter, accountId: string, by: string | null, t: number): boolean {
    return w.update("platform_admins", { account_id: accountId, revoked_at: null }, { revoked_at: t, revoked_by: by, updated_at: t }) > 0;
  }

  // ───────────── Console passkeys ─────────────

  passkeys(accountId: string): AdminPasskeyRow[] {
    return this.platform.all<AdminPasskeyRow>("platform_admin_passkeys", { where: { account_id: accountId }, orderBy: [["created_at", "asc"]] });
  }

  passkey(id: string): AdminPasskeyRow | undefined {
    return this.platform.get<AdminPasskeyRow>("platform_admin_passkeys", { id });
  }

  insertPasskey(w: RowWriter, row: AdminPasskeyRow): void {
    w.insert("platform_admin_passkeys", { ...row });
  }

  usedPasskey(id: string, counter: number, backedUp: boolean, t: number): Promise<number> {
    return this.platform.write((w) => w.update("platform_admin_passkeys", { id }, { counter, backed_up: backedUp ? 1 : 0, last_used_at: t }));
  }

  deletePasskeys(w: RowWriter, accountId: string): number {
    return w.delete("platform_admin_passkeys", { account_id: accountId });
  }

  // ───────────── Enrolment codes ─────────────

  putEnrolment(row: EnrolmentRow): Promise<void> {
    return this.ephemeral.write((w) => w.upsert("platform_admin_enrolments", { ...row }, "replace"));
  }

  enrolment(accountId: string): EnrolmentRow | undefined {
    return this.ephemeral.get<EnrolmentRow>("platform_admin_enrolments", { account_id: accountId });
  }

  countEnrolmentAttempt(accountId: string): Promise<void> {
    return this.ephemeral.write((w) => {
      const e = w.get<EnrolmentRow>("platform_admin_enrolments", { account_id: accountId });
      if (e) w.update("platform_admin_enrolments", { account_id: accountId }, { attempts: e.attempts + 1 });
    });
  }

  deleteEnrolment(accountId: string): Promise<number> {
    return this.ephemeral.write((w) => w.delete("platform_admin_enrolments", { account_id: accountId }));
  }

  // ───────────── Ceremonies ─────────────

  putChallenge(row: ChallengeRow): Promise<void> {
    return this.ephemeral.write((w) => {
      w.delete("platform_admin_challenges", { expires_at: { lte: row.created_at } });
      w.insert("platform_admin_challenges", { ...row });
    });
  }

  /** The ceremony [id], removed whatever happens next (single use). */
  takeChallenge(id: string): Promise<ChallengeRow | undefined> {
    return this.ephemeral.write((w) => {
      const row = w.get<ChallengeRow>("platform_admin_challenges", { id });
      if (row) w.delete("platform_admin_challenges", { id });
      return row;
    });
  }

  // ───────────── Sessions ─────────────

  insertSession(row: AdminSessionRow): Promise<void> {
    return this.ephemeral.write((w) => void w.insert("platform_admin_sessions", { ...row }));
  }

  sessionByTokenHash(hash: string): AdminSessionRow | undefined {
    return this.ephemeral.get<AdminSessionRow>("platform_admin_sessions", { token_hash: hash });
  }

  session(id: string): AdminSessionRow | undefined {
    return this.ephemeral.get<AdminSessionRow>("platform_admin_sessions", { id });
  }

  activeSessions(accountId: string, t: number): AdminSessionRow[] {
    return this.ephemeral.all<AdminSessionRow>("platform_admin_sessions", {
      where: { account_id: accountId, revoked_at: null, expires_at: { gt: t }, idle_expires_at: { gt: t } },
      orderBy: [["created_at", "desc"]],
    });
  }

  touchSession(id: string, t: number, idleExpiresAt: number): Promise<number> {
    return this.ephemeral.write((w) => w.update("platform_admin_sessions", { id }, { last_used_at: t, idle_expires_at: idleExpiresAt }));
  }

  reauthenticated(id: string, t: number): Promise<number> {
    return this.ephemeral.write((w) => w.update("platform_admin_sessions", { id }, { reauth_at: t }));
  }

  revokeSession(id: string, reason: string, t: number): Promise<boolean> {
    return this.ephemeral.write((w) => w.update("platform_admin_sessions", { id, revoked_at: null }, { revoked_at: t, revoke_reason: reason }) > 0);
  }

  revokeAccountSessions(accountId: string, reason: string, t: number): Promise<number> {
    return this.ephemeral.write((w) => w.update("platform_admin_sessions", { account_id: accountId, revoked_at: null }, { revoked_at: t, revoke_reason: reason }));
  }

  /** Retention: ended sessions a day after they ended, expired ceremonies and enrolment codes. */
  purgeExpired(t: number): Promise<number> {
    const dayAgo = t - 86_400_000;
    return this.ephemeral.write(
      (w) =>
        w.delete("platform_admin_sessions", { $or: [{ revoked_at: { lte: dayAgo } }, { expires_at: { lte: dayAgo } }, { idle_expires_at: { lte: dayAgo } }] }) +
        w.delete("platform_admin_challenges", { expires_at: { lte: t } }) +
        w.delete("platform_admin_enrolments", { expires_at: { lte: t } }),
    );
  }
}
