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
  always empty until the Levels bot (batch D).
- `giveaways`: always empty until the Giveaways bot (batch D); entries will be `{ id, title, endsAt, entrants }`.
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
`{ enabled, maxOpenPerPerson: 1–3 (default 2), panels: [{ id?, name ≤40, postChannelId, categoryId|null, logChannelId|null }] ≤2 }`
→ `{ enabled, maxOpenPerPerson, panels: [{ id, name, postChannelId, categoryId, logChannelId, postedMessageId }], panelLimit: 2 }`.
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
