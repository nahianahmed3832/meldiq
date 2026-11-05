# Community parity API

The server side of the web repo's `docs/MELDIQ_COMMUNITY_PARITY.md` (the reference app's community management, copied
into Meldiq). Each batch is additive: its own feature name with an environment switch, new tables only (no change to
existing ones), and the API version is set when the batches ship together.

## Lobby

Batch B: the community's home page. Members land on it the first time they open the community; it shows a header with
counts, an about text, main channels, a FAQ, who runs the community, voice rooms with people in them, leaderboards, the
onboarding answers that give roles, the rules channel, links and an incoming feed, in the community's own look and card
order. The community guide on Home (`PUT /v1/orgs/:orgId/guide`) is unchanged and stays alongside it.

Code: `server/src/modules/organizations/lobby` (store, service, view, sources, boards, feed, defaults and templates,
routes); contracts in `src/shared/contracts/http/communityLobby.ts`, `communityLobbyView.ts` and
`communityLobbyRoutes.ts`. Tables (migration 072, workspace domain, so SQLite or MongoDB): `community_lobbies`,
`community_lobby_feeds`, `community_lobby_posts`, `community_lobby_seen`. Tests: `test/community_lobby.test.ts` (the
community tables in SQLite and in MongoDB, and switched off).

| Feature name | What |
| --- | --- |
| `community-lobby` | `/v1/orgs/:orgId/lobby…`, `POST /v1/lobby-feed/:token`, `lobby` on community views |

`COMMUNITY_LOBBY=off` switches it off: the feature name goes, every route answers `503 feature_disabled`, community
views lose `lobby`, and what communities set is kept. `LOBBY_FEED_IMAGE_HOSTS` (comma-separated) adds picture hosts the
feed accepts besides YouTube (`youtube.com`, `ytimg.com`), Twitch (`twitch.tv`, `jtvnw.net`) and Imgur (`imgur.com`); a
host covers its subdomains.

**Settings.** `GET /v1/orgs/:orgId/lobby/settings` (members; outsiders get 404) →
`{ settings, rev, updatedAt, canEdit, feed }`. `settings` is:

| Field | What |
| --- | --- |
| `enabled` | Show the lobby to members (apps open it first while it's unseen). Default true. |
| `tagline` | Up to 120 characters, or null. |
| `buttons` | Up to 4 `{ label (≤40), url, channelId }`: exactly one of an https `url` (≤500) or a `channelId` of the community. The first is the primary one. |
| `about` | Markdown, up to 2,000 characters, or null. |
| `mainChannelIds` | Up to 6 channels of the community, in tap order. Empty: the busiest channels the viewer can see. |
| `faq` | Up to 10 `{ id, question (≤200), answer (≤1,000) }`. |
| `showWhoRunsIt` | The same switch as the `who_runs_it` card's `shown`. |
| `look` | `layout` classic\|spotlight\|magazine\|compact, `accent` "auto" or "#rrggbb", `background` glow\|mesh\|banner_blur\|plain, `cards` filled\|glass\|outline, `font` default\|rounded\|serif\|mono\|display, `bannerHeight` tall\|normal\|short, `title` left\|centered. |
| `sections` | All 11 cards once each, in page order: `{ key, shown, column: "main"\|"side" }`. Keys: about, main_channels, live_now, giveaways, feed, faq, leaderboard, pick_roles, rules, who_runs_it, links. Default order is that one, with leaderboard, pick_roles, rules, who_runs_it and links in the side column. |
| `leaderboards` | A non-empty ordered subset of `levels`, `messages_week`, `invites` (tabs). |

Members who can't edit the community never see channels they can't open: those are left out of `mainChannelIds` and
channel buttons. `canEdit` is `workspace.edit`. `feed` is `{ createdAt, lastPostAt }` for editors when there is a feed
URL, null otherwise (always null for everyone else).

**Changing it.** `PUT /v1/orgs/:orgId/lobby/settings` `{ rev, …fields }` → the settings view. Needs `workspace.edit`
(`403 forbidden`). Fields left out keep their value; `look` may set some of its fields. `rev` is the revision the change
was made on (0 before the first save); someone else's save in between gives `409 lobby_stale` with `details.rev`, the
current one. A change that changes nothing saves nothing. Channels must be live channels of the community (private ones
are fine: members only receive the ones they can see), otherwise `400 lobby_channel_invalid` with `details.channelId`.
FAQ ids are kept when sent back (1–32 of `A-Za-z0-9_-`). Setting `showWhoRunsIt` moves the card's switch and the other
way round (`showWhoRunsIt` wins when both are sent). Audit: `community.lobby` with the changed fields; members are told
`org.updated`.

**Templates.** `POST /v1/orgs/:orgId/lobby/template` `{ key, rev? }` → the settings view (`workspace.edit`; `rev`, when
sent, is checked like above). Sets the look, the cards' order, visibility and columns, and the boards; text, channels
and buttons stay; 3–4 starter questions are added only when the FAQ is empty. Audit: `community.lobby_template`.

| Key | Look | Cards shown, in order |
| --- | --- | --- |
| `gaming` | classic, #8b5cf6, mesh, glass, display, tall, left | live now, main channels, giveaways, feed, about, FAQ; side: leaderboard (all three boards), pick roles, rules, who runs it |
| `study` | spotlight, #4f7cac, plain, outline, serif, short, centered | about, main channels, live now, FAQ, rules, pick roles, who runs it, links (messages this week) |
| `creators` | magazine, #ec4899, banner blur, filled, rounded, tall, centered | feed, links, about, main channels, giveaways, FAQ; side: leaderboard (invites, messages), who runs it, rules, pick roles |
| `hangout` | classic, #f59e0b, glow, filled, rounded, normal, left | about, main channels, live now, giveaways, FAQ; side: pick roles, leaderboard (messages, levels), who runs it, rules, links |
| `minimal` | compact, auto, plain, outline, default, short, left | about, main channels, FAQ, rules |

**The lobby.** `GET /v1/orgs/:orgId/lobby` (members) → everything the page shows, worked out for the viewer:

- `community`: `{ id, name, photoRev, bannerRev, accent, memberCount, onlineCount }` (online: connected and not
  invisible).
- `settings` (as above, for this viewer), `rev`, `canEdit`, `seen`, `seenAt`.
- `mainChannels`: `[{ id, name, kind, voice, format, lastActiveAt }]` and `mainChannelsPicked`. Picked channels the
  viewer can see; when none are picked (or none of them are visible), the viewer's text channels by this week's
  messages, then in the community's order, at most 6 (`mainChannelsPicked: false`).
- `whoRunsIt`: `[{ user, badge: owner|admin|mod }]`, at most 25: the owner, admins and anyone whose custom roles let
  them edit the community (admin) or ban or time people out (mod; also manage messages once that permission exists).
  Empty when the switch is off, except for editors (the live editor previews it).
- `liveNow`: voice channels the viewer can see with people in a call now, busiest first: `{ channelId, name, callId,
  startedAt, participantCount, participants }` (the first 8 people).
- `rules`: `{ channelId }` when the community has a rules channel (feature `rules-channel`) the viewer can see, else null.
- `links`: `[{ label, url }]` from the community's links (community parity A's `communitySettings`; empty on a server
  without it).
- `pickRoles`: `{ prompts: [{ id, title, single, options: [{ id, title, emoji, roles: [{ id, name, color }] }] }],
  answered }`: onboarding questions (when onboarding is on) with only the answers that give roles, and the option ids
  the viewer picked. Answering stays `POST /v1/orgs/:orgId/onboarding/answers`.
- `leaderboards`: the settings' boards in order, `{ board, entries: [{ rank, user, count }] }`, top 10 current members.
  `messages_week`: messages sent in the last 7 days in channels the viewer can see (counted once per community and set
  of visible channels, reused for 5 minutes). `invites`: the sum of uses of the invitations each member made (Meldiq
  doesn't record which invitation a member joined with, so people who joined and left since still count). `levels`:
  the Levels bot's XP (`count` is XP) while that bot is on (see Official bots below), empty otherwise.
- `giveaways`: running giveaways of the Giveaways bot in channels the viewer can see, ending first: `{ id, title (the
  prize), endsAt, entrants }` (see Official bots).
- `feed`: the newest 20 feed posts, newest first: `{ id, title, text, url, image, postedAt }`.

People (`user`, `participants`) are `{ id, username, displayName, avatarColor, photoRev }`, with the photo only when the
person shows it to everyone.

**First visit.** `POST /v1/orgs/:orgId/lobby/seen` → `{ seen: true, seenAt }`; the first time is kept. Community views
carry `lobby: { enabled, seen }` for members, so an app opens the lobby first when `enabled && !seen` without loading
it. Leaving the community forgets it; deleting the account removes it.

**Feed URL.** `POST /v1/orgs/:orgId/lobby/feed` → `{ token, feed: { createdAt, lastPostAt } }` (`workspace.edit`).
The URL is `<API base>/v1/lobby-feed/<token>`; the token is shown only now (the server keeps its SHA-256). Posting
again replaces the URL and the old one stops working at once. `DELETE /v1/orgs/:orgId/lobby/feed` → `{ feed: null }`;
posts already in the lobby stay. Audit: `community.lobby_feed` (created, replaced, deleted).

`POST /v1/lobby-feed/:token` (no sign-in, 30 posts a minute per URL) takes Meldiq's `{ title, text, url, image }` or a
Discord-style webhook body `{ content, embeds: [{ title, description, url, image: { url }, thumbnail: { url } }] }`
(the first embed; its description, or `content`, is the text) → `{ id, postedAt }`. Titles are cut to 200 characters
and text to 1,000; links must be https (`400 lobby_feed_invalid`, also when there's no title, text or link); a picture
that isn't https on an allowed host is dropped and the post still goes in. The newest 20 posts per community are kept.
An unknown or replaced token gets 404.

## Posting tools (batch C)

Channel webhooks, "Make a post", reaction roles and tickets. New tables only (migration 073, workspace domain, so new
MongoDB collections when communities live there): `channel_webhooks`, `reaction_roles`, `community_tickets`,
`ticket_panels`, `tickets`. Each goes with its community; a channel's rows go with the channel, a role's reaction
roles with the role. Code: `server/src/modules/organizations/posting`; contracts in
`src/shared/contracts/http/{webhooks,reactionRoles,tickets}.ts`. Tests: `test/channel_webhooks.test.ts`,
`test/reaction_roles.test.ts`, `test/tickets.test.ts` (communities in SQLite and in MongoDB).

| Feature name | Switched off by | What |
| --- | --- | --- |
| `channel-webhooks` | `CHANNEL_WEBHOOKS=off` | Webhooks, their addresses and "Make a post" |
| `reaction-roles` | `REACTION_ROLES=off` | Reaction roles (reactions stop giving roles) |
| `community-tickets` | `COMMUNITY_TICKETS=off` | Tickets, panels, "Open a Ticket" |

Switched off, the feature name goes, its routes answer `503 feature_disabled`, and what communities set up is kept.

### Who posts: sender accounts

A webhook, and each community's "Tickets", posts as a sender account of its own: a bot-kind account (`users.kind`
`agent`, like bots) that can never sign in and is a member of nothing, so it isn't listed, counted or notified. Its
messages go through the one message path (`sendServerMessage`) with a grant for the single channel the server checked,
so they are ordinary channel messages: stored, delivered, searchable, reacted to. Membership, posting rights and
slowmode don't apply to them; an archived or voice channel still refuses (403). The account outlives its webhook, so
posts keep a name (profiles say `bot: true`). Only these senders may put `embeds`, `buttons` or `webhook` in a
payload: `POST /v2/messages` refuses them from people and bots (400).

### Message payload fields

```
embeds?:  [{ title?, description?, url?, color?: 0xRRGGBB, author?: {name}, image?: {url}, thumbnail?: {url}, footer?: {text} }]
buttons?: [{ kind: "link", label: string|null, emoji: string|null, url }
         | { kind: "action", action: "open_ticket" | "close_ticket", label, emoji, panelId? }]
webhook?: { id, name, avatarUrl: string|null }       // show with a BOT tag
textFromEmbeds?: true    // `text` was made from the boxes for older apps: don't show it beside them
title?:   string         // a forum post's title (text then starts with it and a blank line)
```

`avatarUrl` is the poster's https override, or `/v1/webhooks/:id/avatar?rev=…` (fetch with the session), or null.
`open_ticket` calls `POST /v1/orgs/:orgId/tickets` with its `panelId`; `close_ticket` calls `.../tickets/:channelId/close`
for the channel it's in.

### Webhooks (`webhooks.manage`)

A new permission, `webhooks.manage` ("Manage webhooks", channels, administrative): owners and admins hold it, the
Moderator template carries it, Discord's Manage Webhooks maps to it. Every change is in the audit log
(`webhook.create`, `webhook.update`, `webhook.token_rotate`, `webhook.delete`).

Under `/v1/orgs/:orgId/channels/:channelId/webhooks` (the channel must be one the caller can see):

| Route | Body | Answer |
| --- | --- | --- |
| `GET` | | `{ webhooks: [Webhook], limit: 10 }` |
| `POST` (201) | `{ name? }` (≤80; a friendly name like "Plucky Puffin" when left out) | `{ webhook, token }` |
| `PATCH /:webhookId` | `{ name }` | `{ webhook }` |
| `PUT /:webhookId/avatar` | JPEG, or animated GIF/WebP (community icon rules) | `{ webhook }` |
| `DELETE /:webhookId/avatar` | | `{ webhook }` |
| `POST /:webhookId/token` | | `{ webhook, token }`: the old address stops working |
| `DELETE /:webhookId` | | `{ deleted: true }`: posted messages stay |
| `POST /:webhookId/post` | the webhook body below | `{ id, channelId, serverTs }`: "Make a post" |

`Webhook` = `{ id, channelId, name, avatarUrl, createdBy: {id, displayName}|null, createdAt, tokenRotatedAt,
lastUsedAt|null }`. The token (`mqw_` + 43 characters) is shown only when made or rotated; only its SHA-256 is kept.
The address is `<API base>/v1/webhooks/<webhook.id>/<token>`, and the server never logs it. A text, announcement or
forum channel takes webhooks (`400 webhook_channel` otherwise), 10 at most (`409 webhook_limit`, details `{limit}`).
`GET /v1/webhooks/:webhookId/avatar` serves the picture to members of its channel.

**`POST /v1/webhooks/:webhookId/:token`**: no session; 30 posts a minute per webhook address. A wrong token or an
unknown webhook is `404 not_found`. Body (Discord's execute-webhook JSON; `?wait=true` is accepted):

- `content` ≤2000; `username` ≤80 and `avatar_url` (https) override the webhook's name and picture for this post;
- `embeds` ≤10: `title` ≤256, `description` ≤4096, `url`, `color` (number or `#RRGGBB`), `author.name` ≤256,
  `image.url`, `thumbnail.url`, `footer.text` ≤2048; ≤6000 characters across all of them; each needs something to
  show. Discord fields Meldiq doesn't show (`fields`, `timestamp`, icons) are accepted and dropped;
- link buttons, ≤5 in all: `buttons: [{ label?, emoji?, url }]` and/or Discord `components` (action rows of
  `type: 2, style: 5` buttons, `emoji.name`); each needs a label or an emoji; other components are refused;
- `thread_name` ≤100: required in a forum channel (the post's title);
- every address is https, with no credentials. Content or a box is required. Anything wrong: `400 bad_request` with
  `details` naming the field.

Answer `{ id, channelId, serverTs }`.

### Reaction roles (`roles.assign`)

`/v1/orgs/:orgId/channels/:channelId/messages/:messageId/reaction-roles` (a message of that channel):

| Route | Body | Answer |
| --- | --- | --- |
| `GET` (anyone in the channel) | | `ReactionRoles` |
| `PUT` | `{ reactionRoles: [{ emoji ≤64, roleId }] }` (1–20; each emoji and role once) | `ReactionRoles` |
| `DELETE` | | `{ deleted: boolean }` (roles already given stay) |

`ReactionRoles` = `{ messageId, channelId, reactionRoles: [{ emoji, roleId, roleName, roleColor }], setBy, setAt }`.
Only roles the caller could assign under the role rules and that carry no administrative power, for owners too
(`403 reaction_role_not_givable`, details `{roleId}`). A reaction (`{type: "reaction", target, emoji, add}` through
`POST /v2/messages`) with a paired emoji on that message, in that channel, gives the role (`org_role_members.assigned_by`
= `reaction_roles`); taking it off (`add: false`) takes back only a role a reaction gave. Timeouts and the rules
agreement refuse the reaction itself, so nothing is given. Checked again each time: archived roles and roles that
gained an admin power aren't given; guests get only roles a guest may hold; bots never. Audit: `reaction_roles.set`,
`reaction_roles.remove`, and `role.assign`/`role.unassign` with detail "(reaction role)". Deleting the message removes
its pairs; deleting the role or channel too.

### Tickets

Settings (people with `workspace.edit`): `GET`/`PUT /v1/orgs/:orgId/tickets/config`,
`{ enabled, maxOpenPerPerson: 1–3 (default 2; up to 10 with Bots+), panels: [{ id?, name ≤40, postChannelId, categoryId|null, logChannelId|null }] ≤2 (≤10 with Bots+) }`
→ `{ enabled, maxOpenPerPerson, panels: [{ id, name, postChannelId, categoryId, logChannelId, postedMessageId }], panelLimit: 2|10 }`.
Since batch D part 2 this is also the Tickets bot's switch and settings (see Official bots); beyond the free limits
without Bots+ is `403 bots_plus_required`.
Panel ids are kept when sent back. `postChannelId`: a public or announcement text channel; `logChannelId`: any text
channel (a private one is best); `categoryId` null: a "Tickets" category, made when there isn't one
(`400 ticket_channel_invalid`, details `{panel, field}`). Audit `tickets.config`.

- `POST /v1/orgs/:orgId/tickets/panels/:panelId/post` → `{ messageId, channelId }`: the Tickets account posts the
  panel's box with an `open_ticket` button (`409 tickets_off` while off).
- `POST /v1/orgs/:orgId/tickets` (201) `{ panelId?, about ≤300, notABugReport: true }` → `{ ticket }`.
  `notABugReport` false: `400 ticket_confirm_required`; tickets off: `409 tickets_off`; not in the community: 404;
  beyond `maxOpenPerPerson`: `409 ticket_limit` details `{max}`. Makes the private channel `ticket-<n>-<username>` in
  the panel's category (the first panel when none is named), with the opener and today's staff in it; overwrites hide it
  from @everyone and let the opener and every role with a moderation power see, post and attach. Staff: owners,
  admins, and holders of `members.timeout`, `members.ban`, `members.remove` or `reports.view`. The Tickets account
  posts the text first (a box with a `close_ticket` button) and logs "opened" in the panel's log channel.
- `GET /v1/orgs/:orgId/tickets` → `{ tickets: [Ticket] }`: open tickets, all of them for staff, your own otherwise.
- `POST /v1/orgs/:orgId/tickets/:channelId/join` → `{ ticket }`: staff who weren't staff when it opened.
- `POST /v1/orgs/:orgId/tickets/:channelId/close` → `{ ticket }`: the opener or staff (403 otherwise, `409
  ticket_closed` twice). Says "closed by X" in the ticket, archives the channel and moves it out of its category (so
  the category only holds open tickets), logs it. Works while the community has tickets off.

`Ticket` = `{ channelId, number, name, panelId, panelName, opener: {id, username, displayName}|null, about, openedAt,
closedAt, closedBy, joined }`. Community views (`GET /v1/orgs/:orgId` and lists) carry, for members while tickets
are on, `tickets: { panels: [{id, name}], maxOpenPerPerson, openByMe }`: the menu shows "Open a Ticket" then.
Audit: `ticket.open`, `ticket.join`, `ticket.close`, `channel.archive`, `tickets.panel_post`.

Limits: a category holds 50 channels (409 when the tickets category is full of open tickets); closed tickets still
count toward a community's 500 channels.

## Official bots (batch D, parts 1 and 2)

Meldiq's own bots a community turns on from Settings › Bots: Welcomer, Helper, Levels, Logger and Starboard (part 1),
Giveaways, Tickets, Alerts and Wordy (part 2). A bot this server can't run is listed with `available: false` and an
`unavailableReason` and refuses to turn on (`409 official_bot_unavailable`): Alerts without `YOUTUBE_API_KEY` ("Needs a
YouTube API key on this server"), Tickets with `COMMUNITY_TICKETS=off`. New tables only (migration 074, workspace
domain): `official_bots`, `official_bots_plus`, `bot_levels`, `bot_afk`, `bot_starboard`; part 2 (migration 076):
`bot_giveaways`, `bot_alert_watches`, `bot_wordy_games`, `bot_wordy_stats`, `bot_wordy_recaps`. Code: `server/src/modules/officialBots` (runtime,
events, dispatch, commands, catalog, settings, store, manage, routes, one file per bot) and
`modules/platformAdmin/botsPlus.ts`; part 2 adds giveaways (+ giveawayParse), ticketsBot, alerts (+ youtube), wordy
(+ wordyGame, word lists in `server/assets/wordy`, or `WORDY_DIR`) and scheduler. Contracts in
`src/shared/contracts/http/officialBots.ts` and `officialBotTools.ts`. Tests: `test/official_bots.test.ts`,
`test/official_bots_activity.test.ts`, `test/official_bots_games.test.ts`, `test/official_bots_desk.test.ts`
(communities in SQLite and in MongoDB; a fake YouTube, never the real API).

| Feature name | Switched off by | What |
| --- | --- | --- |
| `community-bots` | `COMMUNITY_BOTS=off` | Official bots, their routes and their hooks |

Switched off, every route answers `503 feature_disabled`, the bots stop acting (their members stay), and what
communities set is kept.

**How a bot is in a community.** Turning one on makes (once) a hidden bot account for that bot in that community
(`users.kind` `agent`, never signs in) and adds it as a member, like a developer bot: the member list shows it among the
bots (`bot: true`), with the community's name for it (`look.name`, ≤32, else the bot's name) and picture
(`GET /v1/users/:userId/photo`). Turning it off removes the member and keeps its settings and account. A manager who
removes or bans the bot from the member list turns it off too (audit `official_bot.off`). Bots post through the one
message path: answers in the chat where someone ran a command follow the rules every bot follows there (it must be a
member that may post, otherwise it stays quiet), and posts in a channel a manager picked (welcome, log, starboard,
level-ups) go with a grant for that channel, so a private log channel works. Starboard edits its own post's count line
(a granted `edit`, the only change a grant allows).

**Hooks.** Two cheap hooks only queue events; one queue handles them after the write that caused them, so a bot never
slows or fails anyone's request (a failing bot is logged and the others go on):

- the message path (`messaging/serverSend.ts`, after acceptance, community conversations): messages and the `edit`,
  `delete` and `reaction` changes;
- the audit trail (`ctx.audit` in `app/server.ts`): joins (`community.join`, `invite.accept`, `member.add`,
  `application.approved`), `member.leave`/`remove`/`expire`/`ban`/`unban`/`timeout`/`timeout_end` (with who did it),
  and `role.assign`/`role.unassign`.

Bots' messages (official or not) never run commands or earn XP. Messages starting with `!` are commands for the bots
that are on; `!help` lists the commands of every bot on (answered by Helper, else Levels).

**Routes.** "Editors" hold `workspace.edit`; members may read.

| Route | Answer |
| --- | --- |
| `GET /v1/official-bots` | `{ bots: [CatalogBot], botsPlus: { name, description, perks: [string] } }` |
| `GET /v1/orgs/:orgId/official-bots/alerts/watches` (editors) | `{ watches: [AlertWatch], limit: 3\|25, defaultMessage }` |
| `POST …/alerts/watches` (editors, 201) `{ source, channelId, roleId?, message? }` | `{ watch: AlertWatch }` |
| `PATCH …/alerts/watches/:watchId` (editors) `{ channelId?, roleId?, message? }` | `{ watch: AlertWatch }` |
| `DELETE …/alerts/watches/:watchId` (editors) | `{ deleted: boolean }` |
| `GET /v1/orgs/:orgId/official-bots/wordy/game` (members) | `WordyGame` |
| `POST …/wordy/game` (members, 30 a minute) `{ guess }` | `WordyGame` |
| `GET /v1/orgs/:orgId/official-bots` (members; outsiders 404) | `{ botsPlus, botsPlusUntil, canEdit, bots: [OfficialBot] }`, all nine in catalog order |
| `GET /v1/orgs/:orgId/official-bots/:key` | `{ bot: OfficialBot }` |
| `PUT /v1/orgs/:orgId/official-bots/:key` (editors) `{ enabled?, settings?, look?: { name } }` | `{ bot }` |
| `PUT /v1/orgs/:orgId/official-bots/:key/avatar` (editors, JPEG ≤512 KB) / `DELETE` | `{ bot }` |
| `POST /v1/orgs/:orgId/official-bots/welcomer/test` (editors) | `{ messageId, channelId }`: Welcomer greets the caller |

`CatalogBot` = `{ key, name, tagline, description, color: "#rrggbb", icon: emoji, features: [string], sample: string,
commands: [{ usage, description }], limits: [{ what, free, plus }], available, unavailableReason }`. `OfficialBot` = `{
key, name, available, unavailableReason, enabled, userId|null, look: { name|null, displayName, photoRev|null }, settings: object|null (editors only),
plusPaused: [field], updatedAt|null }`; `plusPaused` names stored Plus settings not applied because Bots+ is gone.
`look.name` null goes back to the bot's own name.

`settings` may be partial (the rest stay) and is checked against the bot's settings below (`400 bad_request`, details
`{ field }`). Channels must be live text channels of the community the editor can see (`400
official_bot_channel_invalid`, details `{ field, channelId }`). Sending a Plus setting without Bots+ is `403
bots_plus_required`, details `{ bot, settings: [field] }`; stored Plus settings stay while Bots+ is gone and the bot acts
on the free version. Turning on can also answer `403 banned` (the bot's account is banned) or `409 limit_reached` (the
member limit). Audit: `official_bot.on`, `official_bot.off`, `official_bot.update` (the detail names what changed).

| Bot | Settings (defaults) | Plus only |
| --- | --- | --- |
| `welcomer` | `channelId` null (#general, else the first public text channel), `messages` [Meldiq's line] (1–10, ≤300 each; `{user}` mention, `{name}`, `{server}`, `{count}` people), `goodbye` null (≤300) | more than one message (one picked at random), `goodbye` (on leaving; `{user}` is their name) |
| `helper` | `commands` [] | `commands`: ≤25 `{ name (a–z 0–9 _ -, ≤32, not a built-in), response ≤500 ({user} mention) }` |
| `levels` | `announce` true, `announceChannelId` null (where they chat), `boost` 1, `roleRewards` [], `levelUpMessage` null | `boost` 1.5 or 2; `roleRewards` ≤20 `{ level 1–500, roleId }`, each role once (`403 bot_role_not_givable`, details `{roleId}`, unless just for show or assignable by the editor without admin powers); `levelUpMessage` (`{user}`, `{level}`) |
| `logger` | `channelId` null (quiet), `memberChannelId` null, `excludeChannelIds` [] | `memberChannelId`, `excludeChannelIds` ≤25 |
| `starboard` | `channelId` null (quiet), `threshold` 5 (1, 2, 3, 4, 5, 7, 10, 15, 20 or 30), `emoji` null, `selfStar` false, `excludeChannelIds` [] | `emoji` (instead of ⭐ and 🌟), `selfStar`, `excludeChannelIds` ≤25 |
| `giveaways` | `requiredRoleId` null | `requiredRoleId` (an active role of the community, else `400 bad_request`); 20 winners and 30 days instead of 3 and 7 |
| `tickets` | the tickets config: `maxOpenPerPerson` (1–3), `panels` [`{ id?, name, postChannelId, categoryId, logChannelId, supportRoleId: null, welcomeMessage: null }`] (≤2; views add `postedMessageId`), `transcripts` false | `maxOpenPerPerson` 4–10, up to 10 `panels`, a panel's `supportRoleId` and `welcomeMessage` (≤500; `{user}` mention, `{panel}`), `transcripts` |
| `alerts` | `{}` (its YouTube channels are managed under `/alerts/watches`) | 25 channels instead of 3 |
| `wordy` | `channelId` null (quiet) | — |

What each does:

- **Welcomer** greets each person who joins (not bots) once, mentioning them; with Bots+ it says goodbye when someone
  leaves. The test answers `409 official_bot_off` while it's off.
- **Helper**: `!8ball question`, `!roll` / `!roll 20` / `!roll 2d6` (1–20 dice, 2–1000 sides), `!flip`,
  `!choose a | b | c` (2–20 choices), `!afk reason` (≤200). Someone mentioning an away person is told the reason once
  per away note; the away person's next message ends it.
- **Levels**: 15–25 XP (times the boost) for a message of 2+ characters that isn't a command, at most once a minute per
  member and community; level = floor(√(XP/100)). Level-ups are announced (when on) and give the role rewards of the
  levels passed (`org_role_members.assigned_by` `bot:levels`, audit `role.assign` by the bot; checked again then:
  active, no admin powers, guest rules, never to bots). `!rank`: level, XP, place and XP to the next level. `!top`: the
  ten with most XP. Feeds the lobby's Levels board.
- **Logger** writes one line per event, never pinging (mentions written as names, no `mentions`): edits (text before →
  after, from the message store), deletions (the last text, and who deleted it), joins (accounts younger than 7 days
  flagged), leaves, kicks, bans, unbans, timeouts (until when, reason) and role changes, with who did it. Member and
  role events go to `memberChannelId` with Bots+. Both destinations must be private text channels in the same
  community that the configuring editor can view. Restored public destinations stay saved for correction; Logger
  publishes nothing to them and diagnostics show the required private destination. Its own channels and excluded
  sources are skipped. Publication checks the current enabled bot, effective settings and private destination in
  the message acceptance path, including after asynchronous source reads. Existing log entries are unchanged.
- **Starboard**: when a message in a public text channel (not private, not hidden from @everyone, not the starboard or
  an excluded channel) has `threshold` people (not its author unless `selfStar`, not bots) with a star reaction on,
  it's copied once (`bot_starboard` keeps it from going twice): text `⭐ N · Author in #channel` then the message, its
  first image attachment (or a box's image), `starboard: { channelId, messageId }` in the payload, and a "Jump to
  message" link button (`<first WEB_ORIGINS>/m/:channelId/:messageId`) when the server knows its web app. New copies
  and count edits require every current destination member to have source membership and access to the original
  timestamp. The acceptance guard also checks recipients captured while preparing delivery, current effective
  source permissions and the active bot configuration. This guard does not remove existing copies after a later
  source deletion or visibility change; those read and retention protections remain open.

- **Giveaways**: `!giveaway <duration> [Nw] <prize>` (duration: one or more of `Ns`, `Nm`, `Nh`, `Nd`, `Nw`, e.g. `1d12h`;
  10 seconds at least; then optionally `3w` winners; the prize ≤200), `!gend` (the channel's running one, now) and
  `!greroll [n]` (n more winners, 1 by default, for the channel's last ended one, never someone who won it already),
  for people who moderate messages in that channel (`messages.manage` there, or its managers); others and mistakes get
  a line saying how. Free: ≤7 days and ≤3 winners; Bots+: ≤30 days, ≤20 winners and the required role (taken when it
  starts). At most 25 running per community. The bot posts the card in that channel (granted): text `🎉 Giveaway:
  <prize>` + `React with 🎉 to enter · N winners · ends in … (31 Oct, 14:00 UTC) · hosted by X`, an embed with the
  same, and `giveaway: { id, endsAt, winners, ended }` in the payload; it reacts 🎉 itself when it's in the channel and
  may react. Entries are people whose latest 🎉 on the card is on: never bots, still members at the end, holding the
  required role when there is one. At the end the card is edited (a granted `edit` carrying the new `text`, `embeds`
  and `giveaway: { …, ended: true, winnerIds }`; apps replace the boxes too) and the bot posts `🎉 Congratulations
  @a, @b! You won <prize>.` with `mentions` (or that nobody entered). Ending is claimed in the row, so it happens once.
  The lobby's `giveaways` lists running ones in channels the viewer can see, ending first, with `entrants` kept up to
  date from 🎉 reactions.
- **Tickets** is batch C's tickets with a face: turning it on or off is the community's tickets switch (either way
  round: `PUT /tickets/config` with another `enabled` brings the bot in or takes it out, never failing the switch), its
  settings are the tickets config (saved through `ctx.tickets`, audited `tickets.config`), and its account posts
  panels, opening boxes and log lines (communities whose tickets were on before keep batch C's sender until the bot is
  switched once). Batch C's own `PUT /tickets/config` takes up to 10 panels and 10 per person, but beyond 2 and 3 is
  `403 bots_plus_required` (`details { bot: "tickets", settings }`); `panelLimit` is 10 with Bots+. Without Bots+, stored
  extras pause: at most 3 open per person, only the first 2 panels open tickets (others 404 and aren't in community
  views), no support role, welcome line or transcript. With Bots+: a panel's support role gets the ticket channel
  overwrite and its members are added, and the opening box says `@Role` with `roleMentions`; the welcome line follows
  the box (mentioning the opener); on close, the transcript (`[YYYY-MM-DD HH:MM] Name: text`, edits applied, deletions
  left out, up to 1,000 messages, posts of ≤3,500 characters, at most 10) goes to the panel's log channel after the
  close line, headed `📄 Transcript of Ticket #n · Panel`.
- **Alerts** follows YouTube channels: `source` is a link (`youtube.com/@handle`, `/channel/UC…`, `/user/name`) or an
  `@handle`, resolved once to the channel id, name (`creator`) and uploads playlist (`400 alerts_source_unknown` when
  YouTube doesn't know it); the same YouTube channel once per post channel (`409 conflict`). 3 per community, 25 with
  Bots+ (`403 bots_plus_required`, details `{ bot: "alerts", settings: ["watches"] }`, then `409 limit_reached`); without
  Bots+ only the first 3 (oldest) are checked (`active: false` on the others). `AlertWatch` = `{ id, source,
  youtubeChannelId, creator, channelId, roleId, message, checkedAt, createdAt, active }`. Every 10 minutes the newest 10
  uploads of each are read; videos published after the watch was added and not seen before (the newest 50 ids are kept,
  claimed before posting) are posted oldest first in the watch's channel: the line (`message` or Meldiq's `{role} 📣
  {creator} just posted a new video: {title}\n{url}`; `{role}` is `@Role`, put first when the line has none) with the
  plain `https://www.youtube.com/watch?v=…` link (apps show the preview) and `roleMentions` when a role is set. Without
  `YOUTUBE_API_KEY` its routes answer `503 alerts_unconfigured` (deleting still works). Quota: one unit per channel per
  check (144 a day each).
- **Wordy**: one word per community per UTC day (from 569 answers; guesses may be any of ~13,000 words), the same for
  everyone there, walking the list in a per-community order so no word repeats until all had their day; Wordy #1 was
  2026-01-01. In its channel (elsewhere it says where it's played; quiet until `channelId` is set): `!wordy` or
  `/wordy` starts or shows your game, `!wordy <word>` guesses, and so does a bare five-letter word from someone with a
  game running; `!wordy stats` shows your games, wins, streak (kept while the last win was today or yesterday) and best
  streak, and the top 5 solvers who are still members. Six tries, one game a day; words that aren't five letters or
  aren't in the list don't use a try. The bot answers with the board as 🟩🟨⬛ rows (scored like the original: greens
  first, each letter of the word matched once), never letters; guesses typed in chat are visible as typed, so apps
  should use the private route: `POST …/wordy/game { guess }` → `WordyGame` = `{ day, number, rows: [{ guess, marks }],
  maxTries: 6, finished, solved, channelId, stats: { played, won, streak, bestStreak, distribution: [6] } }` (`400
  wordy_not_a_word`, `409 wordy_finished`, `409 official_bot_off`); finishing posts the result line (squares only) in
  the channel. Just after 00:00 UTC each community posts yesterday's recap there: the word, how many of those who
  finished solved it, and the 1–6/X distribution as bars (once: claimed in `bot_wordy_recaps`; nothing when nobody
  played). Games are kept 7 days; account deletion removes a person's games and record.

**Scheduler.** Nothing a restart would lose lives in memory. A minute tick (and one at startup) ends giveaways whose
stored `ends_at` passed and posts the due Wordy recaps; it runs on the bots' event queue, so it never interleaves with a
bot handling a message. A giveaway ending before the next tick gets a timer of its own. Alerts checks every 10 minutes,
off the queue (it waits on YouTube), one check at a time. Timers stop when the server closes.

**Bots+.** Per community, granted in the Platform Admin Console while billing for it is off (no Stripe product):
`GET /admin/v1/orgs/:orgId/bots-plus` (`entitlements.view`) and `PUT` (`entitlements.edit`, passkey check and reason)
`{ enabled, expiresAt?: ms|null, reason }` → `{ botsPlus: { enabled, grantedAt, expiresAt, grantedBy, reason } }`.
Granting needs an end date within 366 days (no end: super admins only). Platform audit `org.bots_plus_grant` /
`org.bots_plus_revoke`. Communities see `botsPlus` and `botsPlusUntil` in their bots view.

**Seams.** `OfficialBots.giveaways(orgId, viewerId)` feeds the lobby's `giveaways`; `OfficialBots.tickets` is what
batch C's tickets ask (Bots+, the poster, a panel's extras, the switch, transcripts). `!giveaway`, `!gend`, `!greroll`
and `!wordy` are reserved for community commands; `!help` lists the commands of Helper, Levels, Giveaways and Wordy when
on. Env: `YOUTUBE_API_KEY` (Alerts), `WORDY_DIR` (word lists elsewhere).
## Discovery (batch E)

Discover with tags and the 5-member rule, templates from a community, the community bot directory, and Promote (boosts
and the Promoted row). New tables only (migration 075, workspace domain, so new MongoDB collections when communities
live there): `community_discovery`, `community_templates`, `bot_listings`, `discovery_boosts`, `promoted_bookings`,
`discovery_visits`, `discovery_clicks`. A community's rows go with the community. Code:
`server/src/modules/organizations/discovery` (in the organizations module because it reads communities, roles and
channels, which that module owns) and `src/modules/platformAdmin/discovery.ts`; contracts in
`src/shared/contracts/http/{discovery,communityTemplates,botDirectory}.ts`. Tests: `test/discovery.test.ts`,
`test/community_templates.test.ts`, `test/bot_directory.test.ts` (SQLite and MongoDB), `test/discovery_admin.test.ts`.

| Feature name | Switched off by | What |
| --- | --- | --- |
| `discovery-listing` | `DISCOVERY=off` | `GET /v1/discover`, clicks, Discovery settings (and Promote with it) |
| `discovery-promote` | `DISCOVERY_PROMOTE=off` | The Promote page and checkouts; boosts stop counting, no Promoted row |
| `template-links` | `COMMUNITY_TEMPLATE_LINKS=off` | Templates from a community, `templateCode` on create |
| `bot-directory` | `BOT_DIRECTORY=off` | The bot directory and listings |

Switched off, the feature name goes, its routes answer `503 feature_disabled`, and what was set is kept. The older
`community-discovery` and `community-templates` names (the 2026-10-21 Discover and the starter templates) are unchanged.

### Who is listed, and in what order

A community is listed when it is public, shown (`discoverable`, on by default), not removed by staff, not locked
(community safety's `lockedUntil`), its name doesn't contain a word that passes for Meldiq's own unless staff marked it
official (`meldiq`, `meldling`, `official`, `staff`, plus `DISCOVERY_BLOCKED_WORDS`, comma-separated, whole words), and
it has `DISCOVERY_MIN_MEMBERS` (5) members **or** a boost or Promoted week running. Communities that banned the viewer
never show to them. Order: biggest running boost (mega, super, boost; only the biggest counts), then members, then
name. A mega boost's guaranteed place (top 100, 50 from 100 members, 20 from 1,000) follows from the order.

The older `GET /v1/communities/discover` keeps its shape and still lists small public communities, but now leaves out
those turned off, removed, locked or with a blocked name (all of them show while `DISCOVERY=off`).

**`GET /v1/discover?q=&tag=&cursor=`** (signed in, 60/min) →
```
{ promoted: [Card] (≤4: only with no q, no tag, cursor 0), communities: [Card] (30 a page), nextCursor: number|null }
Card = { id, name, description: string|null (the card line, else the community's description), tags: [string],
         photoRev, bannerRev, accent, memberCount, onlineCount, label: "promoted"|"mega"|"super"|"boost"|null,
         joined, official, joinPolicy: "open"|"invite", applications }
```
`q` (≤60) matches name, card line, description and tags (ASCII case ignored); `tag` (any case) keeps communities with
that tag. Each call records that the viewer opened Discover today (`discovery_visits`, kept 14 days) and adds a view
to each Promoted card shown.

**`POST /v1/discover/:orgId/click`** → `{ recorded: true }` when someone opens a card (404 for a community that isn't
public). It counts a click for the community's running Promoted week and is remembered, so a join through
`POST /v1/communities/:id/join` after it counts as a join for that week.

### Discovery settings (`workspace.edit`)

`GET /v1/orgs/:orgId/discovery`, `PUT` with any of `{ discoverable?: boolean, description?: string ≤300 | null,
tags?: [string] ≤5 }` → `{ discoverable, description, tags, listed, reason, memberCount, minMembers: 5,
communityDescription, official, updatedAt }`. `reason` (null when listed): `private`, `removed`, `turned_off`,
`locked`, `name_blocked`, `too_few_members`. Tags: letters and digits with spaces or single hyphens between, ≤24
characters; stored lower case with single spaces, repeats dropped (400 otherwise). Audit `community.discovery`.
Members without the permission get 403, outsiders 404.

### Templates from a community (`workspace.edit`)

A template copies the community's custom roles (name, description, colour, icon, hoist, permissions, denies, gradient,
mentionable, automatic for everyone), the @everyone defaults, categories and channels (name, kind, topic, voice,
forum, category, order, slowmode, forum tags and guidelines, text-only/no-GIFs/stage/read-only and who posts) and the
overwrites for @everyone and roles. Never messages, members, role holders, people's own overwrites, pictures, archived
channels or ticket channels. One per community.

- `GET /v1/orgs/:orgId/templates` → `{ template: Template|null }`.
- `POST /v1/orgs/:orgId/templates` (201) `{ name?: ≤100 }` (the community's name otherwise) → `{ template }`;
  `409 template_exists` when there's one.
- `POST /v1/orgs/:orgId/templates/sync` → `{ template }`: copies the community again under the same code (404
  `template_not_found` without one). `DELETE /v1/orgs/:orgId/templates` → `{ deleted }`: the code stops working.
- `GET /v1/templates/:code` (anyone signed in, any case) → `{ template: { code, name, source: {id, name, photoRev}|null,
  uses, counts, updatedAt, categories: [{ name: string|null, channels: [{name, kind, voice, format, topic}] }],
  roles: [{name, color}] } }`; uncategorised channels come first with `name: null`. `404 template_not_found`.
- `POST /v1/orgs` with `templateCode` makes the community from it instead of a starter template (checked first: `404
  template_not_found`, `503 feature_disabled` while off). Roles beyond the new community's role limit are left out;
  the owner joins every channel; the template's `uses` goes up.

`Template` = `{ code (12 characters), name, uses, counts: {categories, channels, roles}, outOfDate, createdAt,
updatedAt }`; `outOfDate`: the community changed since the copy. Audit `community.template` (created, synced,
deleted) and `community.start` on the new community.

### Community bot directory

- `GET /v1/bot-directory?q=&category=&sort=most_used|newest|a_z&cursor=` → `{ bots: [{ id, username, displayName,
  description, category, installCount, commands: [{name, description}], owner: {id, username}|null, listedAt }],
  nextCursor, categories }`. Categories: `moderation fun games utility music economy social ai other`. `q` matches
  names, the description and slash commands. Only listed bots that still exist and are public.
- `GET`/`PUT /v2/developer/bots/:id/listing` (the bot's owner; 404 otherwise) `{ listed, category, description ≤200 }`
  → `{ listing: { listed, category, description, listedAt, updatedAt, public } }`. Listing a private bot: `409
  bot_private`. `listedAt` is when it was first listed (Newest). Audit `bot.listing`. Adding a bot by id is unchanged.

### Promote (`workspace.edit`)

Boosts: `boost` (Boosted, $3.99 a week), `super` ($7.99), `mega` ($12.99, gold label, guaranteed place). The Promoted
row: 4 spots a week (Monday 00:00 UTC to the next), $29.99 a week, booked for the next free week within 8 weeks.
Prices are `PROMOTE_PRICES` in `src/app/config.ts` (cents). Boosts and bookings are records with `starts_at`,
`ends_at`, a `state` (`pending` a checkout not paid, `active`, `cancelled`) and a `source` (`grant`, `purchase`). A
locked, removed or private community stops showing; nothing is refunded.

**`GET /v1/orgs/:orgId/promote`** →
```
{ billing: { available, reason }, currency: "usd",
  tiers: [{ tier, weeklyCents, guaranteedTop: number|null }],
  boost: Boost|null (the biggest running), boosts: [Boost] (running and coming up),
  rank: number|null (place in the list), listed, reason,
  promoted: { weeklyCents, spotsPerWeek: 4, nextSpot: { startsAt, endsAt, spotsLeft }|null, allTaken,
              bookings: [{ id, state, source, startsAt, endsAt, views, clicks, joins }] (also ended in the last 4 weeks) },
  visitors: { weekly } }   // different people who opened Discover in the last 7 days
Boost = { id, tier, state, source, startsAt, endsAt }
```

**Billing.** `POST /v1/orgs/:orgId/promote/boost` `{ tier }` and `POST /v1/orgs/:orgId/promote/promoted`
`{ weekStart? }` answer **`503 billing_unavailable`** while billing is off (always today), after the permission check
and, for Promoted, `409 promoted_full` (no free week; details `{ nextSpot }` for a chosen week) or 400 (a `weekStart`
that isn't a Monday 00:00 UTC in the next 8 weeks). On success they will answer `{ url }` (the checkout page). The
seam is `PromoteCheckout` (`discovery/checkout.ts`): the billing module sells subscriptions, so a weekly one-off
checkout kind has to be added there, then an adapter records the boost or booking as `pending` and its webhook makes
it `active`.

**Console** (`/admin/v1`, audited with a reason): `GET /admin/v1/discovery/orgs/:orgId` (`billing.view`) →
`{ discovery: { removedAt, removedReason, official, boosts, bookings } }`; `POST …/orgs/:orgId/boosts`
`{ tier, weeks 1–52, reason }` and `POST …/orgs/:orgId/promoted` `{ weekStart?, reason }` (this week if a spot is free,
else the next free one) with `billing.manage`; `POST /admin/v1/discovery/boosts/:id/cancel` and
`/promoted/:id/cancel` `{ reason }` (`billing.manage`, 409 when cancelled already); `PUT …/orgs/:orgId`
`{ removed?, official?, reason }` (`orgs.members.manage`): take a community out of Discovery, or mark it as run by
Meldiq (shown `official`, allowed a name with a blocked word). Audit `discovery.boost_grant`,
`discovery.promoted_grant`, `discovery.boost_cancel`, `discovery.promoted_cancel`, `discovery.update`.

Errors: `template_exists` (409), `template_not_found` (404), `promoted_full` (409), `billing_unavailable` (now also
503), `bot_private` (now also 409).
