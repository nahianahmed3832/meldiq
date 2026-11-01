import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { ChannelOptionsView } from "./conversations.js";
import { AutoAssignMode, EveryoneDefaults, Permission, RoleExtras } from "./roles.js";
import { route } from "./route.js";

export { ChannelOptionsView, EveryoneDefaults, RoleExtras };

/**
 * Community parity A1 (feature "community-permissions", docs/COMMUNITY_PERMISSIONS.md): what plain members may do by
 * default ("@everyone"), per-community nicknames, a role's second colour, mentions and automatic assignment, the order
 * of roles, channel options (text only, no GIFs, stage, read-only) and who speaks on a stage.
 */

export const NICKNAME_MAX = 32;

const zId = z.string().min(1).max(64);
const zHex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a colour like #E39B7B");
const known = new Set<string>(Permission.options);
const zPermissionList = z
  .array(z.string().refine((k) => known.has(k), { message: "Unknown permission" }))
  .max(64)
  .transform((l) => [...new Set(l)]);

export const OrgParams = z.object({ orgId: zId });
export const OrgMemberParams = z.object({ orgId: zId, userId: zId });
export const RoleParams = z.object({ roleId: zId });
export const ChannelMemberParams = z.object({ id: zId, userId: zId });

export const CommunityProfile = z.strictObject({
  aboutMe: z.string().max(300).nullable(),
  pronouns: z.string().max(40).nullable(),
  theme: z.array(zHex).min(1).max(2).nullable(),
});
export const CommunityProfileBody = z.strictObject({
  baseRev: z.number().int().min(0),
  profile: CommunityProfile,
});
export const CommunityProfileView = z.strictObject({
  orgId: z.string(),
  userId: z.string(),
  rev: z.number().int(),
  profile: CommunityProfile.partial(),
  own: z.boolean(),
});

// ───────────── @everyone ─────────────

export const EveryoneBody = z.object({ permissions: zPermissionList });
export const EveryoneOnly = z.strictObject({ everyone: EveryoneDefaults });

// ───────────── Nicknames ─────────────

/** An empty or blank nickname clears it (the display name shows again). */
export const NicknameBody = z.object({
  nickname: z.string().max(200).nullable(),
});
export const NicknameResult = z.strictObject({
  userId: z.string(),
  nickname: z.string().nullable(),
});

// ───────────── Role extras and order ─────────────

export const RoleExtrasBody = z.object({
  color2: zHex.nullable().optional(),
  mentionable: z.boolean().optional(),
  autoAssign: z
    .object({ mode: AutoAssignMode, before: zTime.nullable().optional() })
    .refine((a) => (a.mode === "joined_before") === (a.before != null), {
      message: 'A date goes with "joined before", and only with it',
    })
    .optional(),
});
export const RoleExtrasResult = z.strictObject({
  roleId: z.string(),
  extras: RoleExtras,
  memberCount: zCount,
});

export const RoleOrderBody = z.object({
  roleIds: z.array(zId).min(1).max(100),
});
export const RoleOrderResult = z.strictObject({
  order: z.array(z.strictObject({ id: z.string(), position: z.number().int() })),
});

// ───────────── Stages ─────────────

export const StageResult = z.strictObject({
  conversationId: z.string(),
  speakerIds: z.array(z.string()),
});

// ───────────── Routes ─────────────

const tag = "community-permissions";
const r = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag, auth: true, ...c });

export const communityPermissionsRoutes = [
  r({
    method: "GET",
    url: "/v1/orgs/:orgId/members/:userId/profile",
    summary: "Community profile overrides, projected through global privacy and current membership.",
    params: OrgMemberParams,
    response: CommunityProfileView,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  r({
    method: "PUT",
    url: "/v1/orgs/:orgId/members/:userId/profile",
    summary: "Replace your own community profile overrides using its revision. Null fields inherit the global profile.",
    params: OrgMemberParams,
    body: CommunityProfileBody,
    response: CommunityProfileView,
    errors: ["not_found", "forbidden", "conflict", "feature_disabled"],
  }),
  r({
    method: "PUT",
    url: "/v1/orgs/:orgId/roles/everyone",
    summary: "Change what plain members may do by default (everyday permissions you hold yourself; needs roles.manage).",
    params: OrgParams,
    body: EveryoneBody,
    response: EveryoneOnly,
    errors: ["not_found", "forbidden", "beyond_your_powers", "not_member_safe", "feature_disabled"],
  }),
  r({
    method: "PUT",
    url: "/v1/orgs/:orgId/members/:userId/nickname",
    summary: "Set or clear a nickname in this community (your own with members.nickname, others' with members.nicknames).",
    params: OrgMemberParams,
    body: NicknameBody,
    response: NicknameResult,
    errors: ["not_found", "bad_request", "nickname_not_allowed", "nicknames_not_allowed", "feature_disabled"],
  }),
  r({
    method: "PUT",
    url: "/v1/roles/:roleId/extras",
    summary: "Set a role's second colour, whether anyone may mention it, and who gets it automatically.",
    params: RoleParams,
    body: RoleExtrasBody,
    response: RoleExtrasResult,
    errors: ["not_found", "forbidden", "beyond_your_powers", "delegation_required", "auto_role_has_powers", "archived", "feature_disabled"],
  }),
  r({
    method: "PUT",
    url: "/v1/orgs/:orgId/roles/order",
    summary: "Reorder roles (highest first); only roles below your own highest move unless you're an owner or admin.",
    params: OrgParams,
    body: RoleOrderBody,
    response: RoleOrderResult,
    errors: ["not_found", "forbidden", "bad_request", "beyond_your_powers", "feature_disabled"],
  }),
  r({
    method: "PUT",
    url: "/v1/conversations/:id/stage/speakers/:userId",
    summary: "Let someone speak on a stage (its moderators).",
    params: ChannelMemberParams,
    response: StageResult,
    errors: ["not_found", "forbidden", "bad_request", "feature_disabled"],
  }),
  r({
    method: "DELETE",
    url: "/v1/conversations/:id/stage/speakers/:userId",
    summary: "Send a speaker back to the audience (its moderators, or the speaker themself).",
    params: ChannelMemberParams,
    response: StageResult,
    errors: ["not_found", "forbidden", "bad_request", "feature_disabled"],
  }),
];
