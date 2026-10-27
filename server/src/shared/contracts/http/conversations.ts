import { z } from "zod/v4";
import { idParams, zCount, zTime } from "./primitives.js";
import { route } from "./route.js";
import { listMediaFields, UserSummary } from "./users.js";

/**
 * Conversations: direct messages, groups and community channels (docs/COMMUNITY_REBUILD_2026-10-21.md,
 * docs/WORKSPACE_ADMINISTRATION.md). Messages themselves are end-to-end encrypted and go through /v1/messages; these
 * routes manage who is in a conversation and what it is.
 */

/** The most people in a group, its creator included. */
export const MAX_GROUP = 50;
/** The slowmode intervals a channel can have, in seconds (0: off), as Discord-style apps offer them. */
export const SLOWMODE_STEPS = [0, 5, 10, 30, 60, 300, 900, 3600, 21600] as const;
/** Up to this many tags per forum (the reference forum allows the same). */
export const FORUM_TAG_LIMIT = 20;
/** Batch B8: the longest a forum's post guidelines may be. */
export const FORUM_GUIDELINES_MAX = 2000;

const zConvId = z.string().max(64);

/** What lists and search show of a person (defined with the users routes). */
export { UserSummary };

export const PresenceShown = z.enum(["online", "idle", "dnd", "offline"]);

/** A conversation member as the viewer may see them: the summary, then what their privacy settings show this viewer. */
export const ConversationMember = UserSummary.extend({
  role: z.enum(["ADMIN", "MEMBER"]),
  /** null: the viewer may not see when this person is online. */
  online: z.boolean().nullable(),
  /** Absent when the viewer may not see it; invisible people appear offline. */
  presence: PresenceShown.optional(),
  notificationsPaused: z.boolean().nullable(),
  ...listMediaFields,
});

export const ConversationMemberDetail = ConversationMember.extend({
  joinedAt: zTime,
  /** Their role in the conversation's community; null outside communities. */
  orgRole: z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"]).nullable(),
});

export const ForumTag = z.strictObject({ id: z.string(), name: z.string() });

/** A call that hasn't ended in the conversation. */
export const ActiveCall = z.strictObject({
  id: z.string(),
  video: z.boolean(),
  state: z.enum(["RINGING", "ACTIVE"]),
  startedAt: zTime,
  /** Voice rooms: who is in the room now (at most 12). */
  participantIds: z.array(z.string()).optional(),
});

/** For a conversation with people on other servers: each server's domain, directory state and queued deliveries. */
export const ConversationFederation = z.strictObject({
  servers: z.array(z.strictObject({ serverId: z.string(), domain: z.string().nullable(), state: z.string(), pending: zCount })),
  /** Whether this server can start a call here (calls are hosted by the caller's server). */
  calls: z.boolean(),
});

/** A conversation as one person sees it. */
export const ConversationView = z.strictObject({
  id: z.string(),
  type: z.enum(["DM", "GROUP", "CHANNEL"]),
  orgId: z.string().nullable(),
  /** Channels for older apps: a channel in a category is shown as a team named after the category. Null outside channels. */
  scope: z.enum(["TEAM", "ORG"]).nullable(),
  scopeId: z.string().nullable(),
  scopeName: z.string().nullable(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  position: z.number().int(),
  format: z.enum(["text", "forum"]),
  forumTags: z.array(ForumTag),
  /** A forum's post guidelines, or null. */
  guidelines: z.string().nullable(),
  kind: z.enum(["PUBLIC", "PRIVATE", "ANNOUNCEMENT"]).nullable(),
  name: z.string().nullable(),
  topic: z.string().nullable(),
  archived: z.boolean(),
  /** A group's photo revision (GET /v1/conversations/:id/photo); null without one and outside groups. */
  photoRev: zTime.nullable(),
  createdAt: zTime,
  updatedAt: zTime,
  memberCount: zCount,
  /** The first 12 members; absent for channels with more than 12. */
  members: z.array(ConversationMember).optional(),
  joined: z.boolean(),
  myRole: z.enum(["ADMIN", "MEMBER"]).nullable(),
  canPost: z.boolean(),
  /** While this person is timed out in the community: when it ends. */
  timedOutUntil: zTime.optional(),
  canAttach: z.boolean(),
  canManage: z.boolean(),
  /** Whether this person may switch the channel between public, private and announcement. */
  canManageAccess: z.boolean(),
  /** Whether the app should offer @everyone here (the hourly limit is checked when sending). */
  canMentionAll: z.boolean(),
  activeCall: ActiveCall.nullable(),
  voice: z.boolean(),
  /** Channels only: seconds between one person's messages (0: off), whether it applies to this person, and when they may post next (null: now). */
  slowmodeSec: zCount.optional(),
  slowmodeExempt: z.boolean().optional(),
  nextPostAt: zTime.nullable().optional(),
  /** Voice channels only: whether this person may join the call, and talk in it. */
  canConnect: z.boolean().optional(),
  canSpeak: z.boolean().optional(),
  federation: ConversationFederation.nullable(),
});

/**
 * A message request on a DM (batch B6): the recipient sees `incoming: true`; the sender always sees "pending" until
 * it's accepted (a decline isn't revealed), with how many messages they sent so far out of `limit`.
 */
export const MessageRequest = z.strictObject({
  state: z.literal("pending"),
  incoming: z.boolean(),
  /** The sender's view only. */
  sent: zCount.optional(),
  limit: zCount,
});

export const ConversationWithRequest = ConversationView.extend({ request: MessageRequest.nullable() });
export const ConversationOnly = z.strictObject({ conversation: ConversationView });
export const ConversationWithRequestOnly = z.strictObject({ conversation: ConversationWithRequest });

/** A device's public keys (griip-envelope-v1): what a sender encrypts to. */
export const DirectoryDevice = z.strictObject({ id: z.string(), signingKey: z.string(), encryptionKey: z.string(), certificate: z.string() });
export const DeviceDirectoryEntry = z.strictObject({
  userId: z.string(),
  identityKey: z.string(),
  devices: z.array(DirectoryDevice),
  /** Devices revoked within the queue lifetime: never encrypted to, but their earlier envelopes still verify. */
  revokedDevices: z.array(DirectoryDevice.extend({ revokedAt: zTime })),
  /**
   * An AI agent reading this conversation (docs/AI_WORKFORCE_2_PLAN.md phase 5): listed only for apps that send
   * `x-meldiq-ai-reader: 1`, with only its device here. A sender wraps to it only if their person chose to share.
   */
  agent: z.strictObject({ installId: z.string(), readerId: z.string(), name: z.string() }).optional(),
});

export const Ok = z.strictObject({ ok: z.literal(true) });

export const ConversationListQuery = z.object({ requests: z.enum(["0", "1"]).optional() });
export const MemberParams = z.strictObject({ id: zConvId, userId: z.string().max(64) });
export const DmBody = z.object({ userId: z.string().max(64) });
export const GroupBody = z.object({ name: z.string().trim().min(1).max(60), memberIds: z.array(z.string().max(64)).min(1).max(MAX_GROUP - 1) });
export const ConversationPatchBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  topic: z.string().trim().max(500).nullable().optional(),
  archived: z.boolean().optional(),
  kind: z.enum(["PUBLIC", "PRIVATE", "ANNOUNCEMENT"]).optional(),
  format: z.enum(["text", "forum"]).optional(),
  forumTags: z
    .array(z.object({ id: z.string().max(64).optional(), name: z.string().max(20) }))
    .max(FORUM_TAG_LIMIT)
    .optional(),
  /** Batch B8: a forum's post guidelines (null removes them). */
  guidelines: z.string().trim().max(FORUM_GUIDELINES_MAX).nullable().optional(),
  /** Batch B3: seconds between one person's messages; only the intervals the apps offer. */
  slowmodeSec: z
    .number()
    .int()
    .refine((n) => (SLOWMODE_STEPS as readonly number[]).includes(n), { message: "Pick one of the offered intervals" })
    .optional(),
});
export const ConversationDeleteBody = z.object({ confirmName: z.string().max(200) });
export const MemberPutBody = z.object({ role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER") });

const conv = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "conversations", auth: true, ...c });

export const conversationRoutes = [
  conv({
    method: "GET",
    url: "/v1/conversations",
    summary: "This person's conversations, most recently active first (?requests=1: only message requests waiting for them).",
    query: ConversationListQuery,
    response: z.strictObject({ conversations: z.array(ConversationWithRequest) }),
  }),
  conv({
    method: "GET",
    url: "/v1/conversations/:id/presence",
    summary: "How many members are online now (counting only people whose online state the viewer may see).",
    params: idParams,
    response: z.strictObject({ online: zCount, members: zCount }),
    errors: ["not_found"],
  }),
  conv({
    method: "GET",
    url: "/v1/conversations/:id",
    summary: "One conversation (a channel the person can see, or one they're in).",
    params: idParams,
    response: ConversationWithRequestOnly,
    errors: ["not_found"],
  }),
  conv({
    method: "GET",
    url: "/v1/conversations/:id/members",
    summary: "Every member, by role and name.",
    params: idParams,
    response: z.strictObject({ members: z.array(ConversationMemberDetail) }),
    errors: ["not_found"],
  }),
  conv({
    method: "GET",
    url: "/v1/conversations/:id/devices",
    summary: "Public keys of every active device of every member: what a sender must encrypt to.",
    params: idParams,
    response: z.strictObject({ users: z.array(DeviceDirectoryEntry) }),
    errors: ["not_found"],
  }),
  conv({
    method: "POST",
    url: "/v1/conversations/dm",
    summary: "Open the direct conversation with someone (created on first use, possibly as a message request).",
    body: DmBody,
    response: ConversationWithRequestOnly,
    errors: ["not_available", "dm_not_allowed", "request_rate_limited", "dms_paused", "federation_disabled"],
  }),
  conv({
    method: "PUT",
    url: "/v1/conversations/:id/photo",
    summary: "Set a group's photo (a JPEG of up to 512 KB; not end-to-end encrypted). Group admins only.",
    params: idParams,
    binary: "request",
    response: z.strictObject({ photoRev: zTime }),
    errors: ["not_found", "forbidden", "too_large", "storage_unavailable"],
  }),
  conv({
    method: "DELETE",
    url: "/v1/conversations/:id/photo",
    summary: "Remove a group's photo. Group admins only.",
    params: idParams,
    response: z.strictObject({ photoRev: z.null() }),
    errors: ["not_found", "forbidden"],
  }),
  conv({
    method: "GET",
    url: "/v1/conversations/:id/photo",
    summary: "A group's photo (image/jpeg), for its members.",
    params: idParams,
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  conv({
    method: "POST",
    url: "/v1/conversations/group",
    summary: "Create a group with people on this server; the creator is its admin.",
    body: GroupBody,
    response: ConversationOnly,
  }),
  conv({
    method: "PATCH",
    url: "/v1/conversations/:id",
    summary: "Change a conversation: name, topic, archived, access mode, forum format, tags and guidelines, slowmode.",
    params: idParams,
    body: ConversationPatchBody,
    response: ConversationOnly,
    errors: ["not_found", "forbidden", "conflict"],
  }),
  conv({
    method: "DELETE",
    url: "/v1/conversations/:id",
    summary: "Delete a community channel with its messages, files and calls, after typing its name.",
    params: idParams,
    body: ConversationDeleteBody,
    response: z.strictObject({ deleted: z.literal(true), id: z.string(), members: zCount, files: zCount }),
    errors: ["not_found", "forbidden", "confirm_mismatch"],
  }),
  conv({
    method: "POST",
    url: "/v1/conversations/:id/join",
    summary: "Join a public or announcement channel the person can see.",
    params: idParams,
    response: ConversationOnly,
    errors: ["not_found", "forbidden", "conflict"],
  }),
  conv({
    method: "PUT",
    url: "/v1/conversations/:id/members/:userId",
    summary: "Add someone to a group or channel, or change their role there. Managers only.",
    params: MemberParams,
    body: MemberPutBody,
    response: Ok,
    errors: ["not_found", "forbidden", "conflict"],
  }),
  conv({
    method: "DELETE",
    url: "/v1/conversations/:id/members/:userId",
    summary: "Leave a group, or take someone out of a group or channel (managers). Community channels can't be left.",
    params: MemberParams,
    response: Ok,
    errors: ["not_found", "forbidden", "leave_community"],
  }),
];
