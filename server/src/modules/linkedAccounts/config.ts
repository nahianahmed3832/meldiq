/**
 * Linked accounts (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md): Steam, AniList, Last.fm and Trakt. Each one is off
 * until its keys are set, and all of them need the API's public address (PUBLIC_API_URL: the providers send people back
 * to /v2/connections/:provider/callback there) and the web app's (PUBLIC_WEB_URL, or the first of WEB_ORIGINS: where
 * people land afterwards, on /settings/profile).
 */
export const LINKED_PROVIDERS = ["steam", "anilist", "lastfm", "trakt"] as const;
export type LinkedProvider = (typeof LINKED_PROVIDERS)[number];

export interface LinkedAccountsConfig {
  /** PUBLIC_API_URL without a trailing slash; null: nothing can be connected. */
  apiBase: string | null;
  /** Where people land after connecting (the web app's profile settings); null: nothing can be connected. */
  returnUrl: string | null;
  steam: { apiKey: string } | null;
  anilist: { clientId: string; clientSecret: string } | null;
  lastfm: { apiKey: string; sharedSecret: string } | null;
  trakt: { clientId: string; clientSecret: string } | null;
}

/** An https URL (or http on this machine, for development) without a trailing slash; null when unset. */
function baseUrl(raw: string | undefined, name: string): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name}: "${v}" isn't a URL`);
  }
  const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !local) throw new Error(`${name} must be an https URL`);
  if (u.search || u.hash) throw new Error(`${name} can't have a query or fragment`);
  return v.replace(/\/+$/, "");
}

/** Both of a pair, or neither (half a pair is a mistake worth refusing to start over). */
function pair(env: NodeJS.ProcessEnv, a: string, b: string): [string, string] | null {
  const x = env[a]?.trim();
  const y = env[b]?.trim();
  if (!x && !y) return null;
  if (!x || !y) throw new Error(`${a} and ${b} go together (set both, or neither)`);
  return [x, y];
}

export function linkedAccountsConfig(env: NodeJS.ProcessEnv, webOrigins: readonly string[]): LinkedAccountsConfig {
  const web = baseUrl(env.PUBLIC_WEB_URL, "PUBLIC_WEB_URL") ?? webOrigins[0] ?? null;
  const steamKey = env.STEAM_API_KEY?.trim();
  const anilist = pair(env, "ANILIST_CLIENT_ID", "ANILIST_CLIENT_SECRET");
  const lastfm = pair(env, "LASTFM_API_KEY", "LASTFM_SHARED_SECRET");
  const trakt = pair(env, "TRAKT_CLIENT_ID", "TRAKT_CLIENT_SECRET");
  return {
    apiBase: baseUrl(env.PUBLIC_API_URL, "PUBLIC_API_URL"),
    returnUrl: web ? `${web}/settings/profile` : null,
    steam: steamKey ? { apiKey: steamKey } : null,
    anilist: anilist ? { clientId: anilist[0], clientSecret: anilist[1] } : null,
    lastfm: lastfm ? { apiKey: lastfm[0], sharedSecret: lastfm[1] } : null,
    trakt: trakt ? { clientId: trakt[0], clientSecret: trakt[1] } : null,
  };
}
