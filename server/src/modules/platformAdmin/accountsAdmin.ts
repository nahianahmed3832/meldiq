import crypto from "node:crypto";
import type { z } from "zod/v4";
import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import {
  type AccountRow,
  deleteOperatorAccount,
  insertOperatorAccount,
  listOperatorAccounts,
  type OperatorAccountRow,
  operatorAccount,
  staticCodeHash,
  updateOperatorVerification,
  userSummary,
} from "../accounts/index.js";
import type { AdminAccountCreateBody, AdminAccountVerificationBody, AdminCreatedAccountsQuery } from "../../shared/contracts/http/platformAdminInsights.js";
import { ApiError, badRequest, forbidden, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { decodeCursor, encodeCursor } from "./pagination.js";
import { allowed } from "./permissions.js";
import { maskId } from "./devicesView.js";
import { PlatformAdminStore } from "./store.js";
import { guardAccountStatusWrite, readAdminAccountAuthority, snapshotAdminAuthority } from "./authority.js";

type CreateBody = z.infer<typeof AdminAccountCreateBody>;
type VerificationBody = z.infer<typeof AdminAccountVerificationBody>;
type ListQuery = z.infer<typeof AdminCreatedAccountsQuery>;

/** Bytes of randomness in a generated password (24 characters of base64url). */
const GENERATED_PASSWORD_BYTES = 18;

/**
 * Accounts made in the Platform Admin Console (docs/ADMIN_ACCOUNTS.md): an operator creates an email-and-password
 * account and chooses how it proves its address — at once (verified), with a fixed tester code, or with the normal
 * emailed code. The operator row and its audit entry are one platform unit; the account is made in the accounts domain.
 */
export class AdminAccounts {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
  ) {}

  async create(p: AdminPrincipal, b: CreateBody, meta: RequestMeta) {
    const accounts = this.ctx.accounts;
    if (b.verification === "email" && b.sendCode && !accounts.mailer.available)
      throw new ApiError(503, "email_unavailable", "This server can't send email right now. Choose another verification, or don't send the code yet.");
    if (await accounts.store.accountByEmail(b.email)) throw new ApiError(409, "email_taken", "That email already has a Meldiq account.");
    const id = newId("acc");
    const generated = b.password === undefined ? crypto.randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url") : null;
    const t = now();
    // The operator row comes first: an account never exists without it, so its tester code and protection hold at once.
    await this.ctx.platform.write((w) => {
      insertOperatorAccount(w, this.row(p, id, b, t));
      this.audit.append(w, {
        action: "account.create",
        outcome: "success",
        actorAccountId: p.account.id,
        actorRole: p.grant.role,
        targetType: "account",
        targetId: id,
        reason: b.reason,
        requestId: meta.requestId,
        network: networkKey(meta.ip),
        detail: { verification: b.verification, tester: b.tester, codeEnds: b.codeExpiresAt ?? null },
      });
    });
    let created: AccountRow | null = null;
    try {
      created = await accounts.service.createByOperator({ id, name: b.name, email: b.email, password: b.password ?? generated!, verified: b.verification === "verified" });
    } finally {
      if (!created) await this.ctx.platform.write((w) => deleteOperatorAccount(w, id));
    }
    if (!created) throw new ApiError(409, "email_taken", "That email already has a Meldiq account.");
    let codeSent = false;
    if (b.verification === "email" && b.sendCode) {
      await accounts.service.sendCode(created, "verify_email", null);
      codeSent = true;
    }
    const row = operatorAccount(this.ctx.platform, id)!;
    return { account: (await this.views(p, [row]))[0]!, password: generated, codeSent };
  }

  async list(p: AdminPrincipal, q: ListQuery) {
    const rows = listOperatorAccounts(this.ctx.platform, decodeCursor(q.cursor), q.limit);
    const shown = rows.slice(0, q.limit);
    const last = shown[shown.length - 1];
    const nextCursor = rows.length > q.limit && last ? encodeCursor({ createdAt: last.created_at, id: last.account_id }) : null;
    return { accounts: await this.views(p, shown), nextCursor };
  }

  /** One canonical account by an exact identifier, including accounts with no encryption identity yet.
   * Email goes in a POST body so it is not persisted in the URL/history/access log. */
  async lookup(p: AdminPrincipal, query: { accountId?: string; email?: string }) {
    if (!allowed(p.grant, "users.view")) throw forbidden("Your role cannot view accounts.");
    if (query.email && !allowed(p.grant, "users.view_email")) throw forbidden("Your role cannot search by email.");
    const account = query.accountId ? await this.ctx.accounts.store.accountById(query.accountId) : query.email ? await this.ctx.accounts.store.accountByEmail(query.email) : undefined;
    if (!account) throw notFound("No matching account.");
    const t = now();
    const identity = account.user_id ? userSummary(this.ctx.identity, account.user_id) : undefined;
    const identityStatus = identity ? identity.deleted_at !== null ? "deleted" as const : identity.disabled_at !== null ? "suspended" as const : "active" as const : null;
    const sessions = allowed(p.grant, "devices.view") ? await this.ctx.accounts.store.recentSessions(account.id, t - 30 * 86_400_000, 51) : null;
    const history = allowed(p.grant, "audit.view") ? this.ctx.platform.all<{ at: number; action: string; outcome: string; reason: string | null }>("platform_audit", {
      where: { target_type: "account", target_id: account.id }, orderBy: [["id", "desc"]], limit: 30,
    }).map(event => ({ at: event.at, action: event.action, outcome: event.outcome, reason: event.reason })) : null;
    return {
      generatedAt: t,
      account: {
        id: account.id, name: account.name, email: allowed(p.grant, "users.view_email") ? account.email : null,
        verifiedAt: account.email_verified_at, createdAt: account.created_at, updatedAt: account.updated_at,
        disabledAt: account.disabled_at, userId: account.user_id, identityStatus,
        canSignIn: account.email_verified_at !== null && account.disabled_at === null && identityStatus !== "suspended" && identityStatus !== "deleted",
      },
      sessions: sessions?.slice(0, 50).map(session => ({
        id: session.id, masked: maskId(session.id), label: session.label, deviceId: session.device_id,
        createdAt: session.created_at, lastUsedAt: session.last_used_at, expiresAt: session.expires_at,
        idleExpiresAt: session.refresh_expires_at, revokedAt: session.revoked_at,
        state: session.revoked_at !== null ? "revoked" as const : session.expires_at <= t || session.refresh_expires_at <= t ? "expired" as const : "active" as const,
      })) ?? null,
      sessionsTruncated: sessions !== null && sessions.length > 50,
      history,
    };
  }

  /** Session revocation remains monotonic and account-bound, including setup-only web/native sessions. */
  async revokeAccountSession(p: AdminPrincipal, accountId: string, sessionId: string, reason: string, meta: RequestMeta) {
    if (!allowed(p.grant, "users.view") || !allowed(p.grant, "users.sessions.revoke")) throw forbidden("Your role cannot revoke account sessions.");
    const grants = new PlatformAdminStore(this.ctx.platform, this.ctx.ephemeral);
    const denied = accountId === p.account.id ? "self" : grants.activeGrant(accountId) && p.grant.role !== "super_admin" ? "platform_admin" : null;
    if (denied) {
      await this.audit.record({ action: "account.session_revoke", outcome: "denied", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "account", targetId: accountId, reason, requestId: meta.requestId, detail: { why: denied } });
      throw forbidden(denied === "self" ? "You cannot revoke your own sessions here." : "Only a super admin can act on another platform administrator.");
    }
    const account = await this.ctx.accounts.store.accountById(accountId);
    const session = account ? await this.ctx.accounts.store.sessionById(sessionId) : undefined;
    if (!account || !session || session.account_id !== account.id) throw notFound("No such session for this account.");
    const changed = await this.ctx.accounts.store.revokeSession(session.id, "admin_revoked", now());
    if (changed && session.device_id) this.ctx.hub.disconnectDevice(session.device_id, "session revoked");
    await this.audit.record({ action: "account.session_revoke", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "account", targetId: accountId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { session: maskId(session.id), changed } });
    return { ok: true as const, changed };
  }

  /** The account domain's native sign-in block, for accounts that have no messaging identity yet. */
  async setSuspended(p: AdminPrincipal, accountId: string, suspend: boolean, reason: string, meta: RequestMeta) {
    if (!allowed(p.grant, "users.view") || !allowed(p.grant, suspend ? "users.suspend" : "users.restore")) throw forbidden("Your role cannot change account status.");
    const grants = new PlatformAdminStore(this.ctx.platform, this.ctx.ephemeral, id => readAdminAccountAuthority(this.ctx, id));
    const action = suspend ? "account.suspend" : "account.restore";
    const audit = { action, actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "account", targetId: accountId, reason, requestId: meta.requestId, network: networkKey(meta.ip) };
    const targetGrant = grants.activeGrant(accountId);
    const denied = accountId === p.account.id ? "self" : targetGrant && p.grant.role !== "super_admin" ? "platform_admin" : null;
    if (denied) {
      await this.audit.record({ ...audit, outcome: "denied", detail: { why: denied } });
      throw forbidden(denied === "self" ? "You cannot change your own account status." : "Only a super admin can act on another platform administrator.");
    }
    const account = await this.ctx.accounts.store.accountById(accountId);
    if (!account) throw notFound("No such account.");
    if (account.user_id) throw new ApiError(409, "conflict", "This account has a messaging identity. Use the person's suspend or restore action so both identities remain consistent.");
    const t = now();
    const authority = await snapshotAdminAuthority(grants, [p.account.id, accountId]);
    const reservationId = `account:${accountId}`;
    let reservation = t;
    try {
      await this.ctx.platform.write(w => {
        guardAccountStatusWrite(w, p.account.id, accountId, suspend, authority);
        const previous = w.get<{ set_at: number }>("platform_restrictions", { user_id: reservationId });
        reservation = Math.max(t, (previous?.set_at ?? 0) + 1);
        const restriction = { until: null, reason, set_by: p.account.id, set_at: reservation };
        w.upsert("platform_restrictions", { user_id: reservationId, kind: "suspension", ...restriction }, restriction);
        this.audit.append(w, { ...audit, action: `${action}.requested`, outcome: "success", detail: { beforeDisabledAt: account.disabled_at } });
      });
    } catch (error) {
      await this.audit.record({ ...audit, outcome: "denied", detail: { why: "platform_safety_check" } });
      throw error;
    }
    const changed = suspend ? account.disabled_at === null : account.disabled_at !== null;
    try {
      if (changed) await this.ctx.accounts.store.updateAccount(accountId, { disabled_at: suspend ? t : null }, t);
      if (suspend) {
        await this.ctx.accounts.service.revokeSessions(accountId, "suspended");
        await grants.revokeAccountSessions(accountId, "suspended", t);
      } else await this.ctx.platform.write(w => { w.delete("platform_restrictions", { user_id: reservationId, set_at: reservation }); });
      await this.audit.record({ ...audit, outcome: "success", detail: { changed } });
    } catch (error) {
      await this.audit.record({ ...audit, outcome: "failed", detail: { why: "account_or_session_persistence", retry: true } });
      throw error;
    }
    return { ok: true as const, changed };
  }

  /** Changes how an operator-made account proves its email; "verified" also marks the address proven now. */
  async setVerification(p: AdminPrincipal, accountId: string, b: VerificationBody, meta: RequestMeta) {
    const before = operatorAccount(this.ctx.platform, accountId);
    if (!before) throw new ApiError(404, "not_found", "No account made in the console has that id.");
    const account = await this.ctx.accounts.store.accountById(accountId);
    if (!account) throw new ApiError(404, "not_found", "That account was deleted.");
    const t = now();
    await this.ctx.platform.write((w) => {
      const next = this.row(p, accountId, { ...b, tester: before.tester === 1, note: before.note ?? undefined }, t);
      updateOperatorVerification(w, accountId, { verification: next.verification, code_hash: next.code_hash, code_expires_at: next.code_expires_at, updated_by: p.account.id, updated_at: t });
      this.audit.append(w, {
        action: "account.verification",
        outcome: "success",
        actorAccountId: p.account.id,
        actorRole: p.grant.role,
        targetType: "account",
        targetId: accountId,
        reason: b.reason,
        requestId: meta.requestId,
        network: networkKey(meta.ip),
        detail: { before: before.verification, after: b.verification, codeEnds: b.codeExpiresAt ?? null },
      });
    });
    if (b.verification === "verified" && !account.email_verified_at) await this.ctx.accounts.service.markVerified(accountId);
    return { account: (await this.views(p, [operatorAccount(this.ctx.platform, accountId)!]))[0]! };
  }

  private row(
    p: AdminPrincipal,
    id: string,
    b: { verification: OperatorAccountRow["verification"]; staticCode?: string; codeExpiresAt?: number; tester: boolean; note?: string },
    t: number,
  ): OperatorAccountRow {
    if (b.codeExpiresAt !== undefined && b.codeExpiresAt <= t) throw badRequest("The fixed code's end must be in the future.");
    return {
      account_id: id,
      verification: b.verification,
      code_hash: b.verification === "static_code" ? staticCodeHash(id, b.staticCode!) : null,
      code_expires_at: b.verification === "static_code" ? (b.codeExpiresAt ?? null) : null,
      tester: b.tester ? 1 : 0,
      note: b.note ?? null,
      created_by: p.account.id,
      created_at: t,
      updated_by: p.account.id,
      updated_at: t,
    };
  }

  private async views(p: AdminPrincipal, rows: OperatorAccountRow[]) {
    const showEmail = allowed(p.grant, "users.view_email");
    const names = new Map<string, string>();
    const out = [];
    for (const r of rows) {
      const a = await this.ctx.accounts.store.accountById(r.account_id);
      if (!names.has(r.created_by)) names.set(r.created_by, (await this.ctx.accounts.store.accountById(r.created_by))?.name ?? "");
      out.push({
        accountId: r.account_id,
        name: a?.name ?? "Deleted account",
        email: a && showEmail ? a.email : null,
        verification: r.verification,
        verified: !!a?.email_verified_at,
        codeExpiresAt: r.code_expires_at,
        tester: r.tester === 1,
        note: r.note,
        userId: a?.user_id ?? null,
        exists: !!a,
        createdBy: { accountId: r.created_by, name: names.get(r.created_by) || null },
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    }
    return out;
  }
}
