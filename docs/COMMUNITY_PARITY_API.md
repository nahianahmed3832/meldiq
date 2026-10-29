# Community parity API

The server side of the web repo's `docs/MELDIQ_COMMUNITY_PARITY.md` (§3 build order). Every piece is additive, so
older apps keep working, and each has a feature name in `/v1/server-info` `features`. In Meldiq a server is a
community (the API says "org").

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
