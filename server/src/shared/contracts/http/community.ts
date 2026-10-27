import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { CommunityView } from "./orgs.js";
import { route } from "./route.js";

/**
 * Community structure and moderation (docs/COMMUNITY_REBUILD_2026-10-21.md): categories and the channel layout,
 * permission overwrites on categories and channels, public discovery and open joining, bans, the guest policy,
 * Security actions and timeouts. Every write is checked on the server; the apps only mirror the rules to hide controls.
 */

/** Path parameters of the community routes (any length up to 64; Fastify never passes an empty segment). */
export const OrgParams = z.object({ orgId: z.string().max(64) });
export const IdParams = z.object({ id: z.string().max(64) });
export const OrgMemberParams = z.object({ orgId: z.string().max(64), userId: z.string().max(64) });
/** The same, as the newer community routes (applications, guide, onboarding, emoji, reports) check them. */
export const OrgParamsNonEmpty = z.object({ orgId: z.string().min(1).max(64) });
export const IdParamsNonEmpty = z.object({ id: z.string().min(1).max(64) });

/**
 * What a permission overwrite can change (the server's CHANNEL_CAPABILITIES, kept equal at compile time).
 * `channels.create` matters on categories; `voice.connect` and `voice.speak` on voice channels.
 */
export const CHANNEL_CAPABILITY_KEYS = [
  "channels.view",
  "messages.post",
  "messages.attach",
  "messages.announce",
  "channels.manage",
  "channels.create",
  "voice.connect",
  "voice.speak",
] as const;
export const ChannelCapabilityKey = z.enum(CHANNEL_CAPABILITY_KEYS);

/** At most this many categories in one community. */
export const CATEGORY_LIMIT = 50;
/** At most this many channels in one community (the server's CHANNEL_LIMITS.perCommunity, kept equal at compile time). */
export const CHANNELS_PER_COMMUNITY = 500;

export const OrgRoleName = z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"]);
export const JoinPolicy = z.enum(["open", "invite"]);
export const ApplicationStatus = z.enum(["pending", "approved", "denied", "withdrawn"]);
export const OkResult = z.strictObject({ ok: z.literal(true) });

// ───────────── The community guide (also part of a community's summary) ─────────────

/** At most this much in a guide. */
export const GUIDE_LIMITS = { welcome: 500, items: 5, title: 80 } as const;

export const GuideItem = z.strictObject({ id: z.string(), title: z.string(), channelId: z.string() });
/** The community guide (batch B8b): a welcome line, "Get started" tasks and resources, each opening a channel. */
export const Guide = z.strictObject({ welcome: z.string().nullable(), tasks: z.array(GuideItem), resources: z.array(GuideItem) });

// ───────────── A community as a member (or someone previewing it) sees it ─────────────

/** A recent burst of joins, shown to moderators (batch B4b). */
export const ActivityAlert = z.strictObject({ kind: z.literal("joins"), count: zCount, at: zTime });

/** A community's summary as the preview and joining answer it: the same view as GET /v1/orgs (orgSummary). */
export const CommunitySummary = CommunityView;

// ───────────── Categories and layout ─────────────

/** A category as the viewer sees it, with what they may do there. */
export const CategoryView = z.strictObject({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  /** Channels in it the viewer can see. */
  channelCount: zCount,
  canManage: z.boolean(),
  canCreateChannels: z.boolean(),
});
export const CategoryList = z.strictObject({ categories: z.array(CategoryView) });

export const CategoryNameBody = z.object({ name: z.string().trim().min(1).max(60) });
export const LayoutBody = z.object({
  categories: z.array(z.string().max(64)).max(CATEGORY_LIMIT).default([]),
  channels: z
    .array(z.object({ id: z.string().max(64), categoryId: z.string().max(64).nullable(), position: z.number().int().min(0).max(10_000) }))
    .max(CHANNELS_PER_COMMUNITY)
    .default([]),
});

// ───────────── Permission overwrites ─────────────

export const OverwriteBody = z.object({
  /** "everyone", a custom role id, or "user:<userId>". */
  subject: z.string().min(1).max(80),
  allow: z.array(ChannelCapabilityKey).max(CHANNEL_CAPABILITY_KEYS.length).default([]),
  deny: z.array(ChannelCapabilityKey).max(CHANNEL_CAPABILITY_KEYS.length).default([]),
});
export type OverwriteBody = z.infer<typeof OverwriteBody>;

export const OverwriteView = z.strictObject({
  subject: z.string(),
  kind: z.enum(["everyone", "member", "role"]),
  /** "@everyone", the member's display name ("Former member") or the role's name ("Deleted role"). */
  label: z.string(),
  color: z.string().nullable(),
  allow: z.array(ChannelCapabilityKey),
  deny: z.array(ChannelCapabilityKey),
});
export const OverwriteList = z.strictObject({
  overwrites: z.array(OverwriteView),
  /** What can be set here (a channel's list leaves out channels.create). */
  capabilities: z.array(z.strictObject({ key: ChannelCapabilityKey, label: z.string(), description: z.string() })),
  /** The community's roles that aren't archived, for picking a subject. */
  roles: z.array(z.strictObject({ id: z.string(), name: z.string(), color: z.string().nullable() })),
  canManage: z.boolean(),
});
/** After a write: the new list, and how many channel memberships the re-check removed. */
export const OverwriteWriteResult = OverwriteList.extend({ removed: zCount });

// ───────────── Discovery and joining ─────────────

export const DiscoverQuery = z.object({ q: z.string().trim().max(60).optional(), cursor: z.coerce.number().int().min(0).max(10_000).default(0) });
export const DiscoveredCommunity = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: zCount,
  photoRev: z.number().int().nullable(),
  /** Its look (API 0.44.0): the accent, and the banner's revision (GET /v1/orgs/:orgId/banner). */
  accent: z.string().nullable(),
  bannerRev: z.number().int().nullable(),
  joinPolicy: JoinPolicy,
  /** The community takes join applications. */
  applications: z.boolean(),
  joined: z.boolean(),
});
export const DiscoverPage = z.strictObject({ communities: z.array(DiscoveredCommunity), nextCursor: zCount.nullable() });

export const PreviewChannel = z.strictObject({
  id: z.string(),
  name: z.string().nullable(),
  topic: z.string().nullable(),
  kind: z.enum(["PUBLIC", "PRIVATE", "ANNOUNCEMENT"]).nullable(),
  voice: z.boolean(),
  format: z.enum(["text", "forum"]),
});
export const CommunityPreview = z.strictObject({
  community: CommunitySummary,
  /** Only the channels a member without roles can see. */
  channels: z.array(PreviewChannel),
  joined: z.boolean(),
  banned: z.boolean(),
  /** The viewer's latest application here (batch B4b), if any. */
  application: z.strictObject({ id: z.string(), status: ApplicationStatus, createdAt: zTime }).nullable(),
});
export const JoinResult = z.strictObject({ org: CommunitySummary, alreadyMember: z.boolean() });

// ───────────── Bans, guests, Security actions, timeouts ─────────────

export const BanView = z.strictObject({
  userId: z.string(),
  displayName: z.string(),
  username: z.string(),
  reason: z.string().nullable(),
  bannedAt: zTime,
  bannedBy: z.string(),
  bannedByName: z.string().nullable(),
});
export const BanBody = z.object({ userId: z.string().max(64), reason: z.string().trim().max(300).nullish() });

export const GuestPolicyBody = z.object({ guestsAllowed: z.boolean(), guestMaxDays: z.number().int().min(1).max(365).nullable() });
export const GuestPolicy = z.strictObject({ guestsAllowed: z.boolean(), guestMaxDays: z.number().int().nullable() });
export const ExpiryBody = z.object({ expiresAt: z.number().int().nullable() });

export const SecurityBody = z.strictObject({
  invitesPausedUntil: z.number().int().nullable().optional(),
  dmsPausedUntil: z.number().int().nullable().optional(),
  activityAlerts: z.boolean().optional(),
});
export const SecurityState = z.strictObject({ invitesPausedUntil: zTime.nullable(), dmsPausedUntil: zTime.nullable(), activityAlerts: z.boolean() });

export const TimeoutBody = z.object({ until: z.number().int().nullable(), reason: z.string().trim().max(300).nullish() });

const tag = "community";

export const communityStructureRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/categories",
    tag,
    summary: "The community's categories the viewer can see, in order, with what they may do in each.",
    auth: true,
    params: OrgParams,
    response: CategoryList,
    errors: ["not_found"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/categories",
    tag,
    summary: "Create a category at the end (at most 50). `category` is absent when the creator can't see an empty category.",
    auth: true,
    params: OrgParams,
    body: CategoryNameBody,
    response: z.strictObject({ category: CategoryView.optional() }),
    errors: ["not_found", "forbidden", "conflict"],
  }),
  route({
    method: "PATCH",
    url: "/v1/categories/:id",
    tag,
    summary: "Rename a category.",
    auth: true,
    params: IdParams,
    body: CategoryNameBody,
    response: z.strictObject({ category: CategoryView.nullable() }),
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "DELETE",
    url: "/v1/categories/:id",
    tag,
    summary: "Delete a category; its channels become uncategorised (refused while its permissions decide who sees them).",
    auth: true,
    params: IdParams,
    response: OkResult,
    errors: ["not_found", "forbidden", "category_has_permissions"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/layout",
    tag,
    summary: "Arrange categories and channels in one atomic write; moved channels take their new category's permissions.",
    auth: true,
    params: OrgParams,
    body: LayoutBody,
    response: z.strictObject({ ok: z.literal(true), removed: zCount, categories: z.array(CategoryView) }),
    errors: ["not_found", "forbidden", "conflict"],
  }),
  route({
    method: "GET",
    url: "/v1/categories/:id/overwrites",
    tag,
    summary: "A category's permission overwrites, what can be set and the roles to pick from.",
    auth: true,
    params: IdParams,
    response: OverwriteList,
    errors: ["not_found"],
  }),
  route({
    method: "PUT",
    url: "/v1/categories/:id/overwrites",
    tag,
    summary: "Set (or, with nothing allowed or denied, remove) one subject's overwrite on a category.",
    auth: true,
    params: IdParams,
    body: OverwriteBody,
    response: OverwriteWriteResult,
    errors: ["not_found", "forbidden", "allow_and_deny", "beyond_your_powers"],
  }),
  route({
    method: "GET",
    url: "/v1/conversations/:id/overwrites",
    tag,
    summary: "A channel's permission overwrites, what can be set and the roles to pick from.",
    auth: true,
    params: IdParams,
    response: OverwriteList,
    errors: ["not_found"],
  }),
  route({
    method: "PUT",
    url: "/v1/conversations/:id/overwrites",
    tag,
    summary: "Set (or, with nothing allowed or denied, remove) one subject's overwrite on a channel.",
    auth: true,
    params: IdParams,
    body: OverwriteBody,
    response: OverwriteWriteResult,
    errors: ["not_found", "forbidden", "allow_and_deny", "beyond_your_powers"],
  }),
];

export const communityDiscoveryRoutes = [
  route({
    method: "GET",
    url: "/v1/communities/discover",
    tag,
    summary: "Public communities, most members first; `q` matches name or description. Pages of 30; nextCursor is the next offset.",
    auth: true,
    query: DiscoverQuery,
    response: DiscoverPage,
  }),
  route({
    method: "GET",
    url: "/v1/communities/:id/preview",
    tag,
    summary: "A public community before joining (or one you're in): its profile, rules and the channels everyone can see.",
    auth: true,
    params: IdParams,
    response: CommunityPreview,
    errors: ["not_found"],
  }),
  route({
    method: "POST",
    url: "/v1/communities/:id/join",
    tag,
    summary: "Join a public community that's open to everyone.",
    auth: true,
    params: IdParams,
    response: JoinResult,
    errors: ["not_found", "forbidden", "application_required", "banned", "invites_paused", "limit_reached"],
  }),
];

export const communityModerationRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/bans",
    tag,
    summary: "The community's bans, newest first (at most 500).",
    auth: true,
    params: OrgParams,
    response: z.strictObject({ bans: z.array(BanView) }),
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/bans",
    tag,
    summary: "Ban someone (a member is removed from the community).",
    auth: true,
    params: OrgParams,
    body: BanBody,
    response: OkResult,
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "DELETE",
    url: "/v1/orgs/:orgId/bans/:userId",
    tag,
    summary: "Lift a ban.",
    auth: true,
    params: OrgMemberParams,
    response: OkResult,
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/guest-policy",
    tag,
    summary: "Whether the community takes guests, and for how many days at most (current guests' end dates come forward).",
    auth: true,
    params: OrgParams,
    body: GuestPolicyBody,
    response: GuestPolicy,
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/members/:userId/expiry",
    tag,
    summary: "A guest's end date (null: none, if the policy has no maximum).",
    auth: true,
    params: OrgMemberParams,
    body: ExpiryBody,
    response: z.strictObject({ expiresAt: z.number().int().nullable() }),
    errors: ["not_found", "forbidden", "conflict"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/security",
    tag,
    summary: "Security actions: pause joining and new direct messages between members (at most 7 days; null resumes), activity alerts.",
    auth: true,
    params: OrgParams,
    body: SecurityBody,
    response: SecurityState,
    errors: ["not_found", "forbidden"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/members/:userId/timeout",
    tag,
    summary: "Time a member out until a time at most 28 days ahead, or end the timeout (null).",
    auth: true,
    params: OrgMemberParams,
    body: TimeoutBody,
    response: z.strictObject({ userId: z.string(), timeoutUntil: zTime.nullable() }),
    errors: ["not_found", "forbidden"],
  }),
];
