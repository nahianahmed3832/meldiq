# Settings parity, batch A (API 0.65.0)

The server side of batch A in the web repo's `docs/MELDIQ_SETTINGS_PARITY.md` (§3, step 2). Every route needs a
session. Every piece is additive, so older apps keep working, and each has a feature name in `/v1/server-info`
`features`. All new data goes to MongoDB whenever the server has one, and to process memory otherwise (development,
tests). No SQLite table or MongoDB validator changes, so production's readWrite-only user never needs `collMod`.

| Feature name | What |
| --- | --- |
| `profile-theme` | Two-colour profile theme in the profile style |
| `shown-badge` | The badge shown next to your name |
| `leave-many` | `POST /v2/orgs/leave` |
| `group-add-policy` | Who may add you to group chats |
| `suggested-people` | The "suggest me" switch and `GET /v2/people/suggested` |
| `username-holds` | Old usernames held 7 days |
| `decoration-favorites` | `/v2/decorations/favorites` |
| `points` | `/v2/points*`, quests, levels |

## Profile style (`PUT /v1/users/me/profile-style`)

- `themeColors`: 1 or 2 `#rrggbb` colours (stored in lower case), or null. When you send it, `accent` becomes its
  first colour, so apps that only know `accent` still show it. When you send `accent` without it (an older app),
  `themeColors` is cleared, so that app's change is what everyone sees.
- `shownBadge`: `"mojo"`, `"bug-hunter"`, `"artist"`, `"none"` (show none), or null (the apps' default). You can
  only pick a badge you hold now; otherwise 400. Badges come from what earns them: a Mojo plan with a badge, a
  confirmed or fixed bug report, an approved decoration. A badge you lose reads as null in every view.
- Both come back in `profileStyle` wherever it is returned: your own profile, other people's, member lists.
- Profiles (`GET /v1/users/me`, `GET /v1/users/:id`) also carry `level` (1 until you buy a level).

The colour presets (Sunset, Ocean…) live in the apps. They are just pairs of colours.

## Leave several communities: `POST /v2/orgs/leave`

`{ orgIds: string[] }` (1 to 100, repeats ignored) → `{ left, skippedOwned, notMember }`. Each leave goes through the
same path as `DELETE /v1/orgs/:orgId/members/:me`, with the same audit entry, notices and member lists. Communities
where you are an owner are skipped and listed in `skippedOwned`, even when another owner exists.

## Privacy (`GET`/`PUT /v1/users/me/messaging`)

The answer gains `groupAddPolicy` (`everyone` | `friends` | `nobody`) and `suggestable` (boolean). You can send
either one on its own. A PUT that carries only these two leaves the DM settings alone.

- **Group add.** The default is `friends`, meaning accepted connections. Operators can change it with
  `DEFAULT_GROUP_ADD_POLICY`. It is checked on `POST /v1/conversations/group` and when a new member is added with
  `PUT /v1/conversations/:id/members/:userId`. Changing an existing member's role skips the check. A block, either
  way round, also refuses. A refusal is `403 group_add_not_allowed` with `details.userIds`.
- **Suggested people.** `GET /v2/people/suggested` returns `{ people: [{ user: UserSummary, sharedCommunities }] }`:
  at most 20 people who share a community with you (neither of you a guest) and have `suggestable` on. It leaves out
  anyone you are connected with, anyone with a request pending either way, anyone blocked either way, and accounts
  that are disabled or on another server. The list is sorted by most shared communities, then username.

Kept in `privacy_settings`, one document per person who chose.

## Old usernames held 7 days

When you change your username, the old one is held for you for 7 days (`username_holds`). Until then nobody else can
take it, whether by changing their username (409 `conflict`) or by signing up (409). You can take it back at any time.
The hourly limit on username changes still applies. Holds are cached in memory for the synchronous sign-up check,
like the approved decorations, and are dropped when the account is deleted.

## Decoration favourites

- `GET /v2/decorations/favorites` → `{ favorites: string[] (newest first), limit: 200 }`
- `PUT /v2/decorations/favorites/:decorationId` → `{ decorationId, favorite: true, count }`. Works for any decoration
  you can wear: classic frames, Meldiq's own, and approved community ones. 404 for any other decoration. Starring the
  same one twice is harmless. A 201st favourite is refused with `409 limit_reached`.
- `DELETE /v2/decorations/favorites/:decorationId` → `{ decorationId, favorite: false, count }`

Kept in `decoration_favorites`.

## Points, quests and levels (`modules/points`)

In code they are called "points". The owner picks the display name later. Points can't be bought, sold or sent.
The server decides every amount, and each earning has a ledger id, so counting it twice still pays once.

| Earning | Points | Rule |
| --- | --- | --- |
| Daily visit | 5 | First `POST /v2/points/checkin` of the UTC day (the apps call it when they open) |
| Streak | 30 | Every 7th consecutive day with a check-in |
| Chatting | 5 per 5 active minutes, at most 25 a day | A minute in which you sent a message (via `POST /v2/messages`) counts once |
| Invite | 100, at most 10 a month (UTC) | Someone joins a community through your invite (`/v1/invites/accept`) and is still a member 7 days later |
| Daily quests (reset 00:00 UTC) | 10 / 5 / 5 | Talk in 3 different chats; react to 3 messages from others; reply to someone else's message |
| One-time quests | 25 / 25 / 25 / 15 / 50 | Avatar and About me; a friend; 3 communities; wear a decoration; two-step sign-in on |

- Accounts under a day old earn nothing and are not counted at all.
- Mojo Plus members earn 1.5×, rounded per earning (5 becomes 8). Spending is never multiplied.
- Quest rewards are paid automatically. Daily quests pay the moment they complete. One-time quests and due invites
  are settled the next time `GET /v2/points` or a check-in runs.
- An invite settles 7 days after the join. If the person has left by then, it lapses. If you already have 10 invite
  credits that month, it is capped and not paid later.
- Levels: `POST /v2/points/level-up` spends 100 points for one level. Without enough points it answers
  `409 not_enough_points` with `details: { cost, balance }`. Your profile shows the new level at once. The apps
  choose a ring colour for every 10 levels.

`GET /v2/points` returns `balance`, `earnedToday`, `earnedTotal`, `level`, `nextLevelCost`, `multiplier`, `streak`
(0 once a day is missed), `chatMinutesToday`, `chatPointsToday`, `chatDailyCap`, `earning`, `day`, `resetsAt`, and
`quests` (`id`, `kind`, `reward`, `progress`, `goal`, `state: open|claimed`). It also returns `invites` (`pending`,
`credited`, `creditedThisMonth`, `monthlyLimit`) and `history`, the last 50 rows (`kind`, `amount`, `detail`, `at`).
`POST /v2/points/checkin` returns `{ counted, points }`.

Collections: `points_accounts` (totals, level, streak), `points_ledger` (one document per change, keyed by its
idempotency id), `points_days` (each person's day: earned, minutes, chats, reactions, replies), `points_invites`
(joins waiting 7 days). A level-up is a single conditional update, so the balance never goes below zero.

Deleting an account removes its points, favourites, privacy choices and held usernames.

# Settings parity, batch B: creators and linked accounts (API 0.65.0)

The server side of creators and connections in step 4 of the web repo's `docs/MELDIQ_SETTINGS_PARITY.md` §3 ("Log in
with Meldiq" apps and bots are built separately). Same rules as batch A: every route but the provider callback needs a
session, everything is additive, new data goes to MongoDB whenever the server has one and to memory otherwise, and no
SQLite table or MongoDB validator changes. The stores share `infrastructure/database/documents.ts`, a small keyed
document store with a memory and a MongoDB implementation (fields stored in snake_case, times in epoch ms).

| Feature name | What |
| --- | --- |
| `creator-verification` | `/v2/creators/verification`, the review queue, the `creator` badge |
| `creator-program` | `/v2/creators/program*`, `/v2/creators/posts` |
| `connections-v2` | `/v2/connections*`: Steam, AniList, Last.fm, Trakt on profiles (not `/v1/connections`, which is friends) |

## Creator verification

- `GET /v2/creators/verification` → `{ codeLine, rules, verified, applications }`. `codeLine` is `meldiq: <username>`
  (null without a username). `rules`: 1,000+ followers, the channel's name must match your username or display name,
  the platforms (`youtube`, `tiktok`, `twitch`, `instagram`, `x`), notes up to 500 characters, a proof of up to 4 MB
  (PNG, JPEG or WebP). `applications` are newest first, each with `status` (`pending`, `approved`, `rejected`) and the
  `reason` an operator gave for turning it down.
- `POST /v2/creators/verification?platform=&channelName=&link=&notes=&bioLineConfirmed=true` with the screenshot as
  the `application/octet-stream` body (the way decorations are sent in) → 201 `{ application }`. The link is https;
  the image is recognised by its bytes. One application can wait at a time (`409 application_open`); after a rejection
  you can apply again. 10 an hour per device. A channel name that doesn't match is `400 creator_name_mismatch`.
- **Name matching** ignores case, spaces, `_`, `.` and a leading `@`.
- **The Creator badge** (`creator` in `shownBadge`, `SHOWABLE_BADGES`) is derived on read like the others: an approved
  channel holds while your username is the one you had when it was approved, or while your current username still
  matches the channel's name. Changing your display name never removes it; changing your username to one that doesn't
  match does (and changing back, or to another matching one, brings it back).
- The proof is kept in the `profile-photos` blob store as `creator-proof-<id>` and only served to the console.

Admin console: `/admin/v1/creators/verification` (list, `:id/proof`, `:id/approve`, `:id/reject { reason }`) with the
new permission `creators.review` (super, operations and support admins). See `PLATFORM_ADMIN_CONSOLE.md`.

## Creator programme

Nothing is paid by the server. The steps are verified → applied → approved.

- `GET /v2/creators/program` → `{ steps: { verified, applied, approved }, application, posts }`.
- `POST /v2/creators/program/apply` → 201 `{ application }`. Verified creators only (`403 not_verified_creator`); one
  waiting at a time (`409 application_open`); `409 conflict` once approved.
- `POST /v2/creators/posts { url, platform, views? }` → 201 `{ post }`, for approved members who are still verified
  (`403 not_in_creator_program`). Each link once (`409 conflict`), at most 200 waiting to be counted.
- `GET /v2/creators/posts` → `{ posts }` with `counted` and the operator's `rewardNote`.

Admin console: `/admin/v1/creators/program` (list, `:id/approve`, `:id/reject { reason }`) and
`/admin/v1/creators/posts?status=pending|counted` with `POST :id/review { counted, rewardNote? }`.

Collections: `creator_verifications`, `creator_program` (each with a unique index on the person while `pending`),
`creator_posts` (unique per person and link).

## Linked accounts (`connections-v2`)

Steam (OpenID 2.0, the assertion checked with Steam's `check_authentication`), AniList (OAuth 2), Last.fm (web auth,
signed `auth.getSession`) and Trakt (OAuth 2 with PKCE S256). Each is off until its keys are set:

| Provider | Settings |
| --- | --- |
| Steam | `STEAM_API_KEY` |
| AniList | `ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET` |
| Last.fm | `LASTFM_API_KEY`, `LASTFM_SHARED_SECRET` |
| Trakt | `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET` |

All of them also need `PUBLIC_API_URL` (the callback is `<PUBLIC_API_URL>/v2/connections/<provider>/callback`: register
exactly that with each provider) and `PUBLIC_WEB_URL` (or the first of `WEB_ORIGINS`), where people land afterwards:
`/settings/profile`. Half a pair stops the server at start.

- `GET /v2/connections` → `{ connections: [{ provider, available, connected, visible, account, connectedAt }] }`,
  always the four providers in that order. `account` is `{ provider, name, url, itemsKind, items, updatedAt }`.
- `POST /v2/connections/:provider/start` → `{ url }` to send the browser to (`409 connection_unavailable` without keys).
  The `state` is `<payload>.<HMAC-SHA256>` with the person, provider, a nonce and a 10-minute expiry; the nonce must
  also match a start recorded on the server (`linked_account_starts`), so each state works once. The HMAC key is
  derived from `PLATFORM_SECRETS_KEY`; without it each process makes its own at start.
- `GET /v2/connections/:provider/callback` (no session) finishes and redirects (302) to
  `/settings/profile?connected=<provider>`, or `?connectionError=<code>&provider=<provider>` with `state` (expired,
  reused, tampered or for another provider), `denied` (turned down on the provider's page), `failed` (the provider
  refused or didn't answer) or `unavailable`.
- `PUT /v2/connections/:provider { visible }` → `{ connection }` (404 when not connected); `DELETE` → `{ connection }`
  (harmless when not connected; Trakt is asked to revoke its token).
- Tokens are kept sealed with `PLATFORM_SECRETS_KEY` (AES-256-GCM, bound to the person and provider). Without the key
  they aren't kept at all: the public data needs none, only Trakt's revocation on disconnect is lost.
- **What profiles show** (`connections` on `GET /v1/users/me` and `GET /v1/users/:id`, absent when there's none, and for
  someone the person blocked): Steam's persona name, profile and up to 5 recently played games; AniList's name, profile
  and up to 5 currently watching; Last.fm's name, profile and the track playing now, or else the top 5 artists of the
  last month; Trakt's name, profile and up to 5 recently watched. Every link is built from ids, never copied from the
  provider; every text is cut to one line.
- **Refresh**: fetched on connect, then at most every 6 hours when a profile or `GET /v2/connections` is read, in the
  background: the reader always gets what's stored. A failed refresh waits another 6 hours too. Refreshes read public
  data only, so a private profile at the provider keeps what was fetched when it was connected.
- All outbound requests go through `modules/linkedAccounts/outbound.ts`: 8-second timeout, no redirects, 1 MB at most,
  answers validated, and logs carry only the provider, host, path and status (never a query string, header or body).

Collections: `linked_accounts` (`<userId>|<provider>`), `linked_account_starts`.

Deleting an account removes its creator applications and their proofs, programme applications, posts and linked
accounts.

# Settings parity, batch B: developer apps and bots (API 0.65.0)

The server side of "Log in with Meldiq" apps and bots from the web repo's `docs/MELDIQ_SETTINGS_PARITY.md` (§1
"Advanced, Developer…", §3 step 4). Additive like batch A: two new feature names, new MongoDB collections (memory
without MongoDB), no SQLite table or MongoDB validator change. Code: `server/src/modules/oauth`, `server/src/modules/bots`,
contracts in `src/shared/contracts/http/oauthApps.ts` and `bots.ts`. Tests: `test/oauth_apps.test.ts`,
`test/bots.test.ts` (each runs on memory and on MongoDB).

| Feature name | What |
| --- | --- |
| `oauth-apps` | `/v2/developer/apps*`, `/v2/oauth/*` |
| `bots` | `/v2/developer/bots*`, `/v2/bots/:botId`, `/v1/orgs/:orgId/bots`, `/v1/orgs/:orgId/commands`, `/v2/interactions`, `/v2/bot/*` |

## "Log in with Meldiq" apps

**Managing apps** (a session): `GET /v2/developer/apps` → `{ apps, limit: 10 }`; `POST` `{ name, redirectUris }` →
201 `{ app, clientSecret }`; `PATCH /v2/developer/apps/:id` `{ name?, redirectUris? }`; `DELETE` (everyone's sign-ins
to it end); `POST /v2/developer/apps/:id/secret` → `{ app, clientSecret }` (the old secret stops at once; tokens already
given out keep working). The app's `id` is its `client_id`. The secret (`mqs_…`) is shown once and stored as a SHA-256
hash. Redirect URIs: 1 to 10, https, or http on `localhost`, `127.0.0.1` or `[::1]` while developing; no `#fragment`, no
user info. The 11th app is `409 limit_reached` (`details.limit`).

**The flow** (OAuth 2.0 authorization code, RFC 6749, with PKCE, RFC 7636):

1. The app sends the browser to the web app's consent page with `client_id`, `redirect_uri`, `scope` (`identify`,
   `email`, space-separated; `identify` is always included), `state`, and, for apps without a server,
   `code_challenge` + `code_challenge_method=S256` (`plain` is refused).
2. The page calls `GET /v2/oauth/authorize/info?…` (signed in): `{ app: { id, name, ownerUsername }, scopes: [{ id,
   description }], redirectUri, alreadyAuthorized }`. An unknown client or an unregistered redirect URI is `400
   oauth_invalid_client` / `oauth_invalid_redirect` and is never redirected to; a bad scope or PKCE method is `400
   oauth_invalid_scope` / `oauth_invalid_request`.
3. The person approves or denies: `POST /v2/oauth/authorize` (same parameters plus `approve`) → `{ redirect }`, the
   redirect URI with `?code=mqc_…&state=…`, or `?error=access_denied&state=…`. Codes are single use and last 10 minutes.
4. The app calls `POST /v2/oauth/token` (form or JSON; client credentials as HTTP Basic or `client_id` /
   `client_secret` in the body, not both):
   - `grant_type=authorization_code`, `code`, `redirect_uri` (the same one), `code_verifier`. A code asked for with a
     challenge needs the matching verifier. A code asked for without one needs the client secret.
   - `grant_type=refresh_token`, `refresh_token`, optional narrower `scope`.
   → `{ access_token: "mqo_…", token_type: "Bearer", expires_in: 3600, refresh_token: "mqr_…", scope }`, with
   `Cache-Control: no-store`. Errors are RFC 6749 §5.2 bodies, `{ error, error_description }`: `invalid_request`,
   `invalid_client` (401, with `WWW-Authenticate: Basic` after Basic), `invalid_grant`, `unsupported_grant_type`,
   `invalid_scope`.
5. `GET /v2/oauth/userinfo` with `Authorization: Bearer <access token>` → `{ id, username, displayName, avatarUrl }`,
   plus `email` and `emailVerified: true` with the `email` scope once the address is verified. `avatarUrl` points at
   `GET /v2/oauth/userinfo/avatar` (the same token; JPEG), and is null unless the person shows their photo to everyone.
   A bad token is `401 invalid_token` with `WWW-Authenticate: Bearer error="invalid_token"`.

**Security decisions.**

- OAuth access tokens work on `/v2/oauth/userinfo*` only. They live in their own collection, so every other route's
  session lookup (v1 sessions, account sessions) never finds them; a test checks the main routes, the socket's lookup is
  the same.
- Only hashes are stored: client secrets, codes, access and refresh tokens. Secrets and codes are compared by hash in
  constant time.
- Each code exchange starts a token family. Refresh tokens rotate: each refresh answers a new one, and the replaced one
  presented again (a copy in use) revokes the whole family. A code presented twice revokes the tokens it gave. A
  family made with the client secret needs the secret to refresh.
- A failed exchange (a wrong verifier, say) uses the code up: the app starts again.
- Approving records a grant (scopes added up over approvals). `GET /v2/oauth/grants` lists them (`app`, `scopes`,
  `createdAt`, `updatedAt`); `DELETE /v2/oauth/grants/:clientId` → `{ revoked }` removes the grant, its unused codes and
  every token at once.
- No CORS for third-party browser apps yet: apps exchange codes from their server or a native app. A single-page app
  would need `Access-Control-Allow-Origin` on `/v2/oauth/token` and `/userinfo` (not built).

Collections: `oauth_apps`, `oauth_codes` (by hash), `oauth_grants` (`<appId>|<userId>`), `oauth_tokens` (families).
Expired codes and families are swept at most every 10 minutes from the token endpoint.

## Bots

**A bot is an account.** A `users` row of kind `agent`, the kind AI agents' bot identities had before 0.47.0 (the only
other value migration 053 allows), so no schema change. It has no account row, email, password or device, and an
identity key nobody holds the private half of: it can't sign in. Everything that means people only already leaves that
kind out (search, DMs, suggestions, delivery queues, points). User payloads (`UserSummary`, profiles, member lists) carry
`bot: true` for it, absent for people. Bots never earn points, and reacting or replying to a bot's message doesn't count
for quests. (Production's one leftover AI agent account also shows `bot: true` now; it has no token and does nothing.)

**Owners** (a session): `GET /v2/developer/bots` → `{ bots, limit, plan }`; `POST` `{ name, username?, public? }` → 201
`{ bot, token }`; `PATCH /v2/developer/bots/:id` `{ name?, public? }`; `DELETE` (the token stops first, then the bot
leaves every community and its account is erased like a person's: "Deleted account" on what it sent);
`POST /v2/developer/bots/:id/token` → `{ bot, token }`. The token (`mqb_…`) is shown once, stored hashed. The quota is
the owner's plan's `bots` in `billing/perks.ts` (Free 2, Go 4, Plus 10): past it, `409 limit_reached` with `details: {
limit, plan }`. Bots made private later stay in communities they were added to. Deleting the owner's account deletes
their bots, their apps and their own sign-ins to apps.

**Communities.** `GET /v2/bots/:botId` shows a public bot (or your own) before adding it: `{ bot: { id, username,
displayName, public, owner, commands } }`. `POST /v1/orgs/:orgId/bots { botId }` → `{ bot, installed }` needs the
community's Edit community permission (owners and admins); a private bot only its owner can add (`403 bot_private`).
It joins as a MEMBER: roles, channel overwrites, slowmode and the member limit apply to it as to anyone, a ban keeps it
out, admins may give it roles. `DELETE /v1/orgs/:orgId/bots/:botId` → `{ removed }`.

**The bot API**: `Authorization: Bot <token>`, only on `/v2/bot/…` (which accepts nothing else). Rate limited per
bot: 120 a minute for reads, polls and replies, 60 for messages, 10 for command registration.

| Route | |
| --- | --- |
| `GET /v2/bot/me` | `{ bot: { id, username, displayName, public, ownerId } }` |
| `GET /v2/bot/communities` | `{ communities: [{ id, name, channels: [{ id, name, kind, voice, canPost }] }] }` (channels it's in) |
| `POST /v2/bot/channels/:channelId/messages` | `{ content (≤4000), replyTo?, messageId? }` → `{ messageId, serverTs, duplicate }` |
| `PATCH /v2/bot/messages/:messageId` | `{ content }`: edits its own message (`403 not_yours` otherwise) |
| `DELETE /v2/bot/messages/:messageId` | deletes its own message |
| `GET` / `PUT /v2/bot/commands` | `{ commands }`: replaces all of them |
| `GET /v2/bot/interactions?wait=0..25` | `{ interactions }`, waiting up to `wait` seconds for the first |
| `POST /v2/bot/interactions/:id/reply` | `{ content, ephemeral? }` → `{ interactionId, ephemeral, messageId }` |

Messages go through the same function as `POST /v2/messages` (`messaging/serverSend.ts`, with the bot as the sender
and no device): membership, posting permission, slowmode, @everyone policy and the plan's characters (a bot has the
Free plan's) all apply, and every member's devices get an ordinary message whose `senderUserId` is the bot
(`senderDeviceId` null). Bots are never in DMs or groups.

**Slash commands.** Up to 100 per bot, names `^[a-z0-9-]{1,32}$` (unique), a description (1–100), up to 25 options
(`name`, `description`, `type`: `string` | `number` | `boolean` | `user` (a user id), `required`, default false). Members
list them with `GET /v1/orgs/:orgId/commands?channelId=` → `{ commands: [{ botId, botUsername, botDisplayName, name,
description, options }] }` (with `channelId`, only bots that can post there). Running one: `POST /v2/interactions
{ channelId, botId, command, options: { name: value } }` → 201 `{ interaction: { id, botId, command, createdAt,
expiresAt } }`. The person must be able to post in the channel and the bot must be in it (`404 bot_not_here`); options
are checked against the command (400). At most 500 waiting per bot (`429 rate_limited`).

The bot takes interactions with the long poll (plain HTTPS from its own computer, nothing to host). Each is handed
out once; one not answered within 60 seconds is handed out again (a bot that crashed). It answers within 15 minutes
(`410 interaction_expired` after; `409 interaction_answered` the second time). A public answer is a message from the bot
in the channel, its payload carrying `interaction: { id, command, userId }`. An ephemeral one is never stored: the person
who ran the command gets a realtime frame `interaction.reply` (`interactionId`, `conversationId`, `botId`, `command`,
`content`, `at`). If a public answer can't be posted (the bot lost its posting rights, slowmode), the interaction stays
open so it can answer again.

A bot answering one command with curl:

```sh
H="Authorization: Bot $MELDIQ_BOT_TOKEN"; API=https://msg.meldiq.app
curl -s -X PUT -H "$H" -H 'content-type: application/json' "$API/v2/bot/commands" \
  -d '{"commands":[{"name":"roll","description":"Roll a die","options":[{"name":"sides","description":"Sides","type":"number","required":true}]}]}'
while :; do
  I=$(curl -s -H "$H" "$API/v2/bot/interactions?wait=25" | jq -c '.interactions[0] // empty')
  [ -z "$I" ] && continue
  ID=$(jq -r .id <<<"$I"); N=$(( RANDOM % $(jq .options.sides <<<"$I") + 1 ))
  curl -s -X POST -H "$H" -H 'content-type: application/json' "$API/v2/bot/interactions/$ID/reply" -d "{\"content\":\"You rolled $N\"}"
done
```

Collections: `bots` (by the bot's user id; the token hash has a unique index) and `bot_interactions` (kept an hour past
their expiry, then swept).
