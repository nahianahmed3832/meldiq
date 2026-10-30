/**
 * Alerts' window on YouTube (community parity batch D part 2): the YouTube Data API v3 with the server's
 * YOUTUBE_API_KEY. Kept behind VideoSource so tests (and a future second provider) never touch the real API. A pasted
 * link or handle becomes a channel id and its uploads playlist once (channels.list, 1 quota unit); each check reads
 * that playlist's newest items (playlistItems.list, 1 unit).
 */

/** What someone pasted, as YouTube can look it up. */
export type ChannelRef = { handle: string } | { id: string } | { username: string };

export interface YoutubeChannel {
  id: string;
  title: string;
  uploadsId: string;
}

export interface Upload {
  videoId: string;
  title: string;
  publishedAt: number;
}

export interface VideoSource {
  /** The channel [ref] names, or null when YouTube doesn't know it. */
  channel(ref: ChannelRef): Promise<YoutubeChannel | null>;
  /** The newest uploads of a channel's uploads playlist, newest first. */
  uploads(uploadsId: string): Promise<Upload[]>;
}

const API = "https://www.googleapis.com/youtube/v3";
const TIMEOUT_MS = 10_000;
const NEWEST = 10;
const HANDLE = /^@?([A-Za-z0-9._-]{3,30})$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/** youtube.com/@handle, /channel/UC…, /user/name, "@handle" or a bare channel id; null for anything else. */
export function parseChannelRef(input: string): ChannelRef | null {
  const text = input.trim();
  if (CHANNEL_ID.test(text)) return { id: text };
  if (text.startsWith("@")) {
    const m = HANDLE.exec(text);
    return m ? { handle: m[1]! } : null;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const [first, second] = url.pathname.split("/").filter(Boolean);
  if (first?.startsWith("@")) {
    const m = HANDLE.exec(first);
    return m ? { handle: m[1]! } : null;
  }
  if (first === "channel" && second && CHANNEL_ID.test(second)) return { id: second };
  if ((first === "user" || first === "c") && second && /^[A-Za-z0-9._-]{1,100}$/.test(second)) return { username: second };
  return null;
}

/** The real thing: YouTube Data API v3 with [apiKey] ([get] is injectable for tests of this file alone). */
export function youtubeSource(apiKey: string, get: typeof fetch = fetch): VideoSource {
  const call = async (path: string, params: Record<string, string>): Promise<{ items?: unknown[] }> => {
    const res = await get(`${API}/${path}?${new URLSearchParams({ ...params, key: apiKey })}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    // The key is in the address: never put it in an error.
    if (!res.ok) throw new Error(`YouTube ${path} answered ${res.status}`);
    return (await res.json()) as { items?: unknown[] };
  };
  return {
    async channel(ref) {
      const by: Record<string, string> = "handle" in ref ? { forHandle: `@${ref.handle}` } : "id" in ref ? { id: ref.id } : { forUsername: ref.username };
      const item = (await call("channels", { part: "snippet,contentDetails", ...by })).items?.[0] as
        | { id?: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }
        | undefined;
      const uploadsId = item?.contentDetails?.relatedPlaylists?.uploads;
      return item?.id && uploadsId ? { id: item.id, title: item.snippet?.title ?? item.id, uploadsId } : null;
    },
    async uploads(uploadsId) {
      const items = (await call("playlistItems", { part: "snippet,contentDetails", playlistId: uploadsId, maxResults: String(NEWEST) })).items ?? [];
      return items.flatMap((raw) => {
        const it = raw as { snippet?: { title?: string; publishedAt?: string }; contentDetails?: { videoId?: string; videoPublishedAt?: string } };
        const videoId = it.contentDetails?.videoId;
        const publishedAt = Date.parse(it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt ?? "");
        return videoId && Number.isFinite(publishedAt) ? [{ videoId, title: it.snippet?.title ?? "A new video", publishedAt }] : [];
      });
    },
  };
}
