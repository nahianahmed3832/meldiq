import { humanCode, normalizeCode, now, sha256Hex } from "../../shared/utilities/util.js";
import type { AccountRow } from "../accounts/index.js";
import type { PlatformAudit } from "./audit.js";
import { isPlatformRole, type PlatformRole } from "./permissions.js";
import type { AdminGrantRow, PlatformAdminStore } from "./store.js";

/**
 * Granting, revoking and enrolling console admins (§3.7). The operator CLI (`admin.js platform-admin-*`) is the only
 * way to make the first admin: no HTTP route can. [actor] is null for the CLI, else the super admin acting.
 */
export const ENROLMENT_MS = 30 * 60_000;
const CODE_LENGTH = 10;

export interface Actor {
  accountId: string | null;
  role: PlatformRole | null;
  requestId?: string;
  network?: string;
}

export const CLI_ACTOR: Actor = { accountId: null, role: null };

/** "ABCDE-FGHJK": shown once, stored as a hash. */
export async function issueEnrolment(store: PlatformAdminStore, accountId: string, actor: Actor, t = now()): Promise<string> {
  const code = humanCode(CODE_LENGTH);
  await store.putEnrolment({ account_id: accountId, code_hash: sha256Hex(`admin-enrol:${normalizeCode(code)}`), attempts: 0, issued_by: actor.accountId, created_at: t, expires_at: t + ENROLMENT_MS });
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Why [account] can't be granted a console role, or null. */
export function grantProblem(account: AccountRow | undefined): string | null {
  if (!account) return "No account has that email address.";
  if (account.disabled_at) return "That account is disabled.";
  if (!account.email_verified_at) return "That account hasn't verified its email address yet.";
  return null;
}

const via = (actor: Actor) => (actor.accountId ? "console" : "cli");
const actorFields = (actor: Actor) => ({ actorAccountId: actor.accountId, actorRole: actor.role, requestId: actor.requestId, network: actor.network });

/**
 * Grants [role] to [account] (or changes its role) and, when it has no console passkey yet, issues an enrolment code.
 * Returns the code to hand over, or null when the admin already has a passkey. The grant and its audit entry are one
 * unit; a role change then ends the admin's console sessions.
 */
export async function grantAdmin(store: PlatformAdminStore, audit: PlatformAudit, account: AccountRow | undefined, role: string, actor: Actor, note: string | null): Promise<string | null> {
  if (!isPlatformRole(role)) throw new Error(`Unknown role. Use one of: super_admin, operations_admin, support_admin, billing_admin, auditor`);
  const problem = grantProblem(account);
  if (problem || !account) throw new Error(problem ?? "No account has that email address.");
  const t = now();
  const enrol = store.passkeys(account.id).length === 0;
  const before = await store.platform.write((w) => {
    const prior = w.get<AdminGrantRow>("platform_admins", { account_id: account.id, revoked_at: null });
    store.putGrant(w, account.id, role, actor.accountId, note, t);
    audit.append(w, {
      action: prior ? "admin.role_change" : "admin.grant",
      outcome: "success",
      ...actorFields(actor),
      targetType: "admin",
      targetId: account.id,
      reason: note,
      detail: { role, from: prior?.role ?? null, enrolmentIssued: enrol, via: via(actor) },
    }, t);
    return prior;
  });
  // A role change ends the admin's sessions: the next sign-in carries the new role from the start.
  if (before && before.role !== role) await store.revokeAccountSessions(account.id, "role_changed", t);
  return enrol ? issueEnrolment(store, account.id, actor, t) : null;
}

/** Revokes [accountId]'s grant and ends its console sessions. False when it had no active grant. */
export async function revokeAdmin(store: PlatformAdminStore, audit: PlatformAudit, accountId: string, actor: Actor, reason: string | null): Promise<boolean> {
  const t = now();
  const revoked = await store.platform.write((w) => {
    const before = w.get<AdminGrantRow>("platform_admins", { account_id: accountId, revoked_at: null });
    if (!before || !store.revokeGrant(w, accountId, actor.accountId, t)) return false;
    audit.append(w, { action: "admin.revoke", outcome: "success", ...actorFields(actor), targetType: "admin", targetId: accountId, reason, detail: { role: before.role, via: via(actor) } }, t);
    return true;
  });
  if (!revoked) return false;
  // Already refused (every request checks the grant); ended for the record.
  await store.revokeAccountSessions(accountId, "grant_revoked", t);
  await store.deleteEnrolment(accountId);
  return true;
}

/** A lost device: removes every console passkey, ends sessions, and issues a new enrolment code. */
export async function resetAdminPasskeys(store: PlatformAdminStore, audit: PlatformAudit, accountId: string, actor: Actor, reason: string | null): Promise<string> {
  const t = now();
  await store.platform.write((w) => {
    if (!w.get("platform_admins", { account_id: accountId, revoked_at: null })) throw new Error("That account has no active console role.");
    const removed = store.deletePasskeys(w, accountId);
    audit.append(w, { action: "admin.passkeys_reset", outcome: "success", ...actorFields(actor), targetType: "admin", targetId: accountId, reason, detail: { removed, via: via(actor) } }, t);
  });
  await store.revokeAccountSessions(accountId, "passkeys_reset", t);
  return issueEnrolment(store, accountId, actor, t);
}
