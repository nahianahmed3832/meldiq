import { z } from "zod/v4";
import { zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Linked accounts (API 0.65.0 batch B, feature `connections-v2`, docs/SETTINGS_PARITY_API.md): Steam, AniList, Last.fm
 * and Trakt, shown on your profile. You sign in on the provider's own page; Meldiq keeps who you are there and a few
 * public things (refreshed at most every 6 hours). Not to be confused with `/v1/connections` (friends).
 */

export const LinkedProviderId = z.enum(["steam", "anilist", "lastfm", "trakt"]);

/** What the items are: Steam's recently played games, AniList's currently watching, Last.fm's now playing or top artists, Trakt's recently watched. */
export const LinkedItemsKind = z.enum(["recently-played", "watching", "now-playing", "top-artists", "recently-watched"]);
export type LinkedItemsKind = z.infer<typeof LinkedItemsKind>;

export const LinkedItem = z.strictObject({
  title: z.string(),
  /** The artist of a track, an episode's number and title. */
  subtitle: z.string().nullable(),
  /** On the provider's site. */
  url: z.string().nullable(),
});
export type LinkedItem = z.infer<typeof LinkedItem>;

/** A linked account as profiles show it (only the ones their owner keeps visible). */
export const ProfileConnection = z.strictObject({
  provider: LinkedProviderId,
  /** The name there. */
  name: z.string(),
  /** The profile there. */
  url: z.string(),
  itemsKind: LinkedItemsKind,
  /** Up to 5. */
  items: z.array(LinkedItem),
  /** When this was last fetched from the provider. */
  updatedAt: zTime,
});

export const ConnectionEntry = z.strictObject({
  provider: LinkedProviderId,
  /** Whether this server can connect it (the provider's keys are set). */
  available: z.boolean(),
  connected: z.boolean(),
  /** Whether it shows on your profile (connected ones only; true unless you hid it). */
  visible: z.boolean(),
  account: ProfileConnection.nullable(),
  connectedAt: zTime.nullable(),
});

export const ProviderParams = z.strictObject({ provider: LinkedProviderId });
export const ConnectionVisibilityBody = z.strictObject({ visible: z.boolean() });
/** What the provider sends back: OAuth's code, state and error, Last.fm's token, Steam's openid.* fields. */
export const ConnectionCallbackQuery = z.record(z.string(), z.string().max(4000));

const linked = (c: Omit<Parameters<typeof route>[0], "tag">) => route({ tag: "linked-accounts", ...c });

export const linkedAccountRoutes = [
  linked({
    method: "GET",
    url: "/v2/connections",
    auth: true,
    summary: "Steam, AniList, Last.fm and Trakt: which this server can connect, which you connected, and what your profile shows from each.",
    response: z.strictObject({ connections: z.array(ConnectionEntry) }),
  }),
  linked({
    method: "POST",
    url: "/v2/connections/:provider/start",
    auth: true,
    summary: "Start connecting: the provider's sign-in page to send the browser to (valid for 10 minutes, once).",
    params: ProviderParams,
    response: z.strictObject({ url: z.string() }),
    errors: ["connection_unavailable"],
  }),
  linked({
    method: "GET",
    url: "/v2/connections/:provider/callback",
    auth: false,
    summary:
      "Where the provider sends the browser back. Redirects (302) to the web app's /settings/profile with ?connected=<provider>, or ?connectionError=<state|denied|failed|unavailable>&provider=<provider>.",
    params: ProviderParams,
    query: ConnectionCallbackQuery,
    status: 302,
    binary: "response",
    response: z.unknown(),
  }),
  linked({
    method: "PUT",
    url: "/v2/connections/:provider",
    auth: true,
    summary: "Show or hide a connected account on your profile.",
    params: ProviderParams,
    body: ConnectionVisibilityBody,
    response: z.strictObject({ connection: ConnectionEntry }),
    errors: ["not_found"],
  }),
  linked({
    method: "DELETE",
    url: "/v2/connections/:provider",
    auth: true,
    summary: "Disconnect: Meldiq forgets the account and its tokens (Trakt is also asked to revoke them).",
    params: ProviderParams,
    response: z.strictObject({ connection: ConnectionEntry }),
  }),
];
