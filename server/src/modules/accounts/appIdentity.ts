import type { Readable } from "node:stream";
import type { AppContext } from "../../app/context.js";
import { photoBlobId } from "./photos.js";
import { privacyOf } from "./profile.js";

/**
 * What "Log in with Meldiq" may tell an app about the person who signed in (API 0.65.0, modules/oauth). Only what the
 * consent screen named: the username, display name and a profile picture the person shows everyone, and, with the
 * email scope, their email once it's verified. Gone, disabled and bot accounts, and people on other servers, have none.
 */
export interface AppIdentity {
  id: string;
  username: string;
  displayName: string;
  /** The current photo's revision when everyone may see it; null otherwise. */
  photoRev: number | null;
  /** Verified email only. */
  email: string | null;
}

type Row = { id: string; username: string; display_name: string; photo_rev: number | null; privacy: string | null; kind: string; home_server_id: string | null };

export async function appIdentity(ctx: AppContext, userId: string): Promise<AppIdentity | null> {
  const u = ctx.identity.get<Row>("users", { id: userId, disabled_at: null, deleted_at: null });
  if (!u || u.kind !== "person" || u.home_server_id) return null;
  const account = await ctx.accounts.store.accountByUserId(userId);
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    photoRev: u.photo_rev && privacyOf(u).photo === "everyone" ? u.photo_rev : null,
    email: account?.email_verified_at ? account.email : null,
  };
}

/** The bytes of [userId]'s photo [rev] (JPEG), or null. */
export async function photoBytes(ctx: AppContext, userId: string, rev: number): Promise<Readable | null> {
  return (await ctx.blobs.get("profile-photos", photoBlobId(userId, rev))) ?? (await ctx.blobs.get("profile-photos", userId));
}
