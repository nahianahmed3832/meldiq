import type { FastifyInstance } from "fastify";
import { deleteBlobNow } from "../files/routes.js";
import { photoBlobId, readJpegBody, storePhoto } from "./photos.js";
import { type AppContext } from "../../app/context.js";
import { wornTag } from "./profileMedia.js";
import { isBugHunter } from "./bugReports.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { UserIdParams } from "../../shared/contracts/http/auth.js";
import { idParams } from "../../shared/contracts/http/primitives.js";
import {
  BlockBody,
  DevicesBody,
  PHONE,
  PhoneQuery,
  PresenceBody,
  PresenceQuery,
  PrivacyBody,
  ProfileUpdateBody,
  SearchQuery,
} from "../../shared/contracts/http/users.js";
import { keyFingerprint } from "../../shared/utilities/crypto.js";
import { allows, appearsOnline, canSeeLastSeen, type ProfileRow, privacyOf, profileView, relation, shownPresence } from "./profile.js";
import { announcePresence } from "../realtime/ws.js";
import { activityField, activityFor, announceActivity } from "./activity/visibility.js";
import { announceOwnSettingsChange, announceProfileChange } from "./profileEvents.js";
import { ApiError, badRequest, conflict, notFound } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { userSummary } from "../auth/routes.js";
import { orgMates } from "../organizations/index.js";
import { rowsByIds } from "../../infrastructure/database/byIds.js";
import { compareText, foldAscii } from "../../shared/utilities/sqlText.js";

/** A username can change at most once an hour, so links and mentions don't churn. */
const USERNAME_CHANGE_INTERVAL_MS = 60 * 60 * 1000;

export interface DeviceKeyRow {
  user_id: string;
  identity_key: string;
  id: string;
  signing_key: string;
  encryption_key: string;
  certificate: string;
}

export interface DirectoryDevice {
  id: string;
  signingKey: string;
  encryptionKey: string;
  certificate: string;
}

/** A device removed from the account: never encrypted to, but its earlier envelopes still verify (T1.5). */
export interface RevokedDirectoryDevice extends DirectoryDevice {
  revokedAt: number;
}

export interface DirectoryEntry {
  userId: string;
  identityKey: string;
  devices: DirectoryDevice[];
  revokedDevices: RevokedDirectoryDevice[];
}

const directoryDevice = (r: Omit<DeviceKeyRow, "user_id" | "identity_key">): DirectoryDevice => ({
  id: r.id,
  signingKey: r.signing_key,
  encryptionKey: r.encryption_key,
  certificate: r.certificate,
});

/**
 * Public key directory entries for a set of users. `devices` are the active devices, the only ones to encrypt to.
 * `revokedDevices` are the devices revoked within the queue lifetime: envelopes they sent before `revokedAt` may still
 * be queued, and recipients verify those against these keys. Anything older has left every queue, so isn't listed.
 */
export function deviceDirectory(ctx: AppContext, userIds: string[]): DirectoryEntry[] {
  if (userIds.length === 0) return [];
  const { identity } = ctx;
  type Device = Omit<DeviceKeyRow, "identity_key"> & { revoked_at: number | null };
  const byUser = new Map<string, DirectoryEntry>();
  for (const u of identity.all<{ id: string; identity_key: string }>("users", { where: { id: { in: userIds }, disabled_at: null } })) {
    byUser.set(u.id, { userId: u.id, identityKey: u.identity_key, devices: [], revokedDevices: [] });
  }
  const ids = [...byUser.keys()];
  for (const d of identity.all<Device>("devices", { where: { user_id: { in: ids }, revoked_at: null } })) {
    byUser.get(d.user_id)!.devices.push(directoryDevice(d));
  }
  const since = now() - ctx.config.queueTtlSeconds * 1000;
  for (const d of identity.all<Device>("devices", { where: { user_id: { in: userIds }, revoked_at: { gt: since } }, orderBy: [["revoked_at", "asc"]] })) {
    byUser.get(d.user_id)?.revokedDevices.push({ ...directoryDevice(d), revokedAt: d.revoked_at! });
  }
  return [...byUser.values()];
}

export default async function userRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };

  // Photos are stored per revision ("<userId>-<rev>"), so a replaced photo is never served under the new revision.
  // Photos saved before 2026-10-17 are under "<userId>" alone and are still found.
  const photoId = photoBlobId;
  // API 0.46.0: the community tag someone wears, shown with their name to everyone who sees them.
  const tagOf = (u: { id: string; profile_style?: string | null }) => {
    const tag = wornTag(ctx, u);
    // API 0.46.0: badges people earned (a confirmed or fixed bug report: Bug Hunter).
    const badges = isBugHunter(ctx.safety, u.id) ? ["bug-hunter"] : [];
    return { ...(tag ? { tag } : {}), ...(badges.length ? { badges } : {}) };
  };
  const meView = (u: any) => ({
    ...profileView(u, { self: true, contact: true, blockedByTarget: false }, ctx),
    ...tagOf(u),
    identityKey: u.identity_key,
    fingerprint: keyFingerprint(u.identity_key),
    createdAt: u.created_at,
  });

  app.get("/v1/users/me", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const u = ctx.identity.get<any>("users", { id: userId });
    return { user: meView(u), deviceId };
  });

  // The person's own profile. Every field is optional; null clears it. Hidden fields stay stored (privacy decides who
  // sees them, not whether they exist).
  /** Longest status ("Vacationing" for a year at most) and longest notification pause. */
  const STATUS_MAX_MS = 366 * 86_400_000;
  const PAUSE_MAX_MS = 30 * 86_400_000;
  app.patch("/v1/users/me", auth, async (req) => {
    const { userId } = me(req);
    const body = parse(ProfileUpdateBody, req.body);
    const u = ctx.identity.get<any>("users", { id: userId });
    let username = u.username as string;
    if (body.username && body.username.toLowerCase() !== username.toLowerCase()) {
      if (u.home_server_id) throw badRequest("This account lives on another server");
      if (u.username_changed_at && now() - u.username_changed_at < USERNAME_CHANGE_INTERVAL_MS) {
        throw new ApiError(429, "username_recently_changed", "You can change your username once an hour");
      }
      if (ctx.identity.get("users", { username: body.username, id: { ne: userId } })) {
        throw conflict("That username is taken");
      }
      username = body.username;
    }
    const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
    const t = now();
    if (body.statusExpiresAt != null && (body.statusExpiresAt <= t || body.statusExpiresAt > t + STATUS_MAX_MS)) {
      throw badRequest("A status ends in the future, within a year");
    }
    if (body.notificationsPausedUntil != null && (body.notificationsPausedUntil <= t || body.notificationsPausedUntil > t + PAUSE_MAX_MS)) {
      throw badRequest("Notifications can be paused for up to 30 days");
    }
    // A new status without an end time doesn't inherit the old one's.
    const statusChanged = body.statusText !== undefined || body.statusEmoji !== undefined;
    const statusExpiresAt = body.statusExpiresAt !== undefined ? body.statusExpiresAt : statusChanged ? null : u.status_expires_at;
    const profile = {
      display_name: body.displayName ?? u.display_name,
      status_text: pick(body.statusText, u.status_text),
      status_emoji: pick(body.statusEmoji, u.status_emoji ?? null),
      status_expires_at: statusExpiresAt ?? null,
      notifications_paused_until: pick(body.notificationsPausedUntil, u.notifications_paused_until ?? null),
      avatar_color: body.avatarColor ?? u.avatar_color,
      first_name: pick(body.firstName, u.first_name),
      last_name: pick(body.lastName, u.last_name),
      pronouns: pick(body.pronouns, u.pronouns ?? null),
      birthday: pick(body.birthday, u.birthday),
      phone: pick(body.phone, u.phone),
      username,
      username_changed_at: username === u.username ? u.username_changed_at : now(),
      updated_at: now(),
      // API 0.46.0: About me and links, only when sent.
      ...(body.aboutMe !== undefined ? { about_me: body.aboutMe || null } : {}),
      ...(body.links !== undefined ? { profile_links: body.links?.length ? JSON.stringify(body.links) : null } : {}),
    };
    try {
      await ctx.identity.write((w) => w.update("users", { id: userId }, profile));
    } catch (e) {
      // Taken by someone else between the check above and this write.
      if (String(e).includes("users.username")) throw conflict("That username is taken");
      throw e;
    }
    const updated = ctx.identity.get<any>("users", { id: userId });
    announceProfileChange(ctx, userId);
    return { user: meView(updated) };
  });

  /**
   * Batch B6b (Discord reference NAV-CTRL-010): appear online automatically, idle, do not disturb, or invisible (offline
   * to everyone), until [until] or until changed. The people who may see your presence hear of the change at once.
   */
  app.put("/v1/users/me/presence", auth, async (req) => {
    const { userId } = me(req);
    const body = parse(PresenceBody, req.body);
    const t = now();
    if (body.until != null && (body.until <= t || body.until > t + PAUSE_MAX_MS)) throw badRequest("A presence choice ends in the future, within 30 days");
    const until = body.mode === "auto" ? null : (body.until ?? null);
    await ctx.identity.write((w) => w.update("users", { id: userId }, { presence_mode: body.mode === "auto" ? null : body.mode, presence_until: until, updated_at: t }));
    announcePresence(ctx, userId);
    // Invisible hides the activity too; appearing again shows it.
    announceActivity(ctx, userId);
    return { mode: body.mode, until };
  });

  // Who may see each part of the profile (src/profile.ts). Only the fields sent change.
  app.put("/v1/users/me/privacy", auth, async (req) => {
    const { userId } = me(req);
    const body = parse(PrivacyBody, req.body);
    const u = ctx.identity.get<any>("users", { id: userId });
    const next = { ...privacyOf(u), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    await ctx.identity.write((w) => w.update("users", { id: userId }, { privacy: JSON.stringify(next), updated_at: now() }));
    // What others may see changed, so they fetch the profile again (and get only what's now allowed).
    announceProfileChange(ctx, userId);
    return { privacy: next };
  });

  // Profile photo: a JPEG the phone has already re-encoded (no metadata). Published to the photo's audience; it is not
  // end-to-end encrypted, and the server can see it (docs/PROFILE_AND_PRIVACY.md).
  app.put("/v1/users/me/photo", auth, async (req) => {
    const { userId } = me(req);
    const buf = await readJpegBody(req, "Profile photos");
    const previous = ctx.identity.get<{ photo_rev: number | null }>("users", { id: userId })?.photo_rev ?? null;
    const rev = Math.max(now(), (previous ?? 0) + 1);
    await storePhoto(ctx, photoId(userId, rev), buf);
    await ctx.identity.write((w) => w.update("users", { id: userId }, { photo_rev: rev, updated_at: rev }));
    if (previous) {
      await deleteBlobNow(ctx, "profile-photos", photoId(userId, previous));
      await deleteBlobNow(ctx, "profile-photos", userId);
    }
    announceProfileChange(ctx, userId);
    return { photoRev: rev };
  });

  app.delete("/v1/users/me/photo", auth, async (req) => {
    const { userId } = me(req);
    const previous = ctx.identity.get<{ photo_rev: number | null }>("users", { id: userId })?.photo_rev ?? null;
    await ctx.identity.write((w) => w.update("users", { id: userId }, { photo_rev: null, updated_at: now() }));
    if (previous) await deleteBlobNow(ctx, "profile-photos", photoId(userId, previous));
    await deleteBlobNow(ctx, "profile-photos", userId);
    announceProfileChange(ctx, userId);
    return { photoRev: null };
  });

  app.get("/v1/users/:id/photo", auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const u = ctx.identity.get<ProfileRow>("users", { id, disabled_at: null });
    // Same answer for "no photo" and "not allowed to see it".
    if (!u?.photo_rev || !allows(privacyOf(u).photo, relation(ctx, me(req).userId, u.id))) throw notFound("No photo");
    const stream = (await ctx.blobs.get("profile-photos", photoId(u.id, u.photo_rev))) ?? (await ctx.blobs.get("profile-photos", u.id));
    if (!stream) throw notFound("No photo");
    return reply
      .header("content-type", "image/jpeg")
      .header("cache-control", "private, max-age=3600")
      .header("etag", `"${u.photo_rev}"`)
      .send(stream);
  });

  // Find someone by their exact phone number, if they allow it. Never a list or a partial match, and the same answer
  // whether nobody has that number or its owner doesn't want to be found. No address book is ever uploaded.
  app.get("/v1/users/by-phone", { ...auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { userId } = me(req);
    const { phone } = parse(PhoneQuery, req.query);
    const p = phone.replace(/[\s()-]/g, "");
    if (!PHONE.test(p)) throw badRequest("Phone numbers start with + and the country code");
    const u = ctx.identity.get<ProfileRow>("users", { phone: p, disabled_at: null, home_server_id: null, id: { ne: userId } });
    if (!u || !allows(privacyOf(u).findByPhone, relation(ctx, userId, u.id))) throw notFound("No one found");
    return { user: userSummary(u as any) };
  });

  // Find colleagues: people who share an organisation with you (prefix match on username or
  // display name), plus an exact username match for anyone (Telegram-style @username lookup).
  app.get("/v1/users/search", auth, async (req) => {
    const { userId } = me(req);
    const { q } = parse(SearchQuery, req.query);
    const term = q.replace(/^@/, "").toLowerCase();
    // Anyone by exact username; people sharing a community by the start of their username, name, or a word in it.
    const findable = (u: any) => u.disabled_at == null && u.home_server_id == null && u.kind === "person" && u.id !== userId;
    const startsWith = (v: string | null | undefined) => v != null && foldAscii(v).startsWith(foldAscii(term));
    const exact = ctx.identity.all<any>("users", { where: { username: term } }).filter(findable);
    const partial = rowsByIds<any>(ctx.identity, "users", "id", orgMates(ctx, userId)).filter(
      (u) => findable(u) && (startsWith(u.username) || startsWith(u.display_name) || (u.display_name != null && foldAscii(u.display_name).includes(` ${foldAscii(term)}`))),
    );
    const rows = [...new Map([...exact, ...partial].map((u) => [u.id, u])).values()].sort((a, b) => compareText(a.username, b.username)).slice(0, 30);
    // Exact-username matches can be strangers: only people who let everyone find them by username are listed to them,
    // never someone who blocked the searcher, and their presence stays hidden (null).
    const visible = rows.filter((u) => {
      const r = relation(ctx, userId, u.id);
      return !r.blockedByTarget && (r.contact || allows(privacyOf(u).findByUsername, r));
    });
    return { users: visible.map((u) => ({ ...userSummary(u), online: canSeeLastSeen(ctx, userId, u) ? appearsOnline(ctx, u) : null })) };
  });

  app.get("/v1/users/:id", auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const u = ctx.identity.get<any>("users", { id, disabled_at: null });
    if (!u) throw notFound("User not found");
    const viewer = me(req).userId;
    const r = relation(ctx, viewer, u.id);
    const visible = allows(privacyOf(u).lastSeen, r);
    return {
      user: {
        statusText: null, // older apps expect the key
        ...profileView(u, r, ctx),
        ...tagOf(u),
        identityKey: u.identity_key,
        fingerprint: keyFingerprint(u.identity_key),
        online: visible ? appearsOnline(ctx, u) : null,
        // Batch B6b: absent when hidden, like the profile's other hidden fields.
        ...(visible ? { presence: shownPresence(ctx, u) } : {}),
        lastSeenAt: visible ? ctx.hub.lastSeenAt(u.id) : null,
        // API 0.56.0: what they're playing, under the same rule (your own always).
        ...activityField(activityFor(ctx, viewer, u)),
        // Someone they blocked sees only the basics: neither when they joined nor where you meet.
        ...(r.blockedByTarget ? {} : { memberSince: u.created_at, mutualCommunities: mutualCommunities(ctx, viewer, u.id) }),
        // API 0.61.0: the Artist badge.
        ...(ctx.decorations.isArtist(u.id) ? { decorationArtist: true as const } : {}),
      },
    };
  });

  app.post("/v1/users/devices", auth, async (req) => {
    const { userIds } = parse(DevicesBody, req.body);
    const ids = [...new Set(userIds)];
    await ctx.federation?.refreshStale(ids);
    return { users: deviceDirectory(ctx, ids) };
  });

  // Blocking (local or remote people): their messages are dropped for the blocker; the blocked person isn't told.
  app.post("/v1/blocks", auth, async (req) => {
    const { userId } = me(req);
    const { userId: other } = parse(BlockBody, req.body);
    if (other === userId) throw badRequest("You can't block yourself");
    if (!ctx.identity.get("users", { id: other })) throw notFound("User not found");
    await ctx.identity.write((w) => w.insert("user_blocks", { user_id: userId, blocked_user_id: other, created_at: now() }, { orIgnore: true }));
    announceOwnSettingsChange(ctx, userId);
    return { blocked: true };
  });

  app.delete("/v1/blocks/:userId", auth, async (req) => {
    const { userId } = me(req);
    const { userId: other } = parse(UserIdParams, req.params);
    await ctx.identity.write((w) => w.delete("user_blocks", { user_id: userId, blocked_user_id: other }));
    announceOwnSettingsChange(ctx, userId);
    return { blocked: false };
  });

  app.get("/v1/blocks", auth, async (req) => {
    const rows = ctx.identity.all<{ blocked_user_id: string }>("user_blocks", { where: { user_id: me(req).userId } });
    return { userIds: rows.map((r) => r.blocked_user_id) };
  });

  // Users the caller may not see are left out (not nulled): released apps parse `online` as non-null.
  app.get("/v1/presence", auth, async (req) => {
    const { userId } = me(req);
    const { ids } = parse(PresenceQuery, req.query);
    const wanted = [...new Set(ids.split(",").filter(Boolean))].slice(0, 200);
    const rows = wanted.length
      ? // Disabled and deleted accounts are left out: their last-seen time stays in memory until the server restarts.
        ctx.identity.all<ProfileRow>("users", { where: { disabled_at: null, id: { in: wanted } } })
      : [];
    // Each person's "last seen" setting decides (contacts by default, the rule this endpoint always had).
    const list = rows.filter((u) => canSeeLastSeen(ctx, userId, u)).map((u) => u.id);
    return {
      presence: rows
        .filter((u) => list.includes(u.id))
        .map((u) => ({
          userId: u.id,
          online: appearsOnline(ctx, u),
          presence: shownPresence(ctx, u),
          lastSeenAt: ctx.hub.lastSeenAt(u.id),
          ...activityField(activityFor(ctx, userId, u)),
        })),
    };
  });
}

/** Communities both [viewer] and [userId] are in, with when [userId] joined each, newest first (at most 50). */
function mutualCommunities(ctx: AppContext, viewer: string, userId: string): { id: string; name: string; photoRev: number | null; joinedAt: number }[] {
  if (viewer === userId) return [];
  const mine = new Set(ctx.ws.all<{ org_id: string }>("org_members", { where: { user_id: viewer } }).map((m) => m.org_id));
  const theirs = ctx.ws.all<{ org_id: string; joined_at: number }>("org_members", { where: { user_id: userId } }).filter((m) => mine.has(m.org_id));
  return theirs
    .map((m) => {
      const o = ctx.ws.get<{ name: string; photo_rev: number | null }>("orgs", { id: m.org_id });
      return o ? { id: m.org_id, name: o.name, photoRev: o.photo_rev ?? null, joinedAt: m.joined_at } : null;
    })
    .filter((x): x is { id: string; name: string; photoRev: number | null; joinedAt: number } => x !== null)
    .sort((a, b) => b.joinedAt - a.joinedAt)
    .slice(0, 50);
}
