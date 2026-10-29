import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Discovery (community parity batch E, feature "discovery-listing", docs/COMMUNITY_PARITY_API.md › Discovery): the
 * Discover page's Promoted row and list of public communities, each community's Discovery settings (shown or not, a
 * one-line card description, topic tags), and Promote (feature "discovery-promote"): boosts and Promoted spots, sold by
 * the week. Billing is off in production, so buying answers 503 billing_unavailable; staff grant them from the console.
 */

/** A public community is listed once it has this many members, unless it's boosted or promoted. */
export const DISCOVERY_MIN_MEMBERS = 5;

export const DISCOVERY_LIMITS = { description: 300, tags: 5, tag: 24, query: 60, page: 30, promotedSpots: 4, horizonWeeks: 8, grantWeeks: 52 } as const;

/** A topic tag as typed: letters and digits, with spaces or single hyphens between them (stored lower case, single spaces). */
export const TAG_PATTERN = /^[\p{L}\p{N}]+(?:(?: +|-)[\p{L}\p{N}]+)*$/u;

export const BOOST_TIERS = ["boost", "super", "mega"] as const;
export type BoostTier = (typeof BOOST_TIERS)[number];
export const BoostTier = z.enum(BOOST_TIERS);

/** Why a community isn't in Discovery right now (null: it is). */
export const UNLISTED_REASONS = ["private", "turned_off", "too_few_members", "locked", "removed", "name_blocked"] as const;

const zTag = z.string().trim().min(1).max(DISCOVERY_LIMITS.tag).regex(TAG_PATTERN, "Tags use letters, digits, spaces and hyphens");
const OrgOnly = z.object({ orgId: z.string().min(1).max(64) });

// ───────────── Discover ─────────────

export const DiscoverListQuery = z.object({
  /** Matches the name, the card description, the community description and the tags. */
  q: z.string().trim().max(DISCOVERY_LIMITS.query).optional(),
  /** Only communities with this tag (any case). */
  tag: z.string().trim().max(DISCOVERY_LIMITS.tag).optional(),
  /** The next offset in the list (nextCursor). */
  cursor: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const DiscoverCard = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** The one-line card description, or the community's description. */
  description: z.string().nullable(),
  tags: z.array(z.string()),
  photoRev: z.number().int().nullable(),
  bannerRev: z.number().int().nullable(),
  accent: z.string().nullable(),
  memberCount: zCount,
  onlineCount: zCount,
  /** "promoted" in the Promoted row; in the list, the biggest active boost (mega shows a gold label). */
  label: z.enum(["promoted", ...BOOST_TIERS]).nullable(),
  joined: z.boolean(),
  /** Run by Meldiq itself. */
  official: z.boolean(),
  joinPolicy: z.enum(["open", "invite"]),
  /** The community takes join applications. */
  applications: z.boolean(),
});

export const DiscoverListing = z.strictObject({
  /** Up to 4 promoted communities: only on the first page with no search or tag. */
  promoted: z.array(DiscoverCard),
  /** Boosted ones first (mega, super, boost), then by members. Pages of 30. */
  communities: z.array(DiscoverCard),
  nextCursor: zCount.nullable(),
});

// ───────────── A community's Discovery settings ─────────────

export const DiscoverySettings = z.strictObject({
  /** Shown in Discovery (public communities are, unless turned off). */
  discoverable: z.boolean(),
  /** The card's one-line description; null: the community's description is used. */
  description: z.string().nullable(),
  tags: z.array(z.string()),
  /** In Discovery right now, and if not, why. */
  listed: z.boolean(),
  reason: z.enum(UNLISTED_REASONS).nullable(),
  memberCount: zCount,
  minMembers: zCount,
  communityDescription: z.string().nullable(),
  official: z.boolean(),
  updatedAt: zTime.nullable(),
});

export const DiscoverySettingsBody = z
  .strictObject({
    discoverable: z.boolean().optional(),
    description: z.string().trim().max(DISCOVERY_LIMITS.description).nullable().optional(),
    tags: z.array(zTag).max(DISCOVERY_LIMITS.tags).optional(),
  })
  .refine((b) => b.discoverable !== undefined || b.description !== undefined || b.tags !== undefined, "Send discoverable, description or tags");

// ───────────── Promote ─────────────

const BoostRecord = z.strictObject({
  id: z.string(),
  tier: BoostTier,
  state: z.enum(["pending", "active", "cancelled"]),
  source: z.enum(["grant", "purchase"]),
  startsAt: zTime,
  endsAt: zTime,
});

const PromotedBooking = z.strictObject({
  id: z.string(),
  state: z.enum(["pending", "active", "cancelled"]),
  source: z.enum(["grant", "purchase"]),
  startsAt: zTime,
  endsAt: zTime,
  /** Recorded from Discover while it ran: times shown in the Promoted row, opened, and joins after opening it there. */
  views: zCount,
  clicks: zCount,
  joins: zCount,
});

export const PromoteView = z.strictObject({
  /** Buying: off while the server has no way to take payment (reason says so in plain words). */
  billing: z.strictObject({ available: z.boolean(), reason: z.string().nullable() }),
  currency: z.string(),
  tiers: z.array(
    z.strictObject({
      tier: BoostTier,
      weeklyCents: zCount,
      /** Mega: a place in the top N whatever else is boosted (100, 50 or 20 by member count); null otherwise. */
      guaranteedTop: zCount.nullable(),
    }),
  ),
  /** The biggest boost running now (the only one that counts), or null. */
  boost: BoostRecord.nullable(),
  /** Boosts bought or granted that haven't ended (running and coming up), soonest first. */
  boosts: z.array(BoostRecord),
  /** Place in the Discovery list (1 = first), null while not listed. */
  rank: zCount.nullable(),
  listed: z.boolean(),
  reason: z.enum(UNLISTED_REASONS).nullable(),
  promoted: z.strictObject({
    weeklyCents: zCount,
    spotsPerWeek: zCount,
    /** The next week with a free spot this community hasn't booked (null: all taken for the next 8 weeks). */
    nextSpot: z.strictObject({ startsAt: zTime, endsAt: zTime, spotsLeft: zCount }).nullable(),
    allTaken: z.boolean(),
    /** This community's bookings: running, coming up, and the last few that ended. */
    bookings: z.array(PromotedBooking),
  }),
  /** Different people who opened Discover in the last 7 days. */
  visitors: z.strictObject({ weekly: zCount }),
});

export const BoostCheckoutBody = z.strictObject({ tier: BoostTier });
export const PromotedCheckoutBody = z.strictObject({ weekStart: zTime.optional() });
export const CheckoutStarted = z.strictObject({ url: z.string() });

// ───────────── Console (platform staff) ─────────────

const zReason = z.string().trim().min(3).max(500);
export const AdminDiscoveryParams = z.object({ orgId: z.string().min(1).max(64) });
export const AdminDiscoveryRecordParams = z.object({ id: z.string().min(1).max(64) });
export const AdminDiscoveryPatch = z
  .strictObject({ removed: z.boolean().optional(), official: z.boolean().optional(), reason: zReason })
  .refine((b) => b.removed !== undefined || b.official !== undefined, "Send removed or official");
export const AdminBoostGrant = z.strictObject({ tier: BoostTier, weeks: z.number().int().min(1).max(DISCOVERY_LIMITS.grantWeeks), reason: zReason });
/** weekStart: a Monday 00:00 UTC; left out, this week if a spot is free, otherwise the next free week. */
export const AdminPromotedGrant = z.strictObject({ weekStart: zTime.optional(), reason: zReason });
export const AdminCancelBody = z.strictObject({ reason: zReason });

// ───────────── Routes ─────────────

const tag = "discovery";
const off = ["feature_disabled"] as const;

export const discoveryRoutes = [
  route({
    method: "GET",
    url: "/v1/discover",
    tag,
    summary: "Discover: the Promoted row, then public communities (boosted first, then by members); q searches names, descriptions and tags.",
    auth: true,
    query: DiscoverListQuery,
    response: DiscoverListing,
    errors: [...off],
  }),
  route({
    method: "POST",
    url: "/v1/discover/:orgId/click",
    tag,
    summary: "Someone opened a community from Discover (counts for Promoted spots and joins).",
    auth: true,
    params: OrgOnly,
    response: z.strictObject({ recorded: z.boolean() }),
    errors: [...off, "not_found"],
  }),
  route({ method: "GET", url: "/v1/orgs/:orgId/discovery", tag, summary: "The community's Discovery settings and whether it's listed (Edit community).", auth: true, params: OrgOnly, response: DiscoverySettings, errors: [...off, "not_found", "forbidden"] }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/discovery",
    tag,
    summary: "Show or hide the community in Discovery, its card description and up to 5 tags (Edit community).",
    auth: true,
    params: OrgOnly,
    body: DiscoverySettingsBody,
    response: DiscoverySettings,
    errors: [...off, "not_found", "forbidden"],
  }),
  route({ method: "GET", url: "/v1/orgs/:orgId/promote", tag, summary: "Promote: boost tiers and prices, the running boost, rank, the next Promoted spot and weekly visitors.", auth: true, params: OrgOnly, response: PromoteView, errors: [...off, "not_found", "forbidden"] }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/promote/boost",
    tag,
    summary: "Buy a week of Boost, Super Boost or Mega Boost (503 billing_unavailable while billing is off).",
    auth: true,
    params: OrgOnly,
    body: BoostCheckoutBody,
    response: CheckoutStarted,
    errors: [...off, "not_found", "forbidden", "billing_unavailable"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/promote/promoted",
    tag,
    summary: "Book the next free Promoted week (409 promoted_full when all taken; 503 billing_unavailable while billing is off).",
    auth: true,
    params: OrgOnly,
    body: PromotedCheckoutBody,
    response: CheckoutStarted,
    errors: [...off, "not_found", "forbidden", "promoted_full", "billing_unavailable"],
  }),
];
