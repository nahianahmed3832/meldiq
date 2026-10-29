import type { RowReader, RowWriter } from "../../../infrastructure/database/rows/index.js";
import { ApiError } from "../../../shared/errors.js";
import { newId, sha256Hex } from "../../../shared/utilities/util.js";
import { INVITE_SLUG, NEVER_EXPIRES_AT, NO_USE_LIMIT } from "../invites.js";

/**
 * A community's custom invite link (community parity A3, docs/COMMUNITY_SETTINGS_API.md): meldiq.app/invite/<slug>.
 * The slug leads to an ordinary invitation that never expires and has no use limit, made by whoever set the slug, so
 * every join rule (bans, paused joining, member limits, the inviter still able to invite) applies as to any code.
 * lookupOrgInvite (invites.ts) resolves it wherever a code is accepted.
 */

/** Words no community may claim: Meldiq's own pages and names, and words people would read as official. */
const RESERVED_SLUGS = new Set([
  "about", "admin", "api", "app", "apps", "billing", "blog", "community", "communities", "discover", "download",
  "everyone", "help", "here", "home", "invite", "invites", "login", "meldiq", "meldling", "mod", "mods", "moderator",
  "mojo", "null", "official", "privacy", "root", "security", "settings", "signin", "signup", "spark", "staff",
  "support", "system", "team", "terms", "undefined", "www",
]);

interface VanityRow {
  slug: string;
  org_id: string;
  invite_id: string;
}

/** The slug as stored (lower case), or 400 invite_slug_invalid. */
export function normalizeInviteSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!INVITE_SLUG.test(slug) || RESERVED_SLUGS.has(slug)) {
    throw new ApiError(400, "invite_slug_invalid", "Use 3 to 32 lowercase letters, digits or hyphens (not at either end) that aren't a reserved word", { slug });
  }
  return slug;
}

/** [orgId]'s custom invite link, or null. */
export function inviteSlugOf(rows: RowReader, orgId: string): string | null {
  return rows.get<VanityRow>("community_vanity_invites", { org_id: orgId })?.slug ?? null;
}

/** 409 invite_slug_taken when another community holds [slug] (case ignored). */
export function requireSlugFree(rows: RowReader, orgId: string, slug: string): void {
  const holder = rows.get<VanityRow>("community_vanity_invites", { slug });
  if (holder && holder.org_id !== orgId) throw new ApiError(409, "invite_slug_taken", "Another community already uses that invite link", { slug });
}

/**
 * Sets [orgId]'s slug inside the write unit [w]. A change keeps the same invitation (its uses carry over) and makes
 * [actorId] its creator, so the link works for as long as the last person who set it may invite people.
 */
export function claimInviteSlug(w: RowWriter, orgId: string, actorId: string, slug: string, t: number): void {
  requireSlugFree(w, orgId, slug);
  const current = w.get<VanityRow>("community_vanity_invites", { org_id: orgId });
  const live = current ? w.get<{ revoked_at: number | null }>("invitations", { id: current.invite_id }) : undefined;
  const inviteId = current && live && !live.revoked_at ? current.invite_id : newId("inv");
  if (inviteId === current?.invite_id) {
    w.update("invitations", { id: inviteId }, { created_by: actorId, code_hint: slug.slice(-4) });
  } else {
    w.insert("invitations", {
      id: inviteId,
      org_id: orgId,
      // Never a code anyone can type: the invitation is reached through the slug only.
      code_hash: sha256Hex(`vanity:${inviteId}`),
      code_hint: slug.slice(-4),
      role: "MEMBER",
      max_uses: NO_USE_LIMIT,
      created_by: actorId,
      created_at: t,
      expires_at: NEVER_EXPIRES_AT,
    });
  }
  if (current) w.delete("community_vanity_invites", { org_id: orgId });
  w.insert("community_vanity_invites", { slug, org_id: orgId, invite_id: inviteId, claimed_by: actorId, claimed_at: t });
}

/** Frees [orgId]'s slug and revokes its invitation (inside [w]); whether there was one. */
export function releaseInviteSlug(w: RowWriter, orgId: string, t: number): boolean {
  const current = w.get<VanityRow>("community_vanity_invites", { org_id: orgId });
  if (!current) return false;
  w.delete("community_vanity_invites", { org_id: orgId });
  w.update("invitations", { id: current.invite_id, revoked_at: null }, { revoked_at: t });
  return true;
}
