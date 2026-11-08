import { z } from "zod/v4";
import { OrgParamsNonEmpty } from "./community.js";
import { CommunityLink, zAccent, zCommunityName } from "./orgs.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * A community's settings from the reference app's Server Profile, Theme and Onboarding pages (community parity A3,
 * feature "community-settings", docs/COMMUNITY_SETTINGS_API.md): its name, accent and background tint, up to five
 * links, a custom invite link once it has enough members, and onboarding's "must finish before chatting" with the
 * channel people land in. Plaintext configuration, like the community guide.
 */

export const COMMUNITY_SETTINGS_LIMITS = { links: 5, linkLabel: 40, linkUrl: 500, slugMin: 3, slugMax: 32, slugMinMembers: 5 } as const;

/** An https address of at most 500 characters. */
const zHttpsUrl = z
  .string()
  .trim()
  .min(1)
  .max(COMMUNITY_SETTINGS_LIMITS.linkUrl)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use a link that starts with https://");

export const CommunityLinkBody = z.strictObject({
  label: z.string().trim().min(1).max(COMMUNITY_SETTINGS_LIMITS.linkLabel),
  url: zHttpsUrl,
});

/** Only the fields sent change; null clears a value. */
export const CommunitySettingsBody = z.strictObject({
  name: zCommunityName.optional(),
  accent: zAccent.nullable().optional(),
  /** The background tint, "#rrggbb", or null for none. */
  background: zAccent.nullable().optional(),
  links: z.array(CommunityLinkBody).max(COMMUNITY_SETTINGS_LIMITS.links).optional(),
  /** The custom invite link (case is ignored), or null to free it. Checked by the server: invite_slug_invalid. */
  inviteSlug: z.string().trim().max(64).nullable().optional(),
  /** New members must finish onboarding before they post or react. */
  onboardingRequired: z.boolean().optional(),
  voiceClips: z.boolean().optional(),
  /** A text channel everyone can see, or null: people land where they usually would. */
  startChannelId: z.string().min(1).max(64).nullable().optional(),
});

export const CommunitySettingsView = z.strictObject({
  name: z.string(),
  accent: z.string().nullable(),
  background: z.string().nullable(),
  links: z.array(CommunityLink),
  inviteSlug: z.string().nullable(),
  /** How many members a community needs before it can claim a custom invite link. */
  inviteSlugMinMembers: zCount,
  memberCount: zCount,
  voiceClips: z.boolean().optional(),
  onboardingRequired: z.boolean(),
  /** When "must finish" was last turned on: only people who joined since are held back. */
  onboardingRequiredSince: zTime.nullable(),
  startChannelId: z.string().nullable(),
  /** When these settings last changed; null before they ever did. */
  updatedAt: zTime.nullable(),
});

/** The viewer's onboarding: whether it's required, whether they finished, and where they land. */
export const OnboardingStatus = z.strictObject({
  onboardingRequired: z.boolean(),
  onboardingDone: z.boolean(),
  finishedAt: zTime.nullable(),
  startChannelId: z.string().nullable(),
  mustFinishOnboarding: z.boolean(),
});

/** The caller's standard invite link: never expires, no use limit; the same code each time while it works. */
export const StandardInvite = z.strictObject({
  id: z.string(),
  code: z.string(),
  uses: zCount,
  createdAt: zTime,
  neverExpires: z.literal(true),
  noUseLimit: z.literal(true),
});

const tag = "community-settings";

export const communitySettingsRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/settings",
    tag,
    summary: "The community's profile, theme, links, custom invite link and onboarding gate (people who can edit it).",
    auth: true,
    params: OrgParamsNonEmpty,
    response: CommunitySettingsView,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/settings",
    tag,
    summary: "Change any of the community's settings (fields sent change; null clears); people who can edit it.",
    auth: true,
    params: OrgParamsNonEmpty,
    body: CommunitySettingsBody,
    response: CommunitySettingsView,
    errors: ["not_found", "forbidden", "invite_slug_invalid", "invite_slug_taken", "invite_slug_needs_members", "start_channel_invalid", "feature_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/invites/standard",
    tag,
    summary: "The caller's standard invite link for the community (never expires, no use limit), made the first time.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: z.strictObject({ invite: StandardInvite }),
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/onboarding/finish",
    tag,
    summary: "Finish (or redo) the community's onboarding: after the required questions and agreeing to the rules.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: OnboardingStatus,
    errors: ["not_found", "onboarding_off", "answer_required", "rules_not_agreed", "feature_disabled"],
  }),
];
