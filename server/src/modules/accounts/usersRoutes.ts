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
  const placeholders = userIds.map(() => "?").join(",");
  const rows = ctx.db
    .prepare(
      `SELECT u.id AS user_id, u.identity_key, d.id, d.signing_key, d.encryption_key, d.certificate
       FROM users u LEFT JOIN devices d ON d.user_id = u.id AND d.revoked_at IS NULL
       WHERE u.id IN (${placeholders}) AND u.disabled_at IS NULL`,
    )
    .all(...userIds) as (DeviceKeyRow & { id: string | null })[];
  const byUser = new Map<string, DirectoryEntry>();
  for (const r of rows) {
    let e = byUser.get(r.user_id);
    if (!e) byUser.set(r.user_id, (e = { userId: r.user_id, identityKey: r.identity_key, devices: [], revokedDevices: [] }));
    if (r.id) e.devices.push(directoryDevice(r));
  }
  const revoked = ctx.db
    .prepare(
      `SELECT user_id, id, signing_key, encryption_key, certificate, revoked_at FROM devices
       WHERE user_id IN (${placeholders}) AND revoked_at IS NOT NULL AND revoked_at > ? ORDER BY revoked_at`,
    )
    .all(...userIds, now() - ctx.config.queueTtlSeconds * 1000) as (Omit<DeviceKeyRow, "identity_key"> & { revoked_at: number })[];
  for (const r of revoked) byUser.get(r.user_id)?.revokedDevices.push({ ...directoryDevice(r), revokedAt: r.revoked_at });
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
    const badges = isBugHunter(ctx.db, u.id) ? ["bug-hunter"] : [];
    return { ...(tag ? { tag } : {}), ...(badges.length ? { badges } : {}) };
  };
  const meView = (u: any) => ({
    ...profileView(u, { self: true, contact: true, blockedByTarget: false }),
    ...tagOf(u),
    identityKey: u.identity_key,
    fingerprint: keyFingerprint(u.identity_key),
    createdAt: u.created_at,
  });

  app.get("/v1/users/me", auth, async (req) => {
    const { userId, deviceId } = me(req);
    const u = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
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
    const u = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    let username = u.username as string;
    if (body.username && body.username.toLowerCase() !== username.toLowerCase()) {
      if (u.home_server_id) throw badRequest("This account lives on another server");
      if (u.username_changed_at && now() - u.username_changed_at < USERNAME_CHANGE_INTERVAL_MS) {
        throw new ApiError(429, "username_recently_changed", "You can change your username once an hour");
      }
      if (ctx.db.prepare("SELECT 1 FROM users WHERE username = ? AND id != ?").get(body.username, userId)) {
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
    ctx.db
      .prepare(
        `UPDATE users SET display_name = ?, status_text = ?, status_emoji = ?, status_expires_at = ?, notifications_paused_until = ?,
           avatar_color = ?, first_name = ?, last_name = ?, pronouns = ?, birthday = ?, phone = ?,
           username = ?, username_changed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        body.displayName ?? u.display_name,
        pick(body.statusText, u.status_text),
        pick(body.statusEmoji, u.status_emoji ?? null),
        statusExpiresAt ?? null,
        pick(body.notificationsPausedUntil, u.notifications_paused_until ?? null),
        body.avatarColor ?? u.avatar_color,
        pick(body.firstName, u.first_name),
        pick(body.lastName, u.last_name),
        pick(body.pronouns, u.pronouns ?? null),
        pick(body.birthday, u.birthday),
        pick(body.phone, u.phone),
        username,
        username === u.username ? u.username_changed_at : now(),
        now(),
        userId,
      );
    // API 0.46.0: About me and links, only when sent.
    if (body.aboutMe !== undefined || body.links !== undefined) {
      ctx.db
        .prepare("UPDATE users SET about_me = ?, profile_links = ? WHERE id = ?")
        .run(
          body.aboutMe !== undefined ? body.aboutMe || null : (u.about_me ?? null),
          body.links !== undefined ? (body.links?.length ? JSON.stringify(body.links) : null) : (u.profile_links ?? null),
          userId,
        );
    }
    const updated = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
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
    ctx.db.prepare("UPDATE users SET presence_mode = ?, presence_until = ?, updated_at = ? WHERE id = ?").run(body.mode === "auto" ? null : body.mode, until, t, userId);
    announcePresence(ctx, userId);
    return { mode: body.mode, until };
  });

  // Who may see each part of the profile (src/profile.ts). Only the fields sent change.
  app.put("/v1/users/me/privacy", auth, async (req) => {
    const { userId } = me(req);
    const body = parse(PrivacyBody, req.body);
    const u = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    const next = { ...privacyOf(u), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    ctx.db.prepare("UPDATE users SET privacy = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), userId);
    // What others may see changed, so they fetch the profile again (and get only what's now allowed).
    announceProfileChange(ctx, userId);
    return { privacy: next };
  });

  // Profile photo: a JPEG the phone has already re-encoded (no metadata). Published to the photo's audience; it is not
  // end-to-end encrypted, and the server can see it (docs/PROFILE_AND_PRIVACY.md).
  app.put("/v1/users/me/photo", auth, async (req) => {
    const { userId } = me(req);
    const buf = await readJpegBody(req, "Profile photos");
    const previous = (ctx.db.prepare("SELECT photo_rev FROM users WHERE id = ?").get(userId) as { photo_rev: number | null } | undefined)?.photo_rev ?? null;
    const rev = Math.max(now(), (previous ?? 0) + 1);
    await storePhoto(ctx, photoId(userId, rev), buf);
    ctx.db.prepare("UPDATE users SET photo_rev = ?, updated_at = ? WHERE id = ?").run(rev, rev, userId);
    if (previous) {
      await deleteBlobNow(ctx, "profile-photos", photoId(userId, previous));
      await deleteBlobNow(ctx, "profile-photos", userId);
    }
    announceProfileChange(ctx, userId);
    return { photoRev: rev };
  });

  app.delete("/v1/users/me/photo", auth, async (req) => {
    const { userId } = me(req);
    const previous = (ctx.db.prepare("SELECT photo_rev FROM users WHERE id = ?").get(userId) as { photo_rev: number | null } | undefined)?.photo_rev ?? null;
    ctx.db.prepare("UPDATE users SET photo_rev = NULL, updated_at = ? WHERE id = ?").run(now(), userId);
    if (previous) await deleteBlobNow(ctx, "profile-photos", photoId(userId, previous));
    await deleteBlobNow(ctx, "profile-photos", userId);
    announceProfileChange(ctx, userId);
    return { photoRev: null };
  });

  app.get("/v1/users/:id/photo", auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const u = ctx.db.prepare("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(id) as ProfileRow | undefined;
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
    const u = ctx.db
      .prepare("SELECT * FROM users WHERE phone = ? AND disabled_at IS NULL AND home_server_id IS NULL AND id != ?")
      .get(p, userId) as ProfileRow | undefined;
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
    const exact = (ctx.db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").all(term) as any[]).filter(findable);
    const partial = rowsByIds<any>(ctx.db, "users", "id", orgMates(ctx, userId)).filter(
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
    const u = ctx.db.prepare("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(id) as any;
    if (!u) throw notFound("User not found");
    const viewer = me(req).userId;
    const r = relation(ctx, viewer, u.id);
    const visible = allows(privacyOf(u).lastSeen, r);
    return {
      user: {
        statusText: null, // older apps expect the key
        ...profileView(u, r),
        ...tagOf(u),
        identityKey: u.identity_key,
        fingerprint: keyFingerprint(u.identity_key),
        online: visible ? appearsOnline(ctx, u) : null,
        // Batch B6b: absent when hidden, like the profile's other hidden fields.
        ...(visible ? { presence: shownPresence(ctx, u) } : {}),
        lastSeenAt: visible ? ctx.hub.lastSeenAt(u.id) : null,
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
    if (!ctx.db.prepare("SELECT 1 FROM users WHERE id = ?").get(other)) throw notFound("User not found");
    ctx.db.prepare("INSERT OR IGNORE INTO user_blocks (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)").run(userId, other, now());
    announceOwnSettingsChange(ctx, userId);
    return { blocked: true };
  });

  app.delete("/v1/blocks/:userId", auth, async (req) => {
    const { userId } = me(req);
    const { userId: other } = parse(UserIdParams, req.params);
    ctx.db.prepare("DELETE FROM user_blocks WHERE user_id = ? AND blocked_user_id = ?").run(userId, other);
    announceOwnSettingsChange(ctx, userId);
    return { blocked: false };
  });

  app.get("/v1/blocks", auth, async (req) => {
    const rows = ctx.db.prepare("SELECT blocked_user_id id FROM user_blocks WHERE user_id = ?").all(me(req).userId) as { id: string }[];
    return { userIds: rows.map((r) => r.id) };
  });

  // Users the caller may not see are left out (not nulled): released apps parse `online` as non-null.
  app.get("/v1/presence", auth, async (req) => {
    const { userId } = me(req);
    const { ids } = parse(PresenceQuery, req.query);
    const wanted = [...new Set(ids.split(",").filter(Boolean))].slice(0, 200);
    const rows = wanted.length
      ? // Disabled and deleted accounts are left out: their last-seen time stays in memory until the server restarts.
        (ctx.db.prepare(`SELECT * FROM users WHERE disabled_at IS NULL AND id IN (${wanted.map(() => "?").join(",")})`).all(...wanted) as ProfileRow[])
      : [];
    // Each person's "last seen" setting decides (contacts by default, the rule this endpoint always had).
    const list = rows.filter((u) => canSeeLastSeen(ctx, userId, u)).map((u) => u.id);
    return {
      presence: rows
        .filter((u) => list.includes(u.id))
        .map((u) => ({ userId: u.id, online: appearsOnline(ctx, u), presence: shownPresence(ctx, u), lastSeenAt: ctx.hub.lastSeenAt(u.id) })),
    };
  });
}
