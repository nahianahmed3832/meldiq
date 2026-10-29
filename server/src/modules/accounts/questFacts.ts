import type { AppContext } from "../../app/context.js";
import { avatarMediaOf, styleOf } from "./profileMedia.js";

/** What the points module's one-time quests and its new-account rule read about a person (API 0.65.0). */
export interface AccountFacts {
  createdAt: number;
  /** A profile photo or an animated avatar. */
  avatar: boolean;
  aboutMe: boolean;
  /** A decoration worn now. */
  decoration: boolean;
  /** At least one accepted connection. */
  friend: boolean;
  twoStep: boolean;
}

/** [userId]'s facts, or null for an account that can't earn at all (gone, disabled, or not a person). */
export async function accountFacts(ctx: AppContext, userId: string): Promise<AccountFacts | null> {
  type Row = { created_at: number; photo_rev: number | null; avatar_media: string | null; about_me: string | null; profile_style: string | null; kind: string; home_server_id: string | null };
  const u = ctx.identity.get<Row>("users", { id: userId, disabled_at: null });
  if (!u || u.kind !== "person" || u.home_server_id) return null;
  const connections = await ctx.relationships.connectionsOf(userId);
  const account = await ctx.accounts.store.accountByUserId(userId);
  return {
    createdAt: u.created_at,
    avatar: !!u.photo_rev || !!avatarMediaOf(u),
    aboutMe: !!u.about_me,
    decoration: !!styleOf(u).decoration,
    friend: connections.some((c) => c.state === "accepted"),
    twoStep: !!account && !!ctx.safety.get<{ enabled_at: number | null }>("account_totp", { account_id: account.id })?.enabled_at,
  };
}

/** Whether [userId] is a local, enabled person created before [before] (the points module's new-account rule). */
export function createdBefore(ctx: AppContext, userId: string, before: number): boolean {
  const u = ctx.identity.get<{ created_at: number; kind: string; home_server_id: string | null }>("users", { id: userId, disabled_at: null });
  return !!u && u.kind === "person" && !u.home_server_id && u.created_at < before;
}
