import { z } from "zod/v4";
import type { DiscordConfig } from "../../../app/config.js";
import { ApiError } from "../../../shared/errors.js";
import { BOT_PERMISSIONS, DiscordChannel, DiscordGuild } from "./mapping.js";

/**
 * Discord's REST API, as far as importing needs it (docs/DISCORD_IMPORT.md): the OAuth2 code exchange and revocation,
 * the signed-in person's servers (to confirm they manage the one chosen), and, as the bot, that server's structure.
 * Every answer is validated; rate limits are honoured (Retry-After) a few times before giving up; nothing is logged.
 */
const TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_WAIT_MS = 15_000;
const ATTEMPTS = 3;
/** The image types and size Meldiq takes for emoji (EXPRESSION_LIMITS) and community photos (MAX_PHOTO_BYTES). */
const MAX_IMAGE_BYTES = 512 * 1024;

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    /** Worth trying again later: a timeout, a rate limit or Discord's own error. */
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type FetchFn = typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(fetchFn: FetchFn, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      if (attempt >= ATTEMPTS) throw new DiscordError(0, true, "Discord didn't answer");
      await sleep(500 * attempt);
      continue;
    }
    if (res.status === 429 && attempt < ATTEMPTS) {
      const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
      const seconds = Number(body?.retry_after ?? res.headers.get("retry-after") ?? 1);
      const wait = Math.min(Math.max(Number.isFinite(seconds) ? seconds * 1000 : 1000, 100), MAX_RATE_LIMIT_WAIT_MS);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500 && attempt < ATTEMPTS) {
      await sleep(500 * attempt);
      continue;
    }
    return res;
  }
}

async function json<T>(res: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  if (!res.ok) throw new DiscordError(res.status, res.status === 429 || res.status >= 500, `${what}: Discord answered ${res.status}`);
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new DiscordError(502, false, `${what}: Discord's answer wasn't understood`);
  return parsed.data;
}

const TokenResponse = z.object({
  access_token: z.string().min(1).max(500),
  token_type: z.string(),
  scope: z.string().max(500),
  guild: z.object({ id: z.string().regex(/^\d{5,25}$/) }).optional(),
});
const PartialGuild = z.object({ id: z.string(), name: z.string().max(200), owner: z.boolean().default(false), permissions: z.string().default("0") });
const CurrentUser = z.object({ id: z.string().regex(/^\d{5,25}$/) });

export class DiscordClient {
  constructor(
    private readonly cfg: DiscordConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  /** Where the person adds the bot and lets Meldiq read their server list once (scopes bot, identify and guilds). */
  authorizeUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      scope: "bot identify guilds",
      permissions: BOT_PERMISSIONS.toString(),
      response_type: "code",
      redirect_uri: this.cfg.redirectUri,
      state,
      integration_type: "0",
      prompt: "consent",
    });
    return `https://discord.com/oauth2/authorize?${q}`;
  }

  /** The code from the redirect, for a user token (and the server the bot was added to). */
  async exchangeCode(code: string): Promise<{ accessToken: string; guildId: string | null }> {
    const res = await call(this.fetchFn, `${this.cfg.apiBase}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: this.basic() },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri }),
    });
    if (res.status === 400 || res.status === 401) throw new ApiError(400, "bad_request", "That Discord sign-in has expired or was already used. Connect Discord again.");
    const t = await json(res, TokenResponse, "Signing in with Discord");
    return { accessToken: t.access_token, guildId: t.guild?.id ?? null };
  }

  /** Ends the user token straight away: Meldiq keeps no Discord token. Best effort. */
  async revoke(token: string): Promise<void> {
    await call(this.fetchFn, `${this.cfg.apiBase}/oauth2/token/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: this.basic() },
      body: new URLSearchParams({ token, token_type_hint: "access_token" }),
    }).catch(() => undefined);
  }

  async userId(token: string): Promise<string> {
    const res = await call(this.fetchFn, `${this.cfg.apiBase}/users/@me`, { headers: { authorization: `Bearer ${token}` } });
    return (await json(res, CurrentUser, "Reading your Discord account")).id;
  }

  /** The signed-in person's servers, with whether they own each and their permission bits there. */
  async userGuilds(token: string): Promise<z.infer<typeof PartialGuild>[]> {
    const res = await call(this.fetchFn, `${this.cfg.apiBase}/users/@me/guilds?limit=200`, { headers: { authorization: `Bearer ${token}` } });
    return json(res, z.array(PartialGuild).max(200), "Reading your Discord servers");
  }

  /** The server as the bot sees it; null when the bot isn't in it (any more). */
  async guild(guildId: string): Promise<DiscordGuild | null> {
    const res = await call(this.fetchFn, `${this.cfg.apiBase}/guilds/${guildId}`, { headers: this.bot() });
    if (res.status === 403 || res.status === 404) return null;
    return json(res, DiscordGuild, "Reading the Discord server");
  }

  /** Its channels and categories (Discord leaves out the ones the bot can't see, and threads). */
  async channels(guildId: string): Promise<DiscordChannel[]> {
    const res = await call(this.fetchFn, `${this.cfg.apiBase}/guilds/${guildId}/channels`, { headers: this.bot() });
    if (res.status === 403 || res.status === 404) throw new ApiError(409, "discord_bot_missing", "Meldiq's Discord bot isn't in that server any more. Connect Discord again to add it.");
    return json(res, z.array(DiscordChannel).max(1000), "Reading the Discord channels");
  }

  /** The bot leaves the server (on disconnect, when the person asks). */
  async leave(guildId: string): Promise<void> {
    const res = await call(this.fetchFn, `${this.cfg.apiBase}/users/@me/guilds/${guildId}`, { method: "DELETE", headers: this.bot() });
    if (!res.ok && res.status !== 404) throw new DiscordError(res.status, res.status >= 500, `Leaving the Discord server: Discord answered ${res.status}`);
  }

  /** A server icon (as JPEG) or an emoji (PNG or GIF) from Discord's image CDN, at most 512 KB. */
  async image(kind: "icon" | "emoji", id: string, hash: string | null, animated = false): Promise<Buffer> {
    const path = kind === "icon" ? `icons/${id}/${hash}.jpg?size=512` : `emojis/${id}.${animated ? "gif" : "png"}?size=128`;
    const res = await call(this.fetchFn, `${this.cfg.cdnBase}/${path}`, {});
    if (!res.ok) throw new DiscordError(res.status, res.status === 429 || res.status >= 500, `Downloading an image: Discord answered ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) throw new DiscordError(413, false, "The image is larger than Meldiq takes");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new DiscordError(413, false, "The image is larger than Meldiq takes");
    return buf;
  }

  private basic(): string {
    return `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString("base64")}`;
  }

  private bot(): Record<string, string> {
    return { authorization: `Bot ${this.cfg.botToken}`, "user-agent": "DiscordBot (https://meldiq.app, 1)" };
  }
}
