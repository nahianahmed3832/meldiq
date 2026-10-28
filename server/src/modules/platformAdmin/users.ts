import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError, badRequest, forbidden, notFound } from "../../shared/errors.js";
import { analytics, utcDay } from "../telemetry/index.js";
import { now } from "../../shared/utilities/util.js";
import { type AccountRow, searchUsers, setIdentitySuspended, userDevices, type UserStatus, type UserSummaryRow, userSummary } from "../accounts/index.js";
import { endLegacySessions } from "../auth/index.js";
import { membershipsOf, securityEvents } from "../organizations/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { decodeCursor, page } from "./pagination.js";
import { can } from "./permissions.js";
import type { PlatformAdminStore } from "./store.js";

const EVENTS_SHOWN = 20;
const CUSTOM_ROLE_SEPARATOR = "\u001f";

export function statusOf(u: Pick<UserSummaryRow, "disabled_at" | "deleted_at">): UserStatus {
  if (u.deleted_at !== null) return "deleted";
  return u.disabled_at !== null ? "suspended" : "active";
}

export interface UserExtras {
  lastActiveAt: number | null;
  suspendedUntil: number | null;
}

/** Last qualifying activity and temporary-suspension ends for [ids] (one query each). */
export function userExtras(ctx: AppContext, ids: string[]): Map<string, UserExtras> {
  const active = analytics.userLastActive(ctx.db, ids);
  const until = new Map(
    (ctx.db.prepare("SELECT user_id, until FROM platform_restrictions WHERE user_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { user_id: string; until: number | null }[]).map((r) => [
      r.user_id,
      r.until,
    ]),
  );
  return new Map(ids.map((id) => [id, { lastActiveAt: active.get(id)?.lastAt ?? null, suspendedUntil: until.get(id) ?? null }]));
}

export function userView(u: UserSummaryRow, extras?: UserExtras) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    status: statusOf(u),
    createdAt: u.created_at,
    suspendedAt: u.deleted_at === null ? u.disabled_at : null,
    activeDevices: u.active_devices,
    lastSeenAt: u.last_seen_at,
    newAccountLimitsUntil: u.limited_until !== null && u.limited_until > now() ? u.limited_until : null,
    lastActiveAt: extras?.lastActiveAt ?? null,
    suspendedUntil: u.disabled_at !== null ? (extras?.suspendedUntil ?? null) : null,
  };
}

const DAY_MS = 86_400_000;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);
/** People an activity filter can look through at once (the console narrows further by search). */
const ACTIVITY_FILTER_LIMIT = 50_000;

/**
 * People in the console (§5.2): search, detail, suspension, restoration and ending sessions. Changes need a reason,
 * a recent passkey check (the route's permission) and leave an audit row; they are idempotent. Nobody acts on
 * themselves, and only a super admin acts on another platform admin.
 */
export class AdminUsers {
  constructor(
    private readonly ctx: AppContext,
    private readonly store: PlatformAdminStore,
    private readonly audit: PlatformAudit,
  ) {}

  async search(p: AdminPrincipal, q: { q?: string; status?: UserStatus; activity?: "active7d" | "inactive30d"; createdFrom?: string; createdTo?: string; cursor?: string; limit: number }) {
    const after = decodeCursor(q.cursor);
    let ids: string[] | undefined;
    let notIds: string[] | undefined;
    const t = now();
    if (q.activity === "active7d") ids = analytics.activeUserIds(this.ctx.db, utcDay(t - 6 * DAY_MS), utcDay(t), ACTIVITY_FILTER_LIMIT);
    if (q.activity === "inactive30d") notIds = analytics.activeUserIds(this.ctx.db, utcDay(t - 29 * DAY_MS), utcDay(t), ACTIVITY_FILTER_LIMIT);
    let text = q.q || undefined;
    // An email address finds the person behind that account, for admins who may see addresses.
    if (text?.includes("@") && can(p.grant.role, "users.view_email")) {
      const account = await this.ctx.accounts.store.accountByEmail(text.toLowerCase());
      const found = account?.user_id ? [account.user_id] : [];
      ids = ids ? ids.filter((id) => found.includes(id)) : found;
      text = undefined;
    }
    const rows = searchUsers(this.ctx.db, {
      q: text,
      status: q.status,
      after,
      limit: q.limit + 1,
      ids,
      notIds,
      createdFrom: q.createdFrom ? dayStart(q.createdFrom) : undefined,
      createdTo: q.createdTo ? dayStart(q.createdTo) + DAY_MS : undefined,
    });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    const extras = userExtras(this.ctx, shown.map((r) => r.id));
    return { users: shown.map((r) => userView(r, extras.get(r.id))), nextCursor };
  }

  private target(userId: string): UserSummaryRow {
    const u = userSummary(this.ctx.db, userId);
    if (!u) throw notFound("No such person");
    return u;
  }

  async detail(p: AdminPrincipal, userId: string, meta: RequestMeta) {
    const u = this.target(userId);
    const account = await this.ctx.accounts.store.accountByUserId(userId);
    const showEmail = can(p.grant.role, "users.view_email");
    const t = now();
    const interventions = this.ctx.db
      .prepare("SELECT at, action, outcome, actor_role, reason FROM platform_audit WHERE target_type = 'user' AND target_id = ? AND action != 'user.view' ORDER BY id DESC LIMIT ?")
      .all(userId, EVENTS_SHOWN) as { at: number; action: string; outcome: string; actor_role: string | null; reason: string | null }[];
    this.audit.record({ action: "user.view", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "user", targetId: userId, requestId: meta.requestId, network: networkKey(meta.ip), detail: { email: showEmail && !!account } });
    return {
      user: userView(u, userExtras(this.ctx, [userId]).get(userId)),
      account: account
        ? {
            id: account.id,
            email: showEmail ? account.email : null,
            emailVerified: account.email_verified_at !== null,
            createdAt: account.created_at,
            disabledAt: account.disabled_at,
            activeSessions: (await this.ctx.accounts.store.activeSessions(account.id, t)).length,
            passkeys: this.ctx.accounts.passkeys.list(account.id).passkeys.length,
          }
        : null,
      devices: userDevices(this.ctx.db, userId).map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at })),
      memberships: membershipsOf(this.ctx.ws, userId).map((m) => ({ orgId: m.org_id, name: m.name, kind: m.kind, role: m.role, joinedAt: m.joined_at, customRoles: m.custom_roles ? m.custom_roles.split(CUSTOM_ROLE_SEPARATOR) : [] })),
      platformRole: account ? (this.store.activeGrant(account.id)?.role ?? null) : null,
      securityEvents: securityEvents(this.ctx.ws, account ? [userId, account.id] : [userId], EVENTS_SHOWN),
      interventions: interventions.map((i) => ({ at: i.at, action: i.action, outcome: i.outcome, actorRole: i.actor_role, reason: i.reason })),
    };
  }

  /** Refuses acting on oneself, and on another platform admin unless a super admin acts (audited as denied). */
  private async guard(p: AdminPrincipal, u: UserSummaryRow, action: string, reason: string, meta: RequestMeta): Promise<AccountRow | undefined> {
    const account = await this.ctx.accounts.store.accountByUserId(u.id);
    const why = p.account.user_id === u.id ? "self" : account && this.store.activeGrant(account.id) && p.grant.role !== "super_admin" ? "platform_admin" : null;
    if (why) {
      this.audit.record({ action, outcome: "denied", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "user", targetId: u.id, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { why } });
      throw forbidden(why === "self" ? "You can't do that to your own account." : "Only a super admin can do that to a platform admin.");
    }
    return account;
  }

  /** Ends every app session (account and v1), the person's open connections, and their console sessions if any. */
  private async endSessions(userId: string, account: AccountRow | undefined, reason: string, t: number): Promise<{ accountSessions: number; legacySessions: number }> {
    const accountSessions = account ? (await this.ctx.accounts.store.activeSessions(account.id, t)).length : 0;
    if (account) {
      await this.ctx.accounts.service.revokeSessions(account.id, reason);
      this.store.revokeAccountSessions(account.id, reason, t);
    }
    const legacySessions = endLegacySessions(this.ctx, userId);
    this.ctx.hub.disconnectUser(userId, reason);
    return { accountSessions, legacySessions };
  }

  async setSuspended(p: AdminPrincipal, userId: string, suspend: boolean, reason: string, meta: RequestMeta, until?: number) {
    const u = this.target(userId);
    const action = suspend ? "user.suspend" : "user.restore";
    if (u.deleted_at !== null) throw new ApiError(409, "conflict", "This account was deleted; there is nothing to suspend or restore.");
    const account = await this.guard(p, u, action, reason, meta);
    const t = now();
    if (until !== undefined && until <= t + 60_000) throw badRequest("A temporary suspension ends at least a minute from now.");
    // A suspension's end (temporary) or none (until lifted); lifting removes it. Kept beside users.disabled_at.
    if (suspend) {
      this.ctx.db
        .prepare(
          `INSERT INTO platform_restrictions (user_id, kind, until, reason, set_by, set_at) VALUES (?, 'suspension', ?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`,
        )
        .run(userId, until ?? null, reason, p.account.id, t);
    } else this.ctx.db.prepare("DELETE FROM platform_restrictions WHERE user_id = ?").run(userId);
    const changedIdentity = setIdentitySuspended(this.ctx.db, userId, suspend ? t : null);
    const changedAccount = !!account && (suspend ? account.disabled_at === null : account.disabled_at !== null);
    if (account && changedAccount) await this.ctx.accounts.store.updateAccount(account.id, { disabled_at: suspend ? t : null }, t);
    const ended = suspend ? await this.endSessions(userId, account, "suspended", t) : null;
    const changed = changedIdentity || changedAccount;
    this.audit.record({
      action,
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "user",
      targetId: userId,
      reason,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail: { changed, until: until ?? null, accountSessions: ended?.accountSessions ?? null, legacySessions: ended?.legacySessions ?? null },
    });
    return { user: userView(this.target(userId), userExtras(this.ctx, [userId]).get(userId)), changed };
  }

  async revokeSessions(p: AdminPrincipal, userId: string, reason: string, meta: RequestMeta) {
    const u = this.target(userId);
    const account = await this.guard(p, u, "user.sessions_revoke", reason, meta);
    const ended = await this.endSessions(userId, account, "admin_revoked", now());
    this.audit.record({ action: "user.sessions_revoke", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "user", targetId: userId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: ended });
    return ended;
  }
}
