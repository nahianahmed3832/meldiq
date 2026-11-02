import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Outbound } from "../src/modules/linkedAccounts/outbound.js";
import { lastFmSignature } from "../src/modules/linkedAccounts/providers.js";
import { REFRESH_AFTER_MS } from "../src/modules/linkedAccounts/index.js";
import { ConnectionEntry } from "../src/shared/contracts/http/linkedAccounts.js";
import { AccountClient, MemoryMailer, PASSWORD } from "./support/accounts.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * API 0.65.0 batch B (docs/SETTINGS_PARITY_API.md): Steam, AniList, Last.fm and Trakt on profiles (`connections-v2`).
 * Every provider is a scripted stand-in on global fetch: nothing here reaches a real service.
 */

const API = "https://api.meldiq.test";
const WEB = "https://web.meldiq.test";
const KEYS = {
  PUBLIC_API_URL: API,
  PUBLIC_WEB_URL: WEB,
  PLATFORM_SECRETS_KEY: "ab".repeat(32),
  STEAM_API_KEY: "steam-key-123",
  ANILIST_CLIENT_ID: "4242",
  ANILIST_CLIENT_SECRET: "anilist-secret",
  LASTFM_API_KEY: "lastfm-key",
  LASTFM_SHARED_SECRET: "lastfm-secret",
  TRAKT_CLIENT_ID: "trakt-client",
  TRAKT_CLIENT_SECRET: "trakt-secret",
};
const PROVIDER_HOSTS = ["steamcommunity.com", "api.steampowered.com", "anilist.co", "graphql.anilist.co", "ws.audioscrobbler.com", "api.trakt.tv"];
const STEAM_ID = "76561198000000001";

interface Call {
  url: URL;
  method: string;
  body: string;
  headers: Record<string, string>;
}

/** Scripted answers by host and path; each test can override one. */
const answers = new Map<string, (c: Call) => { status: number; body: unknown }>();
const calls: Call[] = [];
const json = (body: unknown, status = 200) => ({ status, body });

function defaultAnswers() {
  answers.clear();
  answers.set("steamcommunity.com/openid/login", (c) => {
    const form = new URLSearchParams(c.body);
    return { status: 200, body: form.get("openid.mode") === "check_authentication" && form.get("openid.sig") === "good-sig" ? "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n" : "is_valid:false\n" };
  });
  answers.set("api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/", () => json({ response: { players: [{ steamid: STEAM_ID, personaname: "Ada on Steam", profileurl: "https://evil.example/" }] } }));
  answers.set("api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/", () =>
    json({ response: { total_count: 6, games: Array.from({ length: 6 }, (_, i) => ({ appid: 100 + i, name: `Game ${i}`, playtime_2weeks: 60 })) } }),
  );
  answers.set("anilist.co/api/v2/oauth/token", (c) => {
    const b = JSON.parse(c.body);
    return b.code === "ani-code" && b.client_secret === "anilist-secret" ? json({ access_token: "ani-token-xyz", expires_in: 3600, refresh_token: "ani-refresh" }) : json({ error: "invalid_grant" }, 400);
  });
  answers.set("graphql.anilist.co/", (c) => {
    const b = JSON.parse(c.body);
    if (b.query.includes("Viewer")) return c.headers.authorization === "Bearer ani-token-xyz" ? json({ data: { Viewer: { id: 77, name: "AdaAni" } } }) : json({ errors: [] }, 401);
    return json({
      data: {
        User: { id: 77, name: "AdaAni" },
        MediaListCollection: { lists: [{ entries: Array.from({ length: 7 }, (_, i) => ({ media: { id: 1000 + i, title: { userPreferred: `Show ${i}` } } })) }] },
      },
    });
  });
  answers.set("ws.audioscrobbler.com/2.0/", (c) => {
    const q = c.url.searchParams;
    if (q.get("method") === "auth.getSession") {
      const sig = lastFmSignature({ method: "auth.getSession", api_key: "lastfm-key", token: q.get("token")! }, "lastfm-secret");
      return q.get("api_sig") === sig && q.get("token") === "fm-token" ? json({ session: { name: "adafm", key: "fm-session-key", subscriber: 0 } }) : json({ error: 13, message: "Invalid signature" }, 403);
    }
    if (q.get("method") === "user.getrecenttracks") return json({ recenttracks: { track: [{ name: "Song A", artist: { "#text": "Band A" }, "@attr": { nowplaying: "true" } }, { name: "Song B", artist: { "#text": "Band B" } }] } });
    return json({ topartists: { artist: [{ name: "Band A" }] } });
  });
  answers.set("api.trakt.tv/oauth/token", (c) => json({ access_token: "trakt-access", refresh_token: "trakt-refresh", expires_in: 86400, _verifier: JSON.parse(c.body).code_verifier }));
  answers.set("api.trakt.tv/users/settings", () => json({ user: { username: "AdaTrakt", ids: { slug: "adatrakt" } } }));
  answers.set("api.trakt.tv/users/adatrakt", () => json({ username: "AdaTrakt", name: "Ada T", ids: { slug: "adatrakt" } }));
  answers.set("api.trakt.tv/users/adatrakt/history", () =>
    json([
      { type: "episode", show: { title: "Space Show", ids: { slug: "space-show" } }, episode: { season: 2, number: 5, title: "Moons" } },
      { type: "movie", movie: { title: "Big Film", year: 2024, ids: { slug: "big-film-2024" } } },
    ]),
  );
  answers.set("api.trakt.tv/oauth/revoke", () => json({}));
}

function stubProviders() {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (!PROVIDER_HOSTS.includes(url.hostname)) return real(input, init);
    const call: Call = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "", headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const a = answers.get(`${url.host}${url.pathname}`);
    const r = a ? a(call) : { status: 404, body: { error: "unscripted" } };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
}

/** Follows a provider's sign-in page back to our callback, as the browser would; the 302's target. */
async function callback(h: Harness, provider: string, query: Record<string, string>): Promise<URL> {
  const res = await fetch(`${h.baseUrl}/v2/connections/${provider}/callback?${new URLSearchParams(query).toString()}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

const startUrl = async (c: GriipClient | AccountClient, provider: string) => new URL((await c.req("POST", `/v2/connections/${provider}/start`)).url);

/** Steam's answer for a sign-in started with [start]. */
function steamAssertion(start: URL, sig = "good-sig"): Record<string, string> {
  const returnTo = start.searchParams.get("openid.return_to")!;
  const claimed = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
  return {
    state: new URL(returnTo).searchParams.get("state")!,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": claimed,
    "openid.identity": claimed,
    "openid.return_to": returnTo,
    "openid.response_nonce": "2026-10-29T12:00:00Zabc",
    "openid.assoc_handle": "1234567890",
    "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": sig,
  };
}

const connected = (url: URL, provider: string) => expect(url.toString()).toBe(`${WEB}/settings/profile?connected=${provider}`);
const failedWith = (url: URL, error: string, provider: string) => expect(Object.fromEntries(url.searchParams)).toEqual({ connectionError: error, provider });

describe("the outbound client", () => {
  it("times out and logs only the host and path, never the query (keys travel there)", async () => {
    const warnings: unknown[] = [];
    const http = new Outbound({ warn: (o: unknown) => warnings.push(o) } as never, async () => new Response("no", { status: 500 }));
    await expect(http.text("steam", "https://api.steampowered.com/x?key=SECRET")).rejects.toThrow();
    expect(JSON.stringify(warnings)).not.toContain("SECRET");
    expect(warnings[0]).toMatchObject({ provider: "steam", host: "api.steampowered.com", path: "/x", status: 500 });
  });
});

const PRODUCTION_DOMAINS = "preferences,reports,relationships,history,accounts,files,relay,billing";

describe.each(process.env.MELDIQ_TEST_PG_URL ? [["postgres", {}]] as const : [
  ["memory", {}],
  ["mongodb", { MONGODB_DOMAINS: PRODUCTION_DOMAINS }],
] as const)("linked accounts, kept in %s", (backend, env) => {
  let h: Harness;
  const mailer = new MemoryMailer();
  let ada: GriipClient, bob: GriipClient;

  beforeAll(async () => {
    stubProviders();
    h = await startServer({ ...KEYS, ...env }, { mailer });
    expect(h.ctx.linkedAccounts.accounts.backend).toBe(backend);
    [ada, bob] = await Promise.all([h.client(`lada${backend}`), h.client(`lbob${backend}`)]);
  });
  afterAll(async () => {
    await h.close();
    vi.unstubAllGlobals();
  });

  describe("Steam (OpenID 2.0)", () => {
    it("sends the browser to Steam with a return address on this API", async () => {
      defaultAnswers();
      const start = await startUrl(ada, "steam");
      expect(start.origin + start.pathname).toBe("https://steamcommunity.com/openid/login");
      expect(start.searchParams.get("openid.mode")).toBe("checkid_setup");
      expect(start.searchParams.get("openid.realm")).toBe(API);
      expect(start.searchParams.get("openid.return_to")).toMatch(new RegExp(`^${API}/v2/connections/steam/callback\\?state=`));
    });

    it("refuses an assertion Steam doesn't confirm", async () => {
      failedWith(await callback(h, "steam", steamAssertion(await startUrl(ada, "steam"), "forged")), "failed", "steam");
      expect(await h.ctx.linkedAccounts.accounts.get(`${ada.userId}|steam`)).toBeNull();
    });

    it("stores the account, its name and up to 5 recent games once Steam confirms it (links built from ids)", async () => {
      calls.length = 0;
      connected(await callback(h, "steam", steamAssertion(await startUrl(ada, "steam"))), "steam");
      const check = calls.find((c) => c.url.host === "steamcommunity.com")!;
      expect(new URLSearchParams(check.body).get("openid.mode")).toBe("check_authentication");
      const { connections } = await ada.req("GET", "/v2/connections");
      expect(connections.every((c: unknown) => ConnectionEntry.safeParse(c).success)).toBe(true);
      expect(connections.map((c: { available: boolean; connected: boolean }) => [c.available, c.connected])).toEqual([
        [true, true],
        [true, false],
        [true, false],
        [true, false],
      ]);
      const steam = connections[0];
      expect(steam).toMatchObject({ provider: "steam", connected: true, visible: true, account: { name: "Ada on Steam", url: `https://steamcommunity.com/profiles/${STEAM_ID}`, itemsKind: "recently-played" } });
      expect(steam.account.items).toHaveLength(5);
      expect(steam.account.items[0]).toEqual({ title: "Game 0", subtitle: null, url: "https://store.steampowered.com/app/100" });
    });

    it("takes each state once, only for its own provider and person, and never a tampered one", async () => {
      const start = await startUrl(ada, "steam");
      const assertion = steamAssertion(start);
      connected(await callback(h, "steam", assertion), "steam");
      failedWith(await callback(h, "steam", assertion), "state", "steam");

      const fresh = steamAssertion(await startUrl(ada, "steam"));
      const [body, mac] = fresh.state!.split(".");
      const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
      const asBob = Buffer.from(JSON.stringify([bob.userId, ...payload.slice(1)])).toString("base64url");
      failedWith(await callback(h, "steam", { ...fresh, state: `${asBob}.${mac}` }), "state", "steam");
      failedWith(await callback(h, "steam", { ...fresh, state: `${body}.${mac!.slice(0, -2)}AA` }), "state", "steam");
      failedWith(await callback(h, "trakt", { code: "x", state: fresh.state! }), "state", "trakt");
      failedWith(await callback(h, "steam", { ...fresh, state: "" }), "state", "steam");
    });

    it("says so when the person cancels on Steam's page", async () => {
      const a = steamAssertion(await startUrl(bob, "steam"));
      failedWith(await callback(h, "steam", { state: a.state!, "openid.ns": a["openid.ns"]!, "openid.mode": "cancel" }), "denied", "steam");
    });
  });

  describe("AniList (OAuth 2)", () => {
    it("exchanges the code, keeps the tokens sealed, and shows up to 5 currently watching", async () => {
      const start = await startUrl(ada, "anilist");
      expect(Object.fromEntries(start.searchParams)).toMatchObject({ client_id: "4242", redirect_uri: `${API}/v2/connections/anilist/callback`, response_type: "code" });
      connected(await callback(h, "anilist", { code: "ani-code", state: start.searchParams.get("state")! }), "anilist");
      const stored = (await h.ctx.linkedAccounts.accounts.get(`${ada.userId}|anilist`))!;
      expect(stored).toMatchObject({ externalId: "77", name: "AdaAni", url: "https://anilist.co/user/AdaAni", itemsKind: "watching" });
      expect(stored.items).toHaveLength(5);
      expect(stored.tokens).toMatch(/^v1\./);
      expect(stored.tokens).not.toContain("ani-token");
    });

    it("reports a code the provider refuses, and a refusal on its page", async () => {
      const start = await startUrl(bob, "anilist");
      failedWith(await callback(h, "anilist", { code: "wrong", state: start.searchParams.get("state")! }), "failed", "anilist");
      const again = await startUrl(bob, "anilist");
      failedWith(await callback(h, "anilist", { error: "access_denied", state: again.searchParams.get("state")! }), "denied", "anilist");
    });
  });

  describe("Last.fm (web auth)", () => {
    it("signs auth.getSession and shows what's playing now", async () => {
      const start = await startUrl(ada, "lastfm");
      const cb = new URL(start.searchParams.get("cb")!);
      expect(cb.origin + cb.pathname).toBe(`${API}/v2/connections/lastfm/callback`);
      connected(await callback(h, "lastfm", { state: cb.searchParams.get("state")!, token: "fm-token" }), "lastfm");
      const fm = (await ada.req("GET", "/v2/connections")).connections[2];
      expect(fm.account).toMatchObject({ name: "adafm", url: "https://www.last.fm/user/adafm", itemsKind: "now-playing", items: [{ title: "Song A", subtitle: "Band A" }] });
    });
  });

  describe("Trakt (OAuth 2 with PKCE)", () => {
    it("sends a PKCE challenge, proves it with the verifier, and shows recently watched", async () => {
      calls.length = 0;
      const start = await startUrl(ada, "trakt");
      expect(start.searchParams.get("code_challenge_method")).toBe("S256");
      connected(await callback(h, "trakt", { code: "trakt-code", state: start.searchParams.get("state")! }), "trakt");
      const exchange = calls.find((c) => c.url.pathname === "/oauth/token")!;
      const verifier = JSON.parse(exchange.body).code_verifier;
      expect(crypto.createHash("sha256").update(verifier).digest("base64url")).toBe(start.searchParams.get("code_challenge"));
      const trakt = (await ada.req("GET", "/v2/connections")).connections[3];
      expect(trakt.account).toMatchObject({
        name: "Ada T",
        url: "https://trakt.tv/users/adatrakt",
        itemsKind: "recently-watched",
        items: [
          { title: "Space Show", subtitle: "S02E05 · Moons", url: "https://trakt.tv/shows/space-show" },
          { title: "Big Film (2024)", subtitle: null, url: "https://trakt.tv/movies/big-film-2024" },
        ],
      });
    });
  });

  describe("on profiles", () => {
    it("shows the visible ones to others, none to someone they blocked", async () => {
      const seen = (await bob.req("GET", `/v1/users/${ada.userId}`)).user.connections;
      expect(seen.map((c: { provider: string }) => c.provider)).toEqual(["steam", "anilist", "lastfm", "trakt"]);
      expect((await ada.req("GET", "/v1/users/me")).user.connections).toHaveLength(4);
      await ada.req("POST", "/v1/blocks", { userId: bob.userId });
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.connections).toBeUndefined();
      await ada.req("DELETE", `/v1/blocks/${bob.userId}`);
    });

    it("hides one its owner turned off", async () => {
      const r = await ada.req("PUT", "/v2/connections/steam", { visible: false });
      expect(r.connection).toMatchObject({ provider: "steam", connected: true, visible: false });
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.connections.map((c: { provider: string }) => c.provider)).toEqual(["anilist", "lastfm", "trakt"]);
      await ada.req("PUT", "/v2/connections/steam", { visible: true });
      expect((await expectStatus(bob.req("PUT", "/v2/connections/trakt", { visible: false }), 404)).error.code).toBe("not_found");
    });

    it("serves what's stored and refreshes stale data in the background, at most every 6 hours", async () => {
      calls.length = 0;
      await bob.req("GET", `/v1/users/${ada.userId}`);
      await h.ctx.linkedAccounts.settled();
      expect(calls).toEqual([]);

      const id = `${ada.userId}|steam`;
      const stale = Date.now() - REFRESH_AFTER_MS - 60_000;
      await h.ctx.linkedAccounts.accounts.update(id, {}, { checkedAt: stale });
      answers.set("api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/", () => json({ response: { players: [{ steamid: STEAM_ID, personaname: "Ada Renamed" }] } }));
      const first = (await bob.req("GET", `/v1/users/${ada.userId}`)).user.connections[0];
      expect(first.name).toBe("Ada on Steam");
      await h.ctx.linkedAccounts.settled();
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.connections[0].name).toBe("Ada Renamed");

      // A provider that fails is tried again only after another 6 hours, and the stored data still shows.
      await h.ctx.linkedAccounts.accounts.update(id, {}, { checkedAt: stale });
      answers.set("api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/", () => json({ error: "down" }, 503));
      calls.length = 0;
      await bob.req("GET", `/v1/users/${ada.userId}`);
      await h.ctx.linkedAccounts.settled();
      await bob.req("GET", `/v1/users/${ada.userId}`);
      await h.ctx.linkedAccounts.settled();
      expect(calls.filter((c) => c.url.pathname.includes("GetPlayerSummaries"))).toHaveLength(1);
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.connections[0].name).toBe("Ada Renamed");
      defaultAnswers();
    });
  });

  it("disconnects: the account is forgotten and Trakt is asked to revoke its token", async () => {
    calls.length = 0;
    const r = await ada.req("DELETE", "/v2/connections/trakt");
    expect(r.connection).toMatchObject({ provider: "trakt", connected: false, account: null });
    await vi.waitFor(() => expect(calls.some((c) => c.url.pathname === "/oauth/revoke" && JSON.parse(c.body).token === "trakt-access")).toBe(true));
    expect(await h.ctx.linkedAccounts.accounts.get(`${ada.userId}|trakt`)).toBeNull();
    expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.connections.map((c: { provider: string }) => c.provider)).not.toContain("trakt");
    expect((await ada.req("DELETE", "/v2/connections/trakt")).connection.connected).toBe(false);
  });

  it("forgets every linked account when the account is deleted", async () => {
    const dee = await AccountClient.ready(h.baseUrl, mailer, `ldee${backend}`);
    connected(await callback(h, "steam", steamAssertion(await startUrl(dee, "steam"))), "steam");
    expect(await h.ctx.linkedAccounts.accounts.count({ userId: dee.userId })).toBe(1);
    await dee.req("DELETE", "/v2/account", { password: PASSWORD, confirmEmail: dee.email });
    expect(await h.ctx.linkedAccounts.accounts.count({ userId: dee.userId })).toBe(0);
    expect(await h.ctx.linkedAccounts.starts.count({ userId: dee.userId })).toBe(0);
  });
});

describe("linked accounts without keys", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ PUBLIC_API_URL: API, PUBLIC_WEB_URL: WEB });
  });
  afterAll(async () => h.close());

  it("lists every provider as unavailable and refuses to start", async () => {
    const ada = await h.client("nokeysada");
    const { connections } = await ada.req("GET", "/v2/connections");
    expect(connections.map((c: { provider: string }) => c.provider)).toEqual(["steam", "anilist", "lastfm", "trakt"]);
    expect(connections.every((c: { available: boolean; connected: boolean }) => !c.available && !c.connected)).toBe(true);
    expect((await expectStatus(ada.req("POST", "/v2/connections/steam/start"), 409)).error.code).toBe("connection_unavailable");
    await expectStatus(ada.req("POST", "/v2/connections/myspace/start"), 400);
    failedWith(await callback(h, "trakt", { code: "x", state: "y" }), "unavailable", "trakt");
  });

  it("needs the API's public address too", async () => {
    const h2 = await startServer({ STEAM_API_KEY: "k" });
    try {
      const c = await h2.client("noapiurl");
      expect((await c.req("GET", "/v2/connections")).connections[0]).toMatchObject({ provider: "steam", available: false });
    } finally {
      await h2.close();
    }
  });
});
