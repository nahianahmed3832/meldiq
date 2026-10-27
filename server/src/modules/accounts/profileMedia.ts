import { PROFILE_DECORATIONS, PROFILE_EFFECTS } from "../../shared/contracts/http/users.js";

/** Profile media and style as stored on a user row (API 0.45.0, docs/PROFILE_MEDIA.md); routes in profileMediaRoutes.ts. */
export type AvatarMedia = { kind: "gif" | "webp" | "video"; rev: number };
export type Banner = { kind: "jpeg" | "gif" | "webp"; rev: number };
export type Style = { decoration: string | null; effect: string | null; accent: string | null };

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
  return {
    decoration: PROFILE_DECORATIONS.includes(s.decoration as never) ? (s.decoration as string) : null,
    effect: PROFILE_EFFECTS.includes(s.effect as never) ? (s.effect as string) : null,
    accent: typeof s.accent === "string" && /^#[0-9a-f]{6}$/.test(s.accent) ? s.accent : null,
  };
}

/** The profile fields this adds, for a viewer who may see the photo (the style is shown to everyone). */
export function profileMediaView(u: { avatar_media?: string | null; profile_banner?: string | null; profile_style?: string | null }, photoAllowed: boolean) {
  const out: Record<string, unknown> = {};
  const a = avatarMediaOf(u);
  const b = bannerOf(u);
  if (photoAllowed && a) out.avatarMedia = a;
  if (photoAllowed && b) out.profileBanner = b;
  const s = styleOf(u);
  if (s.decoration || s.effect || s.accent) out.profileStyle = s;
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
