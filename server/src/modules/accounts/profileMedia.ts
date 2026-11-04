import { CollectibleLook } from "../../shared/contracts/http/collectibles.js";
import { createHash } from "node:crypto";
import type { AppContext } from "../../app/context.js";
import { DECORATION_ID } from "../../shared/contracts/http/decorations.js";
import { NAME_EFFECTS, NAME_FONTS, PROFILE_DECORATIONS, PROFILE_EFFECTS, SHOWABLE_BADGES, ProfileLayout, type ShowableBadge } from "../../shared/contracts/http/users.js";
import type { z } from "zod/v4";

/** Profile media and style as stored on a user row (API 0.45.0, docs/PROFILE_MEDIA.md); routes in profileMediaRoutes.ts. */
export type AvatarMedia = { kind: "gif" | "webp" | "video"; rev: number };
export type Banner = { kind: "jpeg" | "gif" | "webp"; rev: number };
export type Style = {
  layout?: z.infer<typeof ProfileLayout> | null;
  collectibles?: CollectibleLook[];
  decoration: string | null;
  effect: string | null;
  accent: string | null;
  /** API 0.46.0: name styles and the worn community tag (docs/PROFILE_MEDIA.md). */
  nameFont: string | null;
  nameColors: string[] | null;
  nameEffect: string | null;
  tagOrgId: string | null;
  /** API 0.65.0: a two-colour profile theme (one colour is allowed too), and the badge shown next to the name. */
  themeColors: string[] | null;
  shownBadge: ShowableBadge | "none" | null;
};
const HEX = /^#[0-9a-f]{6}$/;

/** Blob ids in the profile-photos store, beside the photo ("<owner>-<rev>", as photos.ts names them). */
const blobId = (owner: string, rev: number) => `${owner.replace(/[^A-Za-z0-9_-]/g, "")}-${rev}`;
export const avatarBlob = (userId: string, rev: number) => blobId(`${userId}_avatar`, rev);
export const posterBlob = (userId: string, rev: number) => blobId(`${userId}_poster`, rev);
export const bannerBlob = (userId: string, rev: number) => blobId(`${userId}_pbanner`, rev);

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
export const avatarMediaOf = (u: { avatar_media?: string | null }) => parseJson<AvatarMedia>(u.avatar_media);
export const bannerOf = (u: { profile_banner?: string | null }) => parseJson<Banner>(u.profile_banner);
export function styleOf(u: { profile_style?: string | null }): Style {
  const s = parseJson<Partial<Style>>(u.profile_style) ?? {};
  const looks = CollectibleLook.array().max(8).safeParse(s.collectibles);
  const layout = ProfileLayout.safeParse(s.layout);
  return {
    ...(layout.success ? { layout: layout.data } : {}),
    ...(looks.success && looks.data.length ? { collectibles: looks.data } : {}),
    // A classic frame, or (API 0.61.0) one of Meldiq's own or a community one; one taken down is cleared from its wearers.
    decoration: typeof s.decoration === "string" && (PROFILE_DECORATIONS.includes(s.decoration as never) || DECORATION_ID.test(s.decoration)) ? s.decoration : null,
    effect: PROFILE_EFFECTS.includes(s.effect as never) ? (s.effect as string) : null,
    accent: typeof s.accent === "string" && HEX.test(s.accent) ? s.accent : null,
    nameFont: NAME_FONTS.includes(s.nameFont as never) ? (s.nameFont as string) : null,
    nameColors: Array.isArray(s.nameColors) && s.nameColors.length >= 1 && s.nameColors.length <= 3 && s.nameColors.every((c) => typeof c === "string" && HEX.test(c)) ? s.nameColors : null,
    nameEffect: NAME_EFFECTS.includes(s.nameEffect as never) ? (s.nameEffect as string) : null,
    tagOrgId: typeof s.tagOrgId === "string" && s.tagOrgId ? s.tagOrgId : null,
    themeColors: Array.isArray(s.themeColors) && s.themeColors.length >= 1 && s.themeColors.length <= 2 && s.themeColors.every((c) => typeof c === "string" && HEX.test(c)) ? s.themeColors : null,
    shownBadge: s.shownBadge === "none" || SHOWABLE_BADGES.includes(s.shownBadge as never) ? (s.shownBadge as Style["shownBadge"]) : null,
  };
}

/** Whether a style has anything to show (an all-null style is left out of views). */
const styled = (s: Style) => Object.values(s).some((v) => v !== null);

/** The community tag [u] wears, if they're still in that community and it still has a tag (API 0.46.0). */
export function wornTag(ctx: AppContext, u: { id: string; profile_style?: string | null }): { orgId: string; text: string; color: string | null } | null {
  const orgId = styleOf(u).tagOrgId;
  const tag = orgId ? ctx.authz.communityTag(orgId, u.id) : null;
  return orgId && tag ? { orgId, ...tag } : null;
}

/**
 * The profile fields this adds, for a viewer who may see the photo (the style is shown to everyone). [holds] says
 * whether the person still has a badge: a shown badge they lost reads as null (API 0.65.0).
 */
export function profileMediaView(
  u: {
    avatar_media?: string | null;
    profile_banner?: string | null;
    profile_style?: string | null;
  },
  photoAllowed: boolean,
  holds?: (badge: ShowableBadge) => boolean,
) {
  const out: Record<string, unknown> = {};
  const a = avatarMediaOf(u);
  const b = bannerOf(u);
  if (photoAllowed && a) out.avatarMedia = a;
  if (photoAllowed && b) out.profileBanner = b;
  const stored = styleOf(u);
  const lost = stored.shownBadge !== null && stored.shownBadge !== "none" && holds !== undefined && !holds(stored.shownBadge);
  const s = lost ? { ...stored, shownBadge: null } : stored;
  if (styled(s)) out.profileStyle = s;
  return out;
}

/** For account deletion: every profile file of a user. */
export function profileMediaBlobs(u: { id: string; avatar_media?: string | null; profile_banner?: string | null }): string[] {
  const out: string[] = [];
  const a = avatarMediaOf(u);
  const b = bannerOf(u);
  if (a) out.push(avatarBlob(u.id, a.rev), ...(a.kind === "video" ? [posterBlob(u.id, a.rev)] : []));
  if (b) out.push(bannerBlob(u.id, b.rev));
  return out;
}

/** Revision for an atomic, optional style precondition; old clients may omit it. */
export const styleRevision = (u: { profile_style?: string | null }) =>
  createHash("sha256")
    .update(JSON.stringify(styleOf(u)))
    .digest("hex");
