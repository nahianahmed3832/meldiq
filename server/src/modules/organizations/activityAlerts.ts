import type { AppContext } from "../../app/context.js";

/** Batch B4b (Discord reference ADMIN-CTRL-002 Activity Alerts): this many joins in [JOIN_WINDOW_MS] alert moderators. */
export const JOIN_SPIKE = 10;
export const JOIN_WINDOW_MS = 10 * 60_000;
/** At most one alert per community in this time. */
export const ALERT_QUIET_MS = 30 * 60_000;
/** How long an alert shows to moderators. */
export const ALERT_SHOWN_MS = 24 * 3_600_000;

/** The people who hear about join spikes: those who can pause joining (edit the community or ban members). */
export function safetyModerators(ctx: AppContext, orgId: string): string[] {
  const members = ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: orgId } });
  return members.map((m) => m.user_id).filter((u) => ctx.authz.can(orgId, u, "workspace.edit") || ctx.authz.can(orgId, u, "members.ban"));
}

/**
 * After someone joined [orgId] at [t]: when joins spike, records an alert (audited, shown to moderators for a day) and
 * tells the moderators' apps. Nothing is paused automatically: moderators decide (Security actions).
 */
export async function noteJoin(ctx: AppContext, orgId: string, t: number): Promise<void> {
  const o = ctx.ws.get<{ activity_alerts: number; raid_alert_at: number | null }>("orgs", { id: orgId });
  if (!o || !o.activity_alerts) return;
  if (o.raid_alert_at && o.raid_alert_at > t - ALERT_QUIET_MS) return;
  const joins = ctx.ws.count("org_members", { org_id: orgId, joined_at: { gte: t - JOIN_WINDOW_MS } });
  if (joins < JOIN_SPIKE) return;
  await ctx.ws.write((w) => w.update("orgs", { id: orgId }, { raid_alert_at: t, raid_alert_count: joins }));
  ctx.audit({ actorId: null, orgId, action: "community.activity_alert", target: orgId, detail: `${joins} joins in 10 minutes` });
  ctx.hub.sendToUsers(safetyModerators(ctx, orgId), { t: "org.alert", orgId, kind: "joins", count: joins, at: t });
}

/** The current alert as moderators see it, or null (older than a day, or not a moderator). */
export function activityAlert(ctx: AppContext, org: { id: string; raid_alert_at?: number | null; raid_alert_count?: number | null }, userId: string, at: number) {
  if (!org.raid_alert_at || org.raid_alert_at < at - ALERT_SHOWN_MS) return null;
  if (!ctx.authz.can(org.id, userId, "workspace.edit") && !ctx.authz.can(org.id, userId, "members.ban")) return null;
  return { kind: "joins", count: org.raid_alert_count ?? 0, at: org.raid_alert_at };
}
