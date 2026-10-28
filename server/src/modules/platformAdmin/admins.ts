import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError, badRequest, forbidden, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import { type Actor, grantAdmin, grantProblem, resetAdminPasskeys, revokeAdmin } from "./bootstrap.js";
import type { RequestMeta } from "./credentials.js";
import type { PlatformRole } from "./permissions.js";
import type { AdminGrantRow, PlatformAdminStore } from "./store.js";

const actorOf = (p: AdminPrincipal, meta: RequestMeta): Actor => ({ accountId: p.account.id, role: p.grant.role, requestId: meta.requestId, network: networkKey(meta.ip) });

/**
 * Managing console admins (phase 4, super admins only through `admins.manage`). Rules the server keeps whatever the
 * console shows: nobody changes, revokes or resets themselves; the last active super admin can't be demoted or
 * revoked; a grant needs a verified, enabled account. Refusals are audited as denied.
 */
export class AdminAdmins {
  constructor(
    private readonly ctx: AppContext,
    private readonly store: PlatformAdminStore,
    private readonly audit: PlatformAudit,
  ) {}

  private async entry(g: AdminGrantRow, t: number) {
    const account = await this.ctx.accounts.store.accountById(g.account_id);
    const granter = g.granted_by ? await this.ctx.accounts.store.accountById(g.granted_by) : undefined;
    const lastSignIn = { at: this.ctx.platform.get<{ at: number }>("platform_audit", { action: { in: ["admin.login", "admin.enrol"] }, outcome: "success", actor_account_id: g.account_id }, [["at", "desc"]])?.at ?? null };
    const enrolment = this.store.enrolment(g.account_id);
    return {
      accountId: g.account_id,
      email: account?.email ?? null,
      name: account?.name ?? null,
      role: g.role,
      status: g.revoked_at === null ? ("active" as const) : ("revoked" as const),
      grantedAt: g.granted_at,
      grantedBy: g.granted_by ? { accountId: g.granted_by, name: granter?.name ?? null } : null,
      revokedAt: g.revoked_at,
      passkeys: this.store.passkeys(g.account_id).length,
      activeSessions: this.store.activeSessions(g.account_id, t).length,
      lastSignInAt: lastSignIn.at,
      enrolmentPending: !!enrolment && enrolment.expires_at > t,
    };
  }

  async list() {
    const t = now();
    const admins = [];
    for (const g of this.store.grants()) admins.push(await this.entry(g, t));
    return { admins, activeSuperAdmins: this.store.activeSuperAdmins() };
  }

  private async entryOf(accountId: string) {
    const g = this.store.grant(accountId);
    if (!g) throw notFound("No such console admin");
    return this.entry(g, now());
  }

  /** Refuses with [message] (403), recording the attempt. */
  private async deny(p: AdminPrincipal, action: string, target: string, reason: string, meta: RequestMeta, why: string, message: string): Promise<never> {
    await this.audit.record({ action, outcome: "denied", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "admin", targetId: target, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { why } });
    throw forbidden(message);
  }

  /** The checks every change to another admin passes: not oneself, and never leaving no super admin. */
  private async guard(p: AdminPrincipal, action: string, accountId: string, reason: string, meta: RequestMeta, newRole: PlatformRole | null): Promise<AdminGrantRow | undefined> {
    if (accountId === p.account.id) await this.deny(p, action, accountId, reason, meta, "self", "You can't change your own console access. Ask another super admin.");
    const current = this.store.activeGrant(accountId);
    if (current?.role === "super_admin" && newRole !== "super_admin" && this.store.activeSuperAdmins() <= 1) {
      await this.deny(p, action, accountId, reason, meta, "last_super_admin", "That's the last super admin. Make someone else a super admin first.");
    }
    return current;
  }

  async grant(p: AdminPrincipal, email: string, role: PlatformRole, reason: string, meta: RequestMeta) {
    const account = await this.ctx.accounts.store.accountByEmail(email);
    const problem = grantProblem(account);
    if (problem || !account) throw badRequest(problem ?? "No account has that email address.");
    const current = await this.guard(p, grantActionFor(account.id, this.store), account.id, reason, meta, role);
    if (current?.role === role) throw new ApiError(409, "conflict", "That account already has this role.");
    const code = await grantAdmin(this.store, this.audit, account, role, actorOf(p, meta), reason);
    return { admin: await this.entryOf(account.id), enrolmentCode: code };
  }

  async changeRole(p: AdminPrincipal, accountId: string, role: PlatformRole, reason: string, meta: RequestMeta) {
    const current = await this.guard(p, "admin.role_change", accountId, reason, meta, role);
    if (!current) throw notFound("No active console admin has that account.");
    if (current.role === role) return { admin: await this.entryOf(accountId), enrolmentCode: null };
    const account = await this.ctx.accounts.store.accountById(accountId);
    await grantAdmin(this.store, this.audit, account, role, actorOf(p, meta), reason);
    return { admin: await this.entryOf(accountId), enrolmentCode: null };
  }

  async revoke(p: AdminPrincipal, accountId: string, reason: string, meta: RequestMeta) {
    await this.guard(p, "admin.revoke", accountId, reason, meta, null);
    if (!(await revokeAdmin(this.store, this.audit, accountId, actorOf(p, meta), reason))) throw notFound("No active console admin has that account.");
    return { admin: await this.entryOf(accountId), enrolmentCode: null };
  }

  async resetPasskeys(p: AdminPrincipal, accountId: string, reason: string, meta: RequestMeta) {
    await this.guard(p, "admin.passkeys_reset", accountId, reason, meta, this.store.activeGrant(accountId)?.role ?? null);
    if (!this.store.activeGrant(accountId)) throw notFound("No active console admin has that account.");
    const code = await resetAdminPasskeys(this.store, this.audit, accountId, actorOf(p, meta), reason);
    return { admin: await this.entryOf(accountId), enrolmentCode: code };
  }

  sessions(p: AdminPrincipal, accountId: string) {
    if (!this.store.grant(accountId)) throw notFound("No such console admin");
    return {
      sessions: this.store.activeSessions(accountId, now()).map((s) => ({
        id: s.id,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
        expiresAt: s.expires_at,
        idleExpiresAt: s.idle_expires_at,
        network: s.network,
        current: s.id === p.session.id,
      })),
    };
  }

  async revokeSession(p: AdminPrincipal, sessionId: string, reason: string, meta: RequestMeta) {
    const s = this.store.session(sessionId);
    if (!s || s.revoked_at !== null) throw notFound("No such active console session");
    if (s.id === p.session.id) throw badRequest("That's this session: sign out instead.");
    await this.store.revokeSession(s.id, "admin_revoked", now());
    await this.audit.record({
      action: "admin.session_revoke",
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "admin_session",
      targetId: s.id,
      reason,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail: { admin: s.account_id },
    });
    return { ok: true as const };
  }
}

/** A grant to an account that already has one is a role change, and is recorded as one. */
function grantActionFor(accountId: string, store: PlatformAdminStore): string {
  return store.activeGrant(accountId) ? "admin.role_change" : "admin.grant";
}
