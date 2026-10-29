import type { AppContext } from "../../app/context.js";
import { SHOWABLE_BADGES, type ShowableBadge } from "../../shared/contracts/http/users.js";
import { isBugHunter } from "./bugReports.js";

/**
 * Badges a person can show next to their name (API 0.65.0, docs/SETTINGS_PARITY_API.md). Each is derived on read from
 * what earns it, so one that lapses (a Mojo plan ending, a decoration taken down) stops showing by itself.
 */
export function holdsBadge(ctx: AppContext, userId: string, badge: ShowableBadge): boolean {
  switch (badge) {
    case "mojo":
      return !!ctx.mojo?.perksOf(userId).badge;
    case "bug-hunter":
      return isBugHunter(ctx.safety, userId);
    case "artist":
      return !!ctx.decorations?.isArtist(userId);
    case "creator":
      return !!ctx.creators?.isVerified(userId);
  }
}

/** Every badge [userId] holds now, in the order the apps list them. */
export function heldBadges(ctx: AppContext, userId: string): ShowableBadge[] {
  return SHOWABLE_BADGES.filter((b) => holdsBadge(ctx, userId, b));
}
