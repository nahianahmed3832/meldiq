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
