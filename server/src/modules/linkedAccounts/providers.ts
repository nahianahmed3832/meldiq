import crypto from "node:crypto";
import { z } from "zod/v4";
import type { LinkedItem, LinkedItemsKind } from "../../shared/contracts/http/linkedAccounts.js";
import type { LinkedAccountsConfig, LinkedProvider } from "./config.js";
import { type Outbound, ProviderError } from "./outbound.js";

/**
 * Steam (OpenID 2.0), AniList (OAuth 2), Last.fm (web auth) and Trakt (OAuth 2 with PKCE), as far as showing who
 * someone is there and a few public things goes. Every answer is validated, every text is cut to one short line, and
 * every link shown is built here from ids (never taken from the provider's answer).
 */

export interface PublicProfile {
  externalId: string;
  name: string;
  url: string;
  itemsKind: LinkedItemsKind;
  items: LinkedItem[];
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export interface Finished {
  profile: PublicProfile;
  tokens: Tokens | null;
}

export interface CallbackInput {
  query: Record<string, string>;
  /** /v2/connections/:provider/callback on PUBLIC_API_URL. */
  callback: string;
  /** The PKCE verifier recorded at start. */
  verifier: string;
}

/** The person turned the provider down on its own page. */
export class ConnectDenied extends Error {}

export interface Provider {
  readonly id: LinkedProvider;
  authorizeUrl(callback: string, state: string, challenge: string): string;
  finish(input: CallbackInput): Promise<Finished>;
  /** Fresh public data for a connected account (no tokens needed: public profiles only). */
  refresh(account: { externalId: string; name: string }): Promise<PublicProfile>;
  /** Best effort: tells the provider to forget the tokens. */
  revoke?(tokens: Tokens): Promise<void>;
}

const MAX_ITEMS = 5;

/** One line of plain text, at most [max] characters. */
export function clean(v: unknown, max = 120): string {
  return String(v ?? "")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const item = (title: unknown, subtitle: unknown, url: string | null): LinkedItem => ({ title: clean(title) || "?", subtitle: clean(subtitle) || null, url });
const withQuery = (base: string, params: Record<string, string>) => `${base}?${new URLSearchParams(params).toString()}`;

// Steam ---------------------------------------------------------------------------------------------------------------

const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const STEAM_API = "https://api.steampowered.com";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";
const STEAM_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

const SteamPlayers = z.object({ response: z.object({ players: z.array(z.object({ steamid: z.string(), personaname: z.string() })) }) });
const SteamRecent = z.object({ response: z.object({ games: z.array(z.object({ appid: z.number().int(), name: z.string().optional() })).optional() }) });

function steam(cfg: NonNullable<LinkedAccountsConfig["steam"]>, http: Outbound): Provider {
  return {
    id: "steam",
    authorizeUrl(callback, state) {
      return withQuery(STEAM_OPENID, {
        "openid.ns": OPENID_NS,
        "openid.mode": "checkid_setup",
        "openid.return_to": `${callback}?state=${encodeURIComponent(state)}`,
        "openid.realm": new URL(callback).origin,
        "openid.identity": IDENTIFIER_SELECT,
        "openid.claimed_id": IDENTIFIER_SELECT,
      });
    },
    async finish({ query, callback }) {
      if (query["openid.mode"] === "cancel") throw new ConnectDenied();
      const id = STEAM_ID.exec(query["openid.claimed_id"] ?? "")?.[1];
      const returnTo = `${callback}?state=${encodeURIComponent(query.state ?? "")}`;
      if (query["openid.mode"] !== "id_res" || query["openid.op_endpoint"] !== STEAM_OPENID || query["openid.return_to"] !== returnTo || !id || query["openid.identity"] !== query["openid.claimed_id"]) {
        throw new ProviderError("steam", 400, "Steam's answer isn't a sign-in for this server");
      }
      // Ask Steam itself whether it made this assertion (OpenID 2.0 §11.4.2, direct verification).
      const form = Object.fromEntries(Object.entries(query).filter(([k]) => k.startsWith("openid.")));
      const verdict = await http.text("steam", STEAM_OPENID, { form: { ...form, "openid.mode": "check_authentication" } });
      if (!/^is_valid\s*:\s*true\s*$/m.test(verdict)) throw new ProviderError("steam", 401, "Steam didn't confirm the sign-in");
      return { profile: await this.refresh({ externalId: id, name: "" }), tokens: null };
    },
    async refresh({ externalId }) {
      const players = await http.json("steam", withQuery(`${STEAM_API}/ISteamUser/GetPlayerSummaries/v2/`, { key: cfg.apiKey, steamids: externalId }), SteamPlayers);
      const player = players.response.players.find((p) => p.steamid === externalId);
      if (!player) throw new ProviderError("steam", 404, "Steam doesn't know that account");
      // A private profile has no recent games: that's an empty list, not a failure.
      const recent = await http.json("steam", withQuery(`${STEAM_API}/IPlayerService/GetRecentlyPlayedGames/v1/`, { key: cfg.apiKey, steamid: externalId, count: String(MAX_ITEMS) }), SteamRecent);
      return {
        externalId,
        name: clean(player.personaname) || externalId,
        url: `https://steamcommunity.com/profiles/${externalId}`,
        itemsKind: "recently-played",
        items: (recent.response.games ?? []).slice(0, MAX_ITEMS).map((g) => item(g.name, null, `https://store.steampowered.com/app/${g.appid}`)),
      };
    },
  };
}

// AniList -------------------------------------------------------------------------------------------------------------

const ANILIST = "https://anilist.co";
const ANILIST_GRAPHQL = "https://graphql.anilist.co";
const AniListToken = z.object({ access_token: z.string().min(1).max(4000), refresh_token: z.string().max(4000).optional(), expires_in: z.number().optional() });
const AniListViewer = z.object({ data: z.object({ Viewer: z.object({ id: z.number().int(), name: z.string() }) }) });
const AniListUser = z.object({
  data: z.object({
    User: z.object({ id: z.number().int(), name: z.string() }).nullable(),
    MediaListCollection: z
      .object({ lists: z.array(z.object({ entries: z.array(z.object({ media: z.object({ id: z.number().int(), title: z.object({ userPreferred: z.string().nullable() }) }) })) })) })
      .nullable()
      .optional(),
  }),
});
const ANILIST_USER_QUERY =
  "query ($id: Int) { User(id: $id) { id name } MediaListCollection(userId: $id, type: ANIME, status: CURRENT, sort: UPDATED_TIME_DESC) { lists { entries { media { id title { userPreferred } } } } } }";

function anilist(cfg: NonNullable<LinkedAccountsConfig["anilist"]>, http: Outbound): Provider {
  return {
    id: "anilist",
    authorizeUrl(callback, state) {
      return withQuery(`${ANILIST}/api/v2/oauth/authorize`, { client_id: cfg.clientId, redirect_uri: callback, response_type: "code", state });
    },
    async finish({ query, callback }) {
      if (query.error) throw new ConnectDenied();
      if (!query.code) throw new ProviderError("anilist", 400, "AniList sent no code");
      const t = await http.json("anilist", `${ANILIST}/api/v2/oauth/token`, AniListToken, {
        json: { grant_type: "authorization_code", client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: callback, code: query.code },
      });
      const viewer = await http.json("anilist", ANILIST_GRAPHQL, AniListViewer, { json: { query: "query { Viewer { id name } }" }, headers: { authorization: `Bearer ${t.access_token}` } });
      const tokens = { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null };
      return { profile: await this.refresh({ externalId: String(viewer.data.Viewer.id), name: viewer.data.Viewer.name }), tokens };
    },
    async refresh({ externalId }) {
      const r = await http.json("anilist", ANILIST_GRAPHQL, AniListUser, { json: { query: ANILIST_USER_QUERY, variables: { id: Number(externalId) } } });
      const user = r.data.User;
      if (!user) throw new ProviderError("anilist", 404, "AniList doesn't know that account");
      const entries = (r.data.MediaListCollection?.lists ?? []).flatMap((l) => l.entries);
      return {
        externalId,
        name: clean(user.name) || externalId,
        url: `${ANILIST}/user/${encodeURIComponent(user.name)}`,
        itemsKind: "watching",
        items: entries.slice(0, MAX_ITEMS).map((e) => item(e.media.title.userPreferred, null, `${ANILIST}/anime/${e.media.id}`)),
      };
    },
  };
}

// Last.fm -------------------------------------------------------------------------------------------------------------

const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_WEB = "https://www.last.fm";
const LastFmSession = z.object({ session: z.object({ name: z.string().min(1).max(100), key: z.string().min(1).max(200) }) });
const LastFmTrack = z.object({ name: z.string(), artist: z.object({ "#text": z.string().optional(), name: z.string().optional() }).optional(), "@attr": z.object({ nowplaying: z.string().optional() }).optional() });
const LastFmRecent = z.object({ recenttracks: z.object({ track: z.union([z.array(LastFmTrack), LastFmTrack]).optional() }) });
const LastFmArtist = z.object({ name: z.string() });
const LastFmTop = z.object({ topartists: z.object({ artist: z.union([z.array(LastFmArtist), LastFmArtist]).optional() }) });

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Last.fm's api_sig: md5 of the parameters sorted by name, each name then value, then the shared secret. */
export function lastFmSignature(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .filter((k) => k !== "format" && k !== "callback")
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
  return crypto.createHash("md5").update(base + secret, "utf8").digest("hex");
}

function lastfm(cfg: NonNullable<LinkedAccountsConfig["lastfm"]>, http: Outbound): Provider {
  const music = (name: string) => `${LASTFM_WEB}/music/${encodeURIComponent(name)}`;
  return {
    id: "lastfm",
    authorizeUrl(callback, state) {
      return withQuery(`${LASTFM_WEB}/api/auth/`, { api_key: cfg.apiKey, cb: `${callback}?state=${encodeURIComponent(state)}` });
    },
    async finish({ query }) {
      if (!query.token) throw new ConnectDenied();
      const params = { method: "auth.getSession", api_key: cfg.apiKey, token: query.token };
      const s = await http.json("lastfm", withQuery(LASTFM_API, { ...params, api_sig: lastFmSignature(params, cfg.sharedSecret), format: "json" }), LastFmSession);
      return { profile: await this.refresh({ externalId: s.session.name, name: s.session.name }), tokens: { accessToken: s.session.key, refreshToken: null, expiresAt: null } };
    },
    async refresh({ externalId }) {
      const recent = await http.json("lastfm", withQuery(LASTFM_API, { method: "user.getrecenttracks", user: externalId, limit: "1", api_key: cfg.apiKey, format: "json" }), LastFmRecent);
      const playing = asList(recent.recenttracks.track).find((t) => t["@attr"]?.nowplaying === "true");
      const base = { externalId, name: clean(externalId), url: `${LASTFM_WEB}/user/${encodeURIComponent(externalId)}` };
      if (playing) {
        const artist = playing.artist?.["#text"] ?? playing.artist?.name ?? "";
        return { ...base, itemsKind: "now-playing" as const, items: [item(playing.name, artist, artist ? `${music(artist)}/_/${encodeURIComponent(playing.name)}` : null)] };
      }
      const top = await http.json("lastfm", withQuery(LASTFM_API, { method: "user.gettopartists", user: externalId, period: "1month", limit: String(MAX_ITEMS), api_key: cfg.apiKey, format: "json" }), LastFmTop);
      return { ...base, itemsKind: "top-artists" as const, items: asList(top.topartists.artist).slice(0, MAX_ITEMS).map((a) => item(a.name, null, music(a.name))) };
    },
  };
}

// Trakt ---------------------------------------------------------------------------------------------------------------

const TRAKT_API = "https://api.trakt.tv";
const TRAKT_WEB = "https://trakt.tv";
const SLUG = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const TraktToken = z.object({ access_token: z.string().min(1).max(4000), refresh_token: z.string().max(4000).optional(), expires_in: z.number().optional() });
const TraktSettings = z.object({ user: z.object({ username: z.string(), ids: z.object({ slug: SLUG }) }) });
const TraktUser = z.object({ username: z.string(), name: z.string().nullable().optional(), ids: z.object({ slug: SLUG }) });
const TraktHistory = z.array(
  z.object({
    type: z.string(),
    movie: z.object({ title: z.string(), year: z.number().nullable().optional(), ids: z.object({ slug: SLUG.optional() }) }).optional(),
    show: z.object({ title: z.string(), ids: z.object({ slug: SLUG.optional() }) }).optional(),
    episode: z.object({ season: z.number().int(), number: z.number().int(), title: z.string().nullable().optional() }).optional(),
  }),
);

function trakt(cfg: NonNullable<LinkedAccountsConfig["trakt"]>, http: Outbound): Provider {
  const headers = (token?: string) => ({ "trakt-api-version": "2", "trakt-api-key": cfg.clientId, ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const pad = (n: number) => String(n).padStart(2, "0");
  const fetchProfile = async (slug: string, token?: string): Promise<PublicProfile> => {
    const user = await http.json("trakt", `${TRAKT_API}/users/${slug}`, TraktUser, { headers: headers(token) });
    const history = await http.json("trakt", `${TRAKT_API}/users/${slug}/history?limit=${MAX_ITEMS}`, TraktHistory, { headers: headers(token) });
    const items = history.slice(0, MAX_ITEMS).map((h) => {
      if (h.movie) return item(h.movie.year ? `${h.movie.title} (${h.movie.year})` : h.movie.title, null, h.movie.ids.slug ? `${TRAKT_WEB}/movies/${h.movie.ids.slug}` : null);
      const ep = h.episode ? `S${pad(h.episode.season)}E${pad(h.episode.number)}${h.episode.title ? ` · ${h.episode.title}` : ""}` : null;
      return item(h.show?.title, ep, h.show?.ids.slug ? `${TRAKT_WEB}/shows/${h.show.ids.slug}` : null);
    });
    return { externalId: slug, name: clean(user.name || user.username) || slug, url: `${TRAKT_WEB}/users/${slug}`, itemsKind: "recently-watched", items };
  };
  return {
    id: "trakt",
    authorizeUrl(callback, state, challenge) {
      return withQuery(`${TRAKT_WEB}/oauth/authorize`, { response_type: "code", client_id: cfg.clientId, redirect_uri: callback, state, code_challenge: challenge, code_challenge_method: "S256" });
    },
    async finish({ query, callback, verifier }) {
      if (query.error) throw new ConnectDenied();
      if (!query.code) throw new ProviderError("trakt", 400, "Trakt sent no code");
      const t = await http.json("trakt", `${TRAKT_API}/oauth/token`, TraktToken, {
        json: { code: query.code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: callback, grant_type: "authorization_code", code_verifier: verifier },
      });
      const settings = await http.json("trakt", `${TRAKT_API}/users/settings`, TraktSettings, { headers: headers(t.access_token) });
      const tokens = { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null };
      return { profile: await fetchProfile(settings.user.ids.slug, t.access_token), tokens };
    },
    refresh: ({ externalId }) => fetchProfile(externalId),
    async revoke(tokens) {
      await http.text("trakt", `${TRAKT_API}/oauth/revoke`, { json: { token: tokens.accessToken, client_id: cfg.clientId, client_secret: cfg.clientSecret } });
    },
  };
}

/** The providers whose keys are set. */
export function configuredProviders(cfg: LinkedAccountsConfig, http: Outbound): Map<LinkedProvider, Provider> {
  const out = new Map<LinkedProvider, Provider>();
  if (cfg.steam) out.set("steam", steam(cfg.steam, http));
  if (cfg.anilist) out.set("anilist", anilist(cfg.anilist, http));
  if (cfg.lastfm) out.set("lastfm", lastfm(cfg.lastfm, http));
  if (cfg.trakt) out.set("trakt", trakt(cfg.trakt, http));
  return out;
}
