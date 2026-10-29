import { z } from "zod/v4";
import { OrgMemberParams, OrgParamsNonEmpty, VoiceBanView } from "./community.js";
import { AccountAgeGate, LockReason, SafetySettings, VerificationLevel } from "./orgs.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * A community's safety (community parity A2, feature "community-safety", docs/COMMUNITY_SAFETY_API.md): locking it for a
 * while, automatic raid protection, a verification level for posting, an account-age gate for joining, voice bans and
 * server mutes. Plaintext configuration, like the guide and the rules.
 */

/** How long a lock lasts. */
export const LOCK_DURATIONS = ["15m", "1h", "8h", "1d"] as const;
export const LockDuration = z.enum(LOCK_DURATIONS);

/** Any of the settings; what's left out stays as it is. */
export const SafetySettingsBody = z.strictObject({
  verificationLevel: VerificationLevel.optional(),
  newAccountGate: AccountAgeGate.optional(),
  raidProtection: z.boolean().optional(),
});

/** Lock for one of the durations from now, or unlock (null). Locking again replaces the time. */
export const LockBody = z.strictObject({ duration: LockDuration.nullable() });

export const LockView = z.strictObject({
  lockedUntil: zTime.nullable(),
  lockReason: LockReason.nullable(),
  /** Who locked it (null for raid protection or when not locked). */
  lockedBy: z.string().nullable(),
});

export const VoiceBanBody = z.strictObject({ userId: z.string().min(1).max(64), reason: z.string().trim().max(300).nullish() });
export const VoiceBanList = z.strictObject({ voiceBans: z.array(VoiceBanView) });
export const VoiceMuteBody = z.strictObject({ muted: z.boolean() });
export const VoiceMuteView = z.strictObject({
  userId: z.string(),
  muted: z.boolean(),
  mutedAt: zTime.nullable(),
  /** Devices in a call now whose publishing was changed at once (the media server may be unreachable: 0). */
  devices: zCount,
});
export const VoiceDisconnectView = z.strictObject({ userId: z.string(), disconnected: zCount });

export { SafetySettings, VoiceBanView };

const tag = "community-safety";

export const communitySafetyRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/safety",
    tag,
    summary: "The community's safety settings and lock (people who can edit the community or ban members).",
    auth: true,
    params: OrgParamsNonEmpty,
    response: SafetySettings,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/safety",
    tag,
    summary: "Change the verification level, the account-age gate or raid protection (people who can edit the community).",
    auth: true,
    params: OrgParamsNonEmpty,
    body: SafetySettingsBody,
    response: SafetySettings,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/lock",
    tag,
    summary: "Lock the community for 15 minutes, 1 hour, 8 hours or a day (nobody new joins, only moderators post), or unlock it.",
    auth: true,
    params: OrgParamsNonEmpty,
    body: LockBody,
    response: LockView,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/voice-bans",
    tag,
    summary: "The community's voice bans, newest first (people who can ban).",
    auth: true,
    params: OrgParamsNonEmpty,
    response: VoiceBanList,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/voice-bans",
    tag,
    summary: "Keep someone out of the community's voice channels (they're taken out of a call they're in); they can still chat.",
    auth: true,
    params: OrgParamsNonEmpty,
    body: VoiceBanBody,
    response: VoiceBanList,
    errors: ["not_found", "forbidden", "bad_request", "feature_disabled"],
  }),
  route({
    method: "DELETE",
    url: "/v1/orgs/:orgId/voice-bans/:userId",
    tag,
    summary: "Lift a voice ban.",
    auth: true,
    params: OrgMemberParams,
    response: VoiceBanList,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/voice/members/:userId/mute",
    tag,
    summary: "Mute someone in the community's voice channels until unmuted, or unmute them (`voice.mute_members`).",
    auth: true,
    params: OrgMemberParams,
    body: VoiceMuteBody,
    response: VoiceMuteView,
    errors: ["not_found", "forbidden", "bad_request", "feature_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/voice/members/:userId/disconnect",
    tag,
    summary: "Take someone out of the voice channel call they're in (`voice.move_members`); they may join again.",
    auth: true,
    params: OrgMemberParams,
    response: VoiceDisconnectView,
    errors: ["not_found", "forbidden", "bad_request", "feature_disabled"],
  }),
];
