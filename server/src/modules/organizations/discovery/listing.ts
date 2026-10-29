import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { type BoostTier, DISCOVERY_MIN_MEMBERS, type DiscoverCard, type UNLISTED_REASONS } from "../../../shared/contracts/http/discovery.js";
import { compareText, foldAscii, likeContains } from "../../../shared/utilities/sqlText.js";
import { onlineCount } from "../../accounts/index.js";
import { type BoostRow, type DiscoveryRow, parseTags } from "./store.js";

/**
 * Who Discovery lists and in what order (docs/COMMUNITY_PARITY_API.md › Discovery). A community is listed when it's
 * public, shown (the default), not removed by staff, not locked, its name doesn't pass for Meldiq's own, and it has
 * DISCOVERY_MIN_MEMBERS members, or a boost or Promoted spot running. Boosted ones come first by tier, then everyone by
 * members, then by name.
 */

export type UnlistedReason = (typeof UNLISTED_REASONS)[number];

export interface OrgRow {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  join_policy: string;
  join_questions: string | null;
  photo_rev: number | null;
  banner_rev: number | null;
  accent: string | null;
}

/** A community Discovery considered, with what decides its place. */
export interface Entry {
  org: OrgRow;
  settings: DiscoveryRow | undefined;
  memberCount: number;
  /** The biggest boost running (null without one, or while Promote is off). */
  tier: BoostTier | null;
  /** A boost or a Promoted spot is running: the member minimum doesn't apply. */
  paid: boolean;
}

const TIER_RANK: Record<BoostTier, number> = { boost: 1, super: 2, mega: 3 };

/** The biggest tier among [boosts], or null. */
export function biggestTier(boosts: readonly Pick<BoostRow, "tier">[]): BoostTier | null {
  return boosts.reduce<BoostTier | null>((best, b) => (best === null || TIER_RANK[b.tier] > TIER_RANK[best] ? b.tier : best), null);
}

/** Whether [name] contains one of [blocked] as a whole word (or words), letters and digits compared ignoring case. */
export function nameBlocked(name: string, blocked: readonly string[]): boolean {
  const words = ` ${name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ")} `;
  return blocked.some((w) => words.includes(` ${w} `));
}

/** Why [e] isn't listed, or null when it is. */
export function unlistedReason(e: Entry, locked: boolean, blockedWords: readonly string[]): UnlistedReason | null {
  if (e.org.visibility !== "public") return "private";
  if (e.settings?.removed_at) return "removed";
  if (e.settings && e.settings.discoverable === 0) return "turned_off";
  if (locked) return "locked";
  if (e.settings?.official !== 1 && nameBlocked(e.org.name, blockedWords)) return "name_blocked";
  if (e.memberCount < DISCOVERY_MIN_MEMBERS && !e.paid) return "too_few_members";
  return null;
}

/** Discovery's order: tier, then members, then name and id (stable). */
export function compareEntries(a: Entry, b: Entry): number {
  const tier = (e: Entry) => (e.tier ? TIER_RANK[e.tier] : 0);
  return tier(b) - tier(a) || b.memberCount - a.memberCount || compareText(foldAscii(a.org.name), foldAscii(b.org.name)) || compareText(a.org.id, b.org.id);
}

export const tagsOf = (e: Entry): string[] => (e.settings ? parseTags(e.settings.tags) : []);
export const cardDescription = (e: Entry): string | null => e.settings?.blurb ?? e.org.description ?? null;

/** Whether [e] matches the search [term] (name, descriptions, tags) and the [tag] filter. */
export function matches(e: Entry, term: string, tag: string): boolean {
  const tags = tagsOf(e);
  if (tag && !tags.includes(tag)) return false;
  if (!term) return true;
  return likeContains(e.org.name, term) || likeContains(e.settings?.blurb, term) || likeContains(e.org.description, term) || tags.some((t) => likeContains(t, term));
}

/** One community as a Discover card for [viewerId]. */
export function card(ctx: AppContext, e: Entry, viewerId: string, label: z.infer<typeof DiscoverCard>["label"]): z.infer<typeof DiscoverCard> {
  const members = ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: e.org.id } }).map((m) => m.user_id);
  return {
    id: e.org.id,
    name: e.org.name,
    description: cardDescription(e),
    tags: tagsOf(e),
    photoRev: e.org.photo_rev ?? null,
    bannerRev: e.org.banner_rev ?? null,
    accent: e.org.accent ?? null,
    memberCount: e.memberCount,
    onlineCount: onlineCount(ctx, members),
    label,
    joined: ctx.authz.orgRole(e.org.id, viewerId) !== null,
    official: e.settings?.official === 1,
    joinPolicy: e.org.join_policy === "open" ? "open" : "invite",
    applications: !!e.org.join_questions,
  };
}
