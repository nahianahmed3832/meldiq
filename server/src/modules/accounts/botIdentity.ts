import crypto from "node:crypto";
import type { AppContext } from "../../app/context.js";
import { zUsername } from "../../shared/contracts/http/auth.js";
import { rowsByIds } from "../../infrastructure/database/byIds.js";
import { ApiError } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { photoBlobId, storePhoto } from "./photos.js";
import { announceProfileChange } from "./profileEvents.js";
import { usernameCandidate } from "./identity.js";

/**
 * Bot accounts (API 0.65.0, settings parity batch B). A bot is a users row of kind 'agent', the kind AI agents' bot
 * identities had before 0.47.0 (migration 053 allows only 'person' and 'agent', so no schema change). Everything that
 * means people only already leaves that kind out: search, direct messages, suggestions, delivery queues, points. A bot
 * has no account (no email, no password), no device and an identity key nobody holds the private half of, so it can
 * never sign in; it acts only through its token on /v2/bot/… (modules/bots).
 */
export const BOT_KIND = "agent";

const AVATAR_COLORS = 16;
const USERNAME_ATTEMPTS = 8;

/** Whether [userId] is a bot account (profiles show `bot: true`). */
export function isBotUser(ctx: Pick<AppContext, "identity">, userId: string): boolean {
  return ctx.identity.get<{ kind: string }>("users", { id: userId })?.kind === BOT_KIND;
}

/** Which of [ids] are bot accounts. */
export function botsAmong(ctx: Pick<AppContext, "identity">, ids: Iterable<string>): string[] {
  return rowsByIds<{ id: string; kind: string }>(ctx.identity, "users", "id", ids, "id, kind")
    .filter((r) => r.kind === BOT_KIND)
    .map((r) => r.id);
}

function takenOrHeld(ctx: AppContext, username: string): boolean {
  return !!ctx.identity.get("users", { username }) || ctx.usernames.heldFromOthers(username);
}

function botUsername(ctx: AppContext, wanted: string | undefined, name: string): string {
  if (wanted) {
    const parsed = zUsername.safeParse(wanted);
    if (!parsed.success) throw new ApiError(400, "bad_username", parsed.error.issues[0]?.message ?? "That username isn't allowed");
    if (takenOrHeld(ctx, parsed.data)) throw new ApiError(409, "username_taken", "That username is already taken");
    return parsed.data;
  }
  for (let i = 0; i < USERNAME_ATTEMPTS; i++) {
    const stem = name.trim().slice(0, 13);
    const c = usernameCandidate(/bot$/i.test(stem) ? stem : `${stem}bot`);
    if (zUsername.safeParse(c).success && !takenOrHeld(ctx, c)) return c;
  }
  return `bot${crypto.randomBytes(5).toString("hex")}`;
}

/** Makes a bot's account: its user id is the bot's id. */
export async function createBotIdentity(ctx: AppContext, displayName: string, wantedUsername?: string): Promise<{ userId: string; username: string; createdAt: number }> {
  const username = botUsername(ctx, wantedUsername, displayName);
  const userId = newId("u");
  const t = now();
  try {
    await ctx.identity.write((w) =>
      w.insert("users", {
        id: userId,
        username,
        display_name: displayName,
        // 32 random bytes nobody has the private key of: no device certificate can ever be made for a bot.
        identity_key: crypto.randomBytes(32).toString("base64"),
        avatar_color: crypto.randomInt(0, AVATAR_COLORS),
        created_at: t,
        updated_at: t,
        kind: BOT_KIND,
      }),
    );
  } catch (e) {
    if (String(e).includes("users.username") || String(e).includes("duplicate key")) throw new ApiError(409, "username_taken", "That username is already taken");
    throw e;
  }
  ctx.audit({ actorId: userId, action: "bot.identity_create", target: userId });
  return { userId, username, createdAt: t };
}

/** A bot's display name, changed by its owner. */
export async function renameBotIdentity(ctx: AppContext, userId: string, displayName: string): Promise<void> {
  await ctx.identity.write((w) => w.update("users", { id: userId, kind: BOT_KIND }, { display_name: displayName, updated_at: now() }));
  announceProfileChange(ctx, userId);
}

/**
 * A bot account's picture (community parity batch D: an official bot's picture in one community), a JPEG, or null for
 * the standard one. Served like anyone's at GET /v1/users/:id/photo. Returns the new photo revision.
 */
export async function setBotPhoto(ctx: AppContext, userId: string, jpeg: Buffer | null): Promise<number | null> {
  const previous = ctx.identity.get<{ photo_rev: number | null }>("users", { id: userId, kind: BOT_KIND })?.photo_rev ?? null;
  const rev = jpeg ? Math.max(now(), (previous ?? 0) + 1) : null;
  if (jpeg && rev) await storePhoto(ctx, photoBlobId(userId, rev), jpeg);
  await ctx.identity.write((w) => w.update("users", { id: userId, kind: BOT_KIND }, { photo_rev: rev, updated_at: now() }));
  if (previous) ctx.files.queueBlobDelete("profile-photos", photoBlobId(userId, previous));
  announceProfileChange(ctx, userId);
  return rev;
}
