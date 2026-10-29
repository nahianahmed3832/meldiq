# Community safety (community parity A2)

The server side of the safety part of batch A in the web repo's `docs/MELDIQ_COMMUNITY_PARITY.md` (§1 Server Profile:
raid protection, verification level, new accounts; the Lock item; voice bans; the Mute and Move Members powers). Every
route needs a session. Everything is additive: older apps keep working and simply don't see the new fields.

Feature name `community-safety` in `/v1/server-info` `features`. `COMMUNITY_SAFETY=off` hides it, answers its routes
with 503 `feature_disabled` and stops enforcing all of it (lock, raid protection, verification, account-age gate, voice
bans and mutes); what communities set is kept for when it's back on. The two permission keys stay in the catalog either
way.

Data (migration 070, workspace domain, so SQLite or MongoDB with the rest of the community): `community_safety` (one row
per community that changed a setting or was locked), `community_voice_bans`, `community_voice_mutes`. No existing table
changes. Raid protection's counting and its automatic slowmodes live in the server's memory (a restart starts counting
again and ends an automatic slowmode early).

## Settings: `GET` / `PUT /v1/orgs/:orgId/safety`

```json
{ "verificationLevel": "none", "newAccountGate": "off", "raidProtection": true, "lockedUntil": null, "lockReason": null }
```

- GET: people who can edit the community (`workspace.edit`) or ban (`members.ban`). PUT: `workspace.edit` only. The
  body takes any of `verificationLevel`, `newAccountGate`, `raidProtection`; the rest stays. A change is audited as
  `community.safety` (detail lists what changed) and every member's app reloads the community.
- Community views (`GET /v1/orgs/:orgId`, lists, join results) carry `lockedUntil` for members and `safety` (the
  object above) for people who can edit or ban. Both are absent while the feature is off.

## Locking: `PUT /v1/orgs/:orgId/lock`

Body `{ "duration": "15m" | "1h" | "8h" | "1d" | null }`; null unlocks. Answer `{ lockedUntil, lockReason, lockedBy }`.
Same people as Pause joining (`workspace.edit` or `members.ban`). Locking again replaces the end time. Audited as
`community.lock` (detail: the duration) and `community.unlock`.

While locked:

- Nobody new joins: invitations (also when signing up with one), open joining, applying and approving applications
  answer 403 `community_locked` with `details.until`. Moderators adding existing accounts directly
  (`POST /v1/orgs/:orgId/members`) aren't held back.
- Only moderators post: owners, admins, the channel's managers (`channels.manage` there or channel admins), and
  holders of `messages.manage` once that key exists. Everyone else gets 403 `community_locked_posting` with
  `details.until` for messages, edits, pins and slash commands; reactions, poll votes and read markers still pass.
  Bots keep posting (people who edit the community install them).
- Pause joining (`PUT /v1/orgs/:orgId/security`, `invites_paused`) is unchanged and separate: it only stops joins.

## Raid protection (on by default)

Thresholds are constants in `modules/organizations/safety/rules.ts` (`RAID_LIMITS`):

| What | Threshold | Then |
| --- | --- | --- |
| Joins to one community | 60 within 1 minute | locked for 15 minutes (`lockReason: "raid"`, `lockedBy: null`) |
| Messages in one channel | 30 from at least 6 people within 10 seconds | 5 s slowmode for a fixed 10 minutes |

- The automatic lock never shortens a longer lock. Audited as `community.lock` with no actor and a detail starting
  `automatic:`; members' apps reload the community.
- The automatic slowmode applies only when the channel's own slowmode is under 5 s, and ends a fixed 10 minutes after it
  started (not "after 10 calm minutes": at 5 s per person a flood can't be detected again while it runs). The channel's
  own `slowmodeSec` is never changed; posting answers 429 `slowmode` with `retryAfter` as usual, and the usual people
  skip it. Audited as `channel.auto_slowmode` with no actor; the channel's members' apps reload it.
- Switching raid protection off stops both.

## Verification level

Who may post (messages, edits, pins, slash commands) and react (reactions, poll votes) in the community's channels:

| Level | Needs |
| --- | --- |
| `none` | nothing |
| `low` | a verified email on the account |
| `medium` | low, plus an account at least 5 minutes old and a membership at least 5 minutes old |
| `high` | low, plus an account at least 5 minutes old and a membership at least 10 minutes old |

Skipped by owners, admins, moderators (as for the lock), anyone holding any custom role, and bots. Refusals are 403
`verification_required` with `details: { level, reason: "email" | "wait", allowedAt }` (`allowedAt` null for a missing
email). An identity without an account (an old v1 sign-up) has no verified email. The account's age is its messaging
identity's.

## New accounts (account-age gate)

`newAccountGate`: `off`, `10m`, `1h`, `1d`, `7d`. Accounts younger than that can't join by invitation, openly, or by
applying (checked again on approval): 403 `account_too_new` with `details: { minAccountAge, allowedAt }`. Signing up
with an invitation to such a community either fails with that code (v1 invite-only registration, like `invites_paused`)
or creates the account without joining (account sign-up; the person joins later). Meldiq staff (an active Platform
Admin Console grant) are never held back.

## Voice bans: `/v1/orgs/:orgId/voice-bans`

- `GET` lists them (`{ voiceBans: [{ userId, displayName, username, reason, bannedAt, bannedBy, bannedByName }] }`,
  newest first, at most 500). `POST { userId, reason? }` adds one (answers the list); `DELETE …/:userId` lifts one
  (404 when there's none). All need `members.ban`, and the same rules as bans decide whom (never an owner).
- A voice-banned person can't start or join a call in the community's voice channels (403 `voice_banned`), is taken out
  of a call they're in at once (LiveKit participant removed), and their conversation views say `canConnect: false`.
  They still read and chat. A voice ban stays when they leave, like a ban.
- `GET /v1/orgs/:orgId/bans` also carries `voiceBans` (the same list) while the feature is on.
- Audited as `member.voice_ban` (detail: the reason) and `member.voice_unban`.

## Voice moderation keys

Two new permissions (category voice, admin powers, in the Moderator template; channel capabilities too, so a voice
channel's overwrites can give them there):

- `voice.mute_members`: `PUT /v1/orgs/:orgId/voice/members/:userId/mute` with `{ "muted": true | false }` answers
  `{ userId, muted, mutedAt, devices }`. A server mute lasts until a moderator unmutes (or the person leaves): their
  media tokens can't publish (`canSpeak: false`) in every voice channel of the community, and devices already in a call
  lose publishing at once through LiveKit (`devices` counts them; 0 when the media server can't be reached, then the
  next token carries it). Unmuting gives speaking back where `voice.speak` allows it. Audited `member.voice_mute` and
  `member.voice_unmute`.
- `voice.move_members`: `POST /v1/orgs/:orgId/voice/members/:userId/disconnect` answers `{ userId, disconnected }`
  (devices removed) or 404 when they aren't in a voice call. They may join again. Audited `member.voice_disconnect`.
- Both act on members and guests whose powers the moderator holds, never owners (owners act on anyone else). Without
  the key: 403; yourself: 400.
- In a voice room's call, `POST /v1/calls/:id/moderate` now also lets holders of `voice.mute_members` (mute) and
  `voice.move_members` (remove) in that channel act, besides its managers.

Moving someone to another voice channel isn't offered: Meldiq's apps join one call at a time and choose it themselves,
so "move" is a disconnect.

## Errors

| Code | Status | When |
| --- | --- | --- |
| `community_locked` | 403 | joining a locked community (`details.until`) |
| `community_locked_posting` | 403 | posting in a locked community without being a moderator (`details.until`) |
| `verification_required` | 403 | posting or reacting below the verification level (`details.level`, `reason`, `allowedAt`) |
| `account_too_new` | 403 | joining with an account younger than the gate (`details.minAccountAge`, `allowedAt`) |
| `voice_banned` | 403 | starting or joining a call in a voice channel of a community that voice-banned you |

Tests: `server/test/community_safety.test.ts` (memory and MongoDB, with the gates' clock moved forward and LiveKit
replaced) and `server/test/community_safety_rules.test.ts` (the pure rules on an injected clock).
