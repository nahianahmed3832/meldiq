import type { AppContext } from "../../app/context.js";
import { notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { usernames } from "../accounts/index.js";
import { ENTITLEMENT_KEYS } from "../administration/index.js";
import { channelCounts } from "../messaging/index.js";
import { type OrgKind, orgComposition, orgRecord, type OrgSummaryRow, searchOrgs } from "../organizations/index.js";
import { decodeCursor, page } from "./pagination.js";
import type { AdminBilling } from "./billing.js";

const USAGE_DAYS = 30;

const orgView = (o: OrgSummaryRow) => ({ id: o.id, name: o.name, slug: o.slug, kind: o.kind, visibility: o.visibility, createdAt: o.created_at, members: o.members });

/**
 * Workspaces and communities in the console (§5.2): search and a detail of counts, settings, usage and limits. Never a
 * member list or anything said in them. Suspension is designed but not enforced yet, and says so.
 */
export class AdminOrgs {
  constructor(
    private readonly ctx: AppContext,
    private readonly billing: AdminBilling,
  ) {}

  search(q: { q?: string; kind?: OrgKind; cursor?: string; limit: number }) {
    const rows = searchOrgs(this.ctx.ws, { q: q.q || undefined, kind: q.kind, after: decodeCursor(q.cursor), limit: q.limit + 1 });
    const { rows: shown, nextCursor } = page(rows, q.limit);
    return { organizations: shown.map(orgView), nextCursor };
  }

  async detail(orgId: string) {
    const o = orgRecord(this.ctx.ws, orgId);
    if (!o) throw notFound("No such workspace or community");
    const composition = orgComposition(this.ctx.ws, orgId, now());
    const names = usernames(this.ctx.db, composition.owners);
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
      suspension: { supported: false as const },
    };
  }
}
