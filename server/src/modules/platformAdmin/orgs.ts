import type { AppContext } from "../../app/context.js";
import { badRequest, forbidden, conflict, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { usernames } from "../accounts/index.js";
import { ENTITLEMENT_KEYS } from "../administration/index.js";
import { channelCounts } from "../messaging/index.js";
import { eraseWorkspace, orgPlatformRestriction, setOrgPlatformRestriction, type OrgKind, orgComposition, orgRecord, type OrgSummaryRow, searchOrgs } from "../organizations/index.js";
import { decodeCursor, page } from "./pagination.js";
import { networkKey } from "../../app/middleware/abuse.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import type { AdminBilling } from "./billing.js";

const USAGE_DAYS = 30;

const orgView = (o: OrgSummaryRow) => ({ id: o.id, name: o.name, slug: o.slug, kind: o.kind, visibility: o.visibility, createdAt: o.created_at, members: o.members });

/**
 * Workspaces and communities in the console (§5.2): search and a detail of counts, settings, usage and limits. Never a
 * member list or anything said in them. Platform restrictions are enforced in shared authorization; deletion reuses the existing protected workflow.
 */
export class AdminOrgs {
  constructor(
    private readonly ctx: AppContext,
    private readonly billing: AdminBilling,
    private readonly audit?: PlatformAudit,
  ) {}

  async delete(p: AdminPrincipal, orgId: string, b: { confirmName: string; requestId: string; reason: string }, meta: RequestMeta) {
    if (p.grant.role !== "super_admin") throw forbidden("Only a super admin may permanently delete a community.");
    const org = orgRecord(this.ctx.ws, orgId);
    if (org) {
      if (b.confirmName.trim() !== org.name.trim()) throw badRequest("Type the community name exactly. Nothing was deleted.");
      if (!this.restriction(orgId).active) throw conflict("Suspend the community before deleting it.");
      if (this.billing.orgSubscription(orgId)) throw conflict("Resolve the community subscription through its provider before deleting it.");
    }
    const entry = { actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "org", targetId: orgId, reason: b.reason, requestId: meta.requestId, network: networkKey(meta.ip) };
    await this.audit!.record({ ...entry, action: "org.delete_requested", outcome: "success", detail: { operation: b.requestId } });
    try {
      const result = await eraseWorkspace(this.ctx, orgId, { kind: "platform", accountId: p.account.id }, b);
      await this.audit!.record({ ...entry, action: "org.delete", outcome: "success", detail: { operation: b.requestId, members: result.members, channels: result.channels, files: result.files } });
      return result;
    } catch (e) {
      await this.audit!.record({ ...entry, action: "org.delete", outcome: "failed", detail: { operation: b.requestId } });
      throw e;
    }
  }

  restriction(orgId: string) {
    const row = orgPlatformRestriction(this.ctx.ws, orgId);
    return { supported: true as const, active: this.ctx.authz.platformSuspended(orgId), suspendedAt: row.suspendedAt, until: row.until };
  }

  async restrict(p: AdminPrincipal, orgId: string, b: { suspended: boolean; until?: number | null; reason: string }, meta: RequestMeta) {
    if (!orgRecord(this.ctx.ws, orgId)) throw notFound("No such workspace or community");
    if (b.suspended && b.until != null && (b.until <= now() || b.until > now() + 366 * 86_400_000)) throw badRequest("Choose an end in the next 366 days.");
    const before = this.restriction(orgId);
    const entry = { actorAccountId: p.account.id, actorRole: p.grant.role, targetType: "org", targetId: orgId, reason: b.reason, requestId: meta.requestId, network: networkKey(meta.ip) };
    await this.audit!.record({ ...entry, action: "org.restriction_requested", outcome: "success", detail: { before: before.active, after: b.suspended, until: b.until ?? null } });
    try {
      await setOrgPlatformRestriction(this.ctx.ws, orgId, b.suspended ? now() : null, b.suspended ? (b.until ?? null) : null);
    } catch (e) {
      await this.audit!.record({ ...entry, action: "org.restrict", outcome: "failed" });
      throw e;
    }
    await this.audit!.record({ ...entry, action: b.suspended ? "org.suspend" : "org.restore", outcome: "success", detail: { before: before.active, after: b.suspended, until: b.until ?? null } });
    return this.detail(orgId);
  }

  search(q: { q?: string; kind?: OrgKind; cursor?: string; limit: number }) {
    const rows = searchOrgs(this.ctx.ws, { q: q.q || undefined, kind: q.kind, after: decodeCursor(q.cursor), limit: q.limit + 1 });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    return { organizations: shown.map(orgView), nextCursor };
  }

  async detail(orgId: string) {
    const o = orgRecord(this.ctx.ws, orgId);
    if (!o) throw notFound("No such workspace or community");
    const composition = orgComposition(this.ctx.ws, orgId, now());
    const names = usernames(this.ctx.identity, composition.owners);
    await this.ctx.usage.snapshot();
    const usage = Object.fromEntries(this.ctx.usage.series(orgId, USAGE_DAYS).map((s) => [s.metric, s.total]));
    return {
      organization: {
        ...orgView(o),
        joinPolicy: o.join_policy,
        updatedAt: o.updated_at,
        invitesPausedUntil: o.invites_paused_until,
        dmsPausedUntil: o.dms_paused_until,
        guestsAllowed: o.guests_allowed === 1,
        activityAlerts: o.activity_alerts === 1,
        raidAlertAt: o.raid_alert_at,
      },
      owners: composition.owners.map((id) => ({ id, username: names.get(id) ?? null })),
      composition: { byRole: composition.byRole, customRoles: composition.customRoles, bans: composition.bans, activeInvites: composition.activeInvites },
      channels: channelCounts(this.ctx.ws, orgId),
      usage: { days: USAGE_DAYS, metrics: usage },
      limits: ENTITLEMENT_KEYS.map((key) => ({ key, ...this.ctx.entitlements.limitFor(key, orgId) })),
      subscription: this.billing.orgSubscription(orgId),
      suspension: this.restriction(orgId),
    };
  }
}
