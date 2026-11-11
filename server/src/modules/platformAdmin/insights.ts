import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import { ApiError, badRequest, forbidden, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { eraseAccount, setIdentitySuspended, soleOwnedWorkspaces, userSummary } from "../accounts/index.js";
import { orgMemberIds, orgRecord, removeFromWorkspace } from "../organizations/index.js";
import { analytics, utcDay } from "../telemetry/index.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import type { Exclusions } from "./exclusions.js";
import type { AdminQuotas } from "./quotasAdmin.js";
import type { PlatformAdminStore } from "./store.js";
import { allowed } from "./permissions.js";

const DAY_MS = 86_400_000;
const INCIDENTS_SHOWN = 20;

/**
 * More about one person or organization (docs/PLATFORM_ADMIN_CONSOLE.md › People): activity, traffic, quotas,
 * restrictions, linked incidents, and the account actions that use the app's own workflows (verification and
 * password-reset emails, deletion, removing a member). Deletion is the established erasure (docs/ACCOUNT_DELETION.md),
 * never a side effect of anything else: a super admin, a recent passkey check, the account suspended first, its
 * username typed to confirm, and no community where it is the only owner.
 */
export class AdminInsights {
  constructor(
    private readonly ctx: AppContext,
    private readonly store: PlatformAdminStore,
    private readonly audit: PlatformAudit,
    private readonly quotas: AdminQuotas,
    private readonly exclusions: Exclusions,
  ) {}

  private incidents(column: "user_ref" | "org_ref", id: string) {
    return (
      this.ctx.platform.all<{ id: string; title: string; status: string; kind: string; created_at: number; closed_at: number | null }>("platform_incidents", {
        where: { [column]: id },
        orderBy: [["created_at", "desc"]],
        limit: INCIDENTS_SHOWN,
      })
    ).map((r) => ({ id: r.id, title: r.title, status: r.closed_at ? "closed" : r.status === "mitigated" ? "monitoring" : r.status, kind: r.kind, createdAt: r.created_at }));
  }

  private deletionBlockers(userId: string, suspended: boolean, isAdmin: boolean): string[] {
    const blockers: string[] = [];
    if (!suspended) blockers.push("Suspend the account first.");
    if (isAdmin) blockers.push("This person holds a console role: revoke it first.");
    const owned = soleOwnedWorkspaces(this.ctx.ws, userId);
    if (owned.length) blockers.push(`Only owner of ${owned.map((o) => o.name).join(", ")}: another owner is needed first.`);
    return blockers;
  }

  async user(p: AdminPrincipal, userId: string) {
    const u = userSummary(this.ctx.identity, userId);
    if (!u) throw notFound("No such person");
    const t = now();
    const account = await this.ctx.accounts.store.accountByUserId(userId);
    const restriction = allowed(p.grant, "users.suspend") || allowed(p.grant, "users.restore") || allowed(p.grant, "audit.view")
      ? this.ctx.platform.get<{ until: number | null; reason: string; set_at: number }>("platform_restrictions", { user_id: userId }) : undefined;
    const isAdmin = !!(account && this.store.activeGrant(account.id));
    const blockers = allowed(p.grant, "users.delete") ? (u.deleted_at !== null ? ["Already deleted."] : this.deletionBlockers(userId, u.disabled_at !== null, isAdmin)) : null;
    return {
      activity: allowed(p.grant, "analytics.view") ? analytics.userActivity(this.ctx, userId, utcDay(t - 89 * DAY_MS)) : null,
      traffic30d: allowed(p.grant, "resources.view") ? analytics.userTraffic(this.ctx, userId, utcDay(t - 29 * DAY_MS), utcDay(t)) : null,
      quotas: allowed(p.grant, "quotas.view") ? this.quotas.effective({ type: "user", id: userId }) : null,
      restriction: restriction && u.disabled_at !== null ? { until: restriction.until, reason: restriction.reason, setAt: restriction.set_at } : null,
      incidents: allowed(p.grant, "incidents.view") ? this.incidents("user_ref", userId) : null,
      deletion: blockers ? { possible: blockers.length === 0 && !!account, blockers: account ? blockers : ["No email account: a device-key identity (delete it from the app or the server CLI)."] } : null,
      verification: { emailVerified: account ? account.email_verified_at !== null : null, mailAvailable: this.ctx.accounts.mailer.available },
    };
  }

  async org(p: AdminPrincipal, orgId: string) {
    if (!orgRecord(this.ctx.ws, orgId)) throw notFound("No such organization");
    const t = now();
    const showActivity = allowed(p.grant, "analytics.view");
    const members = showActivity ? orgMemberIds(this.ctx.ws, orgId) : [];
    const ex = showActivity ? await this.exclusions.get(t) : null;
    const a30 = ex ? analytics.activeAmong(this.ctx, members, utcDay(t - 29 * DAY_MS), utcDay(t), ex.ids) : null;
    const a7 = ex ? analytics.activeAmong(this.ctx, members, utcDay(t - 6 * DAY_MS), utcDay(t), ex.ids) : null;
    const showUsage = allowed(p.grant, "resources.view");
    if (showUsage) await this.ctx.usage.snapshot();
    const usage = showUsage ? Object.fromEntries(this.ctx.usage.series(orgId, 30).map((s) => [s.metric, s.total])) : null;
    const storage = usage?.["storage.bytes"] ?? null;
    const quotas = allowed(p.grant, "quotas.view") ? this.quotas.effective({ type: "org", id: orgId }) : null;
    const incidents = allowed(p.grant, "incidents.view") ? this.incidents("org_ref", orgId) : null;
    const health: string[] = [];
    const memberCount = members.length;
    if (memberCount > 0 && a30?.users === 0 && this.ctx.telemetry.since("activity") !== null && t - this.ctx.telemetry.since("activity")! > 30 * DAY_MS) health.push("No member was active in the last 30 days.");
    for (const q of quotas ?? []) if (q.limit !== null && q.limit > 0 && q.used !== null && q.used + (q.reserved ?? 0) >= q.limit * 0.9) health.push(`${q.label}: ${Math.round(((q.used + (q.reserved ?? 0)) / q.limit) * 100)} % of its allowance.`);
    const open = incidents?.filter((i) => !["resolved", "closed"].includes(i.status));
    if (open?.length) health.push(`${open.length} open incident(s) or support case(s) in the latest ${INCIDENTS_SHOWN} linked records.`);
    return { activeMembers30d: a30?.users ?? null, activeMembers7d: a7?.users ?? null, lastActiveAt: a30?.lastAt ?? null, storageBytes: storage, usage30d: usage, quotas, incidents, health };
  }

  /** Same guard as the people actions: not on yourself, and only a super admin on another platform admin. */
  private async guard(p: AdminPrincipal, userId: string, action: string, reason: string, meta: RequestMeta) {
    const account = await this.ctx.accounts.store.accountByUserId(userId);
    const why = p.account.user_id === userId ? "self" : account && this.store.activeGrant(account.id) && p.grant.role !== "super_admin" ? "platform_admin" : null;
    if (why) {
      await this.audit.record({ action, outcome: "denied", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "user", targetId: userId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { why } });
      throw forbidden(why === "self" ? "You can't do that to your own account." : "Only a super admin can do that to a platform admin.");
    }
    return account;
  }

  /** Sends the person a new email-verification code (unverified accounts) or a password-reset code, to their own address. */
  async sendEmail(p: AdminPrincipal, userId: string, kind: "verification" | "password_reset", reason: string, meta: RequestMeta) {
    const account = await this.guard(p, userId, `user.${kind}_email`, reason, meta);
    if (!account) throw badRequest("This person has no email account.");
    if (!this.ctx.accounts.mailer.available) throw new ApiError(503, "email_unavailable", "The server has no mail transport: no email can be sent.");
    if (account.disabled_at) throw new ApiError(409, "conflict", "The account is suspended: restore it first.");
    let detail: string;
    if (kind === "verification") {
      if (account.email_verified_at) throw new ApiError(409, "conflict", "The email address is already verified.");
      await this.ctx.accounts.service.resendVerification(account.email, meta.ip);
      detail = "A new verification code was sent to the person's own address.";
    } else {
      await this.ctx.accounts.service.forgotPassword(account.email, meta.ip);
      detail = "A password-reset code was sent to the person's own address. Their password changes only if they use it.";
    }
    await this.audit.record({ action: `user.${kind}_email`, outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "user", targetId: userId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: {} });
    return { sent: true, detail };
  }

  async deleteUser(p: AdminPrincipal, userId: string, reason: string, confirm: string, meta: RequestMeta) {
    const u = userSummary(this.ctx.identity, userId);
    if (!u) throw notFound("No such person");
    const account = await this.guard(p, userId, "user.delete", reason, meta);
    if (!account) throw badRequest("This person has no email account: delete device-key identities with the server CLI.");
    if (confirm.trim().toLowerCase() !== u.username.toLowerCase()) throw badRequest("Type the person's username exactly to confirm. Nothing was deleted.");
    const blockers = this.deletionBlockers(userId, u.disabled_at !== null, !!this.store.activeGrant(account.id));
    if (blockers.length) throw new ApiError(409, "conflict", blockers.join(" "));
    const result = await eraseAccount(this.ctx, this.ctx.accounts, account, null);
    await this.ctx.platform.write((w) => w.delete("platform_restrictions", { user_id: userId }));
    await this.audit.record({
      action: "user.delete",
      outcome: "success",
      actorAccountId: p.account.id,
      actorRole: p.grant.role,
      targetType: "user",
      targetId: userId,
      reason,
      requestId: meta.requestId,
      network: networkKey(meta.ip),
      detail: { devices: result.devices, conversations: result.conversations, workspaces: result.workspaces },
    });
    return { deleted: true as const, summary: { devices: result.devices, conversations: result.conversations, workspaces: result.workspaces, deletedAt: result.deletedAt } };
  }

  async removeMember(p: AdminPrincipal, orgId: string, userId: string, reason: string, meta: RequestMeta) {
    if (!orgRecord(this.ctx.ws, orgId)) throw notFound("No such organization");
    const role = this.ctx.authz.orgRole(orgId, userId);
    if (!role) throw notFound("That person isn't a member.");
    if (role === "OWNER") throw new ApiError(409, "conflict", "Owners can't be removed from the console: the community's owners decide its ownership.");
    await removeFromWorkspace(this.ctx, orgId, userId, null, "removed");
    await this.audit.record({ action: "org.member_remove", outcome: "success", actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "org", targetId: orgId, reason, requestId: meta.requestId, network: networkKey(meta.ip), detail: { userId, role } });
    return { removed: true };
  }
}

/** Lifts temporary suspensions whose time has come (the console's minute job); audited as the system. */
export async function liftExpiredSuspensions(ctx: AppContext, audit: PlatformAudit, t = now()): Promise<number> {
  const due = ctx.platform.all<{ user_id: string; set_at: number }>("platform_restrictions", { where: { until: { lte: t } } }).filter(r => !r.user_id.startsWith("account:"));
  for (const { user_id, set_at } of due) {
    const account = await ctx.accounts.store.accountByUserId(user_id);
    await setIdentitySuspended(ctx.identity, user_id, null);
    if (account?.disabled_at) await ctx.accounts.store.updateAccount(account.id, { disabled_at: null }, t);
    await ctx.platform.write((w) => {
      w.delete("platform_restrictions", { user_id, set_at });
      if (account) w.delete("platform_restrictions", { user_id: `account:${account.id}`, set_at });
    });
    await audit.record({ action: "user.restore", outcome: "success", actorAccountId: "system:restrictions", actorRole: null, targetType: "user", targetId: user_id, reason: "Temporary suspension ended", detail: { automatic: true } });
  }
  return due.length;
}
