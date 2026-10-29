# Community permissions, nicknames, role extras and channel options (community parity A1, 2026-10-30)

Part 1 of batch A of `meldiq_web/docs/MELDIQ_COMMUNITY_PARITY.md`: the reference app's role and channel controls,
written in Meldiq's own words. Feature string `community-permissions`; `COMMUNITY_PERMISSIONS=off` hides it, answers
its routes with `503 feature_disabled`, sends no new fields in views and stops enforcing what communities set (kept
for when it's back on). Code: `server/src/modules/organizations/communityPermissions/`, `permissions/catalog.ts`,
`permissions/channelOptions.ts`, `authz.ts`, `modules/messaging/contentRules.ts` and `historyLimit.ts`. Migration
`069_community_permissions.sql` (new tables only). Test: `server/test/community_permissions.test.ts` (memory and
MongoDB, workspace rows included).

## 1. New permissions

| Key | Default | Flags | Enforced |
|---|---|---|---|
| `messages.react` | Members, guests | restrictable | A reaction with an emoji not yet on the message (`reactions_not_allowed`); joining an existing one stays open. |
| `messages.embed` | Members, guests | restrictable | A message or edit with an http(s) address in its text or a `link` preview (`links_not_allowed`). A GIF's own address doesn't count. |
| `messages.voice` | Members, guests | restrictable | `attachments[].voice` (`voice_messages_not_allowed`). |
| `messages.external_emoji` | Members, guests | restrictable | `customEmoji[]` / `customSticker` of another community (`external_emoji_not_allowed`). |
| `messages.polls` | Members, guests | restrictable | A message with `poll` (`polls_not_allowed`). |
| `messages.big_text` | Members, guests | restrictable | A line starting `#`, `##` or `###` and a space, in a message or edit (`headings_not_allowed`). |
| `messages.history` | Members, guests | restrictable | Without it a channel's history (`GET /v2/conversations/:id/messages`, search, the summary's last message) starts when the person joined the channel. |
| `threads.create` | Members, guests | restrictable | The first reply with a new `threadRoot` (`threads_not_allowed`). |
| `threads.post` | Members, guests | restrictable | Later replies in a thread, and every reply in a forum post (`thread_replies_not_allowed`). |
| `members.nickname` | Members, guests | restrictable | Changing your own nickname (`nickname_not_allowed`). |
| `messages.mention_all` | none | restrictable | Holders may @everyone in any channel (others keep the small-conversation rule) and mention any role. |
| `messages.manage` | Admins | admin | Delete and pin anyone's message in a channel (`not_yours` / `manage_messages_required` otherwise), skip slowmode, ignore text-only and no-GIF options, post in read-only channels. Channel managers count too. |
| `threads.manage` | Admins | admin | Delete and pin anyone's message inside a thread. (Meldiq has no thread lock or close yet.) |
| `members.nicknames` | Admins | admin | Change others' nicknames, only people the caller may act on (`nicknames_not_allowed`). |

Pinning in a community channel now needs `messages.manage` (or managing the channel), as in the reference. The
everyday keys are in both base sets, so nothing changes until a community or a role takes them away. The Moderator
template gains `messages.manage`, `threads.manage` and `members.nicknames`. All but `members.nickname(s)` are channel
capabilities too (category and channel overwrites). Role mentions: a payload's `roleMentions: [roleId]` is checked
(`role_mention_not_allowed`); the apps don't send it yet.

## 2. @everyone defaults

`GET /v1/orgs/:orgId/roles` carries `everyone: { permissions, standard, allowed, customized, updatedAt }`, and its
`baseRoles` Member entry follows it. `PUT /v1/orgs/:orgId/roles/everyone` `{ permissions }` replaces what plain members
hold: needs `roles.manage`, only non-administrative keys (`not_member_safe`), and only keys the caller holds may be
added or removed (`beyond_your_powers`). Stored as changes to the standard set (`community_member_defaults`), so a key
a later server adds reaches members; saving the standard set deletes the row. Audited `everyone.update`; everyone's
channel access is checked again.

## 3. Nicknames

`PUT /v1/orgs/:orgId/members/:userId/nickname` `{ nickname }` → `{ userId, nickname }`. Up to 32 characters (as
people count them), no control or invisible characters; empty clears. Member lists carry `nickname`. Kept in
`org_nicknames`, removed with the membership. Audited `member.nickname`.

## 4. Role extras and order

`PUT /v1/roles/:roleId/extras` `{ color2?, mentionable?, autoAssign?: { mode: none|everyone|joined_before, before? } }`
→ `{ roleId, extras, memberCount }`; whoever may edit the role. Role views carry `extras`; member lists' role badges
carry `color2`. Roles given automatically carry no permissions or restrictions (`auto_role_has_powers`, also on
PATCH): members who match get them (assigned by `auto`, within the 20-role limit), and so do people who join later; a
change takes them back from people they no longer match. Kept in `org_role_extras`.

`PUT /v1/orgs/:orgId/roles/order` `{ roleIds }` (highest first) → `{ order: [{ id, position }] }`: the listed roles
swap the positions they hold. Owners and admins move any; others with `roles.manage` only roles below their own
highest. Audited `role.reorder`.

## 5. Channel options

`POST /v1/orgs/:orgId/channels` and `PATCH /v1/conversations/:id` take `textOnly`, `noGifs`, `stage`, `readOnly`,
`posterRoleIds` (and creation `slowmodeSec`). Views carry `options` (stage moderators also `speakerIds`).

- Text only: no attachments, GIFs, stickers or GIF links (`text_only_channel`; `canAttach` false).
- No GIFs: no `gif` payloads or links to tenor, giphy, gfycat or `.gif` files (`gifs_not_allowed`).
- Read-only: everyone reads and reacts; poster roles and moderators post (`read_only_channel`). Changing it later needs
  `channels.visibility`.
- Stage (voice channels): listeners get listen-only call credentials until a moderator (the channel's managers) lets
  them speak: `PUT|DELETE /v1/conversations/:id/stage/speakers/:userId` → `{ conversationId, speakerIds }` (a speaker
  may step down). Hands go up through `POST /v1/calls/:id/hand`; letting someone speak lowers it and changes their
  live call permissions on the media server. Kept in `channel_options` and `stage_speakers`.

Moderators (managers and `messages.manage`) aren't held to text-only and no-GIFs. Audited `channel.options`,
`stage.speaker_add`, `stage.speaker_remove`.
