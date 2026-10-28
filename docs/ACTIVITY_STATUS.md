# Activity status: "Playing PUBG Mobile" (2026-10-29, API 0.56.0)

The owner asked (2026-10-28) for the Android app to show what someone is playing, the way Discord shows "Playing Free
Fire": on their profile, in the You tab, in DMs and in community member lists. Strictly opt-in, games only.

## What is built, and what isn't yet

| Part | State |
|---|---|
| Server: `PUT /v2/me/activity`, `GET /v2/me/activity`, `activity` frame, `activity` on profiles, member lists and `/v1/presence`, MongoDB `user_activities` | built, API 0.56.0, `server/src/modules/accounts/activity/`, tests `server/test/activity_status.test.ts` |
| Android: Settings › Privacy › Activity privacy (opt-in with the disclosure, Usage access status, hidden games) | built (`ui/screens/profile/ActivityPrivacyScreen.kt`) |
| Android: detection (UsageStatsManager events, games only), reporting, live display | built (`activity/`, `ui/components/ActivityLine.kt`), unit tests `ActivityRulesTest` |
| Meldiq Web: showing activities | not built: the web app ignores the new frame and field until it learns them |
| Google Play: permissions declaration for `PACKAGE_USAGE_STATS` | **not submitted**; nothing is uploaded to Play (§5) |
| Production | **not deployed**; needs the owner's go-ahead |

## 1. What others see

- "Playing PUBG Mobile · 12 min" with a controller glyph, under the name on a profile, under the preview of a DM in the
  chat list, as the DM header's subtitle, first in a community member list row, and on your own You tab.
- Shown to exactly the people who may see your presence: your "Online and last seen" setting (people you share a
  conversation with, or non-guest members of a community you're in, by default), and only while you appear online.
  Invisible hides it from everyone; your own devices always see yours.
- It ends when you close the game (after a 2-minute grace, so checking a message doesn't end it), when you turn
  sharing off, when Meldiq's last connection closes, or 10 minutes after the phone last refreshed it.

## 2. Server (API 0.56.0)

- **`PUT /v2/me/activity`** `{"activity": {"kind": "playing", "name", "packageId"?, "startedAt"?} | null}` → `{"activity": … | null}`.
  - `kind`: only `playing` today. `name`: 1–64 characters, one line (no control or format characters), trimmed.
    `packageId`: an Android package name. `startedAt`: replaced by the server's time when absent, in the future or over a day old.
  - The same game reported again keeps its start time and announces nothing (the app refreshes every 4 minutes).
  - Rate limit 20 per minute per client; the app sends about one per 4 minutes while playing.
- **`GET /v2/me/activity`**: what the server currently holds for you.
- **Frame** `{"t":"activity","userId","activity": … | null}` to the connected people who may see your presence (DM and
  group peers, non-guest members of your communities, each filtered by your "last seen" setting) and to your own
  devices. Choosing invisible sends `null`; appearing again sends the activity.
- **Fields:** `activity` (absent when nothing is shown) on `GET /v1/users/:id`, conversation and community member lists,
  and `GET /v1/presence` entries.
- **Storage:** `ActivityService` keeps the current activities in memory (member lists and profiles are built
  synchronously) and writes every change to the `user_activities` collection in MongoDB whenever the server has one
  (`_id` = user id, `activity`, `updated_at`, `expires_at`; index on `expires_at`). It is new data, so it never lived in
  SQLite and needs no domain migration (the owner's rule: everything new goes to MongoDB). Without `MONGODB_URI`
  (development, tests) a memory store stands in. A restarted server loads activities that haven't lapsed; a sweep every
  minute removes lapsed ones and announces their end. An account deletion leaves nothing behind for long: the person is
  disconnected, which ends the activity.
- **Not federated:** like presence and typing, activities aren't sent to other servers.

## 3. Android

- **Opt-in:** Settings › Privacy › Activity privacy › *Share what I'm playing*, off by default, per server profile
  (`ActivitySettings`, on the phone only). Turning it on shows the disclosure (§5) first, then opens Android's Usage
  access settings if Meldiq isn't allowed yet. The screen shows whether Usage access is allowed, the game in front now,
  and every game the phone noticed with a switch to never show it (hidden games are never sent).
- **Detection** (`GameDetector`, `Foreground`, `ReportPolicy`): every 30 s while the screen is on, the app reads the
  usage *events* since its last look (`UsageStatsManager.queryEvents`: resumed, paused, screen off) to know the app in
  front. It counts as a game only if it's on the known list (`KnownGames`: PUBG Mobile and BGMI, Free Fire and Free Fire
  MAX, Call of Duty: Mobile, Genshin Impact, Honkai: Star Rail, Mobile Legends, Honor of Kings, Wild Rift, Clash of
  Clans, Clash Royale, Brawl Stars, Roblox, Minecraft, Among Us, Pokémon GO, eFootball, EA SPORTS FC Mobile and others)
  or Android lists it in the game category (`ApplicationInfo.CATEGORY_GAME`). Anything else is dropped where it's read:
  never stored, logged or sent. Meldiq itself never counts.
- **Debounce:** a game shows after 15 s in front, keeps showing for 2 minutes after it leaves the front, and is
  refreshed every 4 minutes while it lasts.
- **No new service:** the reporter runs in the app's process while the relay connection is up. With *Stay connected in
  background* on (the default) that connection's foreground service keeps the process alive while a game is in front;
  with it off, the connection drops in the background and the server ends the activity, which is the honest result.
  The screen says so when the setting is off.
- **Display:** `PeopleActivity` holds what others play, in memory, from frames and from the profiles, member lists and
  presence the app already loads (`UserRepository.remember`, `refreshPresence`). A presence frame saying someone went
  offline ends theirs. `PlayingLine`, `activityLabel` and `MyPlayingLine` (`ui/components/ActivityLine.kt`) draw it.
- **Package visibility:** the manifest's `<queries>` names the launcher intent, so apps with a launcher icon are
  visible to Meldiq and the one in front can be read for its category and label. Meldiq doesn't request
  `QUERY_ALL_PACKAGES`.

## 4. Merging with the floating redesign

The redesign (`android-floating-redesign`) moves the You tab's profile into `ui/screens/you/UserPanel.kt` and Settings
into `ui/screens/profile/SettingsWindow.kt`. This branch touches `YouScreen.kt`, `AppRoot.kt` and `i18n/gen.py` with a
few lines only. After merging, put `MyPlayingLine()` under the name in `UserPanel` (and drop the `activity` item this
branch adds to `YouScreen`), and keep the Activity privacy row wherever Privacy ends up.

## 5. Google Play policy (not submitted)

`PACKAGE_USAGE_STATS` is a special permission: only the person can grant it, in Settings › Usage access. Google Play
treats it as sensitive:

1. **Permissions declaration** in Play Console (App content › Sensitive permissions) for `PACKAGE_USAGE_STATS`, with the
   core use: "Shows the game the user is playing to their friends and communities ('Playing …'), only after they opt
   in; only games are recognised and only the game's name and start time are sent." Google may ask for a video of the
   opt-in flow. Without an approved declaration, a release with this permission is rejected.
2. **Prominent disclosure** in the app, before the person is sent to grant access and before anything is collected:
   the dialog on turning *Share what I'm playing* on (`act_disclosure_*`) says what is accessed (which app is in the
   foreground), why (to recognise games), what is sent (game name and start time) and to whom (the Meldiq server, shown
   to people who can see when they're online), that other apps are never collected, and how to turn it off. The person
   must tap *Agree and continue*; *Not now* leaves it off.
3. **Data safety form:** declare "App activity › Other actions" (the game being played) as collected, shared with other
   users as chosen by the person, not used for advertising, optional, and deletable by turning it off.
4. **Privacy policy:** add a paragraph matching §1–§3 before release.

Until the declaration is approved, ship builds with this permission only outside Google Play (the debug APK), or remove
the `<uses-permission>` line from the manifest for a Play release; the rest of the feature then reports "Usage access
is off" and sends nothing.
