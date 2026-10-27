import { z } from "zod/v4";
import { PresenceState } from "../realtime.js";
import { UserIdParams, zName, zUsername } from "./auth.js";
import { idParams, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * People (docs/PROFILE_AND_PRIVACY.md): your own profile, privacy and presence choice, profiles and photos of others as
 * their privacy settings allow, finding people, their public device keys, blocking and presence.
 */

/** Who may see a part of a profile (src/modules/accounts/profile.ts). */
export const Audience = z.enum(["everyone", "contacts", "nobody"]);
/** Who may see each part of a profile. */
export const Privacy = z.strictObject({
  photo: Audience,
  /** The status, its emoji and pronouns. */
  bio: Audience,
  /** First and last name. */
  name: Audience,
  birthday: Audience,
  phone: Audience,
  /** Online state, presence and last seen time. */
  lastSeen: Audience,
  /** Who can find the person by their exact phone number. */
  findByPhone: Audience,
  /** Who can find the person by their exact username. */
  findByUsername: Audience,
});
/** What a person chose to appear as. "auto": online while an app is connected; "invisible": offline to everyone. */
export const PresenceMode = z.enum(["auto", "idle", "dnd", "invisible"]);

/** Phone numbers in E.164 form: "+" and 7 to 15 digits, no leading zero after the "+". */
export const PHONE = /^\+[1-9]\d{6,14}$/;

/** Birthday: a real calendar date, YYYY-MM-DD (years from 1900 to this year) or --MM-DD. */
export function validBirthday(s: string): boolean {
  const m = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const year = m[1] ? Number(m[1]) : 2000; // a leap year, so --02-29 is allowed
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (m[1] && (year < 1900 || year > new Date().getUTCFullYear())) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Optional text: trimmed, "" and null clear it, absent leaves it unchanged. */
const zOptText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v));

/** Every field is optional; null (or "") clears it. */
export const ProfileUpdateBody = z.object({
  displayName: zName.optional(),
  statusText: zOptText(140),
  statusEmoji: zOptText(16).refine((v) => v == null || !/[\p{L}\p{N}]/u.test(v), "The status emoji can't contain letters or digits"),
  /** When the status ends (within a year). */
  statusExpiresAt: z.number().int().nullable().optional(),
  /** Pause notifications until then (within 30 days). */
  notificationsPausedUntil: z.number().int().nullable().optional(),
  avatarColor: z.number().int().min(0).max(15).optional(),
  firstName: zOptText(40),
  lastName: zOptText(40),
  pronouns: zOptText(40),
  birthday: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((v) => v == null || v === "" || validBirthday(v), "Birthday must be YYYY-MM-DD or --MM-DD")
    .transform((v) => (v === "" ? null : v)),
  phone: z
    .string()
    .trim()
    .nullable()
    .optional()
    // Absent stays absent (an edit of another field must not clear the number).
    .transform((v) => (v === undefined ? undefined : v === null || v === "" ? null : v.replace(/[\s()-]/g, "")))
    .refine((v) => v == null || PHONE.test(v), "Phone numbers start with + and the country code, e.g. +8801712345678"),
  /** At most one change an hour. */
  username: zUsername.optional(),
});
export const PresenceBody = z.strictObject({ mode: PresenceMode, until: z.number().int().nullable().optional() });
export const PrivacyBody = Privacy.partial();

/** Profile style (API 0.45.0, docs/PROFILE_MEDIA.md): Meldiq's own decorations and effects, drawn by the apps. */
export const PROFILE_DECORATIONS = ["aurora", "ember", "frost", "neon", "sakura", "pixel"] as const;
export const PROFILE_EFFECTS = ["sparkles", "glow", "stars", "bubbles"] as const;
export const ProfileStyleBody = z.object({
  decoration: z.enum(PROFILE_DECORATIONS).nullable().optional(),
  effect: z.enum(PROFILE_EFFECTS).nullable().optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});
const ProfileStyle = z.strictObject({ decoration: z.enum(PROFILE_DECORATIONS).nullable(), effect: z.enum(PROFILE_EFFECTS).nullable(), accent: z.string().nullable() });
const AvatarMedia = z.strictObject({ kind: z.enum(["gif", "webp", "video"]), rev: z.number().int() });
const ProfileBanner = z.strictObject({ kind: z.enum(["jpeg", "gif", "webp"]), rev: z.number().int() });
export const PhoneQuery = z.object({ phone: z.string().trim().max(24) });
export const SearchQuery = z.object({ q: z.string().trim().min(1).max(40) });
export const DevicesBody = z.object({ userIds: z.array(z.string().max(64)).min(1).max(500) });
export const BlockBody = z.object({ userId: z.string().max(64) });
export const PresenceQuery = z.object({ ids: z.string().max(5000) });

/**
 * A person as lists and search show them: only what they publish to everyone. A null status means none or not shown;
 * photoRev is absent without a photo everyone may see.
 */
export const UserSummary = z.strictObject({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarColor: z.number().int(),
  statusText: z.string().nullable(),
  statusEmoji: z.string().nullable(),
  photoRev: z.number().int().optional(),
  /** People on another server: their home server's id (username is then "name:domain"). */
  homeServer: z.string().nullable(),
});

/** A profile as its viewer may see it: hidden and empty fields are both absent. */
const profileFields = {
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarColor: z.number().int(),
  homeServer: z.string().nullable(),
  statusText: z.string().optional(),
  statusEmoji: z.string().optional(),
  statusExpiresAt: zTime.optional(),
  pronouns: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  photoRev: z.number().int().optional(),
  birthday: z.string().optional(),
  phone: z.string().optional(),
  /** API 0.45.0: an animated avatar and a banner (to whoever may see the photo), and the profile's style. */
  avatarMedia: AvatarMedia.optional(),
  profileBanner: ProfileBanner.optional(),
  profileStyle: ProfileStyle.optional(),
};
/** Only in the person's own profile. */
const ownFields = {
  privacy: Privacy,
  /** Set while notifications are paused. */
  notificationsPausedUntil: z.number().int().nullable(),
  presenceMode: PresenceMode,
  /** When a presence choice other than "auto" ends (null: until changed). */
  presenceUntil: z.number().int().nullable(),
};

/** The signed-in person's own profile, with their privacy settings and keys. */
export const OwnProfile = z.strictObject({
  ...profileFields,
  ...ownFields,
  identityKey: z.string(),
  fingerprint: z.string(),
  createdAt: zTime,
});

/** Someone's profile (or your own, which then includes your settings), with their keys and presence if shown to you. */
export const UserProfile = z.strictObject({
  ...profileFields,
  /** null unless shown (older apps expect the key). */
  statusText: z.string().nullable(),
  privacy: ownFields.privacy.optional(),
  notificationsPausedUntil: ownFields.notificationsPausedUntil.optional(),
  presenceMode: ownFields.presenceMode.optional(),
  presenceUntil: ownFields.presenceUntil.optional(),
  identityKey: z.string(),
  fingerprint: z.string(),
  /** null: their "last seen" setting hides it from you. */
  online: z.boolean().nullable(),
  /** Absent when hidden. */
  presence: PresenceState.optional(),
  lastSeenAt: zTime.nullable(),
});

/** A device's public keys, to encrypt to and verify. */
export const DirectoryDevice = z.strictObject({ id: z.string(), signingKey: z.string(), encryptionKey: z.string(), certificate: z.string() });
/**
 * A person's public keys: `devices` are the ones to encrypt to; `revokedDevices` were removed within the queue lifetime,
 * and their earlier envelopes still verify against these keys.
 */
export const DirectoryEntry = z.strictObject({
  userId: z.string(),
  identityKey: z.string(),
  devices: z.array(DirectoryDevice),
  revokedDevices: z.array(DirectoryDevice.extend({ revokedAt: zTime })),
});

export const PresenceEntry = z.strictObject({ userId: z.string(), online: z.boolean(), presence: PresenceState, lastSeenAt: zTime.nullable() });

const user = (url: string, extra: Omit<Parameters<typeof route>[0], "url" | "tag" | "auth">) => route({ url, tag: "users", auth: true, ...extra });

export const userRoutes = [
  user("/v1/users/me", { method: "GET", summary: "Your own profile, and this device's id.", response: z.strictObject({ user: OwnProfile, deviceId: z.string() }) }),
  user("/v1/users/me", {
    method: "PATCH",
    summary: "Edit your profile; only the fields sent change.",
    body: ProfileUpdateBody,
    response: z.strictObject({ user: OwnProfile }),
    errors: ["conflict", "username_recently_changed"],
  }),
  user("/v1/users/me/presence", {
    method: "PUT",
    summary: "Appear online automatically, idle, do not disturb or invisible, until a time or until changed.",
    body: PresenceBody,
    response: z.strictObject({ mode: PresenceMode, until: z.number().int().nullable() }),
  }),
  user("/v1/users/me/privacy", {
    method: "PUT",
    summary: "Who may see each part of your profile; only the fields sent change.",
    body: PrivacyBody,
    response: z.strictObject({ privacy: Privacy }),
  }),
  user("/v1/users/me/photo", {
    method: "PUT",
    summary: "Set your profile photo: a JPEG of at most 512 KB, sent as application/octet-stream.",
    binary: "request",
    response: z.strictObject({ photoRev: z.number().int() }),
    errors: ["too_large", "storage_unavailable"],
  }),
  user("/v1/users/me/photo", { method: "DELETE", summary: "Remove your profile photo.", response: z.strictObject({ photoRev: z.null() }) }),
  user("/v1/users/:id/photo", {
    method: "GET",
    summary: "Someone's profile photo (image/jpeg), if they show it to you.",
    params: idParams,
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  user("/v1/users/me/avatar-media", {
    method: "PUT",
    summary: "Set an animated avatar: a GIF or WebP (≤ 4 MB, ≤ 1024 px), or a video clip (≤ 12 MB, ≤ 6 s) shown as a 3 s silent loop.",
    binary: "request",
    response: z.strictObject({ avatarMedia: AvatarMedia }),
    errors: ["bad_request", "too_large", "storage_unavailable", "media_engine_unavailable"],
  }),
  user("/v1/users/me/avatar-media", { method: "DELETE", summary: "Remove your animated avatar.", response: z.strictObject({ avatarMedia: z.null() }) }),
  user("/v1/users/:id/avatar-media", {
    method: "GET",
    summary: "Someone's animated avatar (image/gif, image/webp or video/mp4), if they show you their photo.",
    params: idParams,
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  user("/v1/users/:id/avatar-poster", {
    method: "GET",
    summary: "The still frame of someone's video avatar (image/jpeg).",
    params: idParams,
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  user("/v1/users/me/profile-banner", {
    method: "PUT",
    summary: "Set your profile banner: a JPEG (≤ 1 MB) or an animated GIF or WebP (≤ 6 MB), at most 2048 × 1024.",
    binary: "request",
    response: z.strictObject({ profileBanner: ProfileBanner }),
    errors: ["bad_request", "too_large", "storage_unavailable"],
  }),
  user("/v1/users/me/profile-banner", { method: "DELETE", summary: "Remove your profile banner.", response: z.strictObject({ profileBanner: z.null() }) }),
  user("/v1/users/:id/profile-banner", {
    method: "GET",
    summary: "Someone's profile banner, if they show you their photo.",
    params: idParams,
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  user("/v1/users/me/profile-style", {
    method: "PUT",
    summary: "Your profile's decoration, effect and accent colour (fields sent change; null removes).",
    body: ProfileStyleBody,
    response: z.strictObject({ profileStyle: ProfileStyle }),
    errors: ["bad_request"],
  }),
  user("/v1/users/by-phone", {
    method: "GET",
    summary: "Find someone by their exact phone number, if they allow it (never a partial match).",
    query: PhoneQuery,
    response: z.strictObject({ user: UserSummary }),
    errors: ["not_found"],
  }),
  user("/v1/users/search", {
    method: "GET",
    summary: "People who share a community with you (prefix match), plus an exact username match for anyone who allows it.",
    query: SearchQuery,
    response: z.strictObject({ users: z.array(UserSummary.extend({ online: z.boolean().nullable() })) }),
  }),
  user("/v1/users/:id", {
    method: "GET",
    summary: "Someone's profile as their privacy settings show it to you, with their identity key.",
    params: idParams,
    response: z.strictObject({ user: UserProfile }),
    errors: ["not_found"],
  }),
  user("/v1/users/devices", {
    method: "POST",
    summary: "The key directory: people's identity keys and their devices' public keys.",
    body: DevicesBody,
    response: z.strictObject({ users: z.array(DirectoryEntry) }),
  }),
  user("/v1/blocks", {
    method: "POST",
    summary: "Block someone: their messages are dropped for you, and they aren't told.",
    body: BlockBody,
    response: z.strictObject({ blocked: z.literal(true) }),
    errors: ["not_found"],
  }),
  user("/v1/blocks/:userId", { method: "DELETE", summary: "Unblock someone.", params: UserIdParams, response: z.strictObject({ blocked: z.literal(false) }) }),
  user("/v1/blocks", { method: "GET", summary: "The people you've blocked.", response: z.strictObject({ userIds: z.array(z.string()) }) }),
  user("/v1/presence", {
    method: "GET",
    summary: "Presence of up to 200 people (comma-separated ids); people whose last seen you may not see are left out.",
    query: PresenceQuery,
    response: z.strictObject({ presence: z.array(PresenceEntry) }),
  }),
];
