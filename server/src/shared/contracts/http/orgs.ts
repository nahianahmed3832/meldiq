import { z } from "zod/v4";
import { PresenceState } from "../realtime.js";
import { zCount, zTime } from "./primitives.js";
import { ConversationView } from "./conversations.js";
import { route } from "./route.js";
import { listMediaFields } from "./users.js";

/**
 * Communities (the code calls them orgs; docs/COMMUNITY_REBUILD_2026-10-21.md): the community itself, its members,
 * invitations, channels and activity. Roles, ownership, usage and the audit log are in roles.ts.
 */

// ───────────── Shared pieces ─────────────

export const OrgRole = z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"]);
const zName = z.string().trim().min(1).max(80);
const zText = z.string().trim().max(500);
const zOptText = zText.nullable().optional();

/**
 * A community's accent colour (docs/COMMUNITY_BRANDING.md): "#rrggbb", stored in lower case; null puts Meldiq's theme
 * back. Apps derive readable text and tints from it, so any colour is safe to pick.
 */
export const zAccent = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #3a5bd9");
const zRules = z.string().trim().max(4000).nullable().optional();
/** A community's tag (API 0.46.0): 2 to 4 letters or digits, stored in capitals; members may wear it by their names. */
export const zCommunityTag = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/, "Use 2 to 4 letters or digits");
/** Accepted from older apps and ignored: every workspace is a community since the rebuild. */
const zOrgKind = z.enum(["team", "community"]);
/** Listed in discovery or not, and how people get in (docs/COMMUNITY_REBUILD_2026-10-21.md §5). */
export const Visibility = z.enum(["private", "public"]);
export const JoinPolicy = z.enum(["invite", "open"]);
/** The starter channel sets a new community can begin with (batch B2). */
export const COMMUNITY_TEMPLATE_IDS = ["starter", "friends", "gaming", "study", "club"] as const;
/** Branches, departments and teams became roles and categories: always empty, kept for apps that read them. */
const zRetired = z.array(z.never()).max(0);

export const OrgParams = z.object({ orgId: z.string().max(64) });
export const OrgMemberParams = z.object({ orgId: z.string().max(64), userId: z.string().max(64) });
export const InviteIdParams = z.object({ id: z.string().max(64) });
export const InviteCodeParams = z.object({ code: z.string().min(8).max(40) });
export const InviteCodeBody = z.object({ code: z.string().min(8).max(40) });

const Ok = z.strictObject({ ok: z.literal(true) });

// ───────────── Views ─────────────

/** A community guide item: a "Get started" task or a resource, each opening a channel. */
const GuideItem = z.strictObject({ id: z.string(), title: z.string(), channelId: z.string() });

/** A community as one of its members sees it (orgSummary). */
export const CommunityView = z.strictObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  /** The caller's base role (null only if they're no longer a member, e.g. a create retried after leaving). */
  myRole: OrgRole.nullable(),
  memberCount: zCount,
  createdAt: zTime,
  /** The community photo's revision (GET /v1/orgs/:orgId/photo), null without one. */
  photoRev: zTime.nullable(),
  /** Its accent colour ("#rrggbb"), null for Meldiq's standard theme (API 0.44.0). */
  accent: z.string().nullable(),
  /** Its banner's revision (GET /v1/orgs/:orgId/banner), null without one (API 0.44.0). */
  bannerRev: zTime.nullable(),
  /** Its tag, which members may wear by their names (API 0.46.0); null without one. */
  tag: z.string().nullable(),
  guestsAllowed: z.boolean(),
  guestMaxDays: zCount.nullable(),
  /** Always "community" since the rebuild. */
  kind: z.literal("community"),
  visibility: Visibility,
  joinPolicy: JoinPolicy,
  rules: z.string().nullable(),
  /** Security actions running (batch B4), null otherwise. */
  invitesPausedUntil: zTime.nullable(),
  dmsPausedUntil: zTime.nullable(),
  /** The join application's questions, or null when the community doesn't take applications. */
  joinQuestions: z.array(z.string()).nullable(),
  /** The community guide (members only), null without one. */
  guide: z.strictObject({ welcome: z.string().nullable(), tasks: z.array(GuideItem), resources: z.array(GuideItem) }).nullable(),
  onboarding: z.boolean(),
  activityAlerts: z.boolean(),
  /** A join spike shown to moderators for a day, null otherwise. */
  activityAlert: z.strictObject({ kind: z.literal("joins"), count: zCount, at: zTime }).nullable(),
});
export const CommunityOnly = z.strictObject({ org: CommunityView });

/** A custom role's name and colour, as shown next to someone. */
export const RoleBadge = z.strictObject({ id: z.string(), name: z.string(), color: z.string().nullable() });

/** The person fields every member list shares (userSummary + memberView): what the person shows to the viewer. */
const personFields = {
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarColor: z.number().int(),
  statusText: z.string().nullable(),
  statusEmoji: z.string().nullable(),
  /** Absent when there's no photo or the viewer may not see it. */
  photoRev: zTime.optional(),
  /** Set for people on another server: their home server's id. */
  homeServer: z.string().nullable(),
  /** null: the viewer may not see when this person is online. */
  online: z.boolean().nullable(),
  presence: PresenceState.optional(),
  notificationsPaused: z.boolean().nullable(),
  ...listMediaFields,
};

/** One person in the community's member list. */
export const CommunityMember = z.strictObject({
  ...personFields,
  orgRole: OrgRole,
  title: z.string().nullable(),
  /** A guest's membership end date, null without one. */
  expiresAt: zTime.nullable(),
  /** A timeout still running, null without one. */
  timeoutUntil: zTime.nullable(),
  branches: zRetired,
  teams: zRetired,
  /** Hoisted roles (batch B12) carry hoist and their position. */
  customRoles: z.array(RoleBadge.extend({ hoist: z.literal(true).optional(), position: z.number().int().optional() })),
});

/** One of the first members of a conversation, as conversation views list them. */
const ConversationMember = z.strictObject({ ...personFields, role: z.enum(["ADMIN", "MEMBER"]) });

/** A channel as the caller sees it: the conversation view (GET /v1/conversations/:id). */
export const ChannelView = ConversationView;

/** A category in the community view (categoryViews). */
export const CategorySummary = z.strictObject({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  /** Channels in it the caller can see. */
  channelCount: zCount,
  canManage: z.boolean(),
  canCreateChannels: z.boolean(),
});

/** An invitation as listed for managing it (the code itself is shown only once, when created). */
export const InviteListItem = z.strictObject({
  id: z.string(),
  /** The code's last 4 characters. */
  hint: z.string(),
  role: z.enum(["ADMIN", "MEMBER", "GUEST"]),
  branchId: z.null(),
  teamId: z.null(),
  /** The custom role it gives on joining, if any. */
  roleId: z.string().nullable(),
  maxUses: zCount,
  uses: zCount,
  createdAt: zTime,
  expiresAt: zTime,
  revokedAt: zTime.nullable(),
  active: z.boolean(),
  /** One state: revoked beats expired beats used up. */
  status: z.enum(["active", "revoked", "expired", "used_up"]),
  createdBy: z.string(),
  createdByName: z.string().nullable(),
});

export const CreatedInvite = z.strictObject({
  id: z.string(),
  /** The code, shown this once (XXXX-XXXX-XXXX). */
  code: z.string(),
  role: z.enum(["ADMIN", "MEMBER", "GUEST"]),
  branchId: z.null(),
  teamId: z.null(),
  roleId: z.string().nullable(),
  maxUses: zCount,
  uses: z.literal(0),
  expiresAt: zTime,
  guestDays: zCount.nullable(),
});

const ActivityEntry = z.strictObject({
  id: z.number().int().positive(),
  at: zTime,
  action: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  target: z.string().nullable(),
  detail: z.string().nullable(),
});

const CommunityTemplate = z.strictObject({
  id: z.enum(COMMUNITY_TEMPLATE_IDS),
  categories: z.array(
    z.strictObject({
      name: z.string(),
      channels: z.array(z.strictObject({ name: z.string(), voice: z.boolean(), format: z.enum(["text", "forum"]), kind: z.enum(["PUBLIC", "ANNOUNCEMENT"]) })),
    }),
  ),
});

/** What the caller may do in the community (GET /v1/orgs/:orgId). The always-false ones are for older apps. */
const CommunityPermissions = z.strictObject({
  canManageOrg: z.boolean(),
  canInvite: z.boolean(),
  canCreateChannels: z.boolean(),
  canManageChannels: z.boolean(),
  canBan: z.boolean(),
  canViewDirectory: z.boolean(),
  isOwner: z.boolean(),
  canLeave: z.boolean(),
  canRestore: z.literal(false),
  canViewRoles: z.boolean(),
  canManageRoles: z.boolean(),
  canAssignRoles: z.boolean(),
  canViewAudit: z.boolean(),
  canViewUsage: z.boolean(),
  canViewApps: z.literal(false),
  canManageWorkflows: z.literal(false),
  canManageGroups: z.literal(false),
  canManageDevelopers: z.literal(false),
  canManageApps: z.literal(false),
  canManagePolicies: z.literal(false),
  canTransferOwnership: z.boolean(),
  /** The caller's effective permission keys, sorted. */
  effective: z.array(z.string()),
});

export const CommunityDetail = z.strictObject({
  org: CommunityView,
  branches: zRetired,
  departments: zRetired,
  teams: zRetired,
  categories: z.array(CategorySummary),
  stats: z.strictObject({ members: zCount, teams: z.literal(0), channels: zCount, branches: z.literal(0), categories: zCount }),
  permissions: CommunityPermissions,
  /** The custom roles the caller holds here. */
  myRoles: z.array(RoleBadge),
});

// ───────────── Inputs ─────────────

export const OrgCreateBody = z.object({
  name: zName,
  description: zOptText,
  /** One per create form: a retry with the same id answers the first result. */
  requestId: z.string().trim().min(8).max(64).optional(),
  kind: zOrgKind.optional(),
  visibility: Visibility.optional(),
  joinPolicy: JoinPolicy.optional(),
  rules: zRules,
  /** The starter channels (batch B2); "starter" when left out. */
  template: z.enum(COMMUNITY_TEMPLATE_IDS).optional(),
});

export const OrgUpdateBody = z.object({
  name: zName.optional(),
  description: zOptText,
  kind: zOrgKind.optional(),
  visibility: Visibility.optional(),
  joinPolicy: JoinPolicy.optional(),
  rules: zRules,
  /** The accent colour, or null for Meldiq's theme (API 0.44.0). */
  accent: zAccent.nullable().optional(),
  /** The community's tag, or null for none (API 0.46.0). */
  tag: zCommunityTag.nullable().optional(),
});

export const OrgDeleteBody = z.object({ confirmName: z.string().max(200), requestId: z.string().min(8).max(64).optional() });

export const MemberSearchQuery = z.object({ q: z.string().trim().max(40).optional() });

export const MemberUpdateBody = z.object({ role: OrgRole.optional(), title: zOptText });

/** Adding existing accounts directly (community-first brief §F): up to twenty at a time. */
export const MembersAddBody = z.object({ userIds: z.array(z.string().min(1).max(64)).min(1).max(20) });
export const MembersAddResult = z.strictObject({ userId: z.string(), outcome: z.enum(["added", "already_member", "not_available"]) });

export const InviteCreateBody = z.object({
  role: z.enum(["ADMIN", "MEMBER", "GUEST"]).default("MEMBER"),
  /** Branches and teams became roles: older apps send null here, anything else is refused. */
  branchId: z.string().max(64).nullable().optional(),
  teamId: z.string().max(64).nullable().optional(),
  /** A custom role the invitation gives on joining (the inviter must be able to assign it). */
  roleId: z.string().max(64).nullable().optional(),
  maxUses: z.number().int().min(1).max(500).default(1),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),
  /** How long a guest's membership lasts once they join. */
  guestDays: z.number().int().min(1).max(365).nullish(),
});

export const ChannelCreateBody = z.object({
  name: z.string().trim().min(1).max(60),
  topic: zOptText,
  /** Older apps always send a scope; only the whole community remains. */
  scope: z.enum(["ORG", "BRANCH", "TEAM"]).default("ORG"),
  scopeId: z.string().max(64).nullable().optional(),
  kind: z.enum(["PUBLIC", "PRIVATE", "ANNOUNCEMENT"]).default("PUBLIC"),
  autoJoin: z.boolean().optional(),
  memberIds: z.array(z.string().max(64)).max(200).default([]),
  /** A voice channel (docs/VOICE_ROOMS.md): its call anyone in it can join, without ringing. */
  voice: z.boolean().default(false),
  /** The category it goes into (null: none), and text or forum. */
  categoryId: z.string().max(64).nullable().optional(),
  format: z.enum(["text", "forum"]).default("text"),
});

export const ChannelListQuery = z.object({ q: z.string().trim().max(40).optional(), includeArchived: z.enum(["true", "false"]).optional() });

// ───────────── Routes ─────────────

const INVITE_PROBLEM_CODES = ["invite_not_found", "invite_revoked", "invite_expired", "invite_used_up", "invite_unavailable"] as const;

const community = (c: Omit<Parameters<typeof route>[0], "tag" | "auth"> & { auth?: boolean }) => route({ tag: "communities", auth: true, ...c });

export const orgRoutes = [
  community({
    method: "POST",
    url: "/v1/orgs",
    summary: "Create a community with its starter channels. Idempotent on requestId.",
    body: OrgCreateBody,
    response: CommunityOnly,
    errors: ["org_name_taken"],
  }),
  community({
    method: "GET",
    url: "/v1/community-templates",
    summary: "The starter templates a new community can begin with.",
    response: z.strictObject({ templates: z.array(CommunityTemplate) }),
  }),
  community({ method: "GET", url: "/v1/orgs", summary: "The communities the caller belongs to, by name.", response: z.strictObject({ orgs: z.array(CommunityView) }) }),
  community({
    method: "GET",
    url: "/v1/orgs/:orgId",
    summary: "A community with its categories, figures and what the caller may do there.",
    params: OrgParams,
    response: CommunityDetail,
    errors: ["not_found"],
  }),
  community({
    method: "PATCH",
    url: "/v1/orgs/:orgId",
    summary: "Change a community's name, description, rules, visibility or join policy (the last two: owners only).",
    params: OrgParams,
    body: OrgUpdateBody,
    response: CommunityOnly,
    errors: ["not_found", "forbidden"],
  }),
  community({
    method: "PUT",
    url: "/v1/orgs/:orgId/photo",
    summary: "Set the community photo (a JPEG of at most 512 KB).",
    params: OrgParams,
    binary: "request",
    response: z.strictObject({ photoRev: zTime }),
    errors: ["not_found", "forbidden", "too_large", "storage_unavailable"],
  }),
  community({
    method: "DELETE",
    url: "/v1/orgs/:orgId/photo",
    summary: "Remove the community photo.",
    params: OrgParams,
    response: z.strictObject({ photoRev: z.null() }),
    errors: ["not_found", "forbidden"],
  }),
  community({
    method: "GET",
    url: "/v1/orgs/:orgId/photo",
    summary: "The community photo (JPEG).",
    params: OrgParams,
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  community({
    method: "PUT",
    url: "/v1/orgs/:orgId/banner",
    summary: "Set the community banner (a JPEG of at most 1 MB; the apps send about 1200 × 480).",
    params: OrgParams,
    binary: "request",
    response: z.strictObject({ bannerRev: zTime }),
    errors: ["not_found", "forbidden", "too_large", "storage_unavailable"],
  }),
  community({
    method: "DELETE",
    url: "/v1/orgs/:orgId/banner",
    summary: "Remove the community banner.",
    params: OrgParams,
    response: z.strictObject({ bannerRev: z.null() }),
    errors: ["not_found", "forbidden"],
  }),
  community({
    method: "GET",
    url: "/v1/orgs/:orgId/banner",
    summary: "The community banner (JPEG): for its members, and for anyone signed in when the community is public.",
    params: OrgParams,
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  community({
    method: "DELETE",
    url: "/v1/orgs/:orgId",
    summary: "Delete a community for good (owners, after typing its name). A retry with the same requestId gets the same answer.",
    params: OrgParams,
    body: OrgDeleteBody,
    response: z.strictObject({ deleted: z.literal(true), orgId: z.string(), members: zCount, channels: zCount, files: zCount }),
    errors: ["not_found", "forbidden", "confirm_mismatch"],
  }),
  community({
    method: "GET",
    url: "/v1/orgs/:orgId/archived",
    summary: "Archived branches and teams: always empty since they became roles (for older apps).",
    params: OrgParams,
    response: z.strictObject({ branches: zRetired, teams: zRetired }),
    errors: ["not_found"],
  }),
  community({
    method: "GET",
    url: "/v1/orgs/:orgId/members",
    summary: "The member list (at most 500), searchable by name or username.",
    params: OrgParams,
    query: MemberSearchQuery,
    response: z.strictObject({ members: z.array(CommunityMember) }),
    errors: ["not_found", "forbidden"],
  }),
  community({
    method: "PATCH",
    url: "/v1/orgs/:orgId/members/:userId",
    summary: "Change a member's base role or title.",
    params: OrgMemberParams,
    body: MemberUpdateBody,
    response: Ok,
    errors: ["not_found", "forbidden", "conflict"],
  }),
  community({
    method: "DELETE",
    url: "/v1/orgs/:orgId/members/:userId",
    summary: "Remove a member, or leave (your own id).",
    params: OrgMemberParams,
    response: Ok,
    errors: ["not_found", "forbidden", "conflict"],
  }),
  community({
    method: "POST",
    url: "/v1/orgs/:orgId/members",
    summary:
      "Add existing accounts directly: people the caller knows who would accept a direct message from them. Others (and anyone blocked, banned or unknown) come back not_available; invite them instead.",
    params: OrgParams,
    body: MembersAddBody,
    response: z.strictObject({ results: z.array(MembersAddResult) }),
    errors: ["not_found", "forbidden", "invites_paused"],
  }),
  community({
    method: "POST",
    url: "/v1/orgs/:orgId/invites",
    summary: "Create an invitation code (shown once), optionally giving a custom role.",
    params: OrgParams,
    body: InviteCreateBody,
    response: z.strictObject({ invite: CreatedInvite }),
    errors: ["not_found", "forbidden", "conflict", "beyond_your_powers", "delegation_required"],
  }),
  community({
    method: "GET",
    url: "/v1/orgs/:orgId/invites",
    summary: "The latest 100 invitations: all of them for invitation managers, otherwise the caller's own.",
    params: OrgParams,
    response: z.strictObject({ invites: z.array(InviteListItem) }),
    errors: ["not_found"],
  }),
  community({
    method: "DELETE",
    url: "/v1/invites/:id",
    summary: "Revoke an invitation (its creator or an invitation manager).",
    params: InviteIdParams,
    response: Ok,
    errors: ["not_found", "forbidden"],
  }),
  community({
    method: "POST",
    url: "/v1/invites/preview",
    summary: "What an invitation code leads to, before accepting it.",
    body: InviteCodeBody,
    response: z.strictObject({
      org: z.strictObject({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        description: z.string().nullable(),
        rules: z.string().nullable(),
        memberCount: zCount,
        /** Its look (API 0.44.0): the accent, and the banner's revision (GET /v1/invites/:code/banner). */
        accent: z.string().nullable(),
        bannerRev: zTime.nullable(),
      }),
      role: z.enum(["ADMIN", "MEMBER", "GUEST"]),
      branch: z.null(),
      team: z.null(),
      /** The custom role it gives, null without one (or if it was archived). */
      grantRole: RoleBadge.nullable(),
      alreadyMember: z.boolean(),
      banned: z.boolean(),
      invitesPaused: z.boolean(),
    }),
    errors: [...INVITE_PROBLEM_CODES],
  }),
  community({
    method: "GET",
    url: "/v1/invites/:code/public",
    summary: "The invite page before signing in: the community's name, description and size only.",
    auth: false,
    params: InviteCodeParams,
    response: z.strictObject({
      community: z.strictObject({
        name: z.string(),
        description: z.string().nullable(),
        memberCount: zCount,
        /** Its accent, and whether it has a banner (GET /v1/invites/:code/banner); API 0.44.0. */
        accent: z.string().nullable(),
        banner: z.boolean(),
        /** Whether it has an icon (GET /v1/invites/:code/photo); API 0.46.0. */
        photo: z.boolean(),
      }),
      invitesPaused: z.boolean(),
    }),
    errors: [...INVITE_PROBLEM_CODES],
  }),
  community({
    method: "GET",
    url: "/v1/invites/:code/banner",
    summary: "The banner of the community an invitation leads to (JPEG), before signing in.",
    auth: false,
    params: InviteCodeParams,
    binary: "response",
    response: z.unknown(),
    errors: [...INVITE_PROBLEM_CODES],
  }),
  community({
    method: "GET",
    url: "/v1/invites/:code/photo",
    summary: "The icon of the community an invitation leads to (JPEG), before signing in.",
    auth: false,
    params: InviteCodeParams,
    binary: "response",
    response: z.unknown(),
    errors: [...INVITE_PROBLEM_CODES],
  }),
  community({
    method: "POST",
    url: "/v1/invites/accept",
    summary: "Join a community with an invitation code. A repeat after joining succeeds without using it again.",
    body: InviteCodeBody,
    response: z.strictObject({ org: CommunityView, alreadyMember: z.boolean() }),
    errors: [...INVITE_PROBLEM_CODES, "banned", "invites_paused", "limit_reached"],
  }),
  community({
    method: "POST",
    url: "/v1/orgs/:orgId/channels",
    summary: "Create a text, forum or voice channel, optionally in a category.",
    params: OrgParams,
    body: ChannelCreateBody,
    response: z.strictObject({ channel: ChannelView }),
    errors: ["not_found", "forbidden", "conflict"],
  }),
  community({
    method: "GET",
    url: "/v1/orgs/:orgId/channels",
    summary: "The channels the caller can see (joined or joinable), by name.",
    params: OrgParams,
    query: ChannelListQuery,
    response: z.strictObject({ channels: z.array(ChannelView) }),
    errors: ["not_found"],
  }),
  community({
    method: "GET",
    url: "/v1/orgs/:orgId/activity",
    summary: "Recent community activity (the latest 60 entries the caller may see).",
    params: OrgParams,
    response: z.strictObject({ activity: z.array(ActivityEntry) }),
    errors: ["not_found", "forbidden"],
  }),
];
