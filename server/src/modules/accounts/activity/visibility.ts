import type { AppContext } from "../../../app/context.js";
import type { ActivityWire } from "../../../shared/contracts/realtime.js";
import { directPeers } from "../../messaging/index.js";
import { presenceWatchers } from "../../organizations/index.js";
import { canSeeLastSeen, type ProfileRow, shownActivity } from "../profile.js";

/**
 * Who sees someone's activity (docs/ACTIVITY_STATUS.md): exactly the people who may see their presence (their "last
 * seen" setting: people they share a conversation with, or non-guest members of a community they're in), and only
 * while they appear online. Invisible means no activity for anyone; the person's own devices always see theirs.
 */
export function activityFor(ctx: AppContext, viewerId: string, u: ProfileRow): ActivityWire | null {
  if (viewerId === u.id) return ctx.activity.current(u.id);
  return canSeeLastSeen(ctx, viewerId, u) ? shownActivity(ctx, u) : null;
}

/** The optional `activity` field of a profile, member or presence entry: absent when nothing is shown. */
export const activityField = (activity: ActivityWire | null): { activity?: ActivityWire } => (activity ? { activity } : {});

/**
 * The connected people who could see [userId]'s activity, before their privacy setting is applied: the people they
 * share a DM or group with, and the non-guest members of their communities. Only people with an open connection are
 * told; everyone else reads it with the member list or profile they load next.
 */
function candidates(ctx: AppContext, userId: string): string[] {
  const out = new Set([...directPeers(ctx, userId), ...presenceWatchers(ctx, userId)]);
  out.delete(userId);
  return [...out].filter((id) => ctx.hub.isUserOnline(id));
}

/** Tells the people who may see [userId]'s presence, and their own devices, what they show as their activity now. */
export function announceActivity(ctx: AppContext, userId: string): void {
  if (!ctx.db.open) return; // server shutting down
  // Through the identity rows (SQLite or MongoDB, docs/MONGODB.md), like the other profile reads.
  const u = ctx.identity.get<ProfileRow>("users", { id: userId });
  if (!u) return;
  const shown = shownActivity(ctx, u);
  const viewers = candidates(ctx, userId).filter((v) => canSeeLastSeen(ctx, v, u));
  ctx.hub.sendToUsers(viewers, { t: "activity", userId, activity: shown });
  ctx.hub.sendToUser(userId, { t: "activity", userId, activity: ctx.activity.current(userId) });
}
