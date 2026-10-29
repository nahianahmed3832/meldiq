import { jpegInfo, pngInfo, sniff, webpInfo } from "../mediaFormats.js";

/**
 * Creator verification rules (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md). Pure functions, no I/O.
 */

/** What a proof screenshot may be, recognised by its bytes. */
export const PROOF_TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
export type ProofType = (typeof PROOF_TYPES)[keyof typeof PROOF_TYPES];

/** Most posts waiting to be counted, per person. */
export const MAX_UNCOUNTED_POSTS = 200;

/** A name as the rule compares it: lower case, without spaces, "_", "." or a leading "@". */
export const normalizedName = (name: string): string =>
  name
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[\s_.]+/g, "");

/** Whether [channelName] matches [name] under that rule (an empty name never matches). */
export function sameName(channelName: string, name: string | null | undefined): boolean {
  if (!name) return false;
  const a = normalizedName(channelName);
  return a.length > 0 && a === normalizedName(name);
}

/** The line a creator puts in their channel's bio; null without a username. */
export const codeLineFor = (username: string | null | undefined): string | null => (username ? `meldiq: ${username}` : null);

/** The proof's media type when [buf] is a PNG, JPEG or WebP that parses; null otherwise. */
export function proofType(buf: Buffer): ProofType | null {
  const kind = sniff(buf);
  if (kind === "png") return pngInfo(buf) ? PROOF_TYPES.png : null;
  if (kind === "jpeg") return jpegInfo(buf) ? PROOF_TYPES.jpeg : null;
  if (kind === "webp") return webpInfo(buf) ? PROOF_TYPES.webp : null;
  return null;
}

/**
 * Whether an approved channel still earns the Creator badge for someone whose username is now [username]: it does
 * while the username is the one they had when it was approved (it may have matched their display name then, and
 * display names can change freely), or while the new username still matches the channel's name.
 */
export const approvalHolds = (a: { channelName: string; usernameAtApproval: string | null }, username: string | null): boolean =>
  (username !== null && username === a.usernameAtApproval) || sameName(a.channelName, username);
