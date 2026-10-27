# Importing a Discord server (API 0.43.0, 2026-10-27)

Someone who runs a Discord server can bring its **structure** into a Meldiq community: the server icon, roles (name and
colour, and optionally what each may do), categories, text, announcement, voice and forum channels, and custom emoji.
Members then join with a Meldiq invitation, which the app offers when the import finishes.

**Never imported:** messages or history, members or their accounts, direct messages, channels the bot can't see, threads,
stickers, soundboard sounds, events, bots, webhooks, per-person channel permissions. Nothing is written to Discord.

## How it works

1. **Connect** (`POST /v1/discord/connect`). The API makes a random state (32 bytes; only its SHA-256 is stored,
   bound to the Meldiq account, single use, 10 minutes) and answers Discord's authorization address with
   `scope=bot identify guilds`, `permissions=1024` (View Channels, nothing else), `response_type=code`.
   Discord only lets people with Manage Server add a bot to a server.
2. **Callback.** Discord sends the person to Meldiq Web's `/discord/callback?code&state&guild_id`; the page posts them to
   `POST /v1/discord/callback`. The API checks the state, exchanges the code (form-encoded, client credentials), and
   with that user token reads `/users/@me` and `/users/@me/guilds`: the chosen server (as Discord's token answer names it,
   not the redirect's hint) must be one the person owns or has Manage Server or Administrator in. The user token is then
   **revoked** (`/oauth2/token/revoke`) in every case; Meldiq stores no Discord token. Finally the bot must see the server.
   A connection row (server id and name, the person's Discord id) lasts 24 hours.
3. **Preview** (`GET /v1/discord/connections/:id/preview`): every item with "create" or "skip" and why, plus the list
   of what is never imported.
4. **Import** (`POST /v1/discord/imports`): into a new community (private, invite-only, owned by the importer) or an
   existing one where the person may change the photo, create roles, create channels and add emoji (each only if that
   part was chosen). The plan is written first, one row per item (`discord_import_items`), then carried out in the
   background: the community (its id recorded at once), icon, roles, categories, channels, emoji.
5. **Progress and retry** (`GET /v1/discord/imports/:id`, `POST …/retry`): a failed item (Discord timed out, an emoji was
   too large) can be retried; items already made are never made again, and the community is never created twice.
   A restart marks running imports "interrupted"; Retry continues them.
6. **Disconnect** (`DELETE /v1/discord/connections/:id?leave=true`): forgets the connection, and the bot leaves the server
   unless someone else still has it connected or an import of it is running.

## Mapping

| Discord | Meldiq |
|---|---|
| Server icon | community photo (JPEG from Discord's CDN, ≤ 512 KB) |
| Role (not @everyone, not bot-managed) | role with the same name (≤ 40 chars) and colour; "From Discord" |
| Role permissions (only if chosen) | Manage Server → edit the community; Create Invite → invite; Kick → remove; Ban → ban; Timeout → time out; Manage Channels → create and manage channels; Manage Roles → manage and assign roles; Manage Expressions → manage emoji; View Audit Log → audit log. **Administrator is never copied.** |
| Category | category, same order |
| Text / announcement channel | text / announcement channel, with its topic |
| Voice / stage channel | voice channel |
| Forum / media channel | forum channel |
| Channel hidden from @everyone | **private** channel (only the importer to start with): nothing private becomes public |
| Other channel types (directory, …) | skipped, listed in the preview |
| Custom emoji (not integration-managed) | community emoji, name made Meldiq-safe (`Wave-Hi` → `wave_hi`), ≤ 256 KB |

Meldiq's own limits apply (500 channels, 50 per category, 50 roles, 50 emoji); what doesn't fit is listed as skipped.

## Setting it up (owner, on Discord's side)

Done for production on 2026-10-27: application "Meldiq" (Client ID `1564576594209673226`) with the redirect below,
privileged intents off, Public Bot on. The secret and bot token are entered on the VPS with `/root/set-discord.sh`
(hidden input, straight into `.env`, a dated copy of `.env` kept first).


Until these four settings are in the API's `.env`, the app says "Importing from Discord isn't set up on this server
yet" and offers nothing that would fail:

1. Discord Developer Portal → New Application ("Meldiq").
2. **OAuth2** → Redirects: add `https://web.meldiq.app/discord/callback`. Copy the Client ID and reset/copy the Client Secret.
3. **Bot**: create it, copy its token. Leave **all privileged gateway intents off** (presence, server members, message
   content): the import doesn't use them. Keep **Public Bot on**: with it off, only the application's owner could add
   the bot, so nobody else could import their server.
4. In `/opt/griip-internal-messaging/.env`: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
   `DISCORD_REDIRECT_URI=https://web.meldiq.app/discord/callback`; then `deploy/scripts/validate-env.sh` and recreate
   the API container. Never commit these values.

Discord's API changes: from 16 November 2026 `GET /guilds/{id}/channels` leaves out channels the bot can't view, which
this import already expects (such channels are simply not in the preview).

## Tests

`test/discord_mapping.test.ts` (rules) and `test/discord_import.test.ts`, against a local stand-in for Discord's API
(`test/support/fakeDiscord.ts`): state checks, someone without Manage Server, a server without the bot, token revocation,
preview, a full import, role permissions (never Administrator), retry without duplicates, a 429 honoured, refused
destinations, disconnect. **Not tested against the real Discord**: there is no Discord application yet.
