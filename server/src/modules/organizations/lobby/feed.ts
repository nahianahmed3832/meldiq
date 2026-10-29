import type { z } from "zod/v4";
import { LOBBY_LIMITS, type LobbyFeedPostBody } from "../../../shared/contracts/http/communityLobby.js";
import { ApiError } from "../../../shared/errors.js";

/**
 * The lobby's incoming feed (community parity B): apps and services POST to a secret URL and the newest posts show in
 * the lobby. Meldiq's own body is `{title, text, url, image}`; a Discord-style webhook body works too. Links must be
 * https; pictures only come from hosts on the allowlist (others are dropped, the post still goes in), so a feed can't
 * make members' apps load images from anywhere.
 */

/** Picture hosts every server allows (a host and its subdomains): YouTube, Twitch and Imgur thumbnails. */
export const DEFAULT_FEED_IMAGE_HOSTS: readonly string[] = ["youtube.com", "ytimg.com", "twitch.tv", "jtvnw.net", "imgur.com"];

export interface FeedPost {
  title: string | null;
  text: string | null;
  url: string | null;
  image: string | null;
}

type Body = z.infer<typeof LobbyFeedPostBody>;

/** [s] trimmed and cut to [max] characters (with an ellipsis), or null when there's nothing left. */
function clip(s: string | null | undefined, max: number): string | null {
  const t = s?.trim();
  if (!t) return null;
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : t;
}

/** An https URL as it should be stored, or null when [raw] isn't one. */
function httpsUrl(raw: string | null | undefined): URL | null {
  const t = raw?.trim();
  if (!t || t.length > LOBBY_LIMITS.url) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

/** Whether [host] is [allowed] or one of its subdomains. */
const hostAllowed = (host: string, allowed: readonly string[]) => allowed.some((a) => host === a || host.endsWith(`.${a}`));

/** The picture if it's an https link to an allowed host; dropped otherwise. */
function allowedImage(raw: string | null | undefined, hosts: readonly string[]): string | null {
  const u = httpsUrl(raw);
  return u && hostAllowed(u.hostname.toLowerCase(), hosts) ? u.toString() : null;
}

/** Meldiq's own fields, or the first embed of a Discord-style body (its description, or the content, as text). */
function fields(body: Body): { title?: string | null; text?: string | null; url?: string | null; image?: string | null } {
  const embed = body.embeds?.[0];
  const image = typeof body.image === "string" ? body.image : (body.image?.url ?? null);
  if (body.title || body.text || body.url || image || !embed) return { title: body.title, text: body.text ?? body.content, url: body.url, image };
  return { title: embed.title, text: embed.description ?? body.content, url: embed.url, image: embed.image?.url ?? embed.thumbnail?.url };
}

/**
 * The post [body] makes, cut to the lobby's limits. 400 lobby_feed_invalid when the link isn't https or there's
 * nothing to show.
 */
export function parseFeedPost(body: Body, imageHosts: readonly string[]): FeedPost {
  const f = fields(body);
  const url = f.url?.trim() ? httpsUrl(f.url) : null;
  if (f.url?.trim() && !url) throw new ApiError(400, "lobby_feed_invalid", "Links in the lobby feed must start with https://", { field: "url" });
  const post: FeedPost = {
    title: clip(f.title, LOBBY_LIMITS.feedTitle),
    text: clip(f.text, LOBBY_LIMITS.feedText),
    url: url?.toString() ?? null,
    image: allowedImage(f.image, imageHosts),
  };
  if (!post.title && !post.text && !post.url) throw new ApiError(400, "lobby_feed_invalid", "A lobby feed post needs a title, text or an https link");
  return post;
}
