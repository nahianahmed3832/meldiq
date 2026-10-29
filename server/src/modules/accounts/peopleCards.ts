import type { AppContext } from "../../app/context.js";
import { mapByIds } from "../../infrastructure/database/byIds.js";
import { appearsOnline, privacyOf } from "./profile.js";

/** A person as lists in other modules show them: names, colour, and their photo only when everyone may see it. */
export interface PersonCard {
  id: string;
  username: string;
  displayName: string;
  avatarColor: number;
  photoRev: number | null;
}

interface CardRow {
  id: string;
  username: string;
  display_name: string;
  avatar_color: number;
  photo_rev: number | null;
  privacy: string | null;
  deleted_at: number | null;
  [k: string]: unknown;
}

/** Cards for [ids] that are live accounts (community parity B: the lobby's staff, rooms and leaderboards). */
export function personCards(ctx: Pick<AppContext, "identity">, ids: Iterable<string>): Map<string, PersonCard> {
  const rows = mapByIds<CardRow>(ctx.identity, "users", "id", ids, "id, username, display_name, avatar_color, photo_rev, privacy, deleted_at");
  const out = new Map<string, PersonCard>();
  for (const [id, u] of rows) {
    if (u.deleted_at) continue;
    const photo = privacyOf(u).photo === "everyone" && u.photo_rev ? u.photo_rev : null;
    out.set(id, { id, username: u.username, displayName: u.display_name, avatarColor: u.avatar_color, photoRev: photo });
  }
  return out;
}

/** How many of [ids] appear online now (connected and not invisible); only connected people are looked up. */
export function onlineCount(ctx: AppContext, ids: readonly string[]): number {
  return ids.filter((id) => ctx.hub.isUserOnline(id) && appearsOnline(ctx, id)).length;
}
